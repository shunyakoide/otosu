import { closestOnSegment } from '../sim/collide';
import { HZ } from '../sim/constants';
import { chordSlots } from '../sim/music';
import type { SegKind, ShapeAddedEvent, ShapeEffect, ShapeForm } from '../sim/types';

// 描く側が持つ図形（group）の自分用コピーと、その形の計算（D9, D14）。
// sim の Segment は参照せず、shapeAdded / shapePose イベントから作る。回転角はステップから sim と同じ式で出す。

export const MAX_VERTS = 64;

export type Hit = { step: number; v: number; s: number; tau: number };
export type Shape = {
  group: number;
  kind: SegKind;
  form: ShapeForm;
  effect: ShapeEffect;
  note: number;
  /** chord で重ねる音（D32）。form と note は変わらないので、置いたときに1度だけ求める */
  chord: readonly number[];
  closed: boolean;
  /** 重心から頂点までの平均距離（circle のキックの大きさ） */
  radius: number;
  gx: number;
  gy: number;
  /** 重心からの相対頂点（φ = 0） */
  rel: Float32Array;
  n: number;
  /** 辺ごとの周上の開始位置と長さ */
  s0: Float32Array;
  elen: Float32Array;
  perimeter: number;
  theta0: number;
  rotStartStep: number;
  omega: number;
  hit: Hit | null;
  resStep: number;
  resV: number;
  replayAt: number;
};

/** 周上の点と、そこでの辺の法線（pointAt が書く） */
export type Point = { x: number; y: number; nx: number; ny: number };

export function makeShape(e: ShapeAddedEvent): Shape {
  const n = Math.min(e.points.length, MAX_VERTS);
  const rel = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    rel[i * 2] = e.points[i]![0];
    rel[i * 2 + 1] = e.points[i]![1];
  }
  const ne = e.closed ? n : n - 1;
  const s0 = new Float32Array(Math.max(ne, 0));
  const elen = new Float32Array(Math.max(ne, 0));
  let p = 0;
  for (let i = 0; i < ne; i++) {
    const j = (i + 1) % n;
    s0[i] = p;
    elen[i] = Math.hypot(rel[j * 2]! - rel[i * 2]!, rel[j * 2 + 1]! - rel[i * 2 + 1]!);
    p += elen[i]!;
  }
  let radius = 0;
  for (let i = 0; i < n; i++) radius += Math.hypot(rel[i * 2]!, rel[i * 2 + 1]!);
  radius = n > 0 ? radius / n : 0;
  return {
    group: e.group, kind: e.segKind, form: e.form, effect: e.effect, note: e.note, chord: chordSlots(e.form, e.note),
    closed: e.closed, radius, gx: e.gx, gy: e.gy,
    rel, n, s0, elen, perimeter: p,
    theta0: 0, rotStartStep: e.step, omega: 0,
    hit: null,
    resStep: -Infinity, resV: 0, replayAt: -Infinity,
  };
}

/** 図形の回転角 φ(step)（sim の shapeAngle と同じ式） */
export const shapeAngle = (s: Shape, step: number) => s.theta0 + (s.omega * (step - s.rotStartStep)) / HZ;

/** 最初の頂点の向き（画面の y 下向きのまま） */
export function vertexAngle(s: Shape, step: number): number {
  return Math.atan2(s.rel[1] ?? 0, s.rel[0] ?? 1) + shapeAngle(s, step);
}

// 毎回 new しないための作業領域（pose の返り値は次の pose で上書きされる）
const verts = new Float32Array(MAX_VERTS * 2);
const near = { dist: 0, nx: 0, ny: 0 };

/** 回転角 φ・縮尺 k での頂点（ワールド）。返すのは共有の作業領域なので、次の pose / contour の前に使い切る */
export function pose(s: Shape, phi: number, k: number): Float32Array {
  const v = verts;
  const cs = Math.cos(phi) * k;
  const sn = Math.sin(phi) * k;
  for (let i = 0; i < s.n; i++) {
    const x = s.rel[i * 2]!;
    const y = s.rel[i * 2 + 1]!;
    v[i * 2] = s.gx + cs * x - sn * y;
    v[i * 2 + 1] = s.gy + sn * x + cs * y;
  }
  return v;
}

/**
 * 図形を外へ d px 広げ、上へ lift px ずらした輪郭（D32）。閉じた図形は重心から拡大、
 * 開いた図形（線・ペン）は両端を結ぶ向きに垂直な、上側へ平行にずらす。返すのは pose と同じ作業領域
 */
export function contour(s: Shape, phi: number, d: number, lift: number): Float32Array {
  const v = pose(s, phi, s.closed ? 1 + d / Math.max(s.radius, 8) : 1);
  let ox = 0;
  let oy = -lift;
  if (!s.closed && s.n >= 2) {
    const ex = v[(s.n - 1) * 2]! - v[0]!;
    const ey = v[(s.n - 1) * 2 + 1]! - v[1]!;
    const l = Math.hypot(ex, ey) || 1;
    let nx = -ey / l;
    let ny = ex / l;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    ox += nx * d;
    oy += ny * d;
  }
  if (ox !== 0 || oy !== 0) {
    for (let i = 0; i < s.n; i++) {
      v[i * 2]! += ox;
      v[i * 2 + 1]! += oy;
    }
  }
  return v;
}

/** 周上の位置 arc の点と辺の法線（回転角 φ）を o に書く */
export function pointAt(s: Shape, phi: number, arc: number, o: Point): void {
  const ne = s.closed ? s.n : s.n - 1;
  if (ne <= 0) {
    o.x = s.gx; o.y = s.gy; o.nx = 0; o.ny = 0;
    return;
  }
  let i = 0;
  while (i < ne - 1 && arc > s.s0[i]! + s.elen[i]!) i++;
  const j = (i + 1) % s.n;
  const el = s.elen[i]!;
  const u = el > 0 ? Math.min(1, Math.max(0, (arc - s.s0[i]!) / el)) : 0;
  const x0 = s.rel[i * 2]!, y0 = s.rel[i * 2 + 1]!;
  const ex = s.rel[j * 2]! - x0, ey = s.rel[j * 2 + 1]! - y0;
  const lx = x0 + u * ex, ly = y0 + u * ey;
  const cs = Math.cos(phi), sn = Math.sin(phi);
  o.x = s.gx + cs * lx - sn * ly;
  o.y = s.gy + sn * lx + cs * ly;
  const tx = el > 0 ? ex / el : 0, ty = el > 0 ? ey / el : 0;
  o.nx = -(sn * tx + cs * ty);
  o.ny = cs * tx - sn * ty;
}

/** 打点 (x, y) の周上の位置 */
export function arcPos(s: Shape, step: number, x: number, y: number): number {
  const v = pose(s, shapeAngle(s, step), 1);
  const ne = s.closed ? s.n : s.n - 1;
  let best = Infinity;
  let pos = 0;
  for (let i = 0; i < ne; i++) {
    const j = (i + 1) % s.n;
    const ax = v[i * 2]!, ay = v[i * 2 + 1]!;
    const ex = v[j * 2]! - ax, ey = v[j * 2 + 1]! - ay;
    const ll = ex * ex + ey * ey;
    const u = ll > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / ll)) : 0;
    const d = Math.hypot(x - ax - u * ex, y - ay - u * ey);
    if (d < best) {
      best = d;
      pos = s.s0[i]! + u * s.elen[i]!;
    }
  }
  return pos;
}

/** 周上の位置を図形の範囲に収める（閉じた図形は一周で戻る）。開いた図形の外なら NaN */
export function wrapArc(s: Shape, a: number): number {
  if (s.closed) return ((a % s.perimeter) + s.perimeter) % s.perimeter;
  return a < 0 || a > s.perimeter ? NaN : a;
}

/**
 * 図形を選ぶための当たり判定（回転角 φ の姿勢で）。o.dist = (x, y) から辺までの最短距離、
 * o.inside = 閉じた図形の内側か
 */
export function hitTest(s: Shape, phi: number, x: number, y: number, o: { dist: number; inside: boolean }): void {
  const v = pose(s, phi, 1);
  const ne = s.closed ? s.n : s.n - 1;
  let best = Infinity;
  let inside = false;
  for (let i = 0; i < ne; i++) {
    const j = (i + 1) % s.n;
    const ax = v[i * 2]!, ay = v[i * 2 + 1]!, bx = v[j * 2]!, by = v[j * 2 + 1]!;
    closestOnSegment(x, y, ax, ay, bx, by, near);
    if (near.dist < best) best = near.dist;
    if (s.closed && (ay > y) !== (by > y) && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  }
  o.dist = best;
  o.inside = inside;
}
