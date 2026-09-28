import { BALL_LINE_COOLDOWN, DRIFT_PERIOD, LINE_COOLDOWN, PHRASE_LEN, V_MIN } from './constants';
import type { DriftMode } from './types';

// sim の規則のうち、状態を持たない純関数。

/** 0..1 をなめらかに（動き出し・止まり際をゆっくりに） */
export const smooth = (x: number): number => x * x * (3 - 2 * x);

/**
 * 衝突をイベント化するか（D4）。境界: impact ≥ V_MIN、同じボール×図形は BALL_LINE_COOLDOWN ステップ以上、
 * 同じ図形は LINE_COOLDOWN ステップ以上あいていること。
 */
export function hitAllowed(s: number, impact: number, lastBallLine: number | undefined, lastLineEvent: number): boolean {
  if (impact < V_MIN) return false;
  if (lastBallLine !== undefined && s - lastBallLine < BALL_LINE_COOLDOWN) return false;
  return s - lastLineEvent >= LINE_COOLDOWN;
}

/** 放出番号 k の放出口オフセット（整数 px）。純関数・整数演算のみ（エンジン差なし） */
export function driftOffset(mode: DriftMode, amp: number, emitterId: number, k: number): number {
  if (mode === 'off' || amp <= 0) return 0;
  if (mode === 'drift') {
    // 三角波 0 → +1 → 0 → −1 → 0。放出口ごとに 1/4 周期ずらす
    const P = DRIFT_PERIOD;
    const ph = (k + emitterId * (P / 4)) % P;
    const q = 4 * ph;
    const tri = q < P ? q : q < 3 * P ? 2 * P - q : q - 4 * P; // [-P, P]
    return Math.round((amp * tri) / P);
  }
  const OFF = [0, 2, -2, 1]; // ×amp/2
  const idx = (Math.floor(k / PHRASE_LEN) + emitterId) % OFF.length;
  return Math.round((amp * OFF[idx]!) / 2);
}
