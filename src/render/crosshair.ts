import {
  AdditiveBlending, BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments, type Color,
} from 'three';
import type { Bounds } from '../sim/constants';

// 当たった点の照準線（D62、crosshair）。当たった点から縦横の細い線が画面の端まで伸び、ゆっくり消える。
// 当たった点のまわりには目盛りが付く。線は加算で重ねるので、交わったところが明るくなる。
// 時刻は renderStep から取るので、止めると止まる。

/** 同時に出す数、出ている秒、端まで伸びきる秒、次を出すまでの最短の間（秒） */
const MAX_CROSS = 5;
const CROSS_SEC = 1.4;
const GROW_SEC = 0.22;
const CROSS_GAP = 0.12;
/** 当たった点のまわりのあき、目盛りの間隔・数（片側）・長さ（ワールド px） */
const GAP = 7;
const TICK = 16;
const TICKS = 6;
const TICK_LEN = 2.5;
const TICK_MAJOR = 6;

/** 1つ分の線分: 横 2 本・縦 2 本・目盛り（横線の上・縦線の横に、両側 TICKS ずつ） */
const SEGS = 4 + TICKS * 4;

type Item = { at: number; x: number; y: number; v: number };

export class Crosshair {
  readonly object: LineSegments;
  private readonly items: Item[] = [];
  private head = 0;
  private last = -Infinity;
  private readonly pos: BufferAttribute;
  private readonly col: BufferAttribute;

  constructor() {
    for (let i = 0; i < MAX_CROSS; i++) this.items.push({ at: -Infinity, x: 0, y: 0, v: 0 });
    const g = new BufferGeometry();
    this.pos = new BufferAttribute(new Float32Array(MAX_CROSS * SEGS * 2 * 3), 3);
    this.col = new BufferAttribute(new Float32Array(MAX_CROSS * SEGS * 2 * 3), 3);
    g.setAttribute('position', this.pos);
    g.setAttribute('color', this.col);
    this.object = new LineSegments(g, new LineBasicMaterial({
      vertexColors: true, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  /** 当たった（ワールド座標、時刻は秒） */
  hit(x: number, y: number, at: number, strength: number): void {
    if (at - this.last < CROSS_GAP) return;
    this.last = at;
    Object.assign(this.items[this.head]!, { at, x, y, v: Math.min(1, strength) });
    this.head = (this.head + 1) % MAX_CROSS;
  }

  /** 毎フレーム呼ぶ。time = 表示している時刻（秒）、view = 見えている範囲（ワールド座標） */
  update(on: boolean, time: number, view: Bounds, top: number, base: Color): void {
    this.object.visible = on;
    if (!on) return;
    const pos = this.pos;
    const col = this.col;
    let k = 0;
    const seg = (ax: number, ay: number, bx: number, by: number, a: number) => {
      pos.setXYZ(k, ax, -ay, 0);
      col.setXYZ(k++, base.r * a, base.g * a, base.b * a);
      pos.setXYZ(k, bx, -by, 0);
      col.setXYZ(k++, base.r * a, base.g * a, base.b * a);
    };
    for (const it of this.items) {
      const age = time - it.at;
      if (!(age >= 0 && age < CROSS_SEC)) {
        for (let i = 0; i < SEGS; i++) seg(0, 0, 0, 0, 0);
        continue;
      }
      const q = age / CROSS_SEC;
      // 出るときに一度強く光り、あとはゆっくり消える
      const a = (0.25 + 0.2 * it.v) * (1 - q) ** 1.6 * (1 + 1.5 * Math.max(0, 1 - age / 0.08));
      // 当たった点から端へ伸びる（先へ行くほど速く伸びきる）
      const g = 1 - (1 - Math.min(1, age / GROW_SEC)) ** 3;
      const { x, y } = it;
      const left = x - GAP - (x - GAP - view.minX) * g;
      const right = x + GAP + (view.maxX - x - GAP) * g;
      const up = y - GAP - (y - GAP - top) * g;
      const down = y + GAP + (view.maxY - y - GAP) * g;
      seg(x - GAP, y, left, y, a);
      seg(x + GAP, y, right, y, a);
      seg(x, y - GAP, x, up, a);
      seg(x, y + GAP, x, down, a);
      // 目盛り: 伸びた線の上だけに出す。遠いほど淡く、3つごとに長く
      for (let i = 1; i <= TICKS; i++) {
        const d = i * TICK;
        const len = i % 3 === 0 ? TICK_MAJOR : TICK_LEN;
        const ta = a * 1.4 * (1 - i / (TICKS + 1));
        const inX = (px: number) => px >= left && px <= right;
        const inY = (py: number) => py >= up && py <= down;
        for (const s of [-1, 1]) {
          const px = x + s * d;
          const py = y + s * d;
          seg(px, y - len, px, y + len, inX(px) ? ta : 0);
          seg(x - len, py, x + len, py, inY(py) ? ta : 0);
        }
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as LineBasicMaterial).dispose();
  }
}
