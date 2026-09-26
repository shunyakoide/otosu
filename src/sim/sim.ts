import { closestOnSegment, rayCapsule, type Hit } from './collide';
import {
  BALL_LINE_COOLDOWN, DT, G, HISTORY, HIT_RADIUS, HZ, LINE_COOLDOWN, MAX_AGE_STEPS, MAX_BALLS,
  MIN_LINE_LEN, REST_VN, RESTITUTION, STALL_SPEED, STALL_STEPS, TANGENT_KEEP, V_MIN, WORLD_H, WORLD_W,
  impactVelocity, maxOmega,
} from './constants';
import { lengthToNote } from './music';
import type { Ball, Command, Emitter, Segment, SimEvent, Snapshot } from './types';

const MAX_BOUNCES_PER_STEP = 4;
const PUSH_OUT = 0.01;

export type SimOptions = {
  bpm: number;
  /** 放出口ごとの放出間隔（拍）。例 [2, 3] */
  pattern: readonly number[];
};

/** ステップ（小数可）における線分の角度。描画側からも使う */
export function segmentAngle(seg: Segment, step: number): number {
  return seg.theta0 + (seg.omega * (step - seg.rotStartStep)) / HZ;
}

export function periodSteps(beats: number, bpm: number): number {
  return Math.max(1, Math.round((beats * HZ * 60) / bpm));
}

export class Sim {
  /** 次に実行するステップ番号 */
  step = 0;
  bpm: number;
  rotating = false;
  rotationSpeed = 0.3;

  readonly segments: Segment[] = [];
  readonly balls: Ball[] = [];
  readonly emitters: Emitter[] = [];

  private queue: Command[] = [];
  private events: SimEvent[] = [];
  private nextSegmentId = 1;
  private nextBallId = 1;
  private readonly history: Snapshot[] = [];
  private readonly hit: Hit = { t: 0, nx: 0, ny: 0 };
  private readonly near = { dist: 0, nx: 0, ny: 0 };

  constructor(opts: SimOptions) {
    this.bpm = opts.bpm;
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
          this.addSegment(s, cmd.ax, cmd.ay, cmd.bx, cmd.by);
          break;
        case 'removeSegment': {
          const i = this.segments.findIndex((seg) => seg.id === cmd.id);
          if (i >= 0) {
            this.segments.splice(i, 1);
            this.events.push({ kind: 'segmentRemoved', step: s, segmentId: cmd.id });
          }
          break;
        }
        case 'clearSegments':
          for (const seg of this.segments) {
            this.events.push({ kind: 'segmentRemoved', step: s, segmentId: seg.id });
          }
          this.segments.length = 0;
          break;
        case 'setRotation':
          this.rotating = cmd.on;
          this.rotationSpeed = cmd.speed;
          for (const seg of this.segments) this.setSegmentRotation(seg, s);
          break;
        case 'setTempo':
          this.bpm = cmd.bpm;
          this.setupEmitters(cmd.bpm, cmd.pattern, s);
          break;
      }
    }
  }

  private addSegment(s: number, ax: number, ay: number, bx: number, by: number): void {
    const length = Math.hypot(bx - ax, by - ay);
    if (length < MIN_LINE_LEN) return;
    const seg: Segment = {
      id: this.nextSegmentId++,
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
    };
    this.setSegmentRotation(seg, s);
    this.segments.push(seg);
    this.events.push({ kind: 'segmentAdded', step: s, segment: seg });
  }

  /** 現在角を基準角に焼き込んでから角速度を設定する（角度が連続するように） */
  private setSegmentRotation(seg: Segment, s: number): void {
    seg.theta0 = segmentAngle(seg, s);
    seg.rotStartStep = s;
    if (!this.rotating) {
      seg.omega = 0;
      return;
    }
    const dir = seg.id % 2 === 0 ? 1 : -1;
    seg.omega = dir * Math.min(this.rotationSpeed, maxOmega(seg.halfLen));
  }

  private setupEmitters(bpm: number, pattern: readonly number[], s: number): void {
    this.emitters.length = 0;
    const n = pattern.length;
    pattern.forEach((beats, i) => {
      this.emitters.push({
        id: i,
        x: WORLD_W * (0.5 + (i - (n - 1) / 2) * 0.16),
        y: 40,
        beats,
        periodSteps: periodSteps(beats, bpm),
        anchorStep: s,
        nextK: 0,
      });
    });
  }

  // ---- 1ステップの処理 ----

  private updatePoses(s: number): void {
    for (const seg of this.segments) {
      if (seg.omega === 0) continue;
      const th = segmentAngle(seg, s);
      const c = Math.cos(th) * seg.halfLen;
      const sn = Math.sin(th) * seg.halfLen;
      seg.ax = seg.cx - c;
      seg.ay = seg.cy - sn;
      seg.bx = seg.cx + c;
      seg.by = seg.cy + sn;
    }
  }

  private emit(s: number): void {
    for (const em of this.emitters) {
      if (em.anchorStep + em.nextK * em.periodSteps !== s) continue;
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
      this.events.push({ kind: 'emit', step: s, emitterId: em.id, ballId: ball.id });
    }
  }

  private integrate(s: number): void {
    const R = HIT_RADIUS;
    const hit = this.hit;
    for (const b of this.balls) {
      b.vy += G * DT;
      let remaining = 1;

      for (let iter = 0; iter < MAX_BOUNCES_PER_STEP; iter++) {
        const dx = b.vx * DT * remaining;
        const dy = b.vy * DT * remaining;
        let best: Segment | undefined;
        let bt = Infinity;
        let bnx = 0;
        let bny = 0;
        for (const seg of this.segments) {
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
        this.bounce(s, b, best, bnx, bny);
        remaining *= 1 - bt;
        if (remaining <= 1e-6) break;
      }

      this.resolveOverlap(b);

      const speed = Math.hypot(b.vx, b.vy);
      b.slowSteps = speed < STALL_SPEED ? b.slowSteps + 1 : 0;
    }
  }

  private bounce(s: number, b: Ball, seg: Segment, nx: number, ny: number): void {
    // 回転する線分の表面速度
    const svx = -seg.omega * (b.y - seg.cy);
    const svy = seg.omega * (b.x - seg.cx);
    const rvx = b.vx - svx;
    const rvy = b.vy - svy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;
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
    if (impact < V_MIN) return;
    if (last !== undefined && s - last < BALL_LINE_COOLDOWN) return;
    if (s - seg.lastEventStep < LINE_COOLDOWN) return;
    seg.lastEventStep = s;
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
    });
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
