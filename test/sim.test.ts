import { describe, expect, it } from 'vitest';
import { driftOffset, hitAllowed, normalizePoints, shapeAngle, Sim } from '../src/sim/sim';
import { formMidi, kickMidi, lengthToNote, midiAt, PROG, sectionAt, sectionRoot, sectionSteps, SONG_IDS, SONGS } from '../src/sim/music';
import { inferForm } from '../src/sim/form';
import { rayCapsule } from '../src/sim/collide';
import {
  BALL_LINE_COOLDOWN, BUMPER_MAX_SPEED, CHAIN_WINDOW, DRIFT_PERIOD, ENERGY_HITS, HZ, LINE_COOLDOWN, MAX_SEGS, SECTION_BARS, V_MIN,
} from '../src/sim/constants';
import { decodeScene, encodeScene, sceneFromSim, validateScene } from '../src/scene/scene';
import type { DriftMode, HitEvent, SceneData, SceneDataV1, ShapeAddedEvent, ShapeForm, SimEvent } from '../src/sim/types';

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
      const th = shapeAngle(seg, sim.step + 100);
      const halfLen = Math.hypot(seg.rbx - seg.rax, seg.rby - seg.ray) / 2;
      expect(seg.ax).toBeCloseTo(seg.cx - Math.cos(th) * halfLen, 9);
      expect(seg.ay).toBeCloseTo(seg.cy - Math.sin(th) * halfLen, 9);
      expect(seg.bx).toBeCloseTo(seg.cx + Math.cos(th) * halfLen, 9);
      expect(seg.by).toBeCloseTo(seg.cy + Math.sin(th) * halfLen, 9);
    }
    const poses = events.filter((e) => e.kind === 'shapePose');
    expect(poses.length).toBe(sim.shapes.size);
    for (const p of poses) {
      expect(p.kind === 'shapePose' && p.omega).toBe(0);
      expect(p.step).toBe(500);
    }
  });

  it('shapeAdded carries the drawn points relative to the centroid, unaffected by later rotation', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addSegment', ax: 700, ay: 300, bx: 1000, by: 380 });
    const [added] = run(sim, 1).filter((e): e is ShapeAddedEvent => e.kind === 'shapeAdded');
    sim.enqueue({ kind: 'setRotation', on: true, speed: 0.4 });
    run(sim, 10);
    expect(added!.points.flat().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-150, -40, 150, 40]);
    expect(sim.shapes.get(added!.group)!.points).toEqual([[700, 300], [1000, 380]]);
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

describe('play / stop (D50)', () => {
  it('stops emitting while stopped and resumes on the same beat grid', () => {
    const emits = (ev: SimEvent[]) => ev.filter((e) => e.kind === 'emit').map((e) => `${e.step}/${e.kind === 'emit' && e.emitterId}`);
    const ref = setup();
    const all = emits(run(ref, 3000));
    const sim = setup();
    run(sim, 1000);
    sim.enqueue({ kind: 'setPlaying', on: false });
    const stopped = run(sim, 1000);
    expect(emits(stopped)).toEqual([]);
    sim.enqueue({ kind: 'setPlaying', on: true });
    const after = emits(run(sim, 1000));
    expect(after.length).toBeGreaterThan(0);
    expect(after).toEqual(all.filter((e) => Number(e.split('/')[0]) >= 2000));
  });

  it('slows rotation down to a stop without jumping, and spins up again', () => {
    const sim = setup(true);
    run(sim, 500);
    const w0 = Math.abs(sim.segments[0]!.omega);
    sim.enqueue({ kind: 'setPlaying', on: false });
    let prev = shapeAngle(sim.segments[0]!, sim.step);
    let maxJump = 0;
    const speeds: number[] = [];
    for (let i = 0; i < 300; i++) {
      run(sim, 1);
      const a = shapeAngle(sim.segments[0]!, sim.step);
      maxJump = Math.max(maxJump, Math.abs(a - prev));
      prev = a;
      speeds.push(Math.abs(sim.segments[0]!.omega));
    }
    expect(maxJump).toBeLessThanOrEqual(w0 / 120 + 1e-9);
    expect(speeds[60]!).toBeLessThan(w0);
    expect(speeds[60]!).toBeGreaterThan(0);
    expect(speeds.at(-1)).toBe(0);
    sim.enqueue({ kind: 'setPlaying', on: true });
    run(sim, 300);
    expect(Math.abs(sim.segments[0]!.omega)).toBeCloseTo(w0, 9);
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

  // D48: 曲を選べる
  it('keeps every song smooth: 4 sections of 5 ascending pitch classes, neighbours within 3 semitones', () => {
    for (const id of SONG_IDS) {
      const song = SONGS[id];
      expect(song.scales.length).toBe(PROG.length);
      expect(song.roots.length).toBe(PROG.length);
      for (const sc of song.scales) {
        expect(sc.length).toBe(5);
        for (let i = 1; i < 5; i++) expect(sc[i]!).toBeGreaterThan(sc[i - 1]!);
      }
      for (let slot = 0; slot < 16; slot++) {
        for (let s = 0; s < PROG.length; s++) {
          expect(Math.abs(midiAt(slot, s, id) - midiAt(slot, (s + 1) % PROG.length, id))).toBeLessThanOrEqual(3);
        }
      }
    }
    // 最初の曲はこれまでと同じ音
    for (let s = 0; s < 4; s++) expect(midiAt(3, s, 'bright')).toBe(midiAt(3, s));
  });

  it('switches the song: hits use its scale, and a section event carries the new root', () => {
    const sim = setup();
    run(sim, 10);
    sim.enqueue({ kind: 'setSong', song: 'dusk' });
    const events = run(sim, 3000);
    const sec = events.find((e) => e.kind === 'section');
    expect(sec && sec.kind === 'section' && sec.root).toBe(sectionRoot(sec && sec.kind === 'section' ? sec.section : 0, 'dusk'));
    const hits = hitsOf(events);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.midi).toBe(formMidi(h.form, h.note, h.section, 'dusk'));
    expect(sceneFromSim(sim).song).toBe('dusk');
  });

  it('saves the song in the scene only when it is not the default, and ignores unknown songs', () => {
    const sim = setup();
    run(sim, 1);
    expect(sceneFromSim(sim).song).toBeUndefined();
    const scene = { ...sceneFromSim(sim), song: 'wistful' };
    expect(decodeScene(encodeScene(scene as SceneData))!.song).toBe('wistful');
    expect(validateScene({ ...scene, song: 'nope' })!.song).toBeUndefined();
    const loaded = new Sim({ bpm: 90, pattern: [2, 3] });
    loaded.enqueue({ kind: 'loadScene', scene: scene as SceneData });
    run(loaded, 1);
    expect(loaded.song).toBe('wistful');
  });
});

function polygon(cx: number, cy: number, r: number, n: number, rot = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });
}

describe('shapes (D12)', () => {
  it('uses one note per shape from its perimeter, and hits carry group/segKind', () => {
    const sim = new Sim({ bpm: 90, pattern: [2], drift: { mode: 'off', amp: 0 } });
    const sq: [number, number][] = [[910, 500], [1010, 500], [1010, 600], [910, 600]];
    sim.enqueue({ kind: 'addShape', points: sq, closed: true, segKind: 'line' });
    const events = run(sim, 600);
    const added = events.find((e) => e.kind === 'shapeAdded')!;
    expect(added.kind === 'shapeAdded' && added.points.length).toBe(4);
    const note = lengthToNote(400).index;
    expect(sim.segments.length).toBe(4);
    expect(sim.segments.every((s) => s.group === sim.segments[0]!.group)).toBe(true);
    expect(sim.shapes.get(sim.segments[0]!.group)!.note).toBe(note);
    expect(added.kind === 'shapeAdded' && [added.gx, added.gy, added.note]).toEqual([960, 550, note]);
    const hits = hitsOf(events);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.group).toBe(sim.segments[0]!.group);
      expect(h.segKind).toBe('line');
      expect(h.note).toBe(note);
    }
  });

  it('rotates the whole shape around its centroid', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addShape', points: polygon(960, 540, 100, 3), closed: true, segKind: 'line' });
    sim.enqueue({ kind: 'setRotation', on: true, speed: 0.5 });
    run(sim, 1);
    const before = sim.segments.map((s) => [s.ax, s.ay]);
    run(sim, 240);
    const sh = [...sim.shapes.values()][0]!;
    for (const s of sim.segments) expect(Math.hypot(s.ax - sh.gx, s.ay - sh.gy)).toBeCloseTo(sh.radius, 0);
    expect(sim.segments.map((s) => [s.ax, s.ay])).not.toEqual(before);
    // 辺どうしはつながったまま
    for (let i = 0; i < 3; i++) {
      const a = sim.segments[i]!;
      const b = sim.segments[(i + 1) % 3]!;
      expect(a.bx).toBeCloseTo(b.ax, 9);
      expect(a.by).toBeCloseTo(b.ay, 9);
    }
  });

  it('sounds only once when a ball hits a corner (two edges of the same shape)', () => {
    const sim = new Sim({ bpm: 90, pattern: [2], drift: { mode: 'off', amp: 0 } });
    // 放出口（x=960）の真下に頂点
    sim.enqueue({ kind: 'addShape', points: [[900, 560], [960, 500], [1020, 560]], closed: true, segKind: 'line' });
    const hits = hitsOf(run(sim, 160));
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0]!;
    expect(hits.filter((h) => h.step - first.step < LINE_COOLDOWN).length).toBe(1);
  });

  it('removeSegment removes the whole shape', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addShape', points: polygon(500, 500, 80, 4), closed: true, segKind: 'line' });
    sim.enqueue({ kind: 'addSegment', ax: 100, ay: 900, bx: 400, by: 900 });
    run(sim, 1);
    const g = sim.segments[2]!.group;
    sim.enqueue({ kind: 'removeSegment', id: sim.segments[2]!.id });
    const ev = run(sim, 1);
    expect(ev.filter((e) => e.kind === 'shapeRemoved')).toEqual([{ kind: 'shapeRemoved', step: 1, group: g }]);
    expect(sim.segments.length).toBe(1);
    expect(sim.shapes.size).toBe(1);
  });

  it('does not add a shape that would exceed MAX_SEGS', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    for (let i = 0; i < 17; i++) {
      sim.enqueue({ kind: 'addShape', points: polygon(100 + i * 100, 500, 40, 24), closed: true, segKind: 'line' });
    }
    run(sim, 1);
    expect(sim.shapes.size).toBe(16);
    expect(sim.segments.length).toBe(16 * 24);
    expect(sim.segments.length).toBeLessThanOrEqual(MAX_SEGS);
  });

  it('rejects degenerate shapes', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addShape', points: [[10, 10], [10, 10]], closed: false, segKind: 'line' });
    sim.enqueue({ kind: 'addShape', points: [[10, 10], [60, 10]], closed: true, segKind: 'line' });
    sim.enqueue({ kind: 'addShape', points: [[10, 10], [30, 10]], closed: false, segKind: 'line' });
    run(sim, 1);
    expect(sim.shapes.size).toBe(0);
  });
});

describe('bumper (D13)', () => {
  const bounceSeq = (kind: 'line' | 'bumper') => {
    const sim = new Sim({ bpm: 90, pattern: [8], drift: { mode: 'off', amp: 0 } });
    sim.enqueue({ kind: 'addShape', points: [[760, 700], [1160, 700]], closed: false, segKind: kind });
    return hitsOf(run(sim, 120 * 12)).filter((h) => h.ballId === 1).map((h) => h.normalSpeed);
  };

  it('bounces higher than it fell, up to the speed cap', () => {
    const b = bounceSeq('bumper');
    expect(b.length).toBeGreaterThanOrEqual(3);
    expect(b[1]!).toBeGreaterThan(b[0]!);
    expect(b[2]!).toBeGreaterThanOrEqual(b[1]! - 20);
    for (const v of b) expect(v).toBeLessThanOrEqual(BUMPER_MAX_SPEED + 20);
    const l = bounceSeq('line');
    expect(l[1]!).toBeLessThan(l[0]!);
  });

  it('bounds the energy: a bumper never launches faster than the cap', () => {
    const sim = new Sim({ bpm: 90, pattern: [1], drift: { mode: 'off', amp: 0 } });
    sim.enqueue({ kind: 'addShape', points: [[700, 900], [1220, 900]], closed: false, segKind: 'bumper' });
    sim.enqueue({ kind: 'addShape', points: [[700, 300], [1000, 360]], closed: false, segKind: 'bumper' });
    for (let i = 0; i < 120 * 10; i++) {
      sim.advance();
      // 力学的エネルギー v²/2 − G·y（y 下向き）はバンパーでしか増えず、そこで速さが上限に抑えられる
      // → 一番高いバンパー（y ≥ 290）で上限の速さのときを超えない（離散化の誤差ぶん少し余裕を見る）
      const limit = (BUMPER_MAX_SPEED * BUMPER_MAX_SPEED) / 2 - 1400 * 290;
      for (const b of sim.balls) expect((b.vx * b.vx + b.vy * b.vy) / 2 - 1400 * b.y).toBeLessThanOrEqual(limit * 1.02 + 20000);
    }
  });
});

describe('chain / energy / section (D14)', () => {
  const stairs = () => {
    const sim = new Sim({ bpm: 90, pattern: [2, 3], drift: { mode: 'drift', amp: 24 } });
    sim.enqueue({ kind: 'addShape', points: [[850, 300], [1100, 360]], closed: false, segKind: 'line' });
    sim.enqueue({ kind: 'addShape', points: [[1050, 520], [800, 600]], closed: false, segKind: 'bumper' });
    sim.enqueue({ kind: 'addShape', points: polygon(900, 800, 60, 24), closed: true, segKind: 'line' });
    sim.enqueue({ kind: 'addShape', points: [[600, 950], [700, 900], [800, 960], [900, 930], [1000, 990]], closed: false, segKind: 'line' });
    sim.enqueue({ kind: 'setRotation', on: true, speed: 0.3 });
    return sim;
  };

  it('is deterministic: same commands → same event stream', () => {
    const a = JSON.stringify(run(stairs(), 6000));
    const b = JSON.stringify(run(stairs(), 6000));
    expect(a).toBe(b);
  });

  it('counts chains across different shapes within the window', () => {
    const hits = hitsOf(run(stairs(), 6000));
    expect(Math.max(...hits.map((h) => h.chain))).toBeGreaterThanOrEqual(2);
    const last = new Map<number, HitEvent>();
    for (const h of hits) {
      const p = last.get(h.ballId);
      const expected = p && h.step - p.step <= CHAIN_WINDOW && p.group !== h.group ? p.chain + 1 : 1;
      expect(h.chain).toBe(expected);
      last.set(h.ballId, h);
    }
  });

  it('computes energy from the hits in the last 2 bars', () => {
    const sim = stairs();
    const hits = hitsOf(run(sim, 6000));
    const W = sim.energyWindow;
    expect(W).toBe(640);
    for (const h of hits) {
      // 同じステップの衝突は処理順しだいで数えるかが変わるので、その幅で確かめる
      const c = h.step;
      const before = hits.filter((x) => x.step > c - W && x.step < c).length;
      const same = hits.filter((x) => x.step === c).length;
      expect(h.energy * ENERGY_HITS).toBeGreaterThanOrEqual(Math.min(ENERGY_HITS, before + 1) - 1e-9);
      expect(h.energy * ENERGY_HITS).toBeLessThanOrEqual(Math.min(ENERGY_HITS, before + same) + 1e-9);
    }
  });

  it('emits section events at start and on each change', () => {
    const ev = run(new Sim({ bpm: 90, pattern: [2] }), 2560 * 2 + 1).filter((e) => e.kind === 'section');
    expect(ev).toEqual([
      { kind: 'section', step: 0, section: 0, root: 0 },
      { kind: 'section', step: 2560, section: 1, root: 5 },
      { kind: 'section', step: 5120, section: 2, root: 0 },
    ]);
  });

  it('shapeAdded carries the midi of the section at that step', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    run(sim, 2600);
    sim.enqueue({ kind: 'addShape', points: polygon(500, 500, 80, 4), closed: true, segKind: 'line' });
    const added = run(sim, 1).find((e) => e.kind === 'shapeAdded')!;
    expect(added.kind === 'shapeAdded' && added.midi).toBe(midiAt(added.kind === 'shapeAdded' ? added.note : 0, 1));
  });
});

describe('scene (P2 / v2)', () => {
  const scene: SceneData = {
    v: 2,
    bpm: 96,
    pattern: [2, 3],
    rotate: true,
    rotationSpeed: 0.35,
    drift: { mode: 'phrase', amp: 30 },
    shapes: [
      ['line', 1, false, 700, 300, 1000, 380],
      ['bumper', -1, false, 1100, 420, 1300, 360],
      ['line', 1, true, 900, 700, 1000, 700, 950, 620],
      ['line', -1, false, 600, 900, 700, 860, 800, 910, 900, 880],
    ],
    forms: ['line', 'line', 'triangle', 'pen'],
  };

  it('round-trips through encode/decode', () => {
    const code = encodeScene(scene);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeScene(code)).toEqual(scene);
  });

  it('reads v1 and converts it to v2 lines', () => {
    const v1: SceneDataV1 = {
      v: 1, bpm: 90, pattern: [2, 3], rotate: false, rotationSpeed: 0.3, drift: { mode: 'drift', amp: 24 },
      segs: [[700, 300, 1000, 380, 1], [1100, 420, 1300, 360, -1], [0, 0, 10, 0, 1]],
    };
    const code = encodeScene(v1 as unknown as SceneData);
    expect(decodeScene(code)).toEqual({
      ...v1,
      v: 2,
      segs: undefined,
      shapes: [['line', 1, false, 700, 300, 1000, 380], ['line', -1, false, 1100, 420, 1300, 360]],
      forms: ['line', 'line'],
    } as unknown as SceneData);
    // v1 を読み込んだ sim は、同じ線を addSegment した sim と同じ音を出す
    const a = new Sim({ bpm: 90, pattern: [2, 3] });
    a.enqueue({ kind: 'loadScene', scene: decodeScene(code)! });
    const b = new Sim({ bpm: 90, pattern: [2, 3] });
    b.enqueue({ kind: 'addSegment', ax: 700, ay: 300, bx: 1000, by: 380, dir: 1 });
    b.enqueue({ kind: 'addSegment', ax: 1100, ay: 420, bx: 1300, by: 360, dir: -1 });
    const key = (hs: HitEvent[]) => hs.map((h) => `${h.step}/${h.midi}/${h.normalSpeed}`);
    expect(key(hitsOf(run(a, 3000)))).toEqual(key(hitsOf(run(b, 3000))));
  });

  it('rejects broken input and sanitizes values', () => {
    expect(decodeScene('')).toBeNull();
    expect(decodeScene('!!!')).toBeNull();
    expect(decodeScene('abc')).toBeNull();
    expect(validateScene({ ...scene, v: 3 })).toBeNull();
    expect(validateScene({ ...scene, pattern: [] })).toBeNull();
    expect(validateScene({ ...scene, drift: { mode: 'x', amp: 1 } })).toBeNull();
    expect(validateScene({ ...scene, shapes: [['arc', 1, false, 0, 0, 100, 0]] })).toBeNull();
    expect(validateScene({ ...scene, shapes: [['line', 0, false, 0, 0, 100, 0]] })).toBeNull();
    expect(validateScene({ ...scene, shapes: [['line', 1, false, 0, 0, 100]] })).toBeNull();
    const s = validateScene({
      ...scene,
      drift: { mode: 'drift', amp: 999 },
      shapes: [['line', 1, false, 0, 0, 10, 0], ['line', 1, false, -5000, 10.4, 500, 10], ['line', 1, true, 5, 5, 200, 5, 100, 100, 5, 5]],
    })!;
    expect(s.drift.amp).toBe(80);
    expect(s.shapes).toEqual([['line', 1, false, -1920, 10, 500, 10], ['line', 1, true, 5, 5, 200, 5, 100, 100]]);
  });

  it('places shapes outside the 16:9 world and culls balls by the view (D23)', () => {
    // 閉じた図形は置ける範囲に収まるよう平行移動、開いた線は点ごとにクランプ
    expect(normalizePoints([[100, 4400], [200, 4400], [150, 4500]], true)).toEqual([[100, 4220], [200, 4220], [150, 4320]]);
    expect(normalizePoints([[-100, 1500], [2000, 1500]], false, { minX: 0, maxX: 1920, maxY: 2000 })).toEqual([[0, 1500], [1920, 1500]]);
    const hitsBelow = (maxY: number) => {
      const sim = new Sim({ bpm: 90, pattern: [2] });
      sim.enqueue({ kind: 'setView', bounds: { minX: -9999, maxX: 9999, maxY } });
      sim.enqueue({ kind: 'addShape', points: [[500, 1600], [1400, 1700]], closed: false, segKind: 'line' });
      run(sim, 1);
      return { view: sim.view, n: run(sim, 1500).filter((e) => e.kind === 'hit' && e.y > 1080).length };
    };
    const tall = hitsBelow(2000);
    expect(tall.view).toEqual({ minX: -1920, maxX: 3840, maxY: 2000 });
    expect(tall.n).toBeGreaterThan(0);
    // 表示範囲がワールドだけなら、下の図形に届く前にボールが消える
    expect(hitsBelow(0).n).toBe(0);
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
      return hs.map(
        (h) => `${h.step - from}/${ids.indexOf(h.lineId)}/${h.midi}/${h.chain}/${h.energy}/${h.normalSpeed.toFixed(9)}`,
      );
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

describe('forms (D16)', () => {
  it('infers the form from the normalized points, and an explicit form wins', () => {
    expect(inferForm(2, false)).toBe('line');
    expect(inferForm(5, false)).toBe('pen');
    expect(inferForm(3, true)).toBe('triangle');
    expect(inferForm(4, true)).toBe('square');
    expect(inferForm(24, true)).toBe('circle');
    expect(inferForm(7, true)).toBe('pen');

    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addSegment', ax: 100, ay: 100, bx: 300, by: 100 });
    sim.enqueue({ kind: 'addShape', points: [[100, 200], [200, 250], [300, 200]], closed: false, segKind: 'line' });
    sim.enqueue({ kind: 'addShape', points: polygon(500, 500, 60, 3), closed: true, segKind: 'line' });
    sim.enqueue({ kind: 'addShape', points: polygon(700, 500, 60, 4), closed: true, segKind: 'line' });
    sim.enqueue({ kind: 'addShape', points: polygon(900, 500, 60, 24), closed: true, segKind: 'bumper' });
    // 形の指定は推定より優先（4点の閉じた図形でもペンで描いたならペン）
    sim.enqueue({ kind: 'addShape', points: polygon(1100, 500, 60, 4), closed: true, segKind: 'line', form: 'pen' });
    const added = run(sim, 1).filter((e): e is ShapeAddedEvent => e.kind === 'shapeAdded');
    expect(added.map((e) => e.form)).toEqual(['line', 'pen', 'triangle', 'square', 'circle', 'pen']);
    expect([...sim.shapes.values()].map((sh) => sh.form)).toEqual(added.map((e) => e.form));
    for (const e of added) expect(e.midi).toBe(formMidi(e.form, e.note, 0));
    expect(added[4]!.midi).toBe(kickMidi(added[4]!.note, 0));
  });
});

describe('circle kick (D16)', () => {
  /** 放出口の真下に円（または同じ点列を別の形で） */
  const drum = (form: ShapeForm, pattern: number[] = [0.25], bpm = 90) => {
    const sim = new Sim({ bpm, pattern, drift: { mode: 'off', amp: 0 } });
    sim.enqueue({ kind: 'addShape', points: polygon(960, 700, 90, 24, 0.1), closed: true, segKind: 'line', form });
    sim.enqueue({ kind: 'addShape', points: [[700, 980], [1220, 1000]], closed: false, segKind: 'bumper' });
    return sim;
  };
  const circleGroup = 1;

  it('sounds once at the contact, like any other shape, pitched to the section root', () => {
    const hs = hitsOf(run(drum('circle'), 120 * 20)).filter((h) => h.group === circleGroup);
    expect(hs.length).toBeGreaterThan(3);
    for (const h of hs) {
      expect(h.form).toBe('circle');
      expect(h.midi).toBe(kickMidi(h.note, h.section));
    }
    // 形は物理にも発音のタイミングにも影響しない
    const pen = hitsOf(run(drum('pen'), 120 * 20)).filter((h) => h.group === circleGroup);
    expect(hs.map((h) => [h.step, h.velocity])).toEqual(pen.map((h) => [h.step, h.velocity]));
  });

  it('is deterministic, including after loadScene', () => {
    const a = JSON.stringify(run(drum('circle'), 5000));
    const b = JSON.stringify(run(drum('circle'), 5000));
    expect(a).toBe(b);

    const src = drum('circle');
    run(src, 1);
    const scene = sceneFromSim(src);
    const x = new Sim({ bpm: 90, pattern: [2] });
    x.enqueue({ kind: 'loadScene', scene });
    const y = setup(true, 'drift');
    run(y, 999);
    const at = y.step;
    y.enqueue({ kind: 'loadScene', scene });
    const key = (from: number, hs: HitEvent[]) => hs.map((h) => `${h.step - from}/${h.form}/${h.midi}/${h.velocity}`);
    const hx = hitsOf(run(x, 3000));
    expect(hx.some((h) => h.form === 'circle')).toBe(true);
    expect(key(at, hitsOf(run(y, 3000)))).toEqual(key(0, hx));
  });
});

describe('scene forms (D18)', () => {
  const base = {
    v: 2, bpm: 90, pattern: [2], rotate: false, rotationSpeed: 0.3, drift: { mode: 'off', amp: 0 },
  } as const;
  const tri = ['line', 1, true, 900, 700, 1000, 700, 950, 620] as const;
  const seg = ['line', 1, false, 100, 100, 400, 100] as const;

  it('round-trips forms through sceneFromSim / encode / loadScene', () => {
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'addShape', points: polygon(500, 500, 60, 4), closed: true, segKind: 'line', form: 'pen' });
    sim.enqueue({ kind: 'addShape', points: polygon(800, 500, 60, 24), closed: true, segKind: 'line' });
    sim.enqueue({ kind: 'addSegment', ax: 100, ay: 900, bx: 400, by: 900 });
    run(sim, 1);
    const scene = sceneFromSim(sim);
    expect(scene.forms).toEqual(['pen', 'circle', 'line']);
    const back = decodeScene(encodeScene(scene))!;
    expect(back).toEqual(scene);
    const re = new Sim({ bpm: 90, pattern: [2] });
    re.enqueue({ kind: 'loadScene', scene: back });
    const added = run(re, 1).filter((e): e is ShapeAddedEvent => e.kind === 'shapeAdded');
    expect(added.map((e) => e.form)).toEqual(['pen', 'circle', 'line']);
  });

  it('infers forms for old scenes, wrong lengths and invalid entries', () => {
    expect(validateScene({ ...base, shapes: [tri, seg] })!.forms).toEqual(['triangle', 'line']);
    expect(validateScene({ ...base, shapes: [tri, seg], forms: ['circle'] })!.forms).toEqual(['triangle', 'line']);
    expect(validateScene({ ...base, shapes: [tri, seg], forms: ['square', 'wave'] })!.forms).toEqual(['square', 'line']);
    // 捨てられた図形の form も一緒に捨てる（順番がずれない）
    const tiny = ['line', 1, false, 0, 0, 10, 0];
    expect(validateScene({ ...base, shapes: [tiny, tri, seg], forms: ['circle', 'pen', 'square'] })!.forms).toEqual(['pen', 'square']);
    // forms の無いシーンを読み込んでも鳴る
    const sim = new Sim({ bpm: 90, pattern: [2] });
    sim.enqueue({ kind: 'loadScene', scene: validateScene({ ...base, shapes: [tri] })! });
    expect([...sim.shapes.values()].length).toBe(0);
    run(sim, 1);
    expect([...sim.shapes.values()].map((sh) => sh.form)).toEqual(['triangle']);
  });
});

describe('shape effects (D32)', () => {
  /** 放出口の真下に線を1本。エフェクトを付けて返す */
  const one = (effect: 'none' | 'echo' | 'rise' | 'chord', form: ShapeForm = 'line') => {
    const sim = new Sim({ bpm: 90, pattern: [4], drift: { mode: 'off', amp: 0 } });
    sim.enqueue({ kind: 'addShape', points: [[860, 600], [1060, 640]], closed: false, segKind: 'line', form });
    run(sim, 1);
    sim.enqueue({ kind: 'setEffect', group: 1, effect });
    return sim;
  };
  const beat = (HZ * 60) / 90;

  it('does not change the physics or the direct hits', () => {
    const key = (hs: HitEvent[]) => hs.filter((h) => h.echo === 0 && h.voice === 0).map((h) => `${h.step}/${h.velocity}`);
    const plain = key(hitsOf(run(one('none'), 120 * 20)));
    expect(plain.length).toBeGreaterThan(5);
    for (const fx of ['echo', 'rise', 'chord'] as const) expect(key(hitsOf(run(one(fx), 120 * 20)))).toEqual(plain);
  });

  it('echo repeats on the following beats, quieter each time', () => {
    const hs = hitsOf(run(one('echo'), 120 * 6));
    const hit = hs.find((h) => h.echo === 0)!;
    const echoes = hs.filter((h) => h.echo > 0 && h.step < hit.step + 4 * beat + 1);
    expect(echoes.map((h) => h.echo)).toEqual([1, 2, 3]);
    for (const e of echoes) {
      expect(Math.abs(e.step / beat - Math.round(e.step / beat))).toBeLessThan(1e-9 + 0.5 / beat);
      expect(e.step - hit.step).toBeGreaterThanOrEqual(beat / 2);
      expect(e.note).toBe(hit.note);
      expect(e.velocity).toBeLessThan(hit.velocity);
    }
  });

  it('rise climbs the scale and stops at the top', () => {
    const hs = hitsOf(run(one('rise'), 120 * 6));
    const hit = hs.find((h) => h.echo === 0)!;
    const rise = hs.filter((h) => h.echo > 0 && h.step < hit.step + 3 * beat);
    expect(rise.map((h) => h.note)).toEqual(rise.map((_, i) => hit.note + i + 1));
    expect(rise.length).toBeGreaterThan(0);
    for (const h of rise) expect(h.midi).toBe(formMidi('line', h.note, h.section));
  });

  it('chord adds two voices at the same step', () => {
    const hs = hitsOf(run(one('chord'), 120 * 6));
    const hit = hs.find((h) => h.voice === 0)!;
    const same = hs.filter((h) => h.step === hit.step);
    expect(same.map((h) => h.voice)).toEqual([0, 1, 2]);
    expect(new Set(same.map((h) => h.midi)).size).toBe(3);
  });

  it('drops pending repeats when the effect changes or the shape goes', () => {
    for (const cmd of [{ kind: 'setEffect', group: 1, effect: 'none' }, { kind: 'removeShape', group: 1 }] as const) {
      const sim = one('echo');
      while (!hitsOf(run(sim, 1)).length);
      sim.enqueue(cmd);
      expect(hitsOf(run(sim, Math.round(beat * 2))).filter((h) => h.echo > 0)).toEqual([]);
    }
  });

  it('round-trips effects through the scene and stays deterministic', () => {
    const src = one('rise', 'circle');
    run(src, 1);
    const scene = sceneFromSim(src);
    expect(scene.effects).toEqual(['rise']);
    const back = decodeScene(encodeScene(scene))!;
    expect(back.effects).toEqual(['rise']);
    const a = new Sim({ bpm: 90, pattern: [4] });
    a.enqueue({ kind: 'loadScene', scene: back });
    const b = new Sim({ bpm: 90, pattern: [4] });
    b.enqueue({ kind: 'loadScene', scene: back });
    expect(JSON.stringify(run(a, 3000))).toBe(JSON.stringify(run(b, 3000)));
    // エフェクトが無ければ書かない。不正な値は none
    expect(sceneFromSim(one('none')).effects).toBeUndefined();
    const seg = ['line', 1, false, 100, 100, 400, 100];
    const base = { v: 2, bpm: 90, pattern: [2], rotate: false, rotationSpeed: 0.3, drift: { mode: 'off', amp: 0 } };
    expect(validateScene({ ...base, shapes: [seg, seg], effects: ['echo', 'reverb'] })!.effects).toEqual(['echo', 'none']);
  });
});
