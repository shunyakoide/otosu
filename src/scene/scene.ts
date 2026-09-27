// 配置の保存・読み込み（P2 / D9、v2 は D12）。純 TS（DOM の保存先は main が扱う）。
// 形式: SceneData の JSON を UTF-8 → base64url。URL では `#s=<code>`、localStorage にも同じ文字列を置く。
// v1（segs）も読み込めて、v2（shapes）に変換して返す。

import { DRIFT_AMP_MAX, MAX_SEGS, MAX_SHAPE_EDGES, MIN_LINE_LEN, WORLD_H, WORLD_W } from '../sim/constants';
import { inferForm, isShapeForm } from '../sim/form';
import type { Sim } from '../sim/sim';
import type { DriftMode, SceneData, SceneShape, SegKind, ShapeForm } from '../sim/types';

export const SCENE_HASH_KEY = 's';
/** v1 と同じキーを使い続ける（中身の v で判別する） */
export const SCENE_STORAGE_KEY = 'otosu.scene.v1';

const MAX_EMITTERS = 4;
const DRIFT_MODES: readonly DriftMode[] = ['off', 'drift', 'phrase'];
const SEG_KINDS: readonly SegKind[] = ['line', 'bumper'];

/** 今の sim の配置。図形は「描いたときの座標」で保存する（回転中でも読み込み後は描いた角度から回り直す） */
export function sceneFromSim(sim: Sim): SceneData {
  const shapes: SceneShape[] = [];
  const forms: ShapeForm[] = [];
  for (const sh of sim.shapes.values()) {
    shapes.push([sh.kind, sh.dir, sh.closed, ...sh.points.flat()]);
    forms.push(sh.form);
  }
  return {
    v: 2,
    bpm: sim.bpm,
    pattern: [...sim.pattern],
    rotate: sim.rotating,
    rotationSpeed: sim.rotationSpeed,
    drift: { mode: sim.driftMode, amp: sim.driftAmp },
    shapes,
    forms,
  };
}

export function encodeScene(scene: SceneData): string {
  const bytes = new TextEncoder().encode(JSON.stringify(scene));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 壊れた・不正な入力は null。範囲外の値は丸め／クランプし、小さすぎる図形は捨てる。v1 は v2 に変換する */
export function decodeScene(code: string): SceneData | null {
  try {
    if (!/^[A-Za-z0-9_-]*$/.test(code) || code.length === 0 || code.length > 200_000) return null;
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
const cx = (v: number) => clamp(Math.round(v), 0, WORLD_W);
const cy = (v: number) => clamp(Math.round(v), 0, WORLD_H);

/** 点列（整数・画面内にクランプ済み）が図形として成り立つか: 連続重複を除いた点数と周長 */
function shapeOk(pts: number[], closed: boolean): boolean {
  const n = pts.length / 2;
  if (n < (closed ? 3 : 2)) return false;
  let per = 0;
  const edges = closed ? n : n - 1;
  if (edges > MAX_SHAPE_EDGES) return false;
  for (let i = 0; i < edges; i++) {
    const j = (i + 1) % n;
    per += Math.hypot(pts[2 * j]! - pts[2 * i]!, pts[2 * j + 1]! - pts[2 * i + 1]!);
  }
  return per >= MIN_LINE_LEN;
}

function edgeCount(sh: SceneShape): number {
  const n = (sh.length - 3) / 2;
  return sh[2] ? n : n - 1;
}

export function validateScene(raw: unknown): SceneData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 && r.v !== 2) return null;
  if (!num(r.bpm)) return null;
  if (!Array.isArray(r.pattern) || r.pattern.length < 1 || r.pattern.length > MAX_EMITTERS) return null;
  if (!r.pattern.every((b) => num(b) && b > 0 && b <= 32)) return null;
  if (typeof r.rotate !== 'boolean' || !num(r.rotationSpeed)) return null;
  const d = r.drift as Record<string, unknown> | undefined;
  if (typeof d !== 'object' || d === null) return null;
  if (!DRIFT_MODES.includes(d.mode as DriftMode) || !num(d.amp)) return null;

  const shapes: SceneShape[] = [];
  const forms: ShapeForm[] = [];
  if (r.v === 1) {
    if (!Array.isArray(r.segs) || r.segs.length > MAX_SEGS) return null;
    for (const s of r.segs) {
      if (!Array.isArray(s) || s.length !== 5 || !s.slice(0, 4).every(num)) return null;
      if (s[4] !== 1 && s[4] !== -1) return null;
      const pts = [cx(s[0]), cy(s[1]), cx(s[2]), cy(s[3])];
      if (Math.hypot(pts[2]! - pts[0]!, pts[3]! - pts[1]!) < MIN_LINE_LEN) continue;
      shapes.push(['line', s[4], false, ...pts]);
      forms.push('line');
    }
  } else {
    if (!Array.isArray(r.shapes)) return null;
    // D18: forms は shapes と同じ順。無い・長さが合わない場合はすべて、不正な値の要素はその図形だけ点列から推定する
    const rawForms = Array.isArray(r.forms) && r.forms.length === r.shapes.length ? (r.forms as unknown[]) : null;
    let total = 0;
    for (const [idx, s] of r.shapes.entries()) {
      if (!Array.isArray(s) || s.length < 7 || s.length % 2 === 0) return null;
      const [kind, dir, closed, ...flat] = s as unknown[];
      if (!SEG_KINDS.includes(kind as SegKind) || (dir !== 1 && dir !== -1) || typeof closed !== 'boolean') return null;
      if (!flat.every(num)) return null;
      const pts: number[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        const x = cx(flat[i] as number);
        const y = cy(flat[i + 1] as number);
        const n = pts.length;
        if (n && pts[n - 2] === x && pts[n - 1] === y) continue; // 連続する重複点
        pts.push(x, y);
      }
      if (closed && pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) {
        pts.splice(-2, 2);
      }
      if (!shapeOk(pts, closed)) continue;
      const sh: SceneShape = [kind as SegKind, dir, closed, ...pts];
      total += edgeCount(sh);
      if (total > MAX_SEGS) break;
      shapes.push(sh);
      const f = rawForms?.[idx];
      // 推定は整えた後の点数で（sim の addShape と同じ）
      forms.push(isShapeForm(f) ? f : inferForm(pts.length / 2, closed));
    }
  }
  return {
    v: 2,
    bpm: clamp(Math.round(r.bpm), 40, 200),
    pattern: r.pattern.map((b: number) => b),
    rotate: r.rotate,
    rotationSpeed: clamp(r.rotationSpeed, 0, 2),
    drift: { mode: d.mode as DriftMode, amp: clamp(Math.round(d.amp), 0, DRIFT_AMP_MAX) },
    shapes,
    forms,
  };
}
