import { describe, expect, it } from 'vitest';
import {
  emptyPool, freeSlot, idleSlot, makePool, occupy, oldestSlot, pickSlot, RETRIGGER_EPS, type Slot,
} from '../src/audio/voicePool';

type V = Slot & { n: number };

function pool(max: number) {
  let made = 0;
  return makePool<V>(max, () => ({ n: made++, ...idleSlot() }));
}

describe('voice pool (D40)', () => {
  it('creates voices lazily, up to max', () => {
    const p = pool(3);
    expect(p.items.length).toBe(0);
    for (let i = 0; i < 3; i++) {
      const v = pickSlot(p, i)!;
      expect(v.n).toBe(i);
      occupy(v, i, 10, 1); // まだ鳴っている
    }
    expect(p.items.length).toBe(3);
    pickSlot(p, 3);
    expect(p.items.length).toBe(3);
  });

  it('reuses the oldest finished voice before making a new one', () => {
    const p = pool(4);
    const a = pickSlot(p, 0)!;
    occupy(a, 0, 0.5, 0.1);
    const b = pickSlot(p, 0.1)!;
    occupy(b, 0.1, 0.5, 0.1);
    expect(b).not.toBe(a);
    // どちらも鳴り終わっている → 古い方（a）、新しく作らない
    expect(pickSlot(p, 5)).toBe(a);
    expect(p.items.length).toBe(2);
  });

  it('steals the oldest voice when all are sounding', () => {
    const p = pool(3);
    const vs = [2, 0, 1].map((at) => {
      const v = pickSlot(p, at)!;
      occupy(v, at, 10, 1);
      return v;
    });
    expect(freeSlot(p, 3)).toBeUndefined();
    expect(pickSlot(p, 3)).toBe(vs[1]); // startedAt = 0
  });

  it('returns undefined when every voice started at or after `at`', () => {
    const p = pool(2);
    for (const at of [1, 1 + RETRIGGER_EPS / 2]) occupy(pickSlot(p, at)!, at, 10, 1);
    expect(pickSlot(p, 1)).toBeUndefined();
    expect(oldestSlot(p.items, 1)).toBeUndefined();
    // 確実に後の時刻なら奪える
    expect(pickSlot(p, 1 + 2 * RETRIGGER_EPS)?.startedAt).toBe(1);
  });

  it('does not reuse a finished voice at the same instant it started', () => {
    const p = pool(1);
    const v = pickSlot(p, 1)!;
    occupy(v, 1, 0, 0); // すぐ鳴り終わる
    expect(freeSlot(p, 1)).toBeUndefined();
    expect(freeSlot(p, 1 + 2 * RETRIGGER_EPS)).toBe(v);
  });

  it('marks start and end with occupy, and an empty pool cannot make voices', () => {
    const v = idleSlot();
    occupy(v, 2, 0.5, 0.25);
    expect(v).toEqual({ startedAt: 2, endsAt: 2.75 });
    const e = emptyPool<V>();
    expect(pickSlot(e, 0)).toBeUndefined();
    expect(() => e.make()).toThrow();
  });
});
