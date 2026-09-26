import { closestOnSegment, rayCapsule, type Hit } from './collide';
import {
  BALL_LINE_COOLDOWN, DRIFT_AMP_DEFAULT, DRIFT_AMP_MAX, DRIFT_PERIOD, DT, G, HISTORY, HIT_RADIUS, HZ,
  LINE_COOLDOWN, MAX_AGE_STEPS, MAX_BALLS, MIN_LINE_LEN, PHRASE_LEN, REST_VN, RESTITUTION, SECTION_BARS,
  STALL_SPEED, STALL_STEPS, TANGENT_KEEP, V_MIN, WORLD_H, WORLD_W, impactVelocity, maxOmega,
} from './constants';
import { lengthToNote, midiAt, sectionAt, sectionSteps } from './music';
import type { Ball, Command, DriftMode, Emitter, SceneData, Segment, SimEvent, Snapshot } from './types';

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

/** ステップ（小数可）における線分の角度。描画側からも使う */
export function segmentAngle(seg: Pick<Segment, 'theta0' | 'omega' | 'rotStartStep'>, step: number): number {
  return seg.theta0 + (seg.omega * (step - seg.rotStartStep)) / HZ;
}

export function periodSteps(beats: number, bpm: number): number {
  return Math.max(1, Math.round((beats * HZ * 60) / bpm));
}

/**
 * 衝突をイベント化するか（D4）。境界: impact ≥ V_MIN、同じボール×線は BALL_LINE_COOLDOWN ステップ以上、
 * 同じ線は LINE_COOLDOWN ステップ以上あいていること。
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
    const ph = (k + emitterId * (P / 4)) % P; // 0..P-1
    const q = 4 * ph; // 0..4P-4
    const tri = q < P ? q : q < 3 * P ? 2 * P - q : q - 4 * P; // [-P, P]
    return Math.round((amp * tri) / P);
  }
  const OFF = [0, 2, -2, 1]; // ×amp/2
  const idx = (Math.floor(k / PHRASE_LEN) + emitterId) % OFF.length;
  return Math.round((amp * OFF[idx]!) / 2);
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

  readonly segments: Segment[] = [];
  readonly balls: Ball[] = [];
  readonly emitters: Emitter[] = [];

  private queue: Command[] = [];
  private events: SimEvent[] = [];
  private nextSegmentId = 1;
  private nextBallId = 1;
  /** 線を引いたときの座標（整数 px）。保存用 */
  private readonly origin = new Map<number, [number, number, number, number]>();
  /** 放出口の基準 x（揺らぎの中心） */
  private baseXs: number[] = [];
  /** ハーモニー区間の基準 */
  private harmonyAnchor = 0;
  private harmonyBase = 0;
  private sectionLen: number;
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

  /** 線を引いたときの座標（整数 px）。保存用 */
  segmentOrigin(id: number): readonly [number, number, number, number] | undefined {
    return this.origin.get(id);
  }

  advance(): void {
    const s = this.step;
    this.applyCommands(s);
    this.updatePoses(s);
    this.emit(s);
    this.integrate(s);
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
          this.addSegment(s, cmd.ax, cmd.ay, cmd.bx, cmd.by, cmd.dir);
          break;
        case 'removeSegment': {
          const i = this.segments.findIndex((seg) => seg.id === cmd.id);
          if (i >= 0) {
            this.segments.splice(i, 1);
            this.origin.delete(cmd.id);
            this.events.push({ kind: 'segmentRemoved', step: s, segmentId: cmd.id });
          }
          break;
        }
        case 'clearSegments':
          this.clearSegments(s);
          break;
        case 'setRotation':
          this.rotating = cmd.on;
          this.rotationSpeed = cmd.speed;
          for (const seg of this.segments) {
            this.setSegmentRotation(seg, s);
            this.pushPose(seg, s);
          }
          break;
        case 'setTempo':
          this.setTempo(s, cmd.bpm, cmd.pattern);
          break;
        case 'setDrift':
          this.setDrift(cmd.mode, cmd.amp);
          break;
        case 'loadScene':
          this.loadScene(s, cmd.scene);
          break;
      }
    }
  }

  private clearSegments(s: number): void {
    for (const seg of this.segments) {
      this.events.push({ kind: 'segmentRemoved', step: s, segmentId: seg.id });
    }
    this.segments.length = 0;
    this.origin.clear();
  }

  private setTempo(s: number, bpm: number, pattern: readonly number[]): void {
    // 進行は途切れさせない: 今の区間から新しい長さで数え直す
    this.harmonyBase = this.sectionAt(s);
    this.harmonyAnchor = s;
    this.bpm = bpm;
    this.pattern = [...pattern];
    this.sectionLen = sectionSteps(bpm, SECTION_BARS, HZ);
    this.setupEmitters(bpm, pattern, s);
  }

  private setDrift(mode: DriftMode, amp: number): void {
    this.driftMode = mode;
    this.driftAmp = Math.min(DRIFT_AMP_MAX, Math.max(0, Math.round(amp)));
  }

  /** 配置の読み込み。ボールも消し、放出・回転・ハーモニーの基準を s に取り直す（読み込み後は毎回同じ曲になる） */
  private loadScene(s: number, scene: SceneData): void {
    this.clearSegments(s);
    this.balls.length = 0;
    this.rotating = scene.rotate;
    this.rotationSpeed = scene.rotationSpeed;
    this.setDrift(scene.drift.mode, scene.drift.amp);
    this.harmonyBase = 0;
    this.harmonyAnchor = s;
    this.bpm = scene.bpm;
    this.pattern = [...scene.pattern];
    this.sectionLen = sectionSteps(scene.bpm, SECTION_BARS, HZ);
    this.setupEmitters(scene.bpm, scene.pattern, s);
    for (const [ax, ay, bx, by, dir] of scene.segs) this.addSegment(s, ax, ay, bx, by, dir);
  }

  private addSegment(s: number, ax0: number, ay0: number, bx0: number, by0: number, dir?: 1 | -1): void {
    // 座標は整数 px に丸める（ライブと読み込み後で同じ状態にするため）
    // 画面外は論理ワールド内にクランプする（scene の読み込み時と同じ扱い）
    const ax = Math.min(WORLD_W, Math.max(0, Math.round(ax0)));
    const ay = Math.min(WORLD_H, Math.max(0, Math.round(ay0)));
    const bx = Math.min(WORLD_W, Math.max(0, Math.round(bx0)));
    const by = Math.min(WORLD_H, Math.max(0, Math.round(by0)));
    const length = Math.hypot(bx - ax, by - ay);
    if (!(length >= MIN_LINE_LEN)) return;
    const id = this.nextSegmentId++;
    const seg: Segment = {
      id,
      cx: (ax + bx) / 2,
      cy: (ay + by) / 2,
      halfLen: length / 2,
      theta0: Math.atan2(by - ay, bx - ax),
      rotStartStep: s,
      omega: 0,
      ax, ay, bx, by,
      length,
      note: lengthToNote(length).index,
      addedStep: s,
      lastEventStep: -Infinity,
      dir: dir ?? (id % 2 === 0 ? 1 : -1),
    };
    this.setSegmentRotation(seg, s);
    this.segments.push(seg);
    this.origin.set(id, [ax, ay, bx, by]);
    // 描画は自分用のコピーを持つ（D9）ので、この時点の値を渡す
    this.events.push({ kind: 'segmentAdded', step: s, segment: { ...seg } });
  }

  /** 現在角を基準角に焼き込んでから角速度を設定する（角度が連続するように） */
  private setSegmentRotation(seg: Segment, s: number): void {
    const was = seg.omega;
    seg.theta0 = segmentAngle(seg, s);
    seg.rotStartStep = s;
    seg.omega = this.rotating ? seg.dir * Math.min(this.rotationSpeed, maxOmega(seg.halfLen)) : 0;
    // B1: 回転が止まっても姿勢を s の角度に揃える（止まっていた線は整数座標のまま触らない）
    if (was !== 0) this.updatePose(seg, s);
  }

  private pushPose(seg: Segment, s: number): void {
    this.events.push({
      kind: 'segmentPose',
      step: s,
      segmentId: seg.id,
      theta0: seg.theta0,
      rotStartStep: seg.rotStartStep,
      omega: seg.omega,
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

  private updatePose(seg: Segment, s: number): void {
    const th = segmentAngle(seg, s);
    const c = Math.cos(th) * seg.halfLen;
    const sn = Math.sin(th) * seg.halfLen;
    seg.ax = seg.cx - c;
    seg.ay = seg.cy - sn;
    seg.bx = seg.cx + c;
    seg.by = seg.cy + sn;
  }

  private updatePoses(s: number): void {
    for (const seg of this.segments) {
      if (seg.omega !== 0) this.updatePose(seg, s);
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

  /** 反射したら true。線に対して相対的に離れていく場合は何もせず false */
  private bounce(s: number, b: Ball, seg: Segment, nx: number, ny: number): boolean {
    // 回転する線分の表面速度
    const svx = -seg.omega * (b.y - seg.cy);
    const svy = seg.omega * (b.x - seg.cx);
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
      b.vx = tx * TANGENT_KEEP - RESTITUTION * vn * nx + svx;
      b.vy = ty * TANGENT_KEEP - RESTITUTION * vn * ny + svy;
    }

    const last = b.lastHit.get(seg.id);
    b.lastHit.set(seg.id, s);
    if (!hitAllowed(s, impact, last, seg.lastEventStep)) return true;
    seg.lastEventStep = s;
    const section = this.sectionAt(s);
    this.events.push({
      kind: 'hit',
      step: s,
      ballId: b.id,
      lineId: seg.id,
      x: b.x,
      y: b.y,
      normalSpeed: impact,
      velocity: impactVelocity(impact),
      note: seg.note,
      midi: midiAt(seg.note, section),
      section,
    });
    return true;
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
      const out = b.y > WORLD_H + margin || b.x < -margin || b.x > WORLD_W + margin;
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
