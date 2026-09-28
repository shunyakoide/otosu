import { Color, RingGeometry } from 'three';
import { HZ } from '../sim/constants';
import { commit, instanced, putDisc } from './instancing';
import { noteColor, type ColorMode } from './palette';

// 波紋（D16）: 衝突・確定音で広がる淡い輪。円の輪と、図形と同じ形の三角・四角の輪。

const MAX_RIPPLES = 64;

/**
 * 波紋: 半径 r0 から grow だけ dur 秒で広がる。明るさ gain·(1−p)²。
 * sides = 3 / 4 なら図形と同じ三角・四角の輪郭で、angle（頂点の向き、画面の y 下向きのまま）から spin だけ回りながら広がる
 */
export type Ripple = { x: number; y: number; step: number; note: number; r0: number; grow: number; dur: number; gain: number; sides?: 3 | 4; angle?: number; spin?: number };

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

export class Ripples {
  readonly circles = instanced(new RingGeometry(0.93, 1, 48), MAX_RIPPLES, 1);
  // 三角・四角の輪。辺の太さが円の輪（半径の 7%）と同じになるよう、内側の半径を cos(π/n) で割って決める
  readonly triangles = instanced(new RingGeometry(1 - 0.07 / Math.cos(Math.PI / 3), 1, 3), MAX_RIPPLES, 1);
  readonly squares = instanced(new RingGeometry(1 - 0.07 / Math.cos(Math.PI / 4), 1, 4), MAX_RIPPLES, 1);
  private readonly buf: Ripple[] = [];
  private head = 0;
  private readonly cnt = [0, 0, 0];
  private readonly color = new Color();

  push(r: Ripple): void {
    if (this.buf.length < MAX_RIPPLES) this.buf.push(r);
    else this.buf[this.head] = r;
    this.head = (this.head + 1) % MAX_RIPPLES;
  }

  draw(rs: number, mode: ColorMode): void {
    const c = this.color;
    const cnt = this.cnt;
    cnt[0] = cnt[1] = cnt[2] = 0;
    for (const r of this.buf) {
      const p = (rs - r.step) / HZ / r.dur;
      if (p < 0 || p >= 1) continue;
      const e = easeOutCubic(p);
      const radius = r.r0 + r.grow * e;
      const k = r.sides === 3 ? 1 : r.sides === 4 ? 2 : 0;
      const mesh = k === 1 ? this.triangles : k === 2 ? this.squares : this.circles;
      // 描く座標は y が上向きなので、向きは逆にする
      putDisc(mesh, cnt[k]!, r.x, r.y, radius, c.copy(noteColor(r.note, mode)).multiplyScalar(r.gain * (1 - p) ** 2),
        -((r.angle ?? 0) + (r.spin ?? 0) * e));
      cnt[k]!++;
    }
    commit(this.circles, cnt[0]!);
    commit(this.triangles, cnt[1]!);
    commit(this.squares, cnt[2]!);
  }
}
