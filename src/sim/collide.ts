// 掃引円 vs 線分 = 点の光線 vs カプセル（線分を半径 R だけ膨らませた形）の最初の交差時刻 (TOI)。

export type Hit = { t: number; nx: number; ny: number };

/**
 * 光線 p + t·d (t∈[0,1]) とカプセル(a–b, 半径 R) の最初の交差を求める。
 * 交差しなければ false。すでにカプセル内にいる場合や離れる方向の交差は無視する。
 */
export function rayCapsule(
  px: number, py: number, dx: number, dy: number,
  ax: number, ay: number, bx: number, by: number,
  R: number, out: Hit,
): boolean {
  let best = Infinity;
  let bnx = 0;
  let bny = 0;

  const ex = bx - ax;
  const ey = by - ay;
  const len = Math.hypot(ex, ey);

  // 側面
  if (len > 1e-9) {
    const ux = ex / len;
    const uy = ey / len;
    const nx = -uy;
    const ny = ux;
    const dp = (px - ax) * nx + (py - ay) * ny; // 符号付き距離
    const dn = dx * nx + dy * ny;
    const s = dp >= 0 ? 1 : -1;
    if (Math.abs(dp) >= R && s * dn < 0) {
      const t = (s * R - dp) / dn;
      if (t >= 0 && t <= 1) {
        const proj = (px + t * dx - ax) * ux + (py + t * dy - ay) * uy;
        if (proj >= 0 && proj <= len) {
          best = t;
          bnx = s * nx;
          bny = s * ny;
        }
      }
    }
  }

  // 端点の円
  for (let i = 0; i < 2; i++) {
    const cx = i === 0 ? ax : bx;
    const cy = i === 0 ? ay : by;
    const fx = px - cx;
    const fy = py - cy;
    const A = dx * dx + dy * dy;
    if (A < 1e-12) continue;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - R * R;
    if (C < 0) continue; // すでに内側
    const disc = B * B - 4 * A * C;
    if (disc < 0) continue;
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    if (t >= 0 && t <= 1 && t < best) {
      best = t;
      bnx = (fx + t * dx) / R;
      bny = (fy + t * dy) / R;
    }
  }

  if (best === Infinity) return false;
  out.t = best;
  out.nx = bnx;
  out.ny = bny;
  return true;
}

/** 点と線分の最近点までの距離と法線（線分→点の向き） */
export function closestOnSegment(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
  out: { dist: number; nx: number; ny: number },
): void {
  const ex = bx - ax;
  const ey = by - ay;
  const ll = ex * ex + ey * ey;
  let u = ll > 0 ? ((px - ax) * ex + (py - ay) * ey) / ll : 0;
  u = Math.min(1, Math.max(0, u));
  const qx = ax + u * ex;
  const qy = ay + u * ey;
  const dx = px - qx;
  const dy = py - qy;
  const d = Math.hypot(dx, dy);
  out.dist = d;
  if (d > 1e-9) {
    out.nx = dx / d;
    out.ny = dy / d;
  } else {
    // 線上にちょうど乗っている: 線の法線（上向き優先）
    const l = Math.sqrt(ll) || 1;
    let nx = -ey / l;
    let ny = ex / l;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    out.nx = nx;
    out.ny = ny;
  }
}
