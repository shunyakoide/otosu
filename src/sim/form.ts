import { SHAPE_FORMS, type ShapeForm } from './types';

// 図形の形（D16）。保存データに形が無い図形（v2 以前）と、form を省略した addShape のための推定。

/** 閉じた図形は頂点数で円（24）・三角（3）・四角（4）、それ以外はペン。開いた2点は線 */
export function inferForm(pointCount: number, closed: boolean): ShapeForm {
  if (!closed) return pointCount === 2 ? 'line' : 'pen';
  if (pointCount === 24) return 'circle';
  if (pointCount === 3) return 'triangle';
  if (pointCount === 4) return 'square';
  return 'pen';
}

export function isShapeForm(v: unknown): v is ShapeForm {
  return typeof v === 'string' && (SHAPE_FORMS as readonly string[]).includes(v);
}
