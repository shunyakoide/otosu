import * as Tone from 'tone';
import { WORLD_W } from '../sim/constants';
import type { HitEvent, ShapeForm } from '../sim/types';

// 音色: ガラス／マレット系の減衰音＋深めのリバーブ（docs/design/audio.md）。
// ステップ2: 自前ボイスプールで音域ごとの音色とステレオ定位（docs/design/step2-audio.md 案2・案3）。
// ステップ4: 確定音・ティック・パッド・energy による盛り上がり・バンパーの音色・ミュート（decisions.md D11, D15）。
// ステップ5: 図形の形ごとの楽器（decisions.md D16）。line = ベル、pen = カリンバ、circle = キック〜タム、
//            triangle = チャイム／シンギングボウル、square = ウッドブロック。確定音も形の音色で鳴らす。
// 発音時刻は呼び出し側が rawContext.currentTime 基準で渡す（decisions.md D3, D8-2）。
//
// 信号の流れ（すべてリミッターの前で音量を揃える）:
//   ベル ×24 / カリンバ ×8 / チャイム ×6 → Panner → hitBus → highpass → brightness(lowpass) → PingPongDelay → reverb → master
//   ウッドブロック ×4 → Panner → percBus ──────────────────────────────────────────────→ reverb（ディレイは通さない）
//   キック ×4（＋サブ ×2）→ kickBus → kickLowpass ─────────────────────────────────────────────→ master（ほぼドライ）
//                                              └→ kickSend（少しだけ）────────────────→ reverb
//   確定音 ×2（line）───────────────────────────────────────────────────────────────→ reverb
//   パッド A/B（根音＋5度）→ padFilter → padGain ─────────────────────────────────────→ reverb
//   ティック ─────────────────────────────────────────────────────────────────────────────────→ master
//   master（ミュート）→ Compressor → Limiter → Destination

const VOICES = 24;
/** 1声部あたりの基準音量（旧 PolySynth 全体の -14dB と同じ。24声の和はコンプ＋リミッターで収める） */
const VOICE_BASE_DB = -15;
/** 音程スロットの最大値（0..15） */
const SLOT_MAX = 15;
const RELEASE = 0.4;

/** energy の平滑化の時定数（秒）と、エフェクトのパラメータを書き換える最小間隔 */
const ENERGY_TAU = 3;
const ENERGY_UPDATE_SEC = 0.1;
/** これを超えるとオクターブ上を重ね始める（平滑化後の energy） */
const DOUBLE_FROM = 0.55;

/** パッドの根音（C 基準の音高クラス）。進行 PROG = I–IV–I–V（sim/music.ts）に対応 */
const PAD_ROOT_PC = [0, 5, 0, 7] as const;
const PAD_ROOT_MIDI = 48; // C3
const PAD_XFADE_SEC = 3;
/** setPadLevel(1) のときのパッドの音量（線形） */
const PAD_MAX_GAIN = 0.1;

// ---- pen: カリンバ（はじく音） ----
const PEN_VOICES = 8;
/** ベル（VOICE_BASE_DB）より少し小さく */
const PEN_BASE_DB = -17;
const PEN_RELEASE = 0.3;
/** 変調の周波数比。非整数にして、アタックだけに金属の舌（タイン）の非整数倍音を出す */
const PEN_TINE_LOW = 5.4;
const PEN_TINE_HIGH = 4.0;

// ---- circle: 柔らかいキック〜タム ----
/** こだま1回ごとの音量の下げ幅（dB。velocity の減衰に加える。D21） */
const ECHO_DB = -4;
const KICK_VOICES = 4;
const KICK_BASE_DB = -16;
const KICK_RELEASE = 0.3;
/** キックのローパス（高域を落として丸いアタックに） */
const KICK_LP_HZ = 800;
/** リバーブへの送り量（線形）。ほぼドライ */
const KICK_SEND = 0.1;
/** 低域は中央寄せにする（e.x の定位に掛ける係数） */
const KICK_PAN = 0.35;
/** いちばん低い帯（C1 帯）だけに重ねるサイン波のサブ */
const SUB_VOICES = 2;
const SUB_DB = -18;

// ---- triangle: チャイム／シンギングボウル ----
const CHIME_VOICES = 6;
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
const WOOD_VOICES = 4;
const WOOD_BASE_DB = -21;
/** クリック（帯域通過したノイズ）の音量。帯域で削れるぶん大きめ */
const WOOD_NOISE_DB = -16;
/** これより低い音高は1オクターブ上げる（C4） */
const WOOD_LIFT_BELOW = 60;

/** 確定音（line 以外）を衝突より小さくする量 */
const CONFIRM_DB = -7;

/** 声部の共通部分（発音の開始時刻と鳴り終わる時刻） */
type Slot = {
  /** 最後に発音を始めた時刻。一番古い声部を選ぶのに使う */
  startedAt: number;
  /** リリースまで鳴り終わる時刻 */
  endsAt: number;
};

type Voice = Slot & { synth: Tone.FMSynth; panner: Tone.Panner };
type KickVoice = Slot & { synth: Tone.MembraneSynth; panner: Tone.Panner };
type SubVoice = Slot & { synth: Tone.Synth };
type ChimeVoice = Slot & { fm: Tone.FMSynth; beat: Tone.Synth; panner: Tone.Panner };
type WoodVoice = Slot & { tone: Tone.MembraneSynth; noise: Tone.NoiseSynth; band: Tone.Filter; panner: Tone.Panner };

/** 同じ声部を同時刻に再発音すると Tone が例外を投げるので、それより確実に後の時刻だけを使う */
const RETRIGGER_EPS = 1e-4;

/**
 * 鳴り終わった声部があればその中で一番古いもの、なければ一番古く発音を始めた声部を止めて使う。
 * どの声部も at と同時刻（以降）に発音済みなら undefined（その音は捨てる）
 */
function pickSlot<V extends Slot>(pool: readonly V[], at: number): V | undefined {
  return freeSlot(pool, at) ?? oldestSlot(pool, at);
}

function freeSlot<V extends Slot>(pool: readonly V[], at: number): V | undefined {
  let free: V | undefined;
  for (const v of pool) {
    if (v.endsAt <= at && v.startedAt < at - RETRIGGER_EPS && (!free || v.startedAt < free.startedAt)) free = v;
  }
  return free;
}

function oldestSlot<V extends Slot>(pool: readonly V[], at: number): V | undefined {
  let oldest: V | undefined;
  for (const v of pool) {
    if (v.startedAt < at - RETRIGGER_EPS && (!oldest || v.startedAt < oldest.startedAt)) oldest = v;
  }
  return oldest;
}

type PadLayer = { root: Tone.FatOscillator; fifth: Tone.FatOscillator; gain: Tone.Gain };

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export class Audio {
  private readonly voices: Voice[] = [];
  private readonly penVoices: Voice[] = [];
  private readonly kickVoices: KickVoice[] = [];
  private readonly subVoices: SubVoice[] = [];
  private readonly chimeVoices: ChimeVoice[] = [];
  private readonly woodVoices: WoodVoice[] = [];
  private delay!: Tone.PingPongDelay;
  private brightness!: Tone.Filter;
  private master!: Tone.Gain;
  private stereoWidth = 0.7;
  private started = false;

  // energy（盛り上がり）
  private energy = 0;
  private energyAt = -Infinity;
  private energyAppliedAt = -Infinity;

  // 確定音・ティック
  private readonly confirmVoices: Tone.FMSynth[] = [];
  private confirmNext = 0;
  private lastConfirmAt = -Infinity;
  private tickSynth!: Tone.Synth;
  private lastTickAt = -Infinity;

  // パッド
  private readonly padLayers: PadLayer[] = [];
  private padGain!: Tone.Gain;
  private padActive = -1;
  private padSection = -1;
  private padOn = true;
  private padLevel = 0.5;
  private pendingSection: number | undefined;

  private muted = false;

  /**
   * ネイティブの AudioContext を自前で作って Tone に渡す。
   * Tone が自動で作る Context は互換ラッパーで getOutputTimestamp を持たないため（描画・MIDI の時刻合わせに必要）。
   * 他のノードより先に呼ぶ必要があるので、生成とは分けている。
   */
  private static native: AudioContext;

  static setupContext(): void {
    Audio.native = new AudioContext({ latencyHint: 'interactive' });
    const ctx = new Tone.Context({
      // Tone の型は互換ラッパーの AudioContext を要求するが、実行時はネイティブも受け付ける
      context: Audio.native as never,
      lookAhead: 0,
    });
    Tone.setContext(ctx);
  }

  get raw(): AudioContext {
    return Audio.native;
  }

  async start(bpm: number): Promise<void> {
    await Tone.start();

    // ---- 衝突ボイス ----
    const hitBus = new Tone.Gain(1);
    for (let i = 0; i < VOICES; i++) {
      const synth = new Tone.FMSynth({
        harmonicity: 3,
        modulationIndex: 3.5,
        oscillator: { type: 'sine' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.004, decay: 1.4, sustain: 0, release: RELEASE },
        modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.2 },
        volume: VOICE_BASE_DB,
      });
      const panner = new Tone.Panner(0);
      synth.chain(panner, hitBus);
      this.voices.push({ synth, panner, startedAt: -Infinity, endsAt: -Infinity });
    }

    // ---- 共通のエフェクト ----
    const highpass = new Tone.Filter({ type: 'highpass', frequency: 120, rolloff: -12 });
    this.brightness = new Tone.Filter({ type: 'lowpass', frequency: this.brightnessHz(0), rolloff: -12, Q: 0.5 });
    this.delay = new Tone.PingPongDelay({
      delayTime: (60 / bpm) * 0.75, feedback: 0.28, wet: this.delayWet(0), maxDelay: 1.5,
    });
    const reverb = new Tone.Reverb({ decay: 6, preDelay: 0.03, wet: 0.35 });
    this.master = new Tone.Gain(this.muted ? 0 : 1);
    const comp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.01, release: 0.25 });
    const limiter = new Tone.Limiter(-1);
    hitBus.chain(highpass, this.brightness, this.delay, reverb, this.master, comp, limiter, Tone.getDestination());
    Tone.getDestination().volume.value = -3;

    // ---- pen: カリンバ（短く明るいアタック、サイン波の胴、1〜1.5秒で減衰） ----
    for (let i = 0; i < PEN_VOICES; i++) {
      const synth = new Tone.FMSynth({
        harmonicity: PEN_TINE_LOW,
        modulationIndex: 2,
        oscillator: { type: 'sine' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.002, decay: 1.3, sustain: 0, release: PEN_RELEASE },
        // 変調はごく短く消える → 立ち上がりだけ金属的、あとは素直なサイン
        modulationEnvelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.05 },
        volume: PEN_BASE_DB,
      });
      const panner = new Tone.Panner(0);
      synth.chain(panner, hitBus);
      this.penVoices.push({ synth, panner, startedAt: -Infinity, endsAt: -Infinity });
    }

    // ---- triangle: チャイム（非整数比の FM ＋少しずらしたサインでうなり、3〜5秒の余韻） ----
    for (let i = 0; i < CHIME_VOICES; i++) {
      const panner = new Tone.Panner(0).connect(hitBus);
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
      this.chimeVoices.push({ fm, beat, panner, startedAt: -Infinity, endsAt: -Infinity });
    }

    // ---- square: ウッドブロック（短い音程つきの胴＋帯域通過ノイズのクリック。ディレイは通さない） ----
    const percBus = new Tone.Gain(1);
    const percHighpass = new Tone.Filter({ type: 'highpass', frequency: 200, rolloff: -12 });
    percBus.chain(percHighpass, reverb);
    for (let i = 0; i < WOOD_VOICES; i++) {
      const panner = new Tone.Panner(0).connect(percBus);
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
      this.woodVoices.push({ tone, noise, band, panner, startedAt: -Infinity, endsAt: -Infinity });
    }

    // ---- circle: キック〜タム（ローパスで丸く、リバーブは薄く。鼓動であって EDM の押し出しではない） ----
    const kickBus = new Tone.Gain(1);
    const kickLowpass = new Tone.Filter({ type: 'lowpass', frequency: KICK_LP_HZ, rolloff: -24, Q: 0.5 });
    const kickSend = new Tone.Gain(KICK_SEND);
    kickBus.connect(kickLowpass);
    kickLowpass.connect(this.master);
    kickLowpass.chain(kickSend, reverb);
    for (let i = 0; i < KICK_VOICES; i++) {
      const panner = new Tone.Panner(0).connect(kickBus);
      const synth = new Tone.MembraneSynth({
        octaves: 3,
        pitchDecay: 0.055,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.004, decay: 0.65, sustain: 0, release: KICK_RELEASE },
        volume: KICK_BASE_DB,
      }).connect(panner);
      this.kickVoices.push({ synth, panner, startedAt: -Infinity, endsAt: -Infinity });
    }
    for (let i = 0; i < SUB_VOICES; i++) {
      const synth = new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.012, decay: 1.0, sustain: 0, release: 0.3 },
        volume: SUB_DB,
      }).connect(kickBus);
      this.subVoices.push({ synth, startedAt: -Infinity, endsAt: -Infinity });
    }

    // ---- 確定音（控えめなポロン。ディレイは通さずリバーブだけ） ----
    for (let i = 0; i < 2; i++) {
      const s = new Tone.FMSynth({
        harmonicity: 2,
        modulationIndex: 1.2,
        oscillator: { type: 'sine' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.003, decay: 1.0, sustain: 0, release: 0.5 },
        modulationEnvelope: { attack: 0.002, decay: 0.15, sustain: 0, release: 0.2 },
        volume: -21,
      });
      s.connect(reverb);
      this.confirmVoices.push(s);
    }

    // ---- ティック（ごく短く小さく、ドライ） ----
    this.tickSynth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.03 },
      volume: -30,
    });
    this.tickSynth.connect(this.master);

    // ---- パッド（根音＋5度、2層でクロスフェード） ----
    const padFilter = new Tone.Filter({ type: 'lowpass', frequency: 900, rolloff: -24 });
    this.padGain = new Tone.Gain(this.padTarget());
    padFilter.chain(this.padGain, reverb);
    for (let i = 0; i < 2; i++) {
      const gain = new Tone.Gain(0).connect(padFilter);
      const root = new Tone.FatOscillator({ frequency: 130.8, type: 'sine', count: 2, spread: 14 }).connect(gain);
      const fifth = new Tone.FatOscillator({ frequency: 196, type: 'triangle', count: 2, spread: 10, volume: -6 })
        .connect(gain);
      root.start();
      fifth.start();
      this.padLayers.push({ root, fifth, gain });
    }

    await reverb.ready;
    this.started = true;
    if (this.pendingSection !== undefined) this.setSection(this.pendingSection, this.raw.currentTime);
  }

  setBpm(bpm: number): void {
    this.delay.delayTime.rampTo((60 / bpm) * 0.75, 0.1);
  }

  setVolume(db: number): void {
    Tone.getDestination().volume.rampTo(db, 0.05);
  }

  /** 0 = モノラル、1 = 画面の左右端をスピーカーの左右端に。次の発音から反映する */
  setStereoWidth(w: number): void {
    this.stereoWidth = clamp(w, 0, 1);
  }

  /** すべての内蔵音（衝突・確定音・ティック・パッド）を 30ms でミュート／解除する。MIDI 出力には関係しない */
  setMuted(on: boolean): void {
    this.muted = on;
    if (!this.started) return;
    this.master.gain.rampTo(on ? 0 : 1, 0.03);
  }

  // ---- 衝突 ----

  /** 形（e.form）で楽器を振り分ける（D16）。バンパーはどの形でもアタックを強める */
  play(e: HitEvent, time: number): void {
    if (!this.started) return;
    if (e.echo) {
      // こだま（D21）: 当たった音より弱く（velocity は sim で減衰済み）、少し遠く・暗くする。energy は動かさない
      const at = Math.max(time, this.raw.currentTime);
      const pan = clamp(this.stereoWidth * ((2 * e.x) / WORLD_W - 1), -1, 1);
      this.strikeKick(e.midi, e.velocity, pan, at, false, ECHO_DB * e.echo);
      return;
    }
    this.updateEnergy(e.energy, time);

    // 過去の時刻は Tone が現在時刻に丸めるので、同時刻の判定もそれに合わせる
    const at = Math.max(time, this.raw.currentTime);
    const pan = clamp(this.stereoWidth * ((2 * e.x) / WORLD_W - 1), -1, 1);
    const t = clamp(e.note / SLOT_MAX, 0, 1);
    const bumper = e.segKind === 'bumper';

    switch (e.form) {
      case 'circle':
        this.strikeKick(e.midi, e.velocity, pan, at, bumper, 0);
        return;
      case 'triangle':
        this.strikeChime(e.midi, t, e.velocity, pan, at, bumper, 0);
        return;
      case 'square':
        this.strikeWood(e.midi, t, e.velocity, pan, at, bumper, 0);
        return;
      case 'pen': {
        const v = pickSlot(this.penVoices, at);
        if (v) this.strikePen(v, e.midi, t, e.velocity, pan, at, bumper, 0);
        this.doubleOctave(this.penVoices, e, t, at, (fv, m, tt, g, ds) =>
          this.strikePen(fv, m, tt, e.velocity, pan, at, false, g, ds));
        return;
      }
      default: {
        // line: 今までの FM ベル
        const v = pickSlot(this.voices, at);
        if (v) this.strike(v, e.midi, t, e.velocity, pan, at, bumper, 0);
        this.doubleOctave(this.voices, e, t, at, (fv, m, tt, g, ds) =>
          this.strike(fv, m, tt, e.velocity, pan, at, false, g, ds));
      }
    }
  }

  /** 盛り上がっているときはオクターブ上を重ねる（line / pen のみ）。空いている声部があるときだけ（本体の音を奪わない） */
  private doubleOctave(
    pool: Voice[], e: HitEvent, t: number, at: number,
    strike: (v: Voice, midi: number, t: number, extraDb: number, decayScale: number) => void,
  ): void {
    if (this.energy <= DOUBLE_FROM || e.midi + 12 > 96) return;
    const free = freeSlot(pool, at);
    if (!free) return;
    const k = (this.energy - DOUBLE_FROM) / (1 - DOUBLE_FROM);
    strike(free, e.midi + 12, Math.min(1, t + 0.2), -12 + 6 * k, 0.7);
  }

  /** 1声部を鳴らす。t は音域（0 = 最低音 … 1 = 最高音） */
  private strike(
    v: Voice, midi: number, t: number, velocity: number, pan: number, time: number,
    bumper: boolean, extraDb: number, decayScale = 1,
  ): void {
    const harmonicity = t < 0.34 ? 2 : t < 0.67 ? 3 : 4;
    let modIndex = (1.2 + 2.8 * t) * (0.6 + 0.4 * velocity);
    let decay = (2.4 - 1.5 * t) * decayScale;
    let gainDb = VOICE_BASE_DB + 2 - 4 * t + extraDb;
    let modDecay = 0.25;
    let attack = 0.004;
    if (bumper) {
      // バンパー: 立ち上がりに強い打撃感（短く明るい変調）、胴鳴りは短め
      modIndex = modIndex * 1.5 + 1.5;
      modDecay = 0.06;
      attack = 0.001;
      decay *= 0.7;
      gainDb += 1.5;
    }

    const s = v.synth;
    s.harmonicity.setValueAtTime(harmonicity, time);
    s.modulationIndex.setValueAtTime(modIndex, time);
    s.volume.setValueAtTime(gainDb, time);
    v.panner.pan.setValueAtTime(pan, time);
    // エンベロープの値は triggerAttack の時点で読まれる（声部は同時に1音だけなので、ここで書き換えてよい）
    s.envelope.attack = attack;
    s.envelope.decay = decay;
    s.modulationEnvelope.decay = modDecay;
    const dur = decay * 0.85;
    s.triggerAttackRelease(midiToFreq(midi), dur, time, velocity);
    v.startedAt = time;
    v.endsAt = time + dur + RELEASE;
  }

  /** energy を時定数 ENERGY_TAU で平滑化し、明るさとディレイ量をゆっくり追従させる */
  private updateEnergy(target: number, time: number): void {
    const dt = Math.max(0, time - this.energyAt);
    const a = Number.isFinite(dt) ? 1 - Math.exp(-dt / ENERGY_TAU) : 1;
    this.energy += (clamp(target, 0, 1) - this.energy) * a;
    this.energyAt = time;
    if (time - this.energyAppliedAt < ENERGY_UPDATE_SEC) return;
    this.energyAppliedAt = time;
    this.brightness.frequency.rampTo(this.brightnessHz(this.energy), 0.8, time);
    this.delay.wet.rampTo(this.delayWet(this.energy), 0.8, time);
  }

  private brightnessHz(e: number): number {
    return 4000 * Math.pow(2, 2 * e); // 4k … 16k Hz
  }

  private delayWet(e: number): number {
    return 0.12 + 0.16 * e; // 0.12 … 0.28
  }

  // ---- 形ごとの楽器 ----

  /**
   * pen: カリンバ。非整数比の変調がアタックだけに鳴って（タインの倍音）すぐ消え、サイン波の胴が 1〜1.5 秒で減衰する。
   * t は音域（0 = 最低音 … 1 = 最高音）
   */
  private strikePen(
    v: Voice, midi: number, t: number, velocity: number, pan: number, at: number,
    bumper: boolean, extraDb: number, decayScale = 1,
  ): void {
    let modIndex = (1.6 + 1.4 * t) * (0.6 + 0.4 * velocity);
    let modDecay = 0.07;
    let attack = 0.002;
    let decay = (1.5 - 0.5 * t) * decayScale;
    let gainDb = PEN_BASE_DB + 1 - 3 * t + extraDb;
    if (bumper) {
      modIndex = modIndex * 1.5 + 1;
      modDecay = 0.035;
      attack = 0.001;
      decay *= 0.8;
      gainDb += 1.5;
    }
    const s = v.synth;
    s.harmonicity.setValueAtTime(PEN_TINE_LOW + (PEN_TINE_HIGH - PEN_TINE_LOW) * t, at);
    s.modulationIndex.setValueAtTime(modIndex, at);
    s.volume.setValueAtTime(gainDb, at);
    v.panner.pan.setValueAtTime(pan, at);
    s.envelope.attack = attack;
    s.envelope.decay = decay;
    s.modulationEnvelope.decay = modDecay;
    const dur = decay * 0.85;
    s.triggerAttackRelease(midiToFreq(midi), dur, at, velocity);
    v.startedAt = at;
    v.endsAt = at + dur + PEN_RELEASE;
  }

  /**
   * circle: 柔らかいキック〜タム。音高 × octaves から音高へ短く下がるサイン（MembraneSynth）をローパスで丸める。
   * 帯（kickMidi の C1 / C2 / C3）で胴の長さと音程の落ち幅を変え、C1 帯だけサイン波のサブを重ねる。
   * velocity の幅は狭くして、強弱より一定の鼓動にする
   */
  private strikeKick(midi: number, velocity: number, pan: number, at: number, bumper: boolean, extraDb: number): void {
    const v = pickSlot(this.kickVoices, at);
    if (!v) return;
    const low = midi < 36;
    const high = midi >= 48;
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
    s.octaves = octaves;
    s.pitchDecay = pitchDecay;
    s.envelope.attack = attack;
    s.envelope.decay = decay;
    s.volume.setValueAtTime(gainDb, at);
    v.panner.pan.setValueAtTime(pan * KICK_PAN, at);
    const dur = decay * 0.8;
    s.triggerAttackRelease(freq, dur, at, vel);
    v.startedAt = at;
    v.endsAt = at + dur + KICK_RELEASE;

    if (low) {
      const sub = pickSlot(this.subVoices, at);
      if (sub) {
        sub.synth.volume.setValueAtTime(SUB_DB + extraDb, at);
        sub.synth.triggerAttackRelease(freq, 0.7, at, vel);
        sub.startedAt = at;
        sub.endsAt = at + 0.7 + 0.3;
      }
    }
  }

  /**
   * triangle: チャイム／シンギングボウル。非整数比 FM の金属的な倍音に、少しずらしたサインを重ねてうなり（きらめき）を出す。
   * 低い音高は1オクターブ上げる。余韻 3〜5 秒、小さめ
   */
  private strikeChime(
    midi: number, t: number, velocity: number, pan: number, at: number, bumper: boolean, extraDb: number,
  ): void {
    const v = pickSlot(this.chimeVoices, at);
    if (!v) return;
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
    v.fm.modulationIndex.setValueAtTime(modIndex, at);
    v.fm.volume.setValueAtTime(gainDb, at);
    v.beat.volume.setValueAtTime(gainDb + CHIME_BEAT_DB, at);
    v.panner.pan.setValueAtTime(pan, at);
    v.fm.envelope.attack = attack;
    v.fm.envelope.decay = decay;
    v.beat.envelope.decay = decay * 1.1;
    const dur = decay * 0.85;
    v.fm.triggerAttackRelease(freq, dur, at, velocity);
    v.beat.triggerAttackRelease(freq * CHIME_DETUNE, dur, at, velocity);
    v.startedAt = at;
    v.endsAt = at + dur + CHIME_RELEASE;
  }

  /**
   * square: ウッドブロック／リム。音程がわずかに落ちる短いサイン（80〜140ms）＋帯域通過ノイズのクリック（約 20ms）。
   * 低い音高は1オクターブ上げる
   */
  private strikeWood(
    midi: number, t: number, velocity: number, pan: number, at: number, bumper: boolean, extraDb: number,
  ): void {
    const v = pickSlot(this.woodVoices, at);
    if (!v) return;
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
    v.tone.volume.setValueAtTime(toneDb, at);
    v.noise.volume.setValueAtTime(noiseDb, at);
    v.band.frequency.setValueAtTime(clamp(freq * 2.5, 1200, 6000), at);
    v.panner.pan.setValueAtTime(pan, at);
    v.tone.envelope.decay = decay;
    v.tone.triggerAttackRelease(freq, decay, at, vel);
    v.noise.triggerAttackRelease(0.02, at, vel);
    v.startedAt = at;
    v.endsAt = at + decay + 0.05;
  }

  // ---- 入力へのフィードバック（D11: MIDI には送らない） ----

  /** 図形を置いた確定音（控えめなポロン） */
  /**
   * 図形を置いた確定音。form の音色で、衝突より小さく中央で鳴らす（D16）。
   * form が line または省略のときは今までの控えめなポロン
   */
  confirm(midi: number, time: number, form?: ShapeForm): void {
    if (!this.started) return;
    const at = Math.max(time, this.raw.currentTime);
    // 配置の読み込みなどで同じステップに何個も来たときは1回だけ鳴らす（同時刻の再発音は Tone が例外を投げる）
    if (at < this.lastConfirmAt + 0.03) return;
    this.lastConfirmAt = at;
    // 音域 0..1（C3 … C6）。音色の明るさと余韻の長さに使う
    const t = clamp((midi - 48) / 36, 0, 1);
    switch (form) {
      case 'circle':
        this.strikeKick(midi, 0.5, 0, at, false, CONFIRM_DB);
        return;
      case 'triangle':
        this.strikeChime(midi, t, 0.6, 0, at, false, CONFIRM_DB);
        return;
      case 'square':
        this.strikeWood(midi, t, 0.6, 0, at, false, CONFIRM_DB);
        return;
      case 'pen': {
        const v = pickSlot(this.penVoices, at);
        if (v) this.strikePen(v, midi, t, 0.6, 0, at, false, CONFIRM_DB, 0.8);
        return;
      }
      default:
        break;
    }
    const s = this.confirmVoices[this.confirmNext]!;
    this.confirmNext = (this.confirmNext + 1) % this.confirmVoices.length;
    s.triggerAttackRelease(midiToFreq(midi), 0.8, at, 0.7);
  }

  /** ドラッグ中に音程スロットが変わったときのティック（即時、ごく短く小さく。1オクターブ上で鳴らす） */
  tick(midi: number): void {
    if (!this.started) return;
    const now = this.raw.currentTime;
    if (now - this.lastTickAt < 0.03) return; // 速くドラッグしたときの連打を間引く
    this.lastTickAt = now;
    this.tickSynth.triggerAttackRelease(midiToFreq(midi + 12), 0.03, now + 0.005, 0.8);
  }

  // ---- パッド（D11: 音だけ。MIDI には送らない） ----

  /** 区間が変わったらパッドのコード（根音＋5度）をゆっくりクロスフェードで切り替える */
  setSection(section: number, time: number): void {
    if (!this.started) {
      this.pendingSection = section;
      return;
    }
    const sec = ((section % PAD_ROOT_PC.length) + PAD_ROOT_PC.length) % PAD_ROOT_PC.length;
    if (sec === this.padSection) return;
    this.padSection = sec;
    const at = Math.max(time, this.raw.currentTime);
    const rootMidi = PAD_ROOT_MIDI + PAD_ROOT_PC[sec]!;

    const next = this.padActive === 0 ? 1 : 0;
    const layer = this.padLayers[next]!;
    layer.root.frequency.setValueAtTime(midiToFreq(rootMidi), at);
    layer.fifth.frequency.setValueAtTime(midiToFreq(rootMidi + 7), at);
    layer.gain.gain.cancelScheduledValues(at);
    layer.gain.gain.setValueAtTime(0, at);
    layer.gain.gain.linearRampToValueAtTime(1, at + PAD_XFADE_SEC);
    if (this.padActive >= 0) {
      const old = this.padLayers[this.padActive]!.gain.gain;
      old.cancelAndHoldAtTime(at);
      old.linearRampToValueAtTime(0, at + PAD_XFADE_SEC);
    }
    this.padActive = next;
  }

  setPad(on: boolean): void {
    this.padOn = on;
    if (this.started) this.padGain.gain.rampTo(this.padTarget(), on ? 2 : 1.5);
  }

  /** 0..1 */
  setPadLevel(v: number): void {
    this.padLevel = clamp(v, 0, 1);
    if (this.started) this.padGain.gain.rampTo(this.padTarget(), 0.3);
  }

  private padTarget(): number {
    return this.padOn ? this.padLevel * PAD_MAX_GAIN : 0;
  }
}
