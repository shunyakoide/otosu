// 配置の保存・読み込み（P2 / D9）。純 TS（DOM の保存先は main が扱う）。
// 形式: SceneData の JSON を UTF-8 → base64url。URL では `#s=<code>`、localStorage にも同じ文字列を置く。

import { DRIFT_AMP_MAX, MIN_LINE_LEN, WORLD_H, WORLD_W } from '../sim/constants';
import type { Sim } from '../sim/sim';
import type { DriftMode, SceneData } from '../sim/types';

export const SCENE_HASH_KEY = 's';
export const SCENE_STORAGE_KEY = 'otosu.scene.v1';

const MAX_SEGS = 400;
const MAX_EMITTERS = 4;
const DRIFT_MODES: readonly DriftMode[] = ['off', 'drift', 'phrase'];

/** 今の sim の配置。線は「引いたときの座標」で保存する（回転中でも読み込み後は引いた角度から回り直す） */
export function sceneFromSim(sim: Sim): SceneData {
  const segs: SceneData['segs'] = [];
  for (const seg of sim.segments) {
    const o = sim.segmentOrigin(seg.id);
    if (o) segs.push([o[0], o[1], o[2], o[3], seg.dir]);
  }
  return {
    v: 1,
    bpm: sim.bpm,
    pattern: [...sim.pattern],
    rotate: sim.rotating,
    rotationSpeed: sim.rotationSpeed,
    drift: { mode: sim.driftMode, amp: sim.driftAmp },
    segs,
  };
}

export function encodeScene(scene: SceneData): string {
  const bytes = new TextEncoder().encode(JSON.stringify(scene));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 壊れた・不正な入力は null。範囲外の値は丸め／クランプし、短すぎる線は捨てる */
export function decodeScene(code: string): SceneData | null {
  try {
    if (!/^[A-Za-z0-9_-]*$/.test(code) || code.length === 0 || code.length > 100_000) return null;
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (code.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return validateScene(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function validateScene(raw: unknown): SceneData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (!num(r.bpm)) return null;
  if (!Array.isArray(r.pattern) || r.pattern.length < 1 || r.pattern.length > MAX_EMITTERS) return null;
  if (!r.pattern.every((b) => num(b) && b > 0 && b <= 32)) return null;
  if (typeof r.rotate !== 'boolean' || !num(r.rotationSpeed)) return null;
  const d = r.drift as Record<string, unknown> | undefined;
  if (typeof d !== 'object' || d === null) return null;
  if (!DRIFT_MODES.includes(d.mode as DriftMode) || !num(d.amp)) return null;
  if (!Array.isArray(r.segs) || r.segs.length > MAX_SEGS) return null;

  const segs: SceneData['segs'] = [];
  for (const s of r.segs) {
    if (!Array.isArray(s) || s.length !== 5 || !s.slice(0, 4).every(num)) return null;
    if (s[4] !== 1 && s[4] !== -1) return null;
    const ax = clamp(Math.round(s[0]), 0, WORLD_W);
    const ay = clamp(Math.round(s[1]), 0, WORLD_H);
    const bx = clamp(Math.round(s[2]), 0, WORLD_W);
    const by = clamp(Math.round(s[3]), 0, WORLD_H);
    if (Math.hypot(bx - ax, by - ay) < MIN_LINE_LEN) continue;
    segs.push([ax, ay, bx, by, s[4]]);
  }
  return {
    v: 1,
    bpm: clamp(Math.round(r.bpm), 40, 200),
    pattern: r.pattern.map((b: number) => b),
    rotate: r.rotate,
    rotationSpeed: clamp(r.rotationSpeed, 0, 2),
    drift: { mode: d.mode as DriftMode, amp: clamp(Math.round(d.amp), 0, DRIFT_AMP_MAX) },
    segs,
  };
}
