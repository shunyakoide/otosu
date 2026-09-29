import type { Tool } from '../input/input';
import { BACKDROPS, type BackdropKind } from '../render/backdrop';
import { FLOWER_KINDS, type FlowerKind } from '../render/flowers';
import type { ColorMode } from '../render/palette';
import { DEFAULT_SONG, type SongId } from '../sim/music';
import type { DriftMode } from '../sim/types';
import { loadPrefs, pickPrefs } from '../ui/storage';

// つまみの値（D24）。描画はこのオブジェクトを直接読み、小窓は直接書き換える。

/** 発射の周期（拍）。読み込んだ配置にない組み合わせは、そのとき足す */
export const PATTERNS: Record<string, number[]> = {
  '2 : 3': [2, 3],
  '3 : 4': [3, 4],
  '1 : 1.5': [1, 1.5],
  '2 : 3 : 5': [2, 3, 5],
};

export const DRIFT_MODES: readonly DriftMode[] = ['off', 'drift', 'phrase'];
export const TRAILS = ['geometry', 'afterimage'] as const;
export const PIXEL_RATIOS = [1, 1.5, 2] as const;

export const DEFAULTS = {
  bpm: 90,
  pattern: '2 : 3',
  volume: -3,
  muted: false,
  tool: 'line' as Tool,
  /** 曲（D48）。配置側で持つ */
  song: DEFAULT_SONG as SongId,
  /** 後ろで鳴り続ける和音（旧 pad）。キーは保存済みの設定のためそのまま */
  pad: true,
  padLevel: 0.5,
  rotate: false,
  rotationSpeed: 0.3,
  drift: 'drift' as DriftMode,
  driftAmp: 24,
  stereoWidth: 0.7,
  trail: 'geometry' as (typeof TRAILS)[number],
  /** 色は白黒（mono）だけ（D37）。音の高さで色を付ける 'pitch' はメニューから外した */
  colorMode: 'mono' as ColorMode,
  bloomStrength: 0.9,
  afterimage: 0.8,
  drip: true,
  dripSpeed: 90,
  flowers: true,
  /** 咲かせる花の種類（mixed = いろいろ） */
  flowerKind: 'mixed' as FlowerKind,
  backdrop: 'none' as BackdropKind,
  backdropLevel: 1,
  hud: false,
  idleLine: 0.3,
  visualOffsetMs: 0,
  pixelRatio: 1 as number,
  internalSound: true,
  midiOutput: '',
  midiChannel: 1,
  midiDrumChannel: 10,
  midiNoteLength: 0.4,
  midiOffsetMs: 0,
};

export type Params = typeof DEFAULTS;

/** 配置（SceneData）側で持つ値と、保存しない値。残りをこの端末の設定として自動保存する（D24） */
const NOT_PREFS = new Set<string>(['bpm', 'pattern', 'song', 'rotate', 'rotationSpeed', 'drift', 'driftAmp', 'tool', 'muted', 'midiOutput', 'colorMode']);

export function currentPrefs(params: Params): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!NOT_PREFS.has(k)) out[k] = v;
  return out;
}

/** この端末に保存されていた設定（型と選択肢が合うものだけ。配置側の値は含めない） */
export function storedPrefs(): Partial<Params> {
  const prefs = pickPrefs(DEFAULTS, loadPrefs(), { trail: TRAILS, pixelRatio: PIXEL_RATIOS, backdrop: BACKDROPS, flowerKind: FLOWER_KINDS });
  for (const k of NOT_PREFS) delete prefs[k as keyof Params];
  return prefs;
}
