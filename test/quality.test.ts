import { describe, expect, it } from 'vitest';
import { QUALITY_LEVELS, QualityGovernor } from '../src/render/quality';

const run = (g: QualityGovernor, dt: number, sec: number) => {
  const changes = [];
  for (let t = 0; t < sec; t += dt) {
    const q = g.update(dt);
    if (q) changes.push(q);
  }
  return changes;
};

describe('QualityGovernor', () => {
  it('60fps では下げない', () => {
    const g = new QualityGovernor();
    expect(run(g, 1 / 60, 10)).toEqual([]);
    expect(g.level).toBe(0);
  });

  it('遅いと 2 秒ごとに1段ずつ下げ、最低で止まる', () => {
    const g = new QualityGovernor();
    expect(run(g, 1 / 30, 2.1)).toEqual([QUALITY_LEVELS[1]]);
    run(g, 1 / 30, 20);
    expect(g.level).toBe(QUALITY_LEVELS.length - 1);
  });

  it('一瞬の止まりは数えない', () => {
    const g = new QualityGovernor();
    for (let i = 0; i < 5; i++) g.update(0.5);
    expect(run(g, 1 / 60, 4)).toEqual([]);
  });

  it('reset で最高に戻る', () => {
    const g = new QualityGovernor();
    run(g, 1 / 20, 5);
    expect(g.reset()).toEqual(QUALITY_LEVELS[0]);
    expect(g.level).toBe(0);
  });
});
