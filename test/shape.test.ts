import { describe, expect, it } from 'vitest';
import { closestOnSegment } from '../src/sim/collide';
import { beatSteps, HZ, MIN_LINE_LEN, PLACE_BOUNDS } from '../src/sim/constants';
import { sectionSteps } from '../src/sim/music';
import { measureShape, normalizePoints } from '../src/sim/shape';
import { Timeline } from '../src/sim/timeline';

describe('normalizePoints', () => {
  it('rounds, drops consecutive duplicates and the repeated start of a closed shape', () => {
    expect(normalizePoints([[0.4, 0.4], [0, 0], [100.2, 0], [100, 0.3], [100, 100]], false)).toEqual([[0, 0], [100, 0], [100, 100]]);
    expect(normalizePoints([[0, 0], [100, 0], [100, 100], [0, 0]], true)).toEqual([[0, 0], [100, 0], [100, 100]]);
  });

  it('rejects too few distinct points', () => {
    expect(normalizePoints([], false)).toBeNull();
    expect(normalizePoints([], true)).toBeNull();
    expect(normalizePoints([[5, 5], [5.2, 4.9]], false)).toBeNull();
    expect(normalizePoints([[0, 0], [100, 0], [0, 0]], true)).toBeNull();
  });

  it('rejects NaN, and clamps infinite coordinates to the bounds', () => {
    expect(normalizePoints([[0, 0], [NaN, 10]], false)).toBeNull();
    expect(normalizePoints([[0, 0], [100, 0], [NaN, 50]], true)).toBeNull();
    expect(normalizePoints([[0, 0], [100, 0], [Infinity, 50]], true)).toEqual([[0, 0], [100, 0], [PLACE_BOUNDS.maxX, 50]]);
  });

  it('clamps open lines per point, but shifts closed shapes as a whole', () => {
    const b = { minX: 0, maxX: 1000, maxY: 500 };
    expect(normalizePoints([[-50, -20], [1200, 600]], false, b)).toEqual([[0, 0], [1000, 500]]);
    // 上（y < 0）にはみ出した閉じた図形は下へずらす（形は保つ）
    expect(normalizePoints([[10, -30], [110, -30], [60, 20]], true, b)).toEqual([[10, 0], [110, 0], [60, 50]]);
    expect(normalizePoints([[950, 10], [1050, 10], [1000, 60]], true, b)).toEqual([[900, 10], [1000, 10], [950, 60]]);
    expect(normalizePoints([[0, 0], [10, 0]], false)).toEqual([[0, 0], [10, 0]]);
    expect(PLACE_BOUNDS.minX).toBeLessThan(0);
  });
});

describe('measureShape', () => {
  it('computes perimeter, edge-weighted centroid and radius', () => {
    const m = measureShape([[0, 0], [100, 0], [100, 100], [0, 100]], true)!;
    expect(m.perimeter).toBe(400);
    expect([m.gx, m.gy]).toEqual([50, 50]);
    expect(m.radius).toBeCloseTo(Math.SQRT2 * 50, 12);
    // 開いた線は閉じる辺を数えない
    expect(measureShape([[0, 0], [100, 0], [100, 100]], false)!.perimeter).toBe(200);
  });

  it('rejects shapes shorter than MIN_LINE_LEN', () => {
    expect(measureShape([[0, 0], [MIN_LINE_LEN - 1, 0]], false)).toBeNull();
    expect(measureShape([[0, 0], [MIN_LINE_LEN, 0]], false)).not.toBeNull();
  });
});

describe('closestOnSegment', () => {
  const out = { dist: 0, nx: 0, ny: 0 };

  it('handles a zero-length segment like a point', () => {
    closestOnSegment(13, 14, 10, 10, 10, 10, out);
    expect(out.dist).toBe(5);
    expect([out.nx, out.ny]).toEqual([0.6, 0.8]);
  });

  it('stays finite when the point sits exactly on a zero-length segment', () => {
    closestOnSegment(10, 10, 10, 10, 10, 10, out);
    expect(out.dist).toBe(0);
    expect(Number.isFinite(out.nx) && Number.isFinite(out.ny)).toBe(true);
  });

  it('prefers the upward normal when the point is on the line', () => {
    closestOnSegment(50, 0, 0, 0, 100, 0, out);
    expect(out.dist).toBe(0);
    expect(out.ny).toBe(-1);
  });
});

describe('Timeline (D9, D10)', () => {
  it('shares the beat formula with sectionSteps', () => {
    expect(beatSteps(1, 90)).toBe(80);
    expect(sectionSteps(97, 8, HZ)).toBe(Math.round(beatSteps(32, 97)));
  });

  it('gridAtOrAfter: on the grid, just after it, and before the anchor', () => {
    const t = new Timeline(90); // 1拍 = 80 ステップ
    t.retime(1000, 90, 0);
    expect(t.gridAtOrAfter(1000, 1)).toBe(1000);
    expect(t.gridAtOrAfter(1001, 1)).toBe(1080);
    expect(t.gridAtOrAfter(1080, 1)).toBe(1080);
    expect(t.gridAtOrAfter(1081, 0.5)).toBe(1120);
    // 起点より前は起点
    expect(t.gridAtOrAfter(10, 1)).toBe(1000);
  });

  it('gridAtOrAfter rounds each grid point from the anchor (no accumulated error)', () => {
    const t = new Timeline(97);
    const p = beatSteps(1, 97); // 74.22… ステップ
    for (let k = 0; k < 500; k++) {
      const g = Math.round(k * p);
      expect(t.gridAtOrAfter(g, 1)).toBe(g);
      expect(t.gridAtOrAfter(g + 1, 1)).toBe(Math.round((k + 1) * p));
    }
  });

  it('retime restarts sections from the given base', () => {
    const t = new Timeline(120); // 1区間 = 1920 ステップ
    t.retime(500, 120, 3);
    expect(t.sectionAt(500)).toBe(3);
    expect(t.sectionAt(500 + 1920)).toBe(0);
    expect(t.sectionAt(499)).toBe(2);
    expect(t.energyWindow).toBe(480);
  });
});
