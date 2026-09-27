import { describe, expect, it } from 'vitest';
import { AudioClock } from '../src/audio/clock';

describe('AudioClock', () => {
  it('follows currentTime smoothly between audio callbacks', () => {
    const c = new AudioClock();
    c.update(1, 0);
    // currentTime は 10ms ごとにしか進まないが、時計はフレームごとに進む
    let prev = c.audible();
    for (let f = 1; f <= 200; f++) {
      const now = f * (1000 / 60);
      const ct = 1 + Math.floor(now / 10) / 100;
      const t = c.update(ct, now);
      expect(t).toBeGreaterThan(prev);
      prev = t;
      if (f > 100) expect(Math.abs(t - (1 + now / 1000))).toBeLessThan(0.012);
    }
  });

  it('snaps after a long gap', () => {
    const c = new AudioClock();
    c.update(1, 0);
    expect(c.update(5, 16)).toBe(5);
  });

  it('maps context time to performance time with latency', () => {
    const c = new AudioClock();
    c.latency = 0.05;
    c.update(2, 1000);
    expect(c.audible()).toBeCloseTo(1.95);
    expect(c.toPerf(2.1)).toBeCloseTo(1150);
  });
});
