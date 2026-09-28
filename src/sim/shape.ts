import { HZ, MIN_LINE_LEN, PLACE_BOUNDS, type Bounds } from './constants';
import type { SegKind, Segment, ShapeEffect, ShapeForm } from './types';

// 図形（D12）の形と姿勢。sim の状態は持たず、Shape と Segment を計算・更新するだけ。

/** 回転の姿勢（図形の回転角 φ、または辺の向き） */
export type Rot = { theta0: number; omega: number; rotStartStep: number };

/**
 * ステップ（小数可）における回転角。図形なら回転角 φ（shapePose から。描いたとき 0）、辺ならその辺の向き
 */
export function shapeAngle(pose: Rot, step: number): number {
  return pose.theta0 + (pose.omega * (step - pose.rotStartStep)) / HZ;
}

/** 図形（D12）。sim 内部の状態 */
export type Shape = {
  group: number;
  kind: SegKind;
  /** 形（D16）。音色が決まる */
  form: ShapeForm;
  /** エフェクト（D32） */
  effect: ShapeEffect;
  /** 回転の向き（図形の属性。id から導かない — B6） */
  dir: 1 | -1;
  closed: boolean;
  /** 描いたときの頂点（整数 px）。保存用 */
  points: [number, number][];
  gx: number;
  gy: number;
  /** 重心から最も遠い頂点までの距離（回転速度の上限に使う） */
  radius: number;
  perimeter: number;
  /** 音程スロット（周長で決まる。作成時に固定） */
  note: number;
  segs: Segment[];
  /** 図形の回転角 φ の基準 */
  theta0: number;
  rotStartStep: number;
  omega: number;
  /** 最後にイベントになった衝突のステップ（クールダウンは図形単位。D4） */
  lastEventStep: number;
};

/**
 * 点列を整数 px に丸めて範囲 b 内にクランプし、連続する重複点（閉じた図形は末尾の始点も）を除く。
 * 図形にならなければ null。
 */
export function normalizePoints(
  points: readonly (readonly [number, number])[], closed: boolean, b: Bounds = PLACE_BOUNDS,
): [number, number][] | null {
  // 閉じた図形は、はみ出したぶん全体を平行移動して画面内に収める（点ごとのクランプだと形が潰れるため）
  let dx = 0;
  let dy = 0;
  if (closed && points.length) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (Number.isFinite(x0 + x1 + y0 + y1)) {
      if (x0 < b.minX) dx = b.minX - x0;
      else if (x1 > b.maxX) dx = b.maxX - x1;
      if (y0 < 0) dy = -y0;
      else if (y1 > b.maxY) dy = b.maxY - y1;
    }
  }
  const out: [number, number][] = [];
  for (const q of points) {
    const p = [q[0] + dx, q[1] + dy];
    // 画面内にクランプ（保存形式と同じ扱いにして、読み込み後も同じ形になるように）
    const x = Math.min(b.maxX, Math.max(b.minX, Math.round(p[0])));
    const y = Math.min(b.maxY, Math.max(0, Math.round(p[1])));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    out.push([x, y]);
  }
  if (closed && out.length > 1) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (f[0] === l[0] && f[1] === l[1]) out.pop();
  }
  if (out.length < (closed ? 3 : 2)) return null;
  return out;
}

/** 辺の数（閉じた図形は最後の点から始点へ戻る辺も数える） */
export function edgeCount(pointCount: number, closed: boolean): number {
  return closed ? pointCount : pointCount - 1;
}

export type ShapeMeasure = { perimeter: number; gx: number; gy: number; radius: number };

/**
 * 周長と、辺の長さで重み付けした辺の中点の平均（重心）、重心から最も遠い頂点までの距離。
 * 周長が MIN_LINE_LEN に満たなければ null（図形にしない）
 */
export function measureShape(points: readonly (readonly [number, number])[], closed: boolean): ShapeMeasure | null {
  const n = points.length;
  const edges = edgeCount(n, closed);
  let perimeter = 0;
  let wx = 0;
  let wy = 0;
  for (let i = 0; i < edges; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    perimeter += len;
    wx += ((a[0] + b[0]) / 2) * len;
    wy += ((a[1] + b[1]) / 2) * len;
  }
  if (!(perimeter >= MIN_LINE_LEN)) return null;
  const gx = wx / perimeter;
  const gy = wy / perimeter;
  let radius = 0;
  for (const p of points) radius = Math.max(radius, Math.hypot(p[0] - gx, p[1] - gy));
  return { perimeter, gx, gy, radius };
}

/** 描いたとき（φ = 0、回転なし）の辺を作る。id は firstId から順に振る */
export function shapeSegments(sh: Shape, s: number, firstId: number): Segment[] {
  const { points, group, kind, gx, gy } = sh;
  const n = points.length;
  const segs: Segment[] = [];
  for (let i = 0; i < edgeCount(n, sh.closed); i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % n]!;
    segs.push({
      id: firstId + i,
      group, kind,
      cx: (ax + bx) / 2,
      cy: (ay + by) / 2,
      gx, gy,
      rax: ax - gx, ray: ay - gy, rbx: bx - gx, rby: by - gy,
      theta0: Math.atan2(by - ay, bx - ax),
      rotStartStep: s,
      omega: 0,
      ax, ay, bx, by,
    });
  }
  return segs;
}

/** 現在の回転角を基準角に焼き込んでから角速度を omega にする（角度が連続するように） */
export function rebaseRotation(sh: Shape, s: number, omega: number): void {
  const was = sh.omega;
  sh.theta0 = shapeAngle(sh, s);
  sh.rotStartStep = s;
  sh.omega = omega;
  for (const seg of sh.segs) {
    seg.theta0 = Math.atan2(seg.rby - seg.ray, seg.rbx - seg.rax) + sh.theta0;
    seg.rotStartStep = s;
    seg.omega = sh.omega;
  }
  // B1: 回転が止まっても姿勢を s の角度に揃える（止まっていた図形は整数座標のまま触らない）
  if (was !== 0) poseShape(sh, s);
}

/** ステップ s の回転角で辺の端点と中点を置き直す */
export function poseShape(sh: Shape, s: number): void {
  const phi = shapeAngle(sh, s);
  const c = Math.cos(phi);
  const sn = Math.sin(phi);
  for (const seg of sh.segs) {
    seg.ax = sh.gx + c * seg.rax - sn * seg.ray;
    seg.ay = sh.gy + sn * seg.rax + c * seg.ray;
    seg.bx = sh.gx + c * seg.rbx - sn * seg.rby;
    seg.by = sh.gy + sn * seg.rbx + c * seg.rby;
    seg.cx = (seg.ax + seg.bx) / 2;
    seg.cy = (seg.ay + seg.by) / 2;
  }
}
