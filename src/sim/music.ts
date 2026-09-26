import { WORLD_W } from './constants';

// 音程のマッピング。audio（周波数）と render（色）の両方から使う純関数。

export const ROOT_MIDI = 48; // C3
export const PENTA = [0, 2, 4, 7, 9] as const;
/** C3〜C6 の16音 */
export const NOTE_COUNT = 16;

const R_MIN = 0.03;
const R_MAX = 0.6;

export type Note = {
  /** 0 = 最低音 … 15 = 最高音 */
  index: number;
  /** ペンタトニック内の度数 0..4 */
  degree: number;
  octave: number;
  midi: number;
};

export function noteFromIndex(index: number): Note {
  const degree = index % 5;
  const octave = Math.floor(index / 5);
  return { index, degree, octave, midi: ROOT_MIDI + 12 * octave + PENTA[degree]! };
}

/** 線の長さ（論理 px）→ 音程。長いほど低い、対数マッピング */
export function lengthToNote(lengthPx: number): Note {
  const r = Math.min(R_MAX, Math.max(R_MIN, lengthPx / WORLD_W));
  const t = Math.log(r / R_MIN) / Math.log(R_MAX / R_MIN);
  return noteFromIndex(Math.round((1 - t) * (NOTE_COUNT - 1)));
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
