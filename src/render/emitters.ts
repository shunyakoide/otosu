import { Color, RingGeometry } from 'three';
import { HZ } from '../sim/constants';
import type { SimEvent } from '../sim/types';
import { commit, instanced, putDisc } from './instancing';
import { OFF_WHITE } from './palette';

// 放出口は emitters / emit イベントの位置から描く（B4）。sim の Emitter は参照しない。

const MAX_EMITTERS = 8;
const EMITTER_TAU = 0.2;

type EmitterView = { x: number; y: number; tx: number; ty: number; pulse: number };

export class Emitters {
  readonly mesh = instanced(new RingGeometry(0.6, 1, 32), MAX_EMITTERS, 1);
  private readonly views = new Map<number, EmitterView>();
  private readonly color = new Color();

  /** 放出した: 光らせ、位置へ寄せる */
  emit(e: Extract<SimEvent, { kind: 'emit' }>): void {
    const em = this.views.get(e.emitterId);
    if (em) {
      em.tx = e.x;
      em.ty = e.y;
      em.pulse = e.step;
    } else {
      this.views.set(e.emitterId, { x: e.x, y: e.y, tx: e.x, ty: e.y, pulse: e.step });
    }
  }

  /** 放出口の一覧が変わった（今ある放出口は位置へ寄せ、なくなったものは消す） */
  set(e: Extract<SimEvent, { kind: 'emitters' }>): void {
    const next = new Map<number, EmitterView>();
    for (const c of e.emitters) {
      const old = this.views.get(c.id);
      next.set(c.id, old
        ? { ...old, tx: c.x, ty: c.y }
        : { x: c.x, y: c.y, tx: c.x, ty: c.y, pulse: -Infinity });
    }
    this.views.clear();
    for (const [id, v] of next) this.views.set(id, v);
  }

  /**
   * 常に 4s 周期でゆっくり呼吸し、区間（section）が変わると 1〜2s かけて大きく膨らむ（D11 パッドの光）。
   * sectionStep = 最後に区間が変わったステップ
   */
  draw(rs: number, dt: number, sectionStep: number): void {
    const c = this.color;
    const k = 1 - Math.exp(-dt / EMITTER_TAU);
    const sec = Math.max(0, rs / HZ);
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * sec) / 4);
    const ts = (rs - sectionStep) / HZ;
    const swell = ts >= 0 ? (1 - Math.exp(-ts / 0.25)) * Math.exp(-ts / 1.2) : 0;
    let n = 0;
    for (const em of this.views.values()) {
      if (n >= MAX_EMITTERS) break;
      em.x += (em.tx - em.x) * k;
      em.y += (em.ty - em.y) * k;
      const t = Math.max(0, (rs - em.pulse) / HZ);
      const r = 8 * (1 + 0.08 * breath + 0.5 * swell);
      const intensity = 0.3 + 0.1 * breath + 0.6 * swell + 1.0 * Math.exp(-t / 0.12);
      putDisc(this.mesh, n, em.x, em.y, r, c.copy(OFF_WHITE).multiplyScalar(intensity));
      n++;
    }
    commit(this.mesh, n);
  }
}
