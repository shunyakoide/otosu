import { MIN_LINE_LEN } from '../sim/constants';
import type { Sim } from '../sim/sim';
import type { Preview } from '../render/render';

// ドラッグで線を引く／右クリックで線を消す。座標はすべて論理ワールド座標（D8-7）。
// 消去とホバーの判定は描画側（表示中の線・描画中の時刻の姿勢）に任せる（B3）。

/** (x, y) の近くに表示されている線の id（なければ -1） */
export type SegmentPicker = (x: number, y: number) => number;

/** カーソルが隠れるのと同じ時間でホバー予告も消す（投影時に予告だけ光り続けないように） */
const HOVER_IDLE_MS = 2000;

export class Input {
  readonly preview: Preview = {
    active: false, ax: 0, ay: 0, bx: 0, by: 0,
    hover: { active: false, x: 0, y: 0 },
  };

  private readonly sim: Sim;
  private readonly toWorld: (x: number, y: number) => { x: number; y: number };
  private readonly pick: SegmentPicker;
  private hoverTimer = 0;

  constructor(
    el: HTMLElement,
    sim: Sim,
    toWorld: (x: number, y: number) => { x: number; y: number },
    pick: SegmentPicker,
  ) {
    this.sim = sim;
    this.toWorld = toWorld;
    this.pick = pick;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => (this.preview.active = false));
    el.addEventListener('pointerleave', () => this.setHover(false));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.erase(e);
    });
  }

  private setHover(active: boolean, x = 0, y = 0): void {
    const h = this.preview.hover!;
    h.active = active;
    h.x = x;
    h.y = y;
    clearTimeout(this.hoverTimer);
    if (active) this.hoverTimer = window.setTimeout(() => (h.active = false), HOVER_IDLE_MS);
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = this.toWorld(e.clientX, e.clientY);
    Object.assign(this.preview, { active: true, ax: p.x, ay: p.y, bx: p.x, by: p.y });
  }

  private move(e: PointerEvent): void {
    const p = this.toWorld(e.clientX, e.clientY);
    this.setHover(true, p.x, p.y);
    if (!this.preview.active) return;
    this.preview.bx = p.x;
    this.preview.by = p.y;
  }

  private up(e: PointerEvent): void {
    if (!this.preview.active || e.button !== 0) return;
    this.move(e);
    const { ax, ay, bx, by } = this.preview;
    this.preview.active = false;
    if (Math.hypot(bx - ax, by - ay) < MIN_LINE_LEN) return;
    this.sim.enqueue({ kind: 'addSegment', ax, ay, bx, by });
  }

  private erase(e: MouseEvent): void {
    const p = this.toWorld(e.clientX, e.clientY);
    const id = this.pick(p.x, p.y);
    if (id >= 0) this.sim.enqueue({ kind: 'removeSegment', id });
  }
}
