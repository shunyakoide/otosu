import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { lengthToNote } from '../src/sim/music';
import { rayCapsule } from '../src/sim/collide';
import type { SimEvent } from '../src/sim/types';

function setup(rotating = false): Sim {
  const sim = new Sim({ bpm: 90, pattern: [2, 3] });
  sim.enqueue({ kind: 'addSegment', ax: 700, ay: 300, bx: 1000, by: 380 });
  sim.enqueue({ kind: 'addSegment', ax: 1100, ay: 420, bx: 1300, by: 360 });
  sim.enqueue({ kind: 'addSegment', ax: 600, ay: 700, bx: 1300, by: 760 });
  sim.enqueue({ kind: 'addSegment', ax: 850, ay: 950, bx: 950, by: 900 });
  if (rotating) sim.enqueue({ kind: 'setRotation', on: true, speed: 0.4 });
  return sim;
}

function run(sim: Sim, steps: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < steps; i++) {
    sim.advance();
    events.push(...sim.drainEvents());
  }
  return events;
}

function hash(sim: Sim, events: SimEvent[]): string {
  const balls = sim.balls.map((b) => `${b.id}:${b.x.toFixed(6)},${b.y.toFixed(6)}`).join('|');
  const hits = events.filter((e) => e.kind === 'hit').map((e) => `${e.step}/${e.lineId}`).join(',');
  return `${balls}#${hits}`;
}

describe('sim', () => {
  it('is deterministic', () => {
    for (const rotating of [false, true]) {
      const a = setup(rotating);
      const b = setup(rotating);
      expect(hash(a, run(a, 6000))).toBe(hash(b, run(b, 6000)));
    }
  });

  it('produces hits and settles into a periodic pattern', () => {
    const sim = setup();
    const events = run(sim, 120 * 30);
    const hits = events.filter((e) => e.kind === 'hit');
    expect(hits.length).toBeGreaterThan(20);
    // 2拍:3拍 @90BPM → 6拍 = 480 ステップ周期。十分後の2周期でヒット列が一致する
    const window = (from: number) =>
      hits.filter((e) => e.step >= from && e.step < from + 480).map((e) => `${e.step - from}/${e.lineId}`);
    expect(window(120 * 20)).toEqual(window(120 * 20 + 480));
  });

  it('never tunnels through a line', () => {
    const sim = new Sim({ bpm: 90, pattern: [1] });
    sim.enqueue({ kind: 'addSegment', ax: 0, ay: 1000, bx: 1920, by: 1000 });
    run(sim, 120 * 10);
    for (const b of sim.balls) expect(b.y).toBeLessThan(1000);
  });

  it('keeps sound and light 1:1 (every hit has velocity and note)', () => {
    const sim = setup(true);
    for (const e of run(sim, 120 * 20)) {
      if (e.kind !== 'hit') continue;
      expect(e.velocity).toBeGreaterThan(0.1);
      expect(e.velocity).toBeLessThanOrEqual(1);
      expect(e.note).toBeGreaterThanOrEqual(0);
      expect(e.note).toBeLessThan(16);
    }
  });
});

describe('music', () => {
  it('maps longer lines to lower notes', () => {
    expect(lengthToNote(58).index).toBe(15);
    expect(lengthToNote(1200).index).toBe(0);
    expect(lengthToNote(300).index).toBeGreaterThan(lengthToNote(600).index);
  });
});

describe('rayCapsule', () => {
  it('hits the side of a horizontal line', () => {
    const out = { t: 0, nx: 0, ny: 0 };
    expect(rayCapsule(50, 0, 0, 100, 0, 50, 100, 50, 5, out)).toBe(true);
    expect(out.t).toBeCloseTo(0.45);
    expect(out.ny).toBeCloseTo(-1);
  });
});
