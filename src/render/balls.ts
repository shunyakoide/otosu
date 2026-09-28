import { CircleGeometry, Color, PlaneGeometry } from 'three';
import { BALL_RADIUS, HZ, MAX_BALLS } from '../sim/constants';
import type { Snapshot } from '../sim/types';
import { commit, instanced, maxBlend, putDisc, putQuad } from './instancing';
import { noteColor, OFF_WHITE, type ColorMode } from './palette';

// ボールと尾。位置は sim のスナップショット（ボール位置の履歴）だけから描く。

/** ボール位置の履歴だけを使う（sim の他の状態は見ない） */
export type SnapshotSource = { snapshot(step: number): Snapshot | undefined };

/** 最後に当たったときの見た目（色・光り方・連鎖） */
export type BallLook = { note: number; step: number; v: number; chain: number };

// 尾（step2 案1）＋ 連鎖の光（D15）
const TRAIL_STEPS = 30;
const TRAIL_STRIDE = 2;
const CHAIN_EXTRA_STEPS = 12;
const CHAIN_EXTRA_MAX = 4;
const TRAIL_QUADS_MAX = (TRAIL_STEPS + CHAIN_EXTRA_STEPS * CHAIN_EXTRA_MAX) / TRAIL_STRIDE;
const CHAIN_FADE_SEC = 1.0;
/** 尾の1クアッドの明るさの上限（重なりの加算でブルームが滲まないように） */
const TRAIL_CAP = 0.9;
/** これより短い区間はクアッドにしない（px） */
const TRAIL_MIN_LEN = 4;

export class Balls {
  readonly balls = instanced(new CircleGeometry(1, 20), MAX_BALLS + 1, 3);
  // 尾は MAX 合成: クアッドの重なりが加算されて白飛び・ブルームの大きな滲みにならないように
  readonly trails = instanced(new PlaneGeometry(1, 1), (MAX_BALLS + 1) * TRAIL_QUADS_MAX, 2, maxBlend());
  /** ボールごとの最後の当たり（onHit が書く） */
  readonly look = new Map<number, BallLook>();

  // 毎フレーム new しないための作業領域
  private readonly trailSnaps: (Snapshot | undefined)[] = new Array(TRAIL_QUADS_MAX + 1);
  private readonly trailPtr = new Int32Array(TRAIL_QUADS_MAX + 1);
  private readonly color = new Color();

  /** thick = ボールを太く描く倍率（D26）。trail = 尾を描くか（'afterimage' では描かない） */
  draw(src: SnapshotSource, rs: number, thick: number, mode: ColorMode, trail: boolean): void {
    this.drawBalls(src, rs, thick, mode);
    if (trail) this.drawTrails(src, rs, thick, mode);
    else commit(this.trails, 0);
  }

  /** ステップ s 時点のボールの強度（衝突直後に明るく、指数で減衰） */
  private intensity(look: BallLook | undefined, s: number): number {
    if (!look || s < look.step) return 0.55;
    const t = (s - look.step) / HZ;
    return 0.55 + (1.0 + 1.5 * look.v) * Math.exp(-t / 0.09);
  }

  private colorOf(look: BallLook | undefined, mode: ColorMode): Color {
    return look ? noteColor(look.note, mode) : OFF_WHITE;
  }

  private drawBalls(src: SnapshotSource, rs: number, thick: number, mode: ColorMode): void {
    const s0 = Math.floor(rs);
    const a = rs - s0;
    const A = src.snapshot(s0);
    const B = src.snapshot(s0 + 1);
    const mesh = this.balls;
    const c = this.color;
    let n = 0;
    if (A) {
      let j = 0;
      for (let i = 0; i < A.count; i++) {
        const id = A.ids[i]!;
        let x = A.xs[i]!;
        let y = A.ys[i]!;
        if (B) {
          while (j < B.count && B.ids[j]! < id) j++;
          if (j < B.count && B.ids[j] === id) {
            x += (B.xs[j]! - x) * a;
            y += (B.ys[j]! - y) * a;
          }
        }
        const look = this.look.get(id);
        let scale = BALL_RADIUS * thick;
        if (look && rs >= look.step) scale *= 1 + 0.35 * Math.exp(-(rs - look.step) / HZ / 0.06);
        putDisc(mesh, n, x, y, scale, c.copy(this.colorOf(look, mode)).multiplyScalar(this.intensity(look, rs)));
        n++;
      }
    }
    commit(mesh, n);
  }

  /**
   * 尾: 直近のステップの位置を TRAIL_STRIDE おきに取り、クアッドでつなぐ（step2 案1）。
   * 連鎖 chain ≥ 3 のボールは尾を長く明るくし、最後の衝突から約 1s で元に戻す（D15）。
   */
  private drawTrails(src: SnapshotSource, rs: number, thick: number, mode: ColorMode): void {
    const s0 = Math.floor(rs);
    const a = rs - s0;
    const A = src.snapshot(s0);
    const B = src.snapshot(s0 + 1);
    const snaps = this.trailSnaps;
    const ptr = this.trailPtr;
    for (let q = 1; q <= TRAIL_QUADS_MAX; q++) {
      snaps[q] = src.snapshot(s0 - q * TRAIL_STRIDE);
      ptr[q] = 0;
    }
    const mesh = this.trails;
    const c = this.color;
    let n = 0;
    if (A) {
      let jb = 0;
      for (let i = 0; i < A.count; i++) {
        const id = A.ids[i]!;
        let px = A.xs[i]!;
        let py = A.ys[i]!;
        if (B) {
          while (jb < B.count && B.ids[jb]! < id) jb++;
          if (jb < B.count && B.ids[jb] === id) {
            px += (B.xs[jb]! - px) * a;
            py += (B.ys[jb]! - py) * a;
          }
        }
        const look = this.look.get(id);
        const base = this.colorOf(look, mode);
        let extra = 0;
        if (look && look.chain >= 3 && rs >= look.step) {
          extra = Math.min(look.chain - 2, CHAIN_EXTRA_MAX) * Math.exp(-(rs - look.step) / HZ / CHAIN_FADE_SEC);
        }
        const steps = TRAIL_STEPS + CHAIN_EXTRA_STEPS * extra;
        const quads = Math.min(TRAIL_QUADS_MAX, Math.ceil(steps / TRAIL_STRIDE));
        const gain = 0.6 * (1 + 0.25 * extra);
        const cap = TRAIL_CAP * (1 + 0.1 * extra);
        for (let q = 1; q <= quads; q++) {
          const S = snaps[q];
          if (!S) break;
          let j = ptr[q]!;
          while (j < S.count && S.ids[j]! < id) j++;
          ptr[q] = j;
          if (j >= S.count || S.ids[j] !== id) break; // この時点ではまだ生まれていない
          const qx = S.xs[j]!;
          const qy = S.ys[j]!;
          // ゆっくり動く・小刻みに跳ねるボールでは点が重なり、加算で白飛びする。短い区間は次の点とまとめる
          if (Math.abs(qx - px) + Math.abs(qy - py) < TRAIL_MIN_LEN) continue;
          const km = (q - 0.5) * TRAIL_STRIDE; // クアッド中点の「何ステップ前か」
          const f = Math.min(1, km / steps);
          // 尾のクアッドはボールや隣と重なって加算されるので、上限を設けてブルームの大きな滲みを防ぐ
          const intensity = Math.min(this.intensity(look, s0 - km) * gain, cap) * Math.pow(1 - f, 1.5);
          const width = 2 * BALL_RADIUS * thick * (0.8 - 0.6 * f);
          c.copy(base).multiplyScalar(intensity);
          putQuad(mesh, n++, px, py, qx, qy, width, c);
          px = qx;
          py = qy;
        }
      }
    }
    commit(mesh, n);
  }
}
