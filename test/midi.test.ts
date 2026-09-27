import { describe, expect, it } from 'vitest';
import { gmDrum } from '../src/midi/midi';

describe('gmDrum（D19）', () => {
  it('円はキック／タム、四角はウッドブロック、それ以外は旋律', () => {
    expect(gmDrum({ form: 'circle', note: 0 })).toBe(36);
    expect(gmDrum({ form: 'circle', note: 7 })).toBe(45);
    expect(gmDrum({ form: 'circle', note: 15 })).toBe(48);
    expect(gmDrum({ form: 'square', note: 2 })).toBe(77);
    expect(gmDrum({ form: 'square', note: 12 })).toBe(76);
    expect(gmDrum({ form: 'line', note: 3 })).toBeNull();
    expect(gmDrum({ form: 'triangle', note: 3 })).toBeNull();
  });
});
