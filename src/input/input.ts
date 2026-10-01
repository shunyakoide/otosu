import { MIN_LINE_LEN, type Bounds } from '../sim/constants';
import { lengthToNote } from '../sim/music';
import { normalizePoints, type Sim } from '../sim/sim';
import type { Preview } from '../render/render';
import type { HintKind } from '../ui/hint';

// ツールで図形を描く／右クリック（タッチでは長押し）で図形のメニューを開く（エフェクト・削除、D32）。座標はすべて論理ワールド座標（D8-7）。
// 消去とホバーの判定は描画側（表示中の図形・描画中の時刻の姿勢）に任せる（B3, D12）。

export type Tool = 'line' | 'pen' | 'circle' | 'triangle' | 'square';
export const TOOLS: readonly Tool[] = ['line', 'pen', 'circle', 'triangle', 'square'];

/** (x, y) の近くに表示されている図形の group（なければ -1） */
export type ShapePicker = (x: number, y: number) => number;

/** カーソルが隠れるのと同じ時間でホバー予告も消す（投影時に予告だけ光り続けないように） */
const HOVER_IDLE_MS = 2000;
/** タッチ: この時間ほぼ動かさずに押し続けると、その場所の図形のメニューを開く（右クリックの代わり） */
const LONG_PRESS_MS = 550;
/** タッチ: 図形を押さえてからこの時間で長押しの案内を出す（すぐ描き始めたときに、ちらつかないように。D53） */
const HOLD_HINT_MS = 150;
/** 長押しとみなす指のぶれ（CSS px） */
const LONG_PRESS_SLOP = 10;
/** ペン: 生の点の間隔・RDP の許容誤差・辺の上限（D12） */
const PEN_MIN_STEP = 3;
const PEN_EPS = 4;
const PEN_MAX_EDGES = 48;
const PEN_MAX_RAW = 4000;
/** ペンの終点が始点のこの距離以内なら閉じた図形にする */
const PEN_CLOSE_DIST = 16;
const SIDES: Record<'circle' | 'triangle' | 'square', number> = { circle: 24, triangle: 3, square: 4 };
/** 右へ水平にドラッグしたとき、三角は頂点が上、四角は辺が水平になるように回す */
const PHASE: Record<'circle' | 'triangle' | 'square', number> = { circle: 0, triangle: -Math.PI / 2, square: Math.PI / 4 };

type Pt = [number, number];

/** Ramer–Douglas–Peucker（反復版） */
function rdp(pts: readonly Pt[], eps: number): Pt[] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const ex = bx - ax;
    const ey = by - ay;
    const ll = Math.hypot(ex, ey);
    let best = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const d = ll > 1e-9 ? Math.abs(ex * (ay - py) - ey * (ax - px)) / ll : Math.hypot(px - ax, py - ay);
      if (d > best) {
        best = d;
        idx = i;
      }
    }
    if (best > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]!);
  return out;
}

function perimeter(pts: readonly Pt[], closed: boolean): number {
  let p = 0;
  for (let i = 1; i < pts.length; i++) p += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (closed && pts.length > 2) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    p += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return p;
}

export class Input {
  readonly preview: Preview = {
    active: false, points: [], closed: false, bumper: false, perimeter: 0,
    hover: { active: false, x: 0, y: 0 },
  };
  /** ドラッグ中に音程スロットが変わったとき（有効な長さに入ったときも）に呼ぶ。main がティック音を鳴らす */
  onPreviewNote: ((slot: number) => void) | null = null;
  /** 図形を長押し・右クリックしたときに呼ぶ（x, y は画面の座標）。main がメニューを開く */
  onShapeMenu: ((group: number, x: number, y: number) => void) | null = null;
  /** 操作の案内を出す・消す（D53）。ms は長押しの線を満たす時間 */
  onHint: ((kind: HintKind | null, ms?: number) => void) | null = null;
  /** 人が図形を描き終えたときに呼ぶ。main が始めの案内を進める（D71） */
  onDraw: (() => void) | null = null;

  private tool: Tool = 'line';
  private readonly sim: Sim;
  private readonly toWorld: (x: number, y: number) => { x: number; y: number };
  private readonly pick: ShapePicker;
  private readonly bounds: () => Bounds;
  private hoverTimer = 0;
  private start: Pt = [0, 0];
  private raw: Pt[] = [];
  private shape: { points: Pt[]; closed: boolean } = { points: [], closed: false };
  private lastSlot = -1;
  /** 描いている指（ペン・マウス）。2本目の指は無視する */
  private pointerId = -1;
  private pressTimer = 0;
  private pressAt: Pt = [0, 0];
  private lastPointerType = '';
  private hintTimer = 0;

  constructor(
    el: HTMLElement,
    sim: Sim,
    toWorld: (x: number, y: number) => { x: number; y: number },
    pick: ShapePicker,
    bounds: () => Bounds,
  ) {
    this.sim = sim;
    this.toWorld = toWorld;
    this.pick = pick;
    this.bounds = bounds;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.preview.active = false;
      this.pointerId = -1;
      clearTimeout(this.pressTimer);
      this.hint(null);
    });
    el.addEventListener('pointerleave', () => {
      this.setHover(false);
      if (!this.preview.active) this.hint(null);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // タッチの長押しでも contextmenu が来る（Android）。そちらは長押しの処理に任せる
      if (this.lastPointerType !== 'touch') this.menu(e);
    });
    // ドラッグ中に Shift を押す／離すだけでもプレビューを切り替える
    const shift = (on: boolean) => {
      this.preview.bumper = on;
      if (this.preview.active && this.lastPointerType === 'mouse') this.hint(on ? 'bumper' : 'drag');
    };
    addEventListener('keydown', (e) => e.key === 'Shift' && shift(true));
    addEventListener('keyup', (e) => e.key === 'Shift' && shift(false));
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.preview.active = false;
  }

  private setHover(active: boolean, x = 0, y = 0): void {
    const h = this.preview.hover;
    h.active = active;
    h.x = x;
    h.y = y;
    clearTimeout(this.hoverTimer);
    if (active) {
      this.hoverTimer = window.setTimeout(() => {
        h.active = false;
        // カーソルが隠れるのと一緒に案内も消す（描いている間は残す）
        if (!this.preview.active) this.hint(null);
      }, HOVER_IDLE_MS);
    }
  }

  private hint(kind: HintKind | null, ms?: number): void {
    clearTimeout(this.hintTimer);
    this.onHint?.(kind, ms);
  }

  private down(e: PointerEvent): void {
    this.lastPointerType = e.pointerType;
    if (e.button !== 0 || this.preview.active) return;
    this.pointerId = e.pointerId;
    (e.target as Element).setPointerCapture(e.pointerId);
    clearTimeout(this.pressTimer);
    if (e.pointerType === 'touch') {
      this.pressAt = [e.clientX, e.clientY];
      this.pressTimer = window.setTimeout(() => {
        // 長押し: 描きかけを捨てて、押した場所の図形のメニューを開く
        this.preview.active = false;
        this.hint(null);
        if (this.menu(e)) navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
      // 図形の上なら、押さえ続けるとメニューが開くことを見せる
      const w = this.toWorld(e.clientX, e.clientY);
      if (this.pick(w.x, w.y) >= 0) {
        this.hintTimer = window.setTimeout(() => this.onHint?.('hold', LONG_PRESS_MS - HOLD_HINT_MS), HOLD_HINT_MS);
      }
    } else {
      this.hint(e.shiftKey ? 'bumper' : 'drag');
    }
    const p = this.toWorld(e.clientX, e.clientY);
    this.start = [p.x, p.y];
    this.raw = [[p.x, p.y]];
    this.lastSlot = -1;
    this.preview.active = true;
    this.preview.bumper = e.shiftKey;
    this.update(p.x, p.y);
  }

  private move(e: PointerEvent): void {
    if (this.preview.active && e.pointerId !== this.pointerId) return;
    if (e.pointerType === 'touch' && this.preview.active
      && Math.hypot(e.clientX - this.pressAt[0], e.clientY - this.pressAt[1]) > LONG_PRESS_SLOP) {
      // 指が動いた = 描いている。長押しと、その輪をやめる
      clearTimeout(this.pressTimer);
      this.hint(null);
    }
    const p = this.toWorld(e.clientX, e.clientY);
    this.setHover(true, p.x, p.y);
    if (e.pointerType === 'mouse') {
      if (this.preview.active) this.hint(e.shiftKey ? 'bumper' : 'drag');
      else if (this.pick(p.x, p.y) >= 0) this.hint('shape');
      else this.hint(null);
    }
    if (!this.preview.active) return;
    this.preview.bumper = e.shiftKey;
    this.update(p.x, p.y);
  }

  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    clearTimeout(this.pressTimer);
    this.pointerId = -1;
    if (!this.preview.active || e.button !== 0) {
      this.hint(null);
      return;
    }
    this.move(e);
    this.preview.active = false;
    this.hint(null);
    const { points, closed } = this.shape;
    if (points.length < 2 || this.preview.perimeter < MIN_LINE_LEN) return;
    const segKind = e.shiftKey ? 'bumper' : 'line';
    this.sim.enqueue({ kind: 'addShape', points: points.map(([x, y]) => [x, y]), closed, segKind, form: this.tool });
    this.onDraw?.();
  }

  /** 現在のツールで図形を作り直し、プレビューに反映する */
  private update(x: number, y: number): void {
    const [sx, sy] = this.start;
    let points: Pt[];
    let closed = false;
    switch (this.tool) {
      case 'line':
        points = [[sx, sy], [x, y]];
        break;
      case 'pen': {
        const last = this.raw[this.raw.length - 1]!;
        if (Math.hypot(x - last[0], y - last[1]) >= PEN_MIN_STEP && this.raw.length < PEN_MAX_RAW) this.raw.push([x, y]);
        let eps = PEN_EPS;
        points = rdp(this.raw, eps);
        while (points.length - 1 > PEN_MAX_EDGES) {
          eps *= 1.5;
          points = rdp(this.raw, eps);
        }
        if (points.length >= 4) {
          const a = points[0]!;
          const b = points[points.length - 1]!;
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) < PEN_CLOSE_DIST) {
            points = points.slice(0, -1);
            closed = true;
          }
        }
        break;
      }
      default: {
        // 始点 = 中心、距離 = 半径、向き = 回転角
        const n = SIDES[this.tool];
        const r = Math.hypot(x - sx, y - sy);
        const a0 = Math.atan2(y - sy, x - sx) + PHASE[this.tool];
        points = [];
        for (let i = 0; i < n; i++) {
          const a = a0 + (2 * Math.PI * i) / n;
          points.push([sx + r * Math.cos(a), sy + r * Math.sin(a)]);
        }
        closed = true;
      }
    }
    // 画面からはみ出た分を戻す。確定時も同じ点列を送るので、描いた位置と置かれる位置が一致する
    points = normalizePoints(points, closed, this.bounds()) ?? points;
    this.shape = { points, closed };
    const pv = this.preview;
    pv.points.length = 0;
    for (const [px, py] of points) pv.points.push(px, py);
    pv.closed = closed;
    pv.perimeter = perimeter(points, closed);

    const slot = pv.perimeter >= MIN_LINE_LEN ? lengthToNote(pv.perimeter).index : -1;
    if (slot !== this.lastSlot) {
      this.lastSlot = slot;
      if (slot >= 0) this.onPreviewNote?.(slot);
    }
  }

  /** 押した場所に図形があればメニューを開く */
  private menu(e: MouseEvent): boolean {
    const p = this.toWorld(e.clientX, e.clientY);
    const group = this.pick(p.x, p.y);
    if (group < 0) return false;
    this.hint(null);
    this.onShapeMenu?.(group, e.clientX, e.clientY);
    return true;
  }
}
