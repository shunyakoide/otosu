// Standard MIDI File（フォーマット0、1トラック）の書き出し。純 TS。

export type SmfNote = {
  /** 開始（秒、録音開始からの経過） */
  time: number;
  /** 長さ（秒） */
  duration: number;
  note: number;
  velocity: number;
  channel: number;
};

export const PPQ = 480;

function varLen(n: number): number[] {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return out;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** 秒で与えたノート列を、指定テンポの SMF にする */
export function writeSmf(notes: readonly SmfNote[], bpm: number, trackName = 'otosu'): Uint8Array {
  const ticksPerSec = (bpm / 60) * PPQ;
  const toTick = (sec: number) => Math.max(0, Math.round(sec * ticksPerSec));

  type Ev = { tick: number; order: number; data: number[] };
  const evs: Ev[] = [];
  // 同じチャンネル・同じ音の次の note on の時刻（重なった音の note off が新しい音を切らないよう、そこで打ち切る）
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  const nextOn = new Map<SmfNote, number>();
  const lastByKey = new Map<number, SmfNote>();
  for (const n of sorted) {
    const key = (((n.channel - 1) & 0x0f) << 7) | (n.note & 0x7f);
    const prev = lastByKey.get(key);
    if (prev) nextOn.set(prev, n.time);
    lastByKey.set(key, n);
  }
  for (const n of sorted) {
    const ch = (n.channel - 1) & 0x0f;
    const on = toTick(n.time);
    const end = Math.min(n.time + n.duration, nextOn.get(n) ?? Infinity);
    const off = Math.max(on + 1, toTick(end));
    const vel = Math.min(127, Math.max(1, Math.round(n.velocity)));
    // 同じ tick では note off を先に置く（同じ音の連打で新しい音が消えないように）
    evs.push({ tick: on, order: 1, data: [0x90 | ch, n.note & 0x7f, vel] });
    evs.push({ tick: off, order: 0, data: [0x80 | ch, n.note & 0x7f, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  const name = Array.from(new TextEncoder().encode(trackName));
  track.push(0, 0xff, 0x03, ...varLen(name.length), ...name);
  const usPerBeat = Math.round(60_000_000 / bpm);
  track.push(0, 0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff);
  track.push(0, 0xff, 0x58, 0x04, 4, 2, 24, 8); // 4/4

  let last = 0;
  for (const e of evs) {
    track.push(...varLen(e.tick - last), ...e.data);
    last = e.tick;
  }
  track.push(0, 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length)];
  return new Uint8Array([...header, ...trackHeader, ...track]);
}
