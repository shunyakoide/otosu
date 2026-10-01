import type { Command } from '../sim/types';

/** 中心・半径から正多角形の頂点を作る（三角は頂点が上、四角は辺が水平。描くときの向きと同じ） */
function regular(cx: number, cy: number, r: number, form: 'circle' | 'triangle' | 'square'): [number, number][] {
  const n = { circle: 24, triangle: 3, square: 4 }[form];
  const phase = { circle: 0, triangle: -Math.PI / 2, square: Math.PI / 4 }[form];
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (i / n) * 2 * Math.PI;
    return [Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))];
  });
}

const demoShape = (form: 'circle' | 'triangle' | 'square', cx: number, cy: number, r: number): Command =>
  ({ kind: 'addShape', points: regular(cx, cy, r, form), closed: true, segKind: 'line', form, loaded: true });

/**
 * 保存された配置がないときに置く図形（D72）。初めての人が線だけでなく形ごとの音色も聞けるように、三角・円・四角と線を混ぜる。
 * 放出口（2 : 3 で x ≈ 806 / 1114）の真下に三角と円を置き、そこで跳ねた玉が下の線と四角に落ちる。
 * 既定の 60 BPM（D73）で、どの図形にも始めて 10 秒以内に玉が当たる（test/sim.test.ts）
 */
export const DEMO: Command[] = [
  demoShape('triangle', 806, 270, 80),
  demoShape('circle', 1114, 300, 65),
  { kind: 'addSegment', ax: 560, ay: 500, bx: 800, by: 570, loaded: true },
  { kind: 'addSegment', ax: 1020, ay: 620, bx: 1340, by: 540, loaded: true },
  demoShape('square', 960, 820, 90),
];
