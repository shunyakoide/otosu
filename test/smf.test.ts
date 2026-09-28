import { describe, expect, it } from 'vitest';
import { channelBits, midiVelocity, noteKey, PPQ, writeSmf } from '../src/midi/smf';

function readVarLen(b: Uint8Array, i: number): [number, number] {
  let v = 0;
  for (;;) {
    const x = b[i++]!;
    v = (v << 7) | (x & 0x7f);
    if (!(x & 0x80)) return [v, i];
  }
}

/** トラックのチャンネルイベントを [tick, status, d1, d2] で返す */
function parse(b: Uint8Array): number[][] {
  expect(String.fromCharCode(...b.slice(0, 4))).toBe('MThd');
  expect((b[12]! << 8) | b[13]!).toBe(PPQ);
  expect(String.fromCharCode(...b.slice(14, 18))).toBe('MTrk');
  const len = (b[18]! << 24) | (b[19]! << 16) | (b[20]! << 8) | b[21]!;
  expect(22 + len).toBe(b.length);
  const out: number[][] = [];
  let i = 22;
  let tick = 0;
  while (i < b.length) {
    const [dt, j] = readVarLen(b, i);
    i = j;
    tick += dt;
    const st = b[i]!;
    if (st === 0xff) {
      const [l, k] = readVarLen(b, i + 2);
      i = k + l;
    } else {
      out.push([tick, st, b[i + 1]!, b[i + 2]!]);
      i += 3;
    }
  }
  return out;
}

describe('writeSmf', () => {
  it('writes notes at the right ticks', () => {
    // 120BPM: 1秒 = 2拍 = 960 tick
    const data = writeSmf([{ time: 1, duration: 0.5, note: 60, velocity: 100, channel: 1 }], 120);
    expect(parse(data)).toEqual([
      [960, 0x90, 60, 100],
      [1440, 0x80, 60, 0],
    ]);
  });

  it('puts note off before note on at the same tick (retrigger)', () => {
    const data = writeSmf(
      [
        { time: 0, duration: 0.5, note: 64, velocity: 80, channel: 2 },
        { time: 0.5, duration: 0.5, note: 64, velocity: 90, channel: 2 },
      ],
      120,
    );
    expect(parse(data).map((e) => [e[0], e[1]])).toEqual([
      [0, 0x91],
      [480, 0x81],
      [480, 0x91],
      [960, 0x81],
    ]);
  });

  it('cuts an overlapping note at the next note on of the same pitch', () => {
    // 0.4s の音を 0.2s 間隔で2回: 1音目は 0.2s（2音目の on）で切れる
    const data = writeSmf(
      [
        { time: 0, duration: 0.4, note: 60, velocity: 80, channel: 1 },
        { time: 0.2, duration: 0.4, note: 60, velocity: 80, channel: 1 },
      ],
      120,
    );
    expect(parse(data).map((e) => [e[0], e[1]])).toEqual([
      [0, 0x90],
      [192, 0x80],
      [192, 0x90],
      [576, 0x80],
    ]);
  });

  it('keeps one note when the same pitch starts twice at the same tick', () => {
    // 反響と直接の衝突が同じステップに重なったとき、1 tick で切れる音を作らない
    const data = writeSmf(
      [
        { time: 0.5, duration: 0.5, note: 60, velocity: 70, channel: 1 },
        { time: 0.5, duration: 0.5, note: 60, velocity: 90, channel: 1 },
      ],
      120,
    );
    expect(parse(data)).toEqual([
      [480, 0x90, 60, 90],
      [960, 0x80, 60, 0],
    ]);
  });

  it('handles long gaps (multi-byte delta)', () => {
    const data = writeSmf([{ time: 300, duration: 1, note: 48, velocity: 1, channel: 16 }], 90);
    const ev = parse(data);
    expect(ev[0]).toEqual([Math.round(300 * 1.5 * PPQ), 0x9f, 48, 1]);
  });
});

describe('MIDI helpers', () => {
  it('maps channel 1..16 to 0..15, keys by channel and note, and clamps velocity to 1..127', () => {
    expect([channelBits(1), channelBits(10), channelBits(16)]).toEqual([0, 9, 15]);
    expect(noteKey(9, 36)).toBe((9 << 7) | 36);
    expect(noteKey(0, 60)).not.toBe(noteKey(1, 60));
    expect([midiVelocity(0), midiVelocity(0.4 * 127), midiVelocity(200), midiVelocity(63.5)]).toEqual([1, 51, 127, 64]);
  });
});
