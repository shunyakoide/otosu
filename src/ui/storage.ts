// 設定と保存した配置の置き場所（D24）。localStorage が使えない環境では何もしない。
// - prefs: この端末での調整（音量・光・MIDI など）。配置とは別に自動保存する
// - library: 名前を付けて保存した配置（中身は scene.ts と同じ符号化文字列）

import { validateScene } from '../scene/scene';
import type { SceneData } from '../sim/types';

const PREFS_KEY = 'otosu.prefs.v1';
const LIBRARY_KEY = 'otosu.library.v1';
const FILE_KIND = 'otosu.scene';

export type Library = Record<string, { code: string; savedAt: number }>;

function readJson(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** 保存できたか（容量がいっぱい・プライベートモード等では false） */
function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * 保存されていた値のうち、既定値と同じ型のものだけを取り出す。
 * choices に挙げたキーは、その中の値のときだけ採用する。
 */
export function pickPrefs<T extends Record<string, unknown>>(
  defaults: T,
  raw: unknown,
  choices: Partial<Record<keyof T, readonly unknown[]>> = {},
): Partial<T> {
  const out: Partial<T> = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const v = src[key];
    if (typeof v !== typeof defaults[key]) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    const allowed = choices[key];
    if (allowed && !allowed.includes(v)) continue;
    out[key] = v as T[typeof key];
  }
  return out;
}

export const loadPrefs = (): unknown => readJson(PREFS_KEY);
export const savePrefs = (prefs: Record<string, unknown>): boolean => writeJson(PREFS_KEY, prefs);

export function loadLibrary(): Library {
  const raw = readJson(LIBRARY_KEY);
  const lib: Library = {};
  if (!raw || typeof raw !== 'object') return lib;
  for (const [name, e] of Object.entries(raw as Record<string, unknown>)) {
    const entry = e as { code?: unknown; savedAt?: unknown } | null;
    if (entry && typeof entry.code === 'string') {
      lib[name] = { code: entry.code, savedAt: typeof entry.savedAt === 'number' ? entry.savedAt : 0 };
    }
  }
  return lib;
}

export const saveLibrary = (lib: Library): boolean => writeJson(LIBRARY_KEY, lib);

/** 新しい順の名前一覧 */
export const libraryNames = (lib: Library): string[] =>
  Object.keys(lib).sort((a, b) => lib[b]!.savedAt - lib[a]!.savedAt || a.localeCompare(b));

// ---- ファイル（別の端末へ持っていく用） ----

export function sceneToFile(name: string, scene: SceneData): string {
  return JSON.stringify({ kind: FILE_KIND, name, scene }, null, 1);
}

/** 読めないファイルは null。配置だけの JSON（SceneData そのもの）も受け付ける */
export function sceneFromFile(text: string): { name: string; scene: SceneData } | null {
  try {
    const raw = JSON.parse(text) as { kind?: unknown; name?: unknown; scene?: unknown };
    const isWrapped = raw && raw.kind === FILE_KIND;
    const scene = validateScene(isWrapped ? raw.scene : raw);
    if (!scene) return null;
    return { name: isWrapped && typeof raw.name === 'string' ? raw.name : '', scene };
  } catch {
    return null;
  }
}
