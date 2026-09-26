import { closestOnSegment } from '../sim/collide';
import { MIN_LINE_LEN } from '../sim/constants';
import type { Sim } from '../sim/sim';
import type { Preview } from '../render/render';

// ドラッグで線を引く／右クリックで最寄りの線を消す。座標はすべて論理ワールド座標（D8-7）。

const ERASE_RADIUS = 12;

export class Input {
  readonly preview: Preview = { active: false, ax: 0, ay: 0, bx: 0, by: 0 };
  private readonly near = { dist: 0, nx: 0, ny: 0 };

  private readonly sim: Sim;
  private readonly toWorld: (x: number, y: number) => { x: number; y: number };

  constructor(el: HTMLElement, sim: Sim, toWorld: (x: number, y: number) => { x: number; y: number }) {
    this.sim = sim;
    this.toWorld = toWorld;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => (this.preview.active = false));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.erase(e);
    });
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = this.toWorld(e.clientX, e.clientY);
    Object.assign(this.preview, { active: true, ax: p.x, ay: p.y, bx: p.x, by: p.y });
  }

  private move(e: PointerEvent): void {
    if (!this.preview.active) return;
    const p = this.toWorld(e.clientX, e.clientY);
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
    let bestId = -1;
    let best = ERASE_RADIUS;
    for (const seg of this.sim.segments) {
      closestOnSegment(p.x, p.y, seg.ax, seg.ay, seg.bx, seg.by, this.near);
      if (this.near.dist < best) {
        best = this.near.dist;
        bestId = seg.id;
      }
    }
    if (bestId >= 0) this.sim.enqueue({ kind: 'removeSegment', id: bestId });
  }
}
