import { closestOnSegment, rayCapsule, type Hit } from './collide';
import {
  BALL_LINE_COOLDOWN, BUMPER_MAX_SPEED, BUMPER_RESTITUTION, CHAIN_WINDOW, CHORD_GAIN, DRIFT_AMP_DEFAULT, DRIFT_AMP_MAX,
  DRIFT_PERIOD, DT, ECHO_BEATS, ECHO_COUNT, ECHO_DECAY, ENERGY_HITS, G, HISTORY, HIT_RADIUS, HZ, LINE_COOLDOWN, MAX_AGE_STEPS, MAX_BALLS, MAX_SEGS,
  MAX_SHAPE_EDGES, MIN_LINE_LEN, PHRASE_LEN, REST_VN, RESTITUTION, SECTION_BARS, STALL_SPEED, STALL_STEPS,
  PLACE_BOUNDS, RISE_BEATS, RISE_COUNT, RISE_DECAY, TANGENT_KEEP, V_MIN, WORLD_BOUNDS, WORLD_W, impactVelocity, maxOmega, type Bounds,
} from './constants';
import { inferForm } from './form';
import { chordSlots, formMidi, lengthToNote, riseSlot, sectionAt, sectionSteps } from './music';
import type {
  Ball, Command, DriftMode, Emitter, HitEvent, SceneData, SegKind, Segment, ShapeAddedEvent, ShapeEffect, ShapeForm,
  SimEvent, Snapshot,
} from './types';

const MAX_BOUNCES_PER_STEP = 4;
const PUSH_OUT = 0.01;
const EMITTER_Y = 40;

export type SimOptions = {
  bpm: number;
  /** 放出口ごとの放出間隔（拍）。例 [2, 3] */
  pattern: readonly number[];
  /** 放出口の揺らぎ。省略時は drift / 24px */
  drift?: { mode: DriftMode; amp: number };
};

/** 回転の姿勢（図形の回転角 φ、または辺の向き） */
type Rot = { theta0: number; omega: number; rotStartStep: number };

/** ステップ（小数可）における辺の向き */
export function segmentAngle(seg: Rot, step: number): number {
  return seg.theta0 + (seg.omega * (step - seg.rotStartStep)) / HZ;
}

/** ステップ（小数可）における図形の回転角 φ（shapePose から。描いたとき 0） */
export function shapeAngle(pose: Rot, step: number): number {
  return pose.theta0 + (pose.omega * (step - pose.rotStartStep)) / HZ;
}

export function periodSteps(beats: number, bpm: number): number {
  return Math.max(1, Math.round((beats * HZ * 60) / bpm));
}

/**
 * 衝突をイベント化するか（D4）。境界: impact ≥ V_MIN、同じボール×図形は BALL_LINE_COOLDOWN ステップ以上、
 * 同じ図形は LINE_COOLDOWN ステップ以上あいていること。
 */
export function hitAllowed(s: number, impact: number, lastBallLine: number | undefined, lastLineEvent: number): boolean {
  if (impact < V_MIN) return false;
  if (lastBallLine !== undefined && s - lastBallLine < BALL_LINE_COOLDOWN) return false;
  return s - lastLineEvent >= LINE_COOLDOWN;
}

/** 放出番号 k の放出口オフセット（整数 px）。純関数・整数演算のみ（エンジン差なし） */
export function driftOffset(mode: DriftMode, amp: number, emitterId: number, k: number): number {
  if (mode === 'off' || amp <= 0) return 0;
  if (mode === 'drift') {
    // 三角波 0 → +1 → 0 → −1 → 0。放出口ごとに 1/4 周期ずらす
    const P = DRIFT_PERIOD;
    const ph = (k + emitterId * (P / 4)) % P;
    const q = 4 * ph;
    const tri = q < P ? q : q < 3 * P ? 2 * P - q : q - 4 * P; // [-P, P]
    return Math.round((amp * tri) / P);
  }
  const OFF = [0, 2, -2, 1]; // ×amp/2
  const idx = (Math.floor(k / PHRASE_LEN) + emitterId) % OFF.length;
  return Math.round((amp * OFF[idx]!) / 2);
}

/** 図形（D12）。sim 内部の状態 */
export type Shape = {
  group: number;
  kind: SegKind;
  /** 形（D16）。音色が決まる */
  form: ShapeForm;
  /** エフェクト（D32） */
  effect: ShapeEffect;
  dir: 1 | -1;
  closed: boolean;
  /** 描いたときの頂点（整数 px）。保存用 */
  points: [number, number][];
  gx: number;
  gy: number;
  /** 重心から最も遠い頂点までの距離（回転速度の上限に使う） */
  radius: number;
  perimeter: number;
  note: number;
  segs: Segment[];
  /** 図形の回転角 φ の基準 */
  theta0: number;
  rotStartStep: number;
  omega: number;
  lastEventStep: number;
};

/**
 * 点列を整数 px に丸めて範囲 b 内にクランプし、連続する重複点（閉じた図形は末尾の始点も）を除く。
 * 図形にならなければ null。
 */
export function normalizePoints(
  points: readonly (readonly [number, number])[], closed: boolean, b: Bounds = PLACE_BOUNDS,
): [number, number][] | null {
  // 閉じた図形は、はみ出したぶん全体を平行移動して画面内に収める（点ごとのクランプだと形が潰れるため）
  let dx = 0;
  let dy = 0;
  if (closed && points.length) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (Number.isFinite(x0 + x1 + y0 + y1)) {
      if (x0 < b.minX) dx = b.minX - x0;
      else if (x1 > b.maxX) dx = b.maxX - x1;
      if (y0 < 0) dy = -y0;
      else if (y1 > b.maxY) dy = b.maxY - y1;
    }
  }
  const out: [number, number][] = [];
  for (const q of points) {
    const p = [q[0] + dx, q[1] + dy];
    // 画面内にクランプ（保存形式と同じ扱いにして、読み込み後も同じ形になるように）
    const x = Math.min(b.maxX, Math.max(b.minX, Math.round(p[0])));
    const y = Math.min(b.maxY, Math.max(0, Math.round(p[1])));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    out.push([x, y]);
  }
  if (closed && out.length > 1) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (f[0] === l[0] && f[1] === l[1]) out.pop();
  }
  if (out.length < (closed ? 3 : 2)) return null;
  return out;
}

export class Sim {
  /** 次に実行するステップ番号 */
  step = 0;
  bpm: number;
  pattern: number[];
  rotating = false;
  rotationSpeed = 0.3;
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
  /** ハーモニー区間の基準 */
  private harmonyAnchor = 0;
  private harmonyBase = 0;
  private sectionLen: number;
  private lastSection = -1;
  /** energy 用: 直近の衝突イベントのステップ（古い順） */
  private recentHits: number[] = [];
  /**
   * echo / rise のくり返し（D32）。group → 当たった音の写しと、次に出す回数・ステップ。
   * 1つの図形のくり返しは常に1列（また当たったら、その音から数え直す）。Map の挿入順で出すので決定論的
   */
  private repeats = new Map<number, { ev: HitEvent; k: number; step: number }>();
  private readonly history: Snapshot[] = [];
  private readonly hit: Hit = { t: 0, nx: 0, ny: 0 };
  private readonly near = { dist: 0, nx: 0, ny: 0 };

  constructor(opts: SimOptions) {
    this.bpm = opts.bpm;
    this.pattern = [...opts.pattern];
    if (opts.drift) this.setDrift(opts.drift.mode, opts.drift.amp);
    this.sectionLen = sectionSteps(opts.bpm, SECTION_BARS, HZ);
    for (let i = 0; i < HISTORY; i++) {
      this.history.push({
        step: -1,
        count: 0,
        ids: new Int32Array(MAX_BALLS + 1),
        xs: new Float32Array(MAX_BALLS + 1),
        ys: new Float32Array(MAX_BALLS + 1),
      });
    }
    this.setupEmitters(opts.bpm, opts.pattern, 0);
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

  /** ステップのハーモニー区間（0..3） */
  sectionAt(step: number): number {
    return sectionAt(step, this.harmonyAnchor, this.harmonyBase, this.sectionLen);
  }

  /** energy の窓（2 小節 = 区間の 1/4） */
  get energyWindow(): number {
    return Math.max(1, Math.round(this.sectionLen / 4));
  }

  /** 辺 id → 図形 id */
  groupOf(segmentId: number): number | undefined {
    return this.segments.find((s) => s.id === segmentId)?.group;
  }

  /** 時刻を進めずに、たまっている編集だけを今のステップで反映する（止めている間。D30） */
  applyPending(): void {
    this.applyCommands(this.step);
  }

  advance(): void {
    const s = this.step;
    this.applyCommands(s);
    this.updateSection(s);
    this.updatePoses(s);
    this.emit(s);
    this.integrate(s);
    this.flushRepeats(s);
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
          for (const sh of this.shapes.values()) {
            this.setShapeRotation(sh, s);
            this.pushPose(sh, s);
          }
          break;
        case 'setTempo':
          this.setTempo(s, cmd.bpm, cmd.pattern);
          break;
        case 'setDrift':
          this.setDrift(cmd.mode, cmd.amp);
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
    this.harmonyBase = this.sectionAt(s);
    this.harmonyAnchor = s;
    this.bpm = bpm;
    this.pattern = [...pattern];
    this.sectionLen = sectionSteps(bpm, SECTION_BARS, HZ);
    this.setupEmitters(bpm, pattern, s);
    // 残りのくり返しは新しい格子（s から始まる）に取り直す
    for (const r of this.repeats.values()) r.step = this.gridAtOrAfter(s, this.repeatBeats(r.ev));
  }

  /** 格子 harmonyAnchor + round(k·beats·HZ·60/bpm) のうち、c 以上で最初のステップ（放出の格子と同じ式） */
  gridAtOrAfter(c: number, beats: number): number {
    const a = this.harmonyAnchor;
    const p = (beats * HZ * 60) / this.bpm;
    let k = Math.max(0, Math.ceil((c - a) / p) - 1);
    while (a + Math.round(k * p) < c) k++;
    return a + Math.round(k * p);
  }

  private repeatBeats(ev: HitEvent): number {
    return this.shapes.get(ev.group)?.effect === 'rise' ? RISE_BEATS : ECHO_BEATS;
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
    this.harmonyBase = 0;
    this.harmonyAnchor = s;
    this.bpm = scene.bpm;
    this.pattern = [...scene.pattern];
    this.sectionLen = sectionSteps(scene.bpm, SECTION_BARS, HZ);
    this.setupEmitters(scene.bpm, scene.pattern, s);
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
    const n = points.length;
    // 推定は正規化後の点数で行う（保存するのも正規化後の点なので、読み込み後も同じ形になる）
    const form = formIn ?? inferForm(n, closed);
    const edges = closed ? n : n - 1;
    if (edges > MAX_SHAPE_EDGES || this.segments.length + edges > MAX_SEGS) return;

    // 周長と、辺の長さで重み付けした辺の中点の平均（重心）
    let perimeter = 0;
    let wx = 0;
    let wy = 0;
    for (let i = 0; i < edges; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % n]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      perimeter += len;
      wx += ((a[0] + b[0]) / 2) * len;
      wy += ((a[1] + b[1]) / 2) * len;
    }
    if (!(perimeter >= MIN_LINE_LEN)) return;
    const gx = wx / perimeter;
    const gy = wy / perimeter;
    let radius = 0;
    for (const p of points) radius = Math.max(radius, Math.hypot(p[0] - gx, p[1] - gy));

    const group = this.nextGroupId++;
    const note = lengthToNote(perimeter).index;
    const shape: Shape = {
      group, kind, form, effect, closed, points, gx, gy, radius, perimeter, note,
      dir: dir ?? (group % 2 === 0 ? 1 : -1),
      segs: [],
      theta0: 0,
      rotStartStep: s,
      omega: 0,
      lastEventStep: -Infinity,
    };
    for (let i = 0; i < edges; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[(i + 1) % n]!;
      const length = Math.hypot(bx - ax, by - ay);
      shape.segs.push({
        id: this.nextSegmentId++,
        group, kind,
        cx: (ax + bx) / 2,
        cy: (ay + by) / 2,
        halfLen: length / 2,
        gx, gy,
        rax: ax - gx, ray: ay - gy, rbx: bx - gx, rby: by - gy,
        theta0: Math.atan2(by - ay, bx - ax),
        rotStartStep: s,
        omega: 0,
        ax, ay, bx, by,
        length,
        note,
        addedStep: s,
        lastEventStep: -Infinity,
        dir: shape.dir,
      });
    }
    this.shapes.set(group, shape);
    this.segments.push(...shape.segs);

    const ev: ShapeAddedEvent = {
      kind: 'shapeAdded',
      step: s,
      group,
      segKind: kind,
      form,
      note,
      midi: formMidi(form, note, this.sectionAt(s)),
      closed,
      dir: shape.dir,
      effect,
      gx, gy,
      points: points.map(([x, y]) => [x - gx, y - gy] as [number, number]),
      // 描画は自分用のコピーを持つ（D9）ので、この時点の値を渡す
      segments: shape.segs.map((seg) => ({ ...seg })),
    };
    this.events.push(ev);
    this.setShapeRotation(shape, s);
    if (shape.omega !== 0) this.pushPose(shape, s);
  }

  /** 現在の回転角を基準角に焼き込んでから角速度を設定する（角度が連続するように） */
  private setShapeRotation(sh: Shape, s: number): void {
    const was = sh.omega;
    sh.theta0 = shapeAngle(sh, s);
    sh.rotStartStep = s;
    sh.omega = this.rotating ? sh.dir * Math.min(this.rotationSpeed, maxOmega(sh.radius)) : 0;
    for (const seg of sh.segs) {
      seg.theta0 = Math.atan2(seg.rby - seg.ray, seg.rbx - seg.rax) + sh.theta0;
      seg.rotStartStep = s;
      seg.omega = sh.omega;
    }
    // B1: 回転が止まっても姿勢を s の角度に揃える（止まっていた図形は整数座標のまま触らない）
    if (was !== 0) this.updateShapePose(sh, s);
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

  private setupEmitters(bpm: number, pattern: readonly number[], s: number): void {
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
        periodSteps: periodSteps(beats, bpm),
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
    this.events.push({ kind: 'section', step: s, section: sec });
  }

  private updateShapePose(sh: Shape, s: number): void {
    const phi = shapeAngle(sh, s);
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    for (const seg of sh.segs) {
      seg.ax = sh.gx + c * seg.rax - sn * seg.ray;
      seg.ay = sh.gy + sn * seg.rax + c * seg.ray;
      seg.bx = sh.gx + c * seg.rbx - sn * seg.rby;
      seg.by = sh.gy + sn * seg.rbx + c * seg.rby;
      seg.cx = (seg.ax + seg.bx) / 2;
      seg.cy = (seg.ay + seg.by) / 2;
    }
  }

  private updatePoses(s: number): void {
    for (const sh of this.shapes.values()) {
      if (sh.omega !== 0) this.updateShapePose(sh, s);
    }
  }

  private emit(s: number): void {
    for (const em of this.emitters) {
      // k 回目の放出は anchor + round(k·beats·7200/BPM)。周期を整数に丸めて足し合わせると、
      // 7200 を割り切れない BPM で誤差がたまり、録音が DAW のグリッドからずれるため（D10）
      const at = em.anchorStep + Math.round((em.nextK * em.beats * HZ * 60) / this.bpm);
      if (at !== s) continue;
      em.x = this.baseXs[em.id]! + driftOffset(this.driftMode, this.driftAmp, em.id, em.nextK);
      em.nextK++;
      const ball: Ball = {
        id: this.nextBallId++,
        emitterId: em.id,
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
      midi: formMidi(sh.form, sh.note, section),
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

  /**
   * 当たった音へのエフェクト（D32）。chord は同じステップに重ねる音を出す。echo / rise はくり返しを予約する:
   * 最初は格子の半分以上あけた次の格子（当たった音とくっつかないように）。同じ図形の残りは捨てて数え直す
   */
  private applyEffect(s: number, sh: Shape, ev: HitEvent): void {
    if (sh.effect === 'chord') {
      chordSlots(sh.form, sh.note).forEach((note, i) => {
        this.events.push({
          ...ev, voice: i + 1, note, midi: formMidi(sh.form, note, ev.section), velocity: ev.velocity * CHORD_GAIN,
        });
      });
    } else if (sh.effect === 'echo' || sh.effect === 'rise') {
      const beats = sh.effect === 'rise' ? RISE_BEATS : ECHO_BEATS;
      const gap = Math.ceil((beats * HZ * 60) / this.bpm / 2);
      this.repeats.delete(sh.group);
      this.repeats.set(sh.group, { ev: { ...ev }, k: 1, step: this.gridAtOrAfter(s + gap, beats) });
    }
  }

  /**
   * 時刻の来たくり返しを出す（D32）。区間と音高は鳴らすステップで決め直す。
   * 出すイベントの step はすべて s（drainEvents の順序は崩れない）。chain・energy には数えない
   */
  private flushRepeats(s: number): void {
    if (this.repeats.size === 0) return;
    for (const [group, r] of this.repeats) {
      if (r.step > s) continue;
      const sh = this.shapes.get(group);
      const rise = sh?.effect === 'rise';
      const note = rise ? riseSlot(r.ev.form, r.ev.note, r.k) : r.ev.note;
      if (!sh || note < 0) {
        this.repeats.delete(group);
        continue;
      }
      const section = this.sectionAt(s);
      this.events.push({
        ...r.ev, step: s, echo: r.k, note, section, midi: formMidi(r.ev.form, note, section),
        velocity: r.ev.velocity * Math.pow(rise ? RISE_DECAY : ECHO_DECAY, r.k),
      });
      r.k++;
      if (r.k > (rise ? RISE_COUNT : ECHO_COUNT)) this.repeats.delete(group);
      else r.step = this.gridAtOrAfter(s + 1, rise ? RISE_BEATS : ECHO_BEATS);
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
