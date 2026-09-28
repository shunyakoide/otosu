import { beatSteps, WORLD_W } from './constants';

// 音程のマッピング。audio（周波数）と render（色）の両方から使う純関数。

export const ROOT_MIDI = 48; // C3
export const PENTA = [0, 2, 4, 7, 9] as const;
/** C3〜C6 の16音 */
export const NOTE_COUNT = 16;
/** 一番上のスロット（15） */
export const SLOT_MAX = NOTE_COUNT - 1;
/** kickMidi の一番低い帯の根音（C1） */
export const KICK_ROOT_MIDI = 24;

const R_MIN = 0.03;
const R_MAX = 0.6;

export type Note = {
  /** 0 = 最低音 … 15 = 最高音 */
  index: number;
  /** ペンタトニック内の度数 0..4 */
  degree: number;
  octave: number;
  midi: number;
};

export function noteFromIndex(index: number): Note {
  const degree = index % 5;
  const octave = Math.floor(index / 5);
  return { index, degree, octave, midi: ROOT_MIDI + 12 * octave + PENTA[degree]! };
}

/** 線の長さ（論理 px）→ 音程。長いほど低い、対数マッピング */
export function lengthToNote(lengthPx: number): Note {
  const r = Math.min(R_MAX, Math.max(R_MIN, lengthPx / WORLD_W));
  const t = Math.log(r / R_MIN) / Math.log(R_MAX / R_MIN);
  return noteFromIndex(Math.round((1 - t) * (NOTE_COUNT - 1)));
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

// ---- ハーモニーの移ろい（step2-audio.md 案1 / D9） ----
// 線に固定するのはスロット（note 0..15）。実際の音高は衝突ステップの区間で決まる。

/** C 基準の音高クラス（昇順5つ）。隣り合うスケールは4音を共有する */
export const SCALES = {
  C: [0, 2, 4, 7, 9],
  F: [0, 2, 5, 7, 9],
  G: [2, 4, 7, 9, 11],
} as const;

// ---- 曲（D48）: 和音の進み方・調・後ろの和音の音色をまとめて選ぶ ----
// どの曲も4区間。各区間は5音の音階（C 基準の音高クラス、昇順）と根音。
// 区間が変わっても同じスロットの音が大きく跳ばないよう、隣り合う音階は近い音を選ぶ（3半音以内）。

export type SongId = 'bright' | 'dusk' | 'wistful' | 'still';
export type Song = {
  scales: readonly (readonly number[])[];
  /** 各区間の根音（C 基準の音高クラス）。キックと後ろの和音に使う */
  roots: readonly number[];
};

export const SONGS: Record<SongId, Song> = {
  /** 明るい: C–F–C–G（I–IV–I–V、長調）。最初からの曲 */
  bright: { scales: [SCALES.C, SCALES.F, SCALES.C, SCALES.G], roots: [0, 5, 0, 7] },
  /** 暗め: Cm–A♭–E♭–B♭（短調） */
  dusk: {
    scales: [[0, 3, 5, 7, 10], [0, 3, 5, 8, 10], [0, 3, 5, 7, 10], [0, 2, 5, 7, 10]],
    roots: [0, 8, 3, 10],
  },
  /** せつない: F–G–Em–Am（IV–V–iii–vi） */
  wistful: { scales: [SCALES.F, SCALES.G, SCALES.G, SCALES.C], roots: [5, 7, 4, 9] },
  /** 動かない: C のまま（和音が変わらない） */
  still: { scales: [SCALES.C, SCALES.C, SCALES.C, SCALES.C], roots: [0, 0, 0, 0] },
};
export const SONG_IDS = Object.keys(SONGS) as SongId[];
export const DEFAULT_SONG: SongId = 'bright';

export function isSongId(v: unknown): v is SongId {
  return typeof v === 'string' && Object.hasOwn(SONGS, v);
}

/** 進行 I–IV–I–V（bright）。区間の数はどの曲も同じ */
export const PROG: readonly (readonly number[])[] = SONGS.bright.scales;

/** 1区間のステップ数 */
export function sectionSteps(bpm: number, bars: number, hz: number): number {
  return Math.max(1, Math.round(beatSteps(bars * 4, bpm, hz)));
}

/** 区間番号（0..PROG.length-1）。anchor 以前のステップにも対応する */
export function sectionAt(step: number, anchor: number, base: number, len: number): number {
  const n = PROG.length;
  const k = base + Math.floor((step - anchor) / len);
  return ((k % n) + n) % n;
}

/** スロットと区間 → MIDI ノート番号 */
export function midiAt(slot: number, section: number, song: SongId = DEFAULT_SONG): number {
  const { degree, octave } = noteFromIndex(slot);
  const scales = SONGS[song].scales;
  return ROOT_MIDI + 12 * octave + scales[section % scales.length]![degree]!;
}

/** 区間の根音（C 基準の音高クラス） */
export function sectionRoot(section: number, song: SongId = DEFAULT_SONG): number {
  const roots = SONGS[song].roots;
  return roots[section % roots.length]!;
}

/**
 * circle（キック）の音高（D16）。区間の根音にそろえ、図形が大きい（スロットが低い）ほど低いオクターブ。
 * スロット 0–4 → C1 帯、5–9 → C2 帯、10–15 → C3 帯（タム寄り）
 */
export function kickMidi(slot: number, section: number, song: SongId = DEFAULT_SONG): number {
  const oct = slot < 5 ? 0 : slot < 10 ? 1 : 2;
  return KICK_ROOT_MIDI + 12 * oct + sectionRoot(section, song);
}

/** 形の音高: circle は kickMidi、それ以外は midiAt */
export function formMidi(form: string, slot: number, section: number, song: SongId = DEFAULT_SONG): number {
  return form === 'circle' ? kickMidi(slot, section, song) : midiAt(slot, section, song);
}

// ---- エフェクトの音高（D32） ----

/** 1段上がるときのスロットの幅: circle は音高が5スロットごとの帯で決まるので1帯、ほかは音階の1音 */
export function slotStep(form: string): number {
  return form === 'circle' ? 5 : 1;
}

/** rise の k 回目のスロット。一番上（SLOT_MAX）を超えたら -1（そこで止める） */
export function riseSlot(form: string, slot: number, k: number): number {
  const n = slot + k * slotStep(form);
  return n < NOTE_COUNT ? n : -1;
}

/**
 * chord で重ねるスロット。ペンタトニックで2つ上（3度前後）と3つ上（5度前後）、circle は1帯・2帯上（キック + タム）。
 * 上に収まらない音は同じだけ下に取る
 */
export function chordSlots(form: string, slot: number): number[] {
  const offs = form === 'circle' ? [5, 10] : [2, 3];
  const out: number[] = [];
  for (const o of offs) {
    const n = slot + o < NOTE_COUNT ? slot + o : slot - o;
    if (n >= 0 && !out.includes(n)) out.push(n);
  }
  return out;
}
