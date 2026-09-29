import * as Tone from 'tone';
import { KICK_ROOT_MIDI, midiToFreq } from '../sim/music';
import { idleSlot, occupy, pickSlot, type Pool, type Slot } from './voicePool';

// 形ごとの楽器（decisions.md D16）。声部の作り方と、1音の鳴らし方。
// どの strike も時刻 at は呼び出し側が決める（同時刻の判定は Audio が Tone の丸めに合わせてから渡す）。

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---- line: FM ベル ----
export const VOICES = 24;
/** 1声部あたりの基準音量（旧 PolySynth 全体の -14dB と同じ。24声の和はコンプ＋リミッターで収める） */
const VOICE_BASE_DB = -15;
const RELEASE = 0.4;

// ---- pen: カリンバ（はじく音） ----
export const PEN_VOICES = 8;
/** ベル（VOICE_BASE_DB）より少し小さく */
const PEN_BASE_DB = -17;
const PEN_RELEASE = 0.3;
/** 変調の周波数比。非整数にして、アタックだけに金属の舌（タイン）の非整数倍音を出す */
const PEN_TINE_LOW = 5.4;
const PEN_TINE_HIGH = 4.0;

// ---- circle: 柔らかいキック〜タム ----
export const KICK_VOICES = 4;
const KICK_BASE_DB = -20;
const KICK_RELEASE = 0.3;
/** キックのローパス（高域を落として丸いアタックに） */
export const KICK_LP_HZ = 800;
/** リバーブへの送り量（線形）。ほぼドライ */
export const KICK_SEND = 0.1;
/** 低域は中央寄せにする（e.x の定位に掛ける係数） */
const KICK_PAN = 0.35;
/** いちばん低い帯（C1 帯）だけに重ねるサイン波のサブ */
export const SUB_VOICES = 2;
const SUB_DB = -22;

// ---- triangle: チャイム／シンギングボウル ----
export const CHIME_VOICES = 6;
const CHIME_BASE_DB = -25;
const CHIME_RELEASE = 1.2;
/** これより低い音高は1オクターブ上げる（E4） */
const CHIME_LIFT_BELOW = 64;
/** 変調の周波数比（非整数で金属的な倍音） */
const CHIME_RATIO = 2.76;
/** うなり用に重ねるサイン波の周波数比（約 6 セント上。1kHz で 3.5Hz のうなり） */
const CHIME_DETUNE = 1.0035;
const CHIME_BEAT_DB = -5;

// ---- square: ウッドブロック／リム ----
export const WOOD_VOICES = 4;
const WOOD_BASE_DB = -21;
/** クリック（帯域通過したノイズ）の音量。帯域で削れるぶん大きめ */
const WOOD_NOISE_DB = -16;
/** これより低い音高は1オクターブ上げる（C4） */
const WOOD_LIFT_BELOW = 60;

export type FmVoice = Slot & { synth: Tone.FMSynth; panner: Tone.Panner };
export type KickVoice = Slot & { synth: Tone.MembraneSynth; panner: Tone.Panner };
export type SubVoice = Slot & { synth: Tone.Synth };
export type ChimeVoice = Slot & { fm: Tone.FMSynth; beat: Tone.Synth; panner: Tone.Panner };
export type WoodVoice = Slot & { tone: Tone.MembraneSynth; noise: Tone.NoiseSynth; band: Tone.Filter; panner: Tone.Panner };

// ---- 声部を作る（足りなくなったときに Pool から呼ばれる。D40） ----

function makeFmVoice(opts: ConstructorParameters<typeof Tone.FMSynth>[0], bus: Tone.InputNode): FmVoice {
  const synth = new Tone.FMSynth(opts);
  const panner = new Tone.Panner(0);
  synth.chain(panner, bus);
  return { synth, panner, ...idleSlot() };
}

/** line: 今までの FM ベル */
export function makeBellVoice(bus: Tone.InputNode): FmVoice {
  return makeFmVoice({
    harmonicity: 3,
    modulationIndex: 3.5,
    oscillator: { type: 'sine' },
    modulation: { type: 'sine' },
    envelope: { attack: 0.004, decay: 1.4, sustain: 0, release: RELEASE },
    modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.2 },
    volume: VOICE_BASE_DB,
  }, bus);
}

/** pen: カリンバ（短く明るいアタック、サイン波の胴、1〜1.5秒で減衰） */
export function makePenVoice(bus: Tone.InputNode): FmVoice {
  return makeFmVoice({
    harmonicity: PEN_TINE_LOW,
    modulationIndex: 2,
    oscillator: { type: 'sine' },
    modulation: { type: 'sine' },
    envelope: { attack: 0.002, decay: 1.3, sustain: 0, release: PEN_RELEASE },
    // 変調はごく短く消える → 立ち上がりだけ金属的、あとは素直なサイン
    modulationEnvelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.05 },
    volume: PEN_BASE_DB,
  }, bus);
}

/** triangle: チャイム（非整数比の FM ＋少しずらしたサインでうなり、3〜5秒の余韻） */
export function makeChimeVoice(bus: Tone.InputNode): ChimeVoice {
  const panner = new Tone.Panner(0).connect(bus);
  const fm = new Tone.FMSynth({
    harmonicity: CHIME_RATIO,
    modulationIndex: 1,
    oscillator: { type: 'sine' },
    modulation: { type: 'sine' },
    envelope: { attack: 0.004, decay: 4, sustain: 0, release: CHIME_RELEASE },
    // 変調を少し残して、余韻の間も金属のきらめきを保つ
    modulationEnvelope: { attack: 0.004, decay: 1.2, sustain: 0.15, release: 1.5 },
    volume: CHIME_BASE_DB,
  }).connect(panner);
  const beat = new Tone.Synth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.03, decay: 4.4, sustain: 0, release: CHIME_RELEASE },
    volume: CHIME_BASE_DB + CHIME_BEAT_DB,
  }).connect(panner);
  return { fm, beat, panner, ...idleSlot() };
}

/** square: ウッドブロック（短い音程つきの胴＋帯域通過ノイズのクリック） */
export function makeWoodVoice(bus: Tone.InputNode): WoodVoice {
  const panner = new Tone.Panner(0).connect(bus);
  const tone = new Tone.MembraneSynth({
    // octaves は開始周波数の倍率（音高 × octaves から音高へ下がる）。ごく小さな音程の落ち込みで「コッ」
    octaves: 1.25,
    pitchDecay: 0.012,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.03 },
    volume: WOOD_BASE_DB,
  }).connect(panner);
  const band = new Tone.Filter({ type: 'bandpass', frequency: 2500, Q: 3 }).connect(panner);
  const noise = new Tone.NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.001, decay: 0.022, sustain: 0, release: 0.01 },
    volume: WOOD_NOISE_DB,
  }).connect(band);
  return { tone, noise, band, panner, ...idleSlot() };
}

/** circle: キック〜タム */
export function makeKickVoice(bus: Tone.InputNode): KickVoice {
  const panner = new Tone.Panner(0).connect(bus);
  const synth = new Tone.MembraneSynth({
    octaves: 3,
    pitchDecay: 0.055,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.004, decay: 0.65, sustain: 0, release: KICK_RELEASE },
    volume: KICK_BASE_DB,
  }).connect(panner);
  return { synth, panner, ...idleSlot() };
}

/** circle の C1 帯に重ねるサブ */
export function makeSubVoice(bus: Tone.InputNode): SubVoice {
  const synth = new Tone.Synth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.012, decay: 1.0, sustain: 0, release: 0.3 },
    volume: SUB_DB,
  }).connect(bus);
  return { synth, ...idleSlot() };
}

// ---- 鳴っている声部を奪う ----

/** 奪うときに前の音を消しきるまで・新しい音の大きさへ戻すまで（秒） */
const STEAL_SEC = 0.005;

type Volume = Tone.Param<'decibels'>;

/**
 * 声部がまだ鳴っていれば（空きがなくて奪ったなら）、その音量を at から STEAL_SEC で 0 まで下げて true を返す。
 * 鳴っている途中で高さや音色を瞬時に変えるとプツッと鳴るため、消しきってから変えて鳴らし直す
 */
function fadeIfSounding(v: Slot, vols: readonly Volume[], at: number): boolean {
  if (v.endsAt <= at) return false;
  for (const p of vols) {
    p.cancelAndHoldAtTime(at);
    p.linearRampToValueAtTime(-Infinity, at + STEAL_SEC);
  }
  return true;
}

/** 音量を at で db にする。奪った声部（0 まで下げた）は STEAL_SEC かけて戻す */
function setVolume(p: Volume, db: number, at: number, stolen: boolean): void {
  if (stolen) p.linearRampToValueAtTime(db, at + STEAL_SEC);
  else p.setValueAtTime(db, at);
}

// ---- 1音を鳴らす ----

/**
 * FM のはじく音（line のベル・pen のカリンバ）の音色。t は音域（0 = 最低音 … 1 = 最高音）。
 * [a, b] は a + b·t（modIndex）または a − b·t（decay・gainDb）
 */
export type FmStrikeSpec = {
  harmonicity: (t: number) => number;
  modIndex: readonly [number, number];
  decay: readonly [number, number];
  gainDb: readonly [number, number];
  attack: number;
  modDecay: number;
  release: number;
  /** バンパー: modIndex × 1.5 + modAdd、変調と胴を短く */
  bumper: { modAdd: number; modDecay: number; decay: number };
};

/** line: FM ベル。バンパーは立ち上がりに強い打撃感（短く明るい変調）、胴鳴りは短め */
export const BELL: FmStrikeSpec = {
  harmonicity: (t) => (t < 0.34 ? 2 : t < 0.67 ? 3 : 4),
  modIndex: [1.2, 2.8],
  decay: [2.4, 1.5],
  gainDb: [VOICE_BASE_DB + 2, 4],
  attack: 0.004,
  modDecay: 0.25,
  release: RELEASE,
  bumper: { modAdd: 1.5, modDecay: 0.06, decay: 0.7 },
};

/**
 * pen: カリンバ。非整数比の変調がアタックだけに鳴って（タインの倍音）すぐ消え、サイン波の胴が 1〜1.5 秒で減衰する
 */
export const PEN: FmStrikeSpec = {
  harmonicity: (t) => PEN_TINE_LOW + (PEN_TINE_HIGH - PEN_TINE_LOW) * t,
  modIndex: [1.6, 1.4],
  decay: [1.5, 0.5],
  gainDb: [PEN_BASE_DB + 1, 3],
  attack: 0.002,
  modDecay: 0.07,
  release: PEN_RELEASE,
  bumper: { modAdd: 1, modDecay: 0.035, decay: 0.8 },
};

/** FM の1声部を鳴らす（line / pen）。t は音域（0 = 最低音 … 1 = 最高音） */
export function strikeFm(
  v: FmVoice, sp: FmStrikeSpec, midi: number, t: number, velocity: number, pan: number, at0: number,
  bumper: boolean, extraDb: number, decayScale = 1,
): void {
  let modIndex = (sp.modIndex[0] + sp.modIndex[1] * t) * (0.6 + 0.4 * velocity);
  let decay = (sp.decay[0] - sp.decay[1] * t) * decayScale;
  let gainDb = sp.gainDb[0] - sp.gainDb[1] * t + extraDb;
  let modDecay = sp.modDecay;
  let attack = sp.attack;
  if (bumper) {
    modIndex = modIndex * 1.5 + sp.bumper.modAdd;
    modDecay = sp.bumper.modDecay;
    attack = 0.001;
    decay *= sp.bumper.decay;
    gainDb += 1.5;
  }

  const s = v.synth;
  const stolen = fadeIfSounding(v, [s.volume], at0);
  const at = stolen ? at0 + STEAL_SEC : at0;
  s.harmonicity.setValueAtTime(sp.harmonicity(t), at);
  s.modulationIndex.setValueAtTime(modIndex, at);
  setVolume(s.volume, gainDb, at, stolen);
  v.panner.pan.setValueAtTime(pan, at);
  // エンベロープの値は triggerAttack の時点で読まれる（声部は同時に1音だけなので、ここで書き換えてよい）
  s.envelope.attack = attack;
  s.envelope.decay = decay;
  s.modulationEnvelope.decay = modDecay;
  const dur = decay * 0.85;
  s.triggerAttackRelease(midiToFreq(midi), dur, at, velocity);
  occupy(v, at, dur, sp.release);
}

/**
 * circle: 柔らかいキック〜タム。音高 × octaves から音高へ短く下がるサイン（MembraneSynth）をローパスで丸める。
 * 帯（kickMidi の C1 / C2 / C3）で胴の長さと音程の落ち幅を変え、C1 帯だけサイン波のサブ（subs から取る）を重ねる。
 * velocity の幅は狭くして、強弱より一定の鼓動にする
 */
export function strikeKick(
  v: KickVoice, subs: Pool<SubVoice>, midi: number, velocity: number, pan: number, at0: number, bumper: boolean, extraDb: number,
): void {
  const low = midi < KICK_ROOT_MIDI + 12; // C1 帯
  const high = midi >= KICK_ROOT_MIDI + 24; // C3 帯
  let octaves = low ? 3.5 : high ? 2.2 : 3;
  let pitchDecay = low ? 0.07 : high ? 0.04 : 0.055;
  let attack = 0.004;
  const decay = low ? 0.9 : high ? 0.45 : 0.65;
  let gainDb = KICK_BASE_DB + (low ? 2 : high ? -3 : 0) + extraDb;
  if (bumper) {
    // バンパー: 音程の落ち幅を広く速く、立ち上がりを鋭く
    octaves *= 1.4;
    pitchDecay *= 0.7;
    attack = 0.001;
    gainDb += 2;
  }
  const vel = 0.55 + 0.45 * clamp(velocity, 0, 1);
  const freq = midiToFreq(midi);
  const s = v.synth;
  // サブもキックと同じ時刻に鳴らすので、どちらかを奪ったら両方を STEAL_SEC 遅らせる
  const sub = low ? pickSlot(subs, at0) : undefined;
  const stolen = fadeIfSounding(v, [s.volume], at0);
  const subStolen = sub !== undefined && fadeIfSounding(sub, [sub.synth.volume], at0);
  const at = stolen || subStolen ? at0 + STEAL_SEC : at0;
  s.octaves = octaves;
  s.pitchDecay = pitchDecay;
  s.envelope.attack = attack;
  s.envelope.decay = decay;
  setVolume(s.volume, gainDb, at, stolen);
  v.panner.pan.setValueAtTime(pan * KICK_PAN, at);
  const dur = decay * 0.8;
  s.triggerAttackRelease(freq, dur, at, vel);
  occupy(v, at, dur, KICK_RELEASE);

  if (sub) {
    setVolume(sub.synth.volume, SUB_DB + extraDb, at, subStolen);
    sub.synth.triggerAttackRelease(freq, 0.7, at, vel);
    occupy(sub, at, 0.7, 0.3);
  }
}

/**
 * triangle: チャイム／シンギングボウル。非整数比 FM の金属的な倍音に、少しずらしたサインを重ねてうなり（きらめき）を出す。
 * 低い音高は1オクターブ上げる。余韻 3〜5 秒、小さめ
 */
export function strikeChime(
  v: ChimeVoice, midi: number, t: number, velocity: number, pan: number, at0: number, bumper: boolean, extraDb: number,
): void {
  const m = midi < CHIME_LIFT_BELOW ? midi + 12 : midi;
  let modIndex = 0.7 + 0.5 * velocity;
  let attack = 0.004;
  const decay = 4.8 - 1.6 * t;
  let gainDb = CHIME_BASE_DB - 2 * t + extraDb;
  if (bumper) {
    modIndex += 1.5;
    attack = 0.001;
    gainDb += 1.5;
  }
  const freq = midiToFreq(m);
  const stolen = fadeIfSounding(v, [v.fm.volume, v.beat.volume], at0);
  const at = stolen ? at0 + STEAL_SEC : at0;
  v.fm.modulationIndex.setValueAtTime(modIndex, at);
  setVolume(v.fm.volume, gainDb, at, stolen);
  setVolume(v.beat.volume, gainDb + CHIME_BEAT_DB, at, stolen);
  v.panner.pan.setValueAtTime(pan, at);
  v.fm.envelope.attack = attack;
  v.fm.envelope.decay = decay;
  v.beat.envelope.decay = decay * 1.1;
  const dur = decay * 0.85;
  v.fm.triggerAttackRelease(freq, dur, at, velocity);
  v.beat.triggerAttackRelease(freq * CHIME_DETUNE, dur, at, velocity);
  occupy(v, at, dur, CHIME_RELEASE);
}

/**
 * square: ウッドブロック／リム。音程がわずかに落ちる短いサイン（80〜140ms）＋帯域通過ノイズのクリック（約 20ms）。
 * 低い音高は1オクターブ上げる
 */
export function strikeWood(
  v: WoodVoice, midi: number, t: number, velocity: number, pan: number, at0: number, bumper: boolean, extraDb: number,
): void {
  const m = midi < WOOD_LIFT_BELOW ? midi + 12 : midi;
  const freq = midiToFreq(m);
  const decay = 0.14 - 0.06 * t;
  let toneDb = WOOD_BASE_DB - 2 * t + extraDb;
  let noiseDb = WOOD_NOISE_DB + extraDb;
  if (bumper) {
    // バンパー: クリックを強く
    noiseDb += 4;
    toneDb += 1;
  }
  const vel = 0.5 + 0.5 * clamp(velocity, 0, 1);
  const stolen = fadeIfSounding(v, [v.tone.volume, v.noise.volume], at0);
  const at = stolen ? at0 + STEAL_SEC : at0;
  setVolume(v.tone.volume, toneDb, at, stolen);
  setVolume(v.noise.volume, noiseDb, at, stolen);
  v.band.frequency.setValueAtTime(clamp(freq * 2.5, 1200, 6000), at);
  v.panner.pan.setValueAtTime(pan, at);
  v.tone.envelope.decay = decay;
  v.tone.triggerAttackRelease(freq, decay, at, vel);
  v.noise.triggerAttackRelease(0.02, at, vel);
  occupy(v, at, decay, 0.05);
}
