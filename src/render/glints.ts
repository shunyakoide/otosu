import { CircleGeometry, Color } from 'three';
import { HZ } from '../sim/constants';
import { hash01 } from './hash';
import { commit, instanced, putDisc } from './instancing';
import { noteColor, OFF_WHITE, type ColorMode } from './palette';
import { pointAt, shapeAngle, type Point, type Shape } from './shape';

// triangle（金属）のきらめき（D16）: 辺に沿って細かいきらめきが散り、瞬きながら長く残る。

const MAX_GLINTS = 768;
/** 1回の衝突のきらめきの数 = GLINT_BASE + GLINT_PER_V·v */
const GLINT_BASE = 10;
const GLINT_PER_V = 14;
/** 半分は打点のまわり（周長 × ±GLINT_SPREAD）、残りは周全体に */
const GLINT_SPREAD = 0.12;
/** 出てくるまでの遅れ（最大、秒）: 散らばって順に灯る */
const GLINT_STAGGER = 0.9;
const GLINT_TAU_MIN = 1.2;
const GLINT_TAU_MAX = 2.8;
/** 1粒の明るさの上限（小さい点なのでブルームで大きく滲まない程度） */
const GLINT_GAIN = 1.0;
/** 辺からの法線方向のずれ（±px） */
const GLINT_JITTER = 2.5;

export class Glints {
  readonly mesh = instanced(new CircleGeometry(1, 8), MAX_GLINTS, 3);
  // きらめきのリングバッファ。step = Infinity は空き
  private readonly group = new Int32Array(MAX_GLINTS);
  private readonly step = new Float64Array(MAX_GLINTS).fill(Infinity);
  private readonly arc = new Float32Array(MAX_GLINTS);
  private readonly delay = new Float32Array(MAX_GLINTS);
  private readonly tau = new Float32Array(MAX_GLINTS);
  private readonly freq = new Float32Array(MAX_GLINTS);
  private readonly phase = new Float32Array(MAX_GLINTS);
  private readonly size = new Float32Array(MAX_GLINTS);
  private readonly off = new Float32Array(MAX_GLINTS);
  private readonly gain = new Float32Array(MAX_GLINTS);
  private head = 0;
  private readonly pt: Point = { x: 0, y: 0, nx: 0, ny: 0 };
  private readonly color = new Color();

  /** きらめきを辺に散らす。位置・遅れ・瞬きはステップと図形からのハッシュで決まる */
  spawn(s: Shape, step: number, v: number, arc: number): void {
    if (s.perimeter <= 0) return;
    const cnt = GLINT_BASE + Math.round(GLINT_PER_V * v);
    for (let k = 0; k < cnt; k++) {
      const i = this.head;
      this.head = (this.head + 1) % MAX_GLINTS;
      const b = k * 8;
      const near = (k & 1) === 0;
      let a = near
        ? arc + (hash01(step, s.group, b) - 0.5) * 2 * GLINT_SPREAD * s.perimeter
        : hash01(step, s.group, b) * s.perimeter;
      a %= s.perimeter;
      if (a < 0) a += s.perimeter;
      this.group[i] = s.group;
      this.step[i] = step;
      this.arc[i] = a;
      this.delay[i] = hash01(step, s.group, b + 1) * GLINT_STAGGER * (near ? 0.3 : 1);
      this.tau[i] = GLINT_TAU_MIN + hash01(step, s.group, b + 2) * (GLINT_TAU_MAX - GLINT_TAU_MIN);
      this.freq[i] = 2 + 7 * hash01(step, s.group, b + 3);
      this.phase[i] = 2 * Math.PI * hash01(step, s.group, b + 4);
      this.size[i] = 0.9 + 1.1 * hash01(step, s.group, b + 5);
      this.off[i] = (hash01(step, s.group, b + 6) - 0.5) * 2 * GLINT_JITTER;
      this.gain[i] = GLINT_GAIN * (0.5 + 0.5 * v) * (0.6 + 0.4 * hash01(step, s.group, b + 7));
    }
  }

  /** 辺の上の小さな点が瞬きながら長く残る。図形が消えたきらめきは消す */
  draw(rs: number, shapes: ReadonlyMap<number, Shape>, mode: ColorMode): void {
    const c = this.color;
    const pt = this.pt;
    let n = 0;
    for (let i = 0; i < MAX_GLINTS; i++) {
      const t = (rs - this.step[i]!) / HZ - this.delay[i]!;
      if (!(t >= 0)) continue;
      const tau = this.tau[i]!;
      const s = shapes.get(this.group[i]!);
      if (!s || t > 3 * tau) {
        this.step[i] = Infinity;
        continue;
      }
      let tw = 0.5 + 0.5 * Math.sin(2 * Math.PI * this.freq[i]! * t + this.phase[i]!);
      tw *= tw;
      tw *= tw;
      const env = (1 - Math.exp(-t / 0.02)) * Math.exp(-t / tau);
      const intensity = this.gain[i]! * env * (0.2 + 0.8 * tw);
      if (intensity < 0.01) continue;
      pointAt(s, shapeAngle(s, rs), this.arc[i]!, pt);
      const off = this.off[i]!;
      const r = this.size[i]! * (0.7 + 0.3 * tw);
      putDisc(this.mesh, n, pt.x + pt.nx * off, pt.y + pt.ny * off, r,
        c.copy(noteColor(s.note, mode)).lerp(OFF_WHITE, 0.6).multiplyScalar(intensity));
      n++;
    }
    commit(this.mesh, n);
  }
}
