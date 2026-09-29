import { describe, expect, it } from 'vitest';
import { noteName } from '../src/render/notes';

describe('noteName (D62)', () => {
  it('names notes with flats and octave numbers (C4 = 60)', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(63)).toBe('E♭4');
    expect(noteName(68)).toBe('A♭4');
    expect(noteName(24)).toBe('C1');
    expect(noteName(83)).toBe('B5');
  });
});
