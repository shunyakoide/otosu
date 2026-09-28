import { Group, type Camera, type Color, type Object3D, type WebGLRenderer } from 'three';
import { HZ, type Bounds } from '../sim/constants';
import { Ascii } from './ascii';
import { Bitmap } from './bitmap';
import { Caustics } from './caustics';
import { Fibers } from './fibers';
import { Grain } from './grain';
import { Particles } from './particles';
import { Slices } from './slices';

// 背景（D33）。種類を切り替えられる。どれも音（当たった点）に反応する。
//   caustics  = 光線の格子を曲げた光の膜
//   particles = ノイズの流れに乗る粒子の軌跡（D34）
//   grain     = 散らばった粒が、音の近くで寄り集まって形になる（D35）
//   bitmap    = 升目に並んだ四角い点の大きさで、濃淡を見せる網点（D38）
//   ascii     = 升目に並んだ文字の濃さで濃淡を見せ、当たると輪の上の文字が入れ替わる（D39）
//   fibers    = 立方体の中の curl noise の流線を細い筒で描く（D42）
//   slices    = 重ねた板に、手前ほど新しい雲を映す時間のスライス（D42）
// 切り替えるときは、いったん暗くしてから次へ。時刻は renderStep から取るので、止めると背景も止まる。
// 種類ごとの中身（頂点・描き込み先）は選んだときに作り、外したら捨てる（使わない背景でメモリを取らない。D40）。

export const BACKDROPS = ['none', 'caustics', 'particles', 'grain', 'bitmap', 'ascii', 'fibers', 'slices'] as const;
export type BackdropKind = (typeof BACKDROPS)[number];

/** 切り替えのフェード（秒） */
const FADE_SEC = 0.6;

/** 1フレームぶんの情報 */
export type LayerFrame = {
  renderer: WebGLRenderer;
  camera: Camera;
  /** 表示している時刻（秒）と、前のフレームから進んだ秒（止めている間は 0） */
  time: number;
  step: number;
  energy: number;
  /** 明るさ（設定 × フェード） */
  level: number;
  base: Color;
  /** 見えている範囲（ワールド）と縮尺（CSS px / ワールド px） */
  view: Bounds;
  scale: number;
};

/** 背景の1種類 */
export interface BackdropLayer {
  readonly object: Object3D;
  /** 当たった（ワールド座標、時刻は秒）。pitch = 音の高さ 0..1、color は音の色 */
  hit(x: number, y: number, at: number, strength: number, pitch: number, color: Color): void;
  /** 見えている間、毎フレーム呼ぶ（main の composer で描く前） */
  update(f: LayerFrame): void;
  dispose(): void;
}

const MAKE: Record<Exclude<BackdropKind, 'none'>, () => BackdropLayer> = {
  caustics: () => new Caustics(),
  particles: () => new Particles(),
  grain: () => new Grain(),
  bitmap: () => new Bitmap(),
  ascii: () => new Ascii(),
  fibers: () => new Fibers(),
  slices: () => new Slices(),
};

export class Backdrop {
  /** シーンに入れるもの（見えている種類の object） */
  readonly object = new Group();
  /** 見えている種類の中身（none のときは null） */
  private layer: BackdropLayer | null = null;
  private shown: BackdropKind = 'none';
  private fade = 0;
  private lastRs = NaN;

  hit(x: number, y: number, step: number, strength: number, pitch: number, color: Color): void {
    this.layer?.hit(x, y, step / HZ, strength, pitch, color);
  }

  private show(kind: BackdropKind): void {
    if (this.layer) {
      this.object.remove(this.layer.object);
      this.layer.dispose();
      this.layer = null;
    }
    this.shown = kind;
    if (kind === 'none') return;
    this.layer = MAKE[kind]();
    this.object.add(this.layer.object);
  }

  /** 毎フレーム呼ぶ。rs = 表示しているステップ、dt = フレームの秒 */
  draw(kind: BackdropKind, frame: Omit<LayerFrame, 'time' | 'step' | 'level'> & { rs: number; dt: number; level: number }): void {
    const want = kind === this.shown ? 1 : 0;
    this.fade += (want - this.fade) * (1 - Math.exp(-frame.dt / (FADE_SEC / 3)));
    if (kind !== this.shown && this.fade < 0.02) {
      this.show(kind);
      this.fade = 0;
    }
    const step = Number.isNaN(this.lastRs) ? 0 : Math.max(0, (frame.rs - this.lastRs) / HZ);
    this.lastRs = frame.rs;
    const l = this.layer;
    if (!l) return;
    const on = this.fade > 0.001;
    l.object.visible = on;
    if (on) l.update({ ...frame, time: frame.rs / HZ, step, level: frame.level * this.fade });
  }

  dispose(): void {
    this.show('none');
  }
}
