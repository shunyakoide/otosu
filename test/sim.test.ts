import { describe, expect, it } from 'vitest';
import { driftOffset, hitAllowed, segmentAngle, Sim } from '../src/sim/sim';
import { lengthToNote, midiAt, PROG, sectionAt, sectionSteps } from '../src/sim/music';
import { rayCapsule } from '../src/sim/collide';
import { BALL_LINE_COOLDOWN, DRIFT_PERIOD, HZ, LINE_COOLDOWN, SECTION_BARS, V_MIN } from '../src/sim/constants';
import { decodeScene, encodeScene, sceneFromSim, validateScene } from '../src/scene/scene';
import type { DriftMode, HitEvent, SceneData, SimEvent } from '../src/sim/types';

function setup(rotating = false, drift: DriftMode = 'off'): Sim {
  const sim = new Sim({ bpm: 90, pattern: [2, 3], drift: { mode: drift, amp: 24 } });
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

const hitsOf = (events: SimEvent[]) => events.filter((e): e is HitEvent => e.kind === 'hit');

function hash(sim: Sim, events: SimEvent[]): string {
  const balls = sim.balls.map((b) => `${b.id}:${b.x.toFixed(6)},${b.y.toFixed(6)}`).join('|');
  const hits = hitsOf(events).map((e) => `${e.step}/${e.lineId}/${e.midi}`).join(',');
  return `${balls}#${hits}`;
}

/** [from, from+len) のヒット列（ステップは from 基準） */
function window(hits: HitEvent[], from: number, len: number): string[] {
  return hits.filter((e) => e.step >= from && e.step < from + len).map((e) => `${e.step - from}/${e.lineId}`);
}

describe('sim', () => {
  it('is deterministic', () => {
    for (const rotating of [false, true]) {
      for (const drift of ['off', 'drift', 'phrase'] as const) {
        const a = setup(rotating, drift);
        const b = setup(rotating, drift);
        expect(hash(a, run(a, 6000))).toBe(hash(b, run(b, 6000)));
      }
    }
  });

  it('produces hits and settles into a periodic pattern', () => {
    const hits = hitsOf(run(setup(), 120 * 30));
    expect(hits.length).toBeGreaterThan(20);
    // 2拍:3拍 @90BPM → 6拍 = 480 ステップ周期
    expect(window(hits, 120 * 20, 480)).toEqual(window(hits, 120 * 20 + 480, 480));
  });

  it('returns to a periodic pattern after setTempo', () => {
    const sim = setup();
    run(sim, 1000);
    sim.enqueue({ kind: 'setTempo', bpm: 120, pattern: [2, 3] });
    const hits = hitsOf(run(sim, 120 * 30));
    // 6拍 @120BPM = 360 ステップ
    const from = 1000 + 120 * 20;
    expect(window(hits, from, 360).length).toBeGreaterThan(0);
    expect(window(hits, from, 360)).toEqual(window(hits, from + 360, 360));
  });

  it('never tunnels through a line', () => {
    const sim = new Sim({ bpm: 90, pattern: [1] });
    sim.enqueue({ kind: 'addSegment', ax: 0, ay: 1000, bx: 1920, by: 1000 });
    run(sim, 120 * 10);
    for (const b of sim.balls) expect(b.y).toBeLessThan(1000);
  });

  it('keeps sound and light 1:1 (every hit has velocity, note and midi)', () => {
    const sim = setup(true, 'drift');
    for (const e of hitsOf(run(sim, 120 * 20))) {
      expect(e.velocity).toBeGreaterThan(0.1);
      expect(e.velocity).toBeLessThanOrEqual(1);
      expect(e.normalSpeed).toBeGreaterThanOrEqual(V_MIN);
      expect(e.note).toBeGreaterThanOrEqual(0);
      expect(e.note).toBeLessThan(16);
      expect(e.midi).toBe(midiAt(e.note, e.section));
    }
  });

  it('rounds segment coordinates to integer px', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addSegment', ax: 100.4, ay: 200.6, bx: 300.5, by: 250.2 });
    run(sim, 1);
    const s = sim.segments[0]!;
    expect([s.ax, s.ay, s.bx, s.by]).toEqual([100, 201, 301, 250]);
  });
});

describe('rotation (B1, B2, B6)', () => {
  it('keeps the physical pose equal to the drawn angle after rotation is turned off', () => {
    const sim = setup(true);
    run(sim, 500);
    sim.enqueue({ kind: 'setRotation', on: false, speed: 0.4 });
    const events = run(sim, 3);
    for (const seg of sim.segments) {
      expect(seg.omega).toBe(0);
      const th = segmentAngle(seg, sim.step + 100);
      expect(seg.ax).toBeCloseTo(seg.cx - Math.cos(th) * seg.halfLen, 9);
      expect(seg.ay).toBeCloseTo(seg.cy - Math.sin(th) * seg.halfLen, 9);
      expect(seg.bx).toBeCloseTo(seg.cx + Math.cos(th) * seg.halfLen, 9);
      expect(seg.by).toBeCloseTo(seg.cy + Math.sin(th) * seg.halfLen, 9);
    }
    const poses = events.filter((e) => e.kind === 'segmentPose');
    expect(poses.length).toBe(sim.segments.length);
    for (const p of poses) {
      expect(p.kind === 'segmentPose' && p.omega).toBe(0);
      expect(p.step).toBe(500);
    }
  });

  it('segmentAdded carries a copy, not the live object', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addSegment', ax: 700, ay: 300, bx: 1000, by: 380 });
    const [added] = run(sim, 1).filter((e) => e.kind === 'segmentAdded');
    sim.enqueue({ kind: 'setRotation', on: true, speed: 0.4 });
    run(sim, 10);
    expect(added!.kind === 'segmentAdded' && added!.segment.omega).toBe(0);
  });

  it('uses the explicit dir for rotation direction', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addSegment', ax: 700, ay: 300, bx: 1000, by: 380, dir: 1 });
    sim.enqueue({ kind: 'addSegment', ax: 700, ay: 600, bx: 1000, by: 680, dir: 1 });
    sim.enqueue({ kind: 'setRotation', on: true, speed: 0.4 });
    run(sim, 1);
    expect(sim.segments.map((s) => Math.sign(s.omega))).toEqual([1, 1]);
  });
});

describe('hit rules (D4 boundaries)', () => {
  it('velocity threshold', () => {
    expect(hitAllowed(100, V_MIN - 1e-9, undefined, -Infinity)).toBe(false);
    expect(hitAllowed(100, V_MIN, undefined, -Infinity)).toBe(true);
  });

  it('ball × line cooldown', () => {
    expect(hitAllowed(100, 500, 100 - (BALL_LINE_COOLDOWN - 1), -Infinity)).toBe(false);
    expect(hitAllowed(100, 500, 100 - BALL_LINE_COOLDOWN, -Infinity)).toBe(true);
  });

  it('line cooldown', () => {
    expect(hitAllowed(100, 500, undefined, 100 - (LINE_COOLDOWN - 1))).toBe(false);
    expect(hitAllowed(100, 500, undefined, 100 - LINE_COOLDOWN)).toBe(true);
  });

  it('merges simultaneous hits on the same line into one', () => {
    const sim = new Sim({ bpm: 90, pattern: [2, 2], drift: { mode: 'off', amp: 0 } });
    sim.enqueue({ kind: 'addSegment', ax: 200, ay: 600, bx: 1720, by: 600 });
    const hits = hitsOf(run(sim, 200));
    const first = hits[0]!;
    expect(hits.filter((h) => h.step === first.step).length).toBe(1);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.step - hits[i - 1]!.step).toBeGreaterThanOrEqual(LINE_COOLDOWN);
  });
});

describe('drift (P1)', () => {
  it('is an integer offset bounded by amp and periodic in k', () => {
    for (const mode of ['drift', 'phrase'] as const) {
      for (let k = 0; k < 300; k++) {
        const o = driftOffset(mode, 24, 1, k);
        expect(Number.isInteger(o)).toBe(true);
        expect(Math.abs(o)).toBeLessThanOrEqual(24);
        expect(o).toBe(driftOffset(mode, 24, 1, k + DRIFT_PERIOD));
      }
    }
    expect(driftOffset('off', 24, 0, 5)).toBe(0);
    expect(new Set(Array.from({ length: 64 }, (_, k) => driftOffset('drift', 24, 0, k))).size).toBeGreaterThan(10);
  });

  it('emit events carry the drifted position', () => {
    const sim = new Sim({ bpm: 90, pattern: [1], drift: { mode: 'drift', amp: 24 } });
    const emits = run(sim, 60 * 20).filter((e) => e.kind === 'emit');
    expect(new Set(emits.map((e) => e.kind === 'emit' && e.x)).size).toBeGreaterThan(5);
  });

  it('hit pattern repeats after the full drift cycle', () => {
    const sim = new Sim({ bpm: 90, pattern: [2], drift: { mode: 'drift', amp: 24 } });
    sim.enqueue({ kind: 'addSegment', ax: 800, ay: 400, bx: 1100, by: 470 });
    sim.enqueue({ kind: 'addSegment', ax: 700, ay: 750, bx: 1200, by: 700 });
    const cycle = 160 * DRIFT_PERIOD; // 2拍 = 160 ステップ × 64 回
    const hits = hitsOf(run(sim, 2400 + cycle + 2000));
    expect(window(hits, 2400, 2000).length).toBeGreaterThan(0);
    expect(window(hits, 2400, 2000)).toEqual(window(hits, 2400 + cycle, 2000));
    // 周期の途中では違う（揺らいでいる）
    expect(window(hits, 2400, 2000)).not.toEqual(window(hits, 2400 + cycle / 2, 2000));
  });

  it('emits an emitters event on init, setTempo and loadScene', () => {
    const sim = new Sim({ bpm: 90, pattern: [2, 3] });
    sim.enqueue({ kind: 'setTempo', bpm: 100, pattern: [3, 4, 5] });
    const ev = run(sim, 2).filter((e) => e.kind === 'emitters');
    expect(ev.map((e) => e.kind === 'emitters' && e.emitters.length)).toEqual([2, 3]);
  });
});

describe('harmony', () => {
  it('computes sections from the step', () => {
    const len = sectionSteps(90, SECTION_BARS, HZ);
    expect(len).toBe(2560);
    expect(sectionAt(0, 0, 0, len)).toBe(0);
    expect(sectionAt(2559, 0, 0, len)).toBe(0);
    expect(sectionAt(2560, 0, 0, len)).toBe(1);
    expect(sectionAt(2560 * 4, 0, 0, len)).toBe(0);
    expect(sectionAt(2560 * 5 + 3, 0, 2, len)).toBe(3);
  });

  it('moves every slot by at most 3 semitones between neighbouring sections', () => {
    expect(midiAt(0, 0)).toBe(48);
    for (let slot = 0; slot < 16; slot++) {
      for (let s = 0; s < PROG.length; s++) {
        // 案1の「±2 半音」は G の第3音（E→G）だけ 3 半音になる。スケールは案1どおり
        expect(Math.abs(midiAt(slot, s) - midiAt(slot, (s + 1) % PROG.length))).toBeLessThanOrEqual(3);
      }
    }
  });

  it('tags hits with the section of the hit step, and re-anchors on setTempo', () => {
    const sim = setup();
    const hits = hitsOf(run(sim, 3000));
    expect(hits.some((h) => h.section === 0) && hits.some((h) => h.section === 1)).toBe(true);
    for (const h of hits) expect(h.section).toBe(Math.floor(h.step / 2560) % 4);

    // 区間1の途中でテンポ変更 → その時点から区間1を新しい長さ（120BPM = 1920 ステップ）で数え直す
    sim.enqueue({ kind: 'setTempo', bpm: 120, pattern: [2, 3] });
    run(sim, 1);
    expect(sim.sectionAt(3000)).toBe(1);
    expect(sim.sectionAt(3000 + 1919)).toBe(1);
    expect(sim.sectionAt(3000 + 1920)).toBe(2);
  });
});

describe('scene (P2)', () => {
  const scene: SceneData = {
    v: 1,
    bpm: 96,
    pattern: [2, 3],
    rotate: true,
    rotationSpeed: 0.35,
    drift: { mode: 'phrase', amp: 30 },
    segs: [
      [700, 300, 1000, 380, 1],
      [1100, 420, 1300, 360, -1],
      [600, 700, 1300, 760, 1],
      [850, 950, 950, 900, 1],
    ],
  };

  it('round-trips through encode/decode', () => {
    const code = encodeScene(scene);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeScene(code)).toEqual(scene);
  });

  it('rejects broken input and sanitizes values', () => {
    expect(decodeScene('')).toBeNull();
    expect(decodeScene('!!!')).toBeNull();
    expect(decodeScene('abc')).toBeNull();
    expect(validateScene({ ...scene, v: 2 })).toBeNull();
    expect(validateScene({ ...scene, pattern: [] })).toBeNull();
    expect(validateScene({ ...scene, drift: { mode: 'x', amp: 1 } })).toBeNull();
    expect(validateScene({ ...scene, segs: [[1, 2, 3, 4, 0]] })).toBeNull();
    const s = validateScene({ ...scene, drift: { mode: 'drift', amp: 999 }, segs: [[0, 0, 10, 0, 1], [-50, 10.4, 500, 10, 1]] })!;
    expect(s.drift.amp).toBe(80);
    expect(s.segs).toEqual([[0, 10, 500, 10, 1]]);
  });

  it('sceneFromSim returns the drawn coordinates, even while rotating', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'loadScene', scene });
    run(sim, 300);
    expect(sceneFromSim(sim)).toEqual(scene);
  });

  it('reproduces the same music after loadScene, regardless of prior state', () => {
    const a = new Sim({ bpm: 90, pattern: [2, 3] });
    a.enqueue({ kind: 'loadScene', scene });
    const ha = hitsOf(run(a, 4000));

    const b = setup(true, 'drift');
    run(b, 1234);
    b.enqueue({ kind: 'setTempo', bpm: 70, pattern: [1, 1.5] });
    run(b, 777);
    const at = b.step;
    b.enqueue({ kind: 'loadScene', scene });
    const hb = hitsOf(run(b, 4000));

    const key = (sim: Sim, from: number, hs: HitEvent[]) => {
      const ids = sim.segments.map((s) => s.id);
      return hs.map((h) => `${h.step - from}/${ids.indexOf(h.lineId)}/${h.midi}/${h.normalSpeed.toFixed(9)}`);
    };
    expect(ha.length).toBeGreaterThan(20);
    expect(key(b, at, hb)).toEqual(key(a, 0, ha));
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

describe('emission timing (D10)', () => {
  it('does not accumulate rounding error at BPMs that do not divide 7200', () => {
    const sim = new Sim({ bpm: 97, pattern: [2], drift: { mode: 'off', amp: 0 } });
    const emits: number[] = [];
    for (let i = 0; i < 120 * 300; i++) {
      sim.advance();
      for (const e of sim.drainEvents()) if (e.kind === 'emit') emits.push(e.step);
    }
    emits.forEach((step, k) => expect(Math.abs(step - (k * 2 * 7200) / 97)).toBeLessThanOrEqual(0.5));
  });
});
