import { Color } from 'three';
import { noteFromIndex } from '../sim/music';

// ペンタトニックの5度数 → 5色。長い線（低音）が寒色側、短い線（高音）が暖色側。
const DEGREE_HEX = [0x3d6bff, 0x2ec8e6, 0x3ddc97, 0xffb23f, 0xff5a6e] as const;
const OCTAVE_GAIN = [0.8, 0.9, 1.0, 1.1] as const;

export const OFF_WHITE = new Color(0xe8ecf2);
export const GRAY = new Color(0x555555);

export type ColorMode = 'pitch' | 'mono';

const cache: Color[] = [];

export function noteColor(note: number, mode: ColorMode): Color {
  if (mode === 'mono') return OFF_WHITE;
  let c = cache[note];
  if (!c) {
    const n = noteFromIndex(note);
    c = new Color(DEGREE_HEX[n.degree]!).multiplyScalar(OCTAVE_GAIN[n.octave] ?? 1);
    cache[note] = c;
  }
  return c;
}
