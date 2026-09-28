import { closestOnSegment, rayCapsule, type Hit } from './collide';
import {
  beatSteps, BUMPER_MAX_SPEED, BUMPER_RESTITUTION, CHAIN_WINDOW, CHORD_GAIN, DRIFT_AMP_DEFAULT, DRIFT_AMP_MAX, DT, ENERGY_HITS, G,
  HISTORY, HIT_RADIUS, HZ, MAX_AGE_STEPS, MAX_BALLS, MAX_SEGS, MAX_SHAPE_EDGES, PLACE_BOUNDS, REST_VN, RESTITUTION, STALL_SPEED,
  STALL_STEPS, TANGENT_KEEP, WORLD_BOUNDS, WORLD_W, impactVelocity, maxOmega, type Bounds,
} from './constants';
import { inferForm } from './form';
import { chordSlots, DEFAULT_SONG, formMidi, lengthToNote, sectionRoot, type SongId } from './music';
import { Repeats } from './repeats';
import { driftOffset, hitAllowed, smooth } from './rules';
import {
  edgeCount, measureShape, normalizePoints, poseShape, rebaseRotation, shapeSegments, type Shape,
} from './shape';
import { Timeline } from './timeline';
import type {
  Ball, Command, DriftMode, Emitter, HitEvent, SceneData, SegKind, Segment, ShapeEffect, ShapeForm, SimEvent, Snapshot,
} from './types';

// 外から使う純関数・型（input / scene / テストが sim.ts から読む）
export { driftOffset, hitAllowed } from './rules';
export { normalizePoints, shapeAngle, type Shape } from './shape';

const MAX_BOUNCES_PER_STEP = 4;
const PUSH_OUT = 0.01;
const EMITTER_Y = 40;
/** 止める・続けるときに回転の速さが変わりきるまで（D50。2 秒） */
const SPIN_FADE_STEPS = 2 * HZ;
/** 回転の速さを変えている間、角速度を置き直す間隔（1/30 秒） */
const SPIN_REBASE = HZ / 30;

export type SimOptions = {
  bpm: number;
  /** 放出口ごとの放出間隔（拍）。例 [2, 3] */
  pattern: readonly number[];
  /** 放出口の揺らぎ。省略時は drift / 24px */
  drift?: { mode: DriftMode; amp: number };
  /** 曲（D48）。省略時は bright */
  song?: SongId;
};

export class Sim {
  /** 次に実行するステップ番号 */
  step = 0;
  pattern: number[];
  rotating = false;
  rotationSpeed = 0.3;
  /** 再生中か（D50）。止めている間は球を出さない（放出の番号は進めるので、続けると拍に合って出る） */
  playing = true;
  /** 回転の速さに掛ける 0..1。止めると SPIN_FADE_STEPS かけて 0 へ、続けると 1 へ */
  spinScale = 1;
  driftMode: DriftMode = 'drift';
  driftAmp = DRIFT_AMP_DEFAULT;
  /** 表示されている範囲。ここから出たボールを消す（D23） */
  view: Bounds = WORLD_BOUNDS;

  /** 全図形の辺（追加順）。当たり判定の順序もこれ */
  readonly segments: Segment[] = [];
  /** 図形（group → Shape、追加順） */
  readonly shapes = new Map<number, Shape>();
  readonly balls: Ball[] = [];
  readonly emitters: Emitter[] = [];

  private queue: Command[] = [];
  private events: SimEvent[] = [];
  private nextSegmentId = 1;
  private nextGroupId = 1;
  private nextBallId = 1;
  /** 放出口の基準 x（揺らぎの中心） */
  private baseXs: number[] = [];
  /** 拍の格子とハーモニー区間の基準 */
  private readonly time: Timeline;
  private lastSection = -1;
  /** 曲（D48）。音階と根音を決める */
  song: SongId = DEFAULT_SONG;
  /** energy 用: 直近の衝突イベントのステップ（古い順） */
  private recentHits: number[] = [];
  /** echo / rise のくり返し（D32） */
  private readonly repeats: Repeats;
  private readonly history: Snapshot[] = [];
  private readonly hit: Hit = { t: 0, nx: 0, ny: 0 };
  private readonly near = { dist: 0, nx: 0, ny: 0 };

  constructor(opts: SimOptions) {
    this.time = new Timeline(opts.bpm);
    this.repeats = new Repeats(this.time, this.shapes);
    this.pattern = [...opts.pattern];
    if (opts.song) this.song = opts.song;
    if (opts.drift) this.setDrift(opts.drift.mode, opts.drift.amp);
    for (let i = 0; i < HISTORY; i++) {
      this.history.push({
        step: -1,
        count: 0,
        ids: new Int32Array(MAX_BALLS + 1),
        xs: new Float32Array(MAX_BALLS + 1),
        ys: new Float32Array(MAX_BALLS + 1),
      });
    }
    this.setupEmitters(opts.pattern, 0);
  }

  enqueue(cmd: Command): void {
    this.queue.push(cmd);
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** 指定ステップのボール位置。履歴から外れていれば undefined */
  snapshot(step: number): Snapshot | undefined {
    if (step < 0) return undefined;
    const s = this.history[step % HISTORY]!;
    return s.step === step ? s : undefined;
  }

  /** テンポ（BPM）。変えるのは setTempo / loadScene コマンドで */
  get bpm(): number {
    return this.time.bpm;
  }

  /** ステップのハーモニー区間（0..3） */
  sectionAt(step: number): number {
    return this.time.sectionAt(step);
  }

  /** energy の窓（2 小節 = 区間の 1/4） */
  get energyWindow(): number {
    return this.time.energyWindow;
  }

  /** 辺 id → 図形 id */
  private groupOf(segmentId: number): number | undefined {
    return this.segments.find((s) => s.id === segmentId)?.group;
  }

  advance(): void {
    const s = this.step;
    this.applyCommands(s);
    this.updateSection(s);
    this.updateSpin(s);
    this.updatePoses(s);
    this.emit(s);
    this.integrate(s);
    this.repeats.flush(s, this.song, this.events);
    this.cull(s);
    this.record(s);
    this.step = s + 1;
  }

  // ---- コマンド ----

  private applyCommands(s: number): void {
    const queue = this.queue;
    this.queue = [];
    for (const cmd of queue) {
      switch (cmd.kind) {
        case 'addSegment':
          this.addShape(s, [[cmd.ax, cmd.ay], [cmd.bx, cmd.by]], false, 'line', cmd.dir, 'line');
          break;
        case 'addShape':
          this.addShape(s, cmd.points, cmd.closed, cmd.segKind, cmd.dir, cmd.form);
          break;
        case 'removeSegment': {
          const g = this.groupOf(cmd.id);
          if (g !== undefined) this.removeShape(s, g);
          break;
        }
        case 'removeShape':
          this.removeShape(s, cmd.group);
          break;
        case 'setEffect': {
          const sh = this.shapes.get(cmd.group);
          if (!sh || sh.effect === cmd.effect) break;
          sh.effect = cmd.effect;
          this.repeats.delete(cmd.group);
          this.events.push({ kind: 'shapeEffect', step: s, group: cmd.group, effect: cmd.effect });
          break;
        }
        case 'clearSegments':
          this.clearShapes(s);
          break;
        case 'setRotation':
          this.rotating = cmd.on;
          this.rotationSpeed = cmd.speed;
          this.rebaseAll(s);
          break;
        case 'setPlaying':
          this.playing = cmd.on;
          break;
        case 'setTempo':
          this.setTempo(s, cmd.bpm, cmd.pattern);
          break;
        case 'setDrift':
          this.setDrift(cmd.mode, cmd.amp);
          break;
        case 'setSong':
          this.setSong(cmd.song);
          break;
        case 'setView': {
          // ワールドより狭くはしない（16:9 の中は常に見えている）。広げるのは置ける範囲の上限まで
          const v = cmd.bounds;
          this.view = {
            minX: Math.round(Math.min(0, Math.max(PLACE_BOUNDS.minX, v.minX))),
            maxX: Math.round(Math.max(WORLD_W, Math.min(PLACE_BOUNDS.maxX, v.maxX))),
            maxY: Math.round(Math.max(WORLD_BOUNDS.maxY, Math.min(PLACE_BOUNDS.maxY, v.maxY))),
          };
          break;
        }
        case 'loadScene':
          this.loadScene(s, cmd.scene);
          break;
      }
    }
  }

  private removeShape(s: number, group: number): void {
    if (!this.shapes.delete(group)) return;
    let w = 0;
    for (const seg of this.segments) if (seg.group !== group) this.segments[w++] = seg;
    this.segments.length = w;
    this.repeats.delete(group);
    this.events.push({ kind: 'shapeRemoved', step: s, group });
  }

  private clearShapes(s: number): void {
    for (const group of this.shapes.keys()) this.events.push({ kind: 'shapeRemoved', step: s, group });
    this.shapes.clear();
    this.segments.length = 0;
    this.repeats.clear();
  }

  private setTempo(s: number, bpm: number, pattern: readonly number[]): void {
    // 進行は途切れさせない: 今の区間から新しい長さで数え直す
    this.retime(s, bpm, pattern, this.sectionAt(s));
    // 残りのくり返しは新しい格子（s から始まる）に取り直す
    this.repeats.regrid(s);
  }

  /** 放出の格子とハーモニー区間を s から取り直す（区間は base から数える） */
  private retime(s: number, bpm: number, pattern: readonly number[], base: number): void {
    this.time.retime(s, bpm, base);
    this.pattern = [...pattern];
    this.setupEmitters(pattern, s);
  }

  /** 曲を変える。区間の数え方はそのままで、次のステップから新しい音階で鳴らす（後ろの和音も切り替える） */
  private setSong(song: SongId): void {
    this.song = song;
    this.lastSection = -1;
  }

  private setDrift(mode: DriftMode, amp: number): void {
    this.driftMode = mode;
    this.driftAmp = Math.min(DRIFT_AMP_MAX, Math.max(0, Math.round(amp)));
  }

  /** 配置の読み込み。ボールも消し、放出・回転・ハーモニー・energy の基準を s に取り直す（読み込み後は毎回同じ曲になる） */
  private loadScene(s: number, scene: SceneData): void {
    this.clearShapes(s);
    this.balls.length = 0;
    this.recentHits = [];
    this.rotating = scene.rotate;
    this.rotationSpeed = scene.rotationSpeed;
    this.setDrift(scene.drift.mode, scene.drift.amp);
    this.setSong(scene.song ?? DEFAULT_SONG);
    this.retime(s, scene.bpm, scene.pattern, 0);
    scene.shapes.forEach(([kind, dir, closed, ...flat], i) => {
      const pts: [number, number][] = [];
      for (let j = 0; j + 1 < flat.length; j += 2) pts.push([flat[j]!, flat[j + 1]!]);
      // 形は forms から（無ければ addShape が点列から推定する。D18）
      this.addShape(s, pts, closed, kind, dir, scene.forms?.[i], scene.effects?.[i]);
    });
  }

  /** 図形を追加する。座標は整数 px に丸める（ライブと読み込み後で同じ状態にするため） */
  private addShape(
    s: number, raw: readonly (readonly [number, number])[], closed: boolean, kind: SegKind, dir?: 1 | -1,
    formIn?: ShapeForm, effect: ShapeEffect = 'none',
  ): void {
    const points = normalizePoints(raw, closed);
    if (!points) return;
    // 推定は正規化後の点数で行う（保存するのも正規化後の点なので、読み込み後も同じ形になる）
    const form = formIn ?? inferForm(points.length, closed);
    const edges = edgeCount(points.length, closed);
    if (edges > MAX_SHAPE_EDGES || this.segments.length + edges > MAX_SEGS) return;
    const m = measureShape(points, closed);
    if (!m) return;
    const { gx, gy } = m;

    const group = this.nextGroupId++;
    const note = lengthToNote(m.perimeter).index;
    const shape: Shape = {
      group, kind, form, effect, closed, points, gx, gy, note,
      radius: m.radius,
      perimeter: m.perimeter,
      dir: dir ?? (group % 2 === 0 ? 1 : -1),
      segs: [],
      theta0: 0,
      rotStartStep: s,
      omega: 0,
      lastEventStep: -Infinity,
    };
    shape.segs = shapeSegments(shape, s, this.nextSegmentId);
    this.nextSegmentId += edges;
    this.shapes.set(group, shape);
    this.segments.push(...shape.segs);

    this.events.push({
      kind: 'shapeAdded',
      step: s,
      group,
      segKind: kind,
      form,
      note,
      midi: formMidi(form, note, this.sectionAt(s), this.song),
      closed,
      dir: shape.dir,
      effect,
      gx, gy,
      points: points.map(([x, y]) => [x - gx, y - gy] as [number, number]),
    });
    this.setShapeRotation(shape, s);
    if (shape.omega !== 0) this.pushPose(shape, s);
  }

  /** 回転の設定と spinScale から角速度を決め直す（角度は連続） */
  private setShapeRotation(sh: Shape, s: number): void {
    const omega = this.rotating ? sh.dir * Math.min(this.rotationSpeed, maxOmega(sh.radius)) * smooth(this.spinScale) : 0;
    rebaseRotation(sh, s, omega);
  }

  /** すべての図形の角速度を決め直して、姿勢を描画に知らせる */
  private rebaseAll(s: number): void {
    for (const sh of this.shapes.values()) {
      this.setShapeRotation(sh, s);
      this.pushPose(sh, s);
    }
  }

  private pushPose(sh: Shape, s: number): void {
    this.events.push({
      kind: 'shapePose',
      step: s,
      group: sh.group,
      theta0: sh.theta0,
      rotStartStep: sh.rotStartStep,
      omega: sh.omega,
    });
  }

  private setupEmitters(pattern: readonly number[], s: number): void {
    this.emitters.length = 0;
    this.baseXs = [];
    const n = pattern.length;
    pattern.forEach((beats, i) => {
      const baseX = Math.round(WORLD_W * (0.5 + (i - (n - 1) / 2) * 0.16));
      this.baseXs.push(baseX);
      this.emitters.push({
        id: i,
        x: baseX + driftOffset(this.driftMode, this.driftAmp, i, 0),
        y: EMITTER_Y,
        beats,
        anchorStep: s,
        nextK: 0,
      });
    });
    this.events.push({
      kind: 'emitters',
      step: s,
      emitters: this.emitters.map((e) => ({ id: e.id, x: e.x, y: e.y })),
    });
  }

  // ---- 1ステップの処理 ----

  private updateSection(s: number): void {
    const sec = this.sectionAt(s);
    if (sec === this.lastSection) return;
    this.lastSection = sec;
    this.events.push({ kind: 'section', step: s, section: sec, root: sectionRoot(sec, this.song) });
  }

  /** 止める・続けるときに回転の速さをゆっくり変える。SPIN_REBASE ステップごとに角速度を置き直す（角度は連続） */
  private updateSpin(s: number): void {
    const target = this.playing ? 1 : 0;
    if (this.spinScale === target) return;
    const d = 1 / SPIN_FADE_STEPS;
    this.spinScale = target > this.spinScale ? Math.min(target, this.spinScale + d) : Math.max(target, this.spinScale - d);
    if (!this.rotating || (this.spinScale !== target && s % SPIN_REBASE !== 0)) return;
    this.rebaseAll(s);
  }

  private updatePoses(s: number): void {
    for (const sh of this.shapes.values()) {
      if (sh.omega !== 0) poseShape(sh, s);
    }
  }

  private emit(s: number): void {
    for (const em of this.emitters) {
      // k 回目の放出は anchor + round(k·beats·7200/BPM)。周期を整数に丸めて足し合わせると、
      // 7200 を割り切れない BPM で誤差がたまり、録音が DAW のグリッドからずれるため（D10）
      const at = (k: number) => em.anchorStep + Math.round(beatSteps(k * em.beats, this.bpm));
      // 格子を過ぎてしまっていたら（取り直しの端数など）、止まったままにせず次の格子へ進める
      while (at(em.nextK) < s) em.nextK++;
      if (at(em.nextK) !== s) continue;
      em.x = this.baseXs[em.id]! + driftOffset(this.driftMode, this.driftAmp, em.id, em.nextK);
      em.nextK++;
      if (!this.playing) continue;
      const ball: Ball = {
        id: this.nextBallId++,
        x: em.x,
        y: em.y,
        vx: 0,
        vy: 0,
        bornStep: s,
        slowSteps: 0,
        lastHit: new Map(),
        lastEventStep: -Infinity,
        lastEventGroup: -1,
        chain: 0,
      };
      this.balls.push(ball);
      this.events.push({ kind: 'emit', step: s, emitterId: em.id, ballId: ball.id, x: em.x, y: em.y });
    }
  }

  private integrate(s: number): void {
    const R = HIT_RADIUS;
    const hit = this.hit;
    for (const b of this.balls) {
      b.vy += G * DT;
      let remaining = 1;
      // B5: 相対的に離れていく面は、このステップでは候補から外す
      let skip: Segment | undefined;

      for (let iter = 0; iter < MAX_BOUNCES_PER_STEP; iter++) {
        const dx = b.vx * DT * remaining;
        const dy = b.vy * DT * remaining;
        let best: Segment | undefined;
        let bt = Infinity;
        let bnx = 0;
        let bny = 0;
        for (const seg of this.segments) {
          if (seg === skip) continue;
          if (!rayCapsule(b.x, b.y, dx, dy, seg.ax, seg.ay, seg.bx, seg.by, R, hit)) continue;
          if (hit.t < bt) {
            bt = hit.t;
            bnx = hit.nx;
            bny = hit.ny;
            best = seg;
          }
        }
        if (!best) {
          b.x += dx;
          b.y += dy;
          break;
        }
        b.x += dx * bt + bnx * PUSH_OUT;
        b.y += dy * bt + bny * PUSH_OUT;
        if (!this.bounce(s, b, best, bnx, bny)) skip = best;
        remaining *= 1 - bt;
        if (remaining <= 1e-6) break;
      }

      this.resolveOverlap(b);

      const speed = Math.hypot(b.vx, b.vy);
      b.slowSteps = speed < STALL_SPEED ? b.slowSteps + 1 : 0;
    }
  }

  /** 反射したら true。図形に対して相対的に離れていく場合は何もせず false */
  private bounce(s: number, b: Ball, seg: Segment, nx: number, ny: number): boolean {
    // 回転する図形の表面速度（重心まわり）
    const svx = -seg.omega * (b.y - seg.gy);
    const svy = seg.omega * (b.x - seg.gx);
    const rvx = b.vx - svx;
    const rvy = b.vy - svy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return false;
    const impact = -vn;
    const tx = rvx - vn * nx;
    const ty = rvy - vn * ny;

    if (impact < REST_VN) {
      // 跳ねずに滑る
      b.vx = tx + svx;
      b.vy = ty + svy;
    } else {
      const e = seg.kind === 'bumper' ? BUMPER_RESTITUTION : RESTITUTION;
      b.vx = tx * TANGENT_KEEP - e * vn * nx + svx;
      b.vy = ty * TANGENT_KEEP - e * vn * ny + svy;
      if (seg.kind === 'bumper') {
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > BUMPER_MAX_SPEED) {
          b.vx *= BUMPER_MAX_SPEED / sp;
          b.vy *= BUMPER_MAX_SPEED / sp;
        }
      }
    }

    const sh = this.shapes.get(seg.group)!;
    const last = b.lastHit.get(seg.group);
    b.lastHit.set(seg.group, s);
    if (!hitAllowed(s, impact, last, sh.lastEventStep)) return true;
    sh.lastEventStep = s;

    // chain: 直前の衝突から CHAIN_WINDOW 以内に別の図形なら +1
    b.chain = s - b.lastEventStep <= CHAIN_WINDOW && b.lastEventGroup !== seg.group ? b.chain + 1 : 1;
    b.lastEventStep = s;
    b.lastEventGroup = seg.group;

    // energy: 直近 2 小節（この衝突を含む）の衝突数
    const hits = this.recentHits;
    hits.push(s);
    const from = s - this.energyWindow;
    let drop = 0;
    while (drop < hits.length && hits[drop]! <= from) drop++;
    if (drop) hits.splice(0, drop);

    const section = this.sectionAt(s);
    const ev: HitEvent = {
      kind: 'hit',
      step: s,
      ballId: b.id,
      lineId: seg.id,
      x: b.x,
      y: b.y,
      normalSpeed: impact,
      velocity: impactVelocity(impact),
      note: sh.note,
      midi: formMidi(sh.form, sh.note, section, this.song),
      section,
      group: seg.group,
      segKind: seg.kind,
      form: sh.form,
      echo: 0,
      voice: 0,
      chain: b.chain,
      energy: Math.min(1, hits.length / ENERGY_HITS),
    };
    this.events.push(ev);
    this.applyEffect(s, sh, ev);
    return true;
  }

  /** 当たった音へのエフェクト（D32）。chord は同じステップに重ねる音を出す。echo / rise はくり返しを予約する */
  private applyEffect(s: number, sh: Shape, ev: HitEvent): void {
    if (sh.effect === 'chord') {
      chordSlots(sh.form, sh.note).forEach((note, i) => {
        this.events.push({
          ...ev, voice: i + 1, note, midi: formMidi(sh.form, note, ev.section, this.song), velocity: ev.velocity * CHORD_GAIN,
        });
      });
    } else if (sh.effect === 'echo' || sh.effect === 'rise') {
      this.repeats.start(s, sh.effect, ev);
    }
  }

  /** CCD の取りこぼし（線を引いた直後、回転による掃引）の保険。音は鳴らさない */
  private resolveOverlap(b: Ball): void {
    const R = HIT_RADIUS;
    const near = this.near;
    for (const seg of this.segments) {
      closestOnSegment(b.x, b.y, seg.ax, seg.ay, seg.bx, seg.by, near);
      if (near.dist >= R) continue;
      const push = R - near.dist + PUSH_OUT;
      b.x += near.nx * push;
      b.y += near.ny * push;
      const vn = b.vx * near.nx + b.vy * near.ny;
      if (vn < 0) {
        b.vx -= vn * near.nx;
        b.vy -= vn * near.ny;
      }
    }
  }

  private cull(s: number): void {
    const margin = 50;
    let w = 0;
    for (const b of this.balls) {
      const v = this.view;
      const out = b.y > v.maxY + margin || b.x < v.minX - margin || b.x > v.maxX + margin;
      const old = s - b.bornStep > MAX_AGE_STEPS;
      const stalled = b.slowSteps > STALL_STEPS;
      if (!out && !old && !stalled) this.balls[w++] = b;
    }
    this.balls.length = w;
    if (this.balls.length > MAX_BALLS) this.balls.splice(0, this.balls.length - MAX_BALLS);
  }

  private record(s: number): void {
    const snap = this.history[s % HISTORY]!;
    snap.step = s;
    snap.count = this.balls.length;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i]!;
      snap.ids[i] = b.id;
      snap.xs[i] = b.x;
      snap.ys[i] = b.y;
    }
  }
}
