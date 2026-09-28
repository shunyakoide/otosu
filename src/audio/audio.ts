import * as Tone from 'tone';
import { WORLD_W } from '../sim/constants';
import { midiToFreq, noteFromIndex, ROOT_MIDI, SLOT_MAX, type SongId } from '../sim/music';
import type { HitEvent, ShapeForm } from '../sim/types';
import {
  BELL, CHIME_VOICES, clamp, KICK_LP_HZ, KICK_SEND, KICK_VOICES, makeBellVoice, makeChimeVoice, makeKickVoice, makePenVoice,
  makeSubVoice, makeWoodVoice, PEN, PEN_VOICES, strikeChime, strikeFm, strikeKick, strikeWood, SUB_VOICES, VOICES, WOOD_VOICES,
  type ChimeVoice, type FmStrikeSpec, type FmVoice, type KickVoice, type SubVoice, type WoodVoice,
} from './instruments';
import { Pad } from './pad';
import { emptyPool, freeSlot, makePool, pickSlot, type Pool } from './voicePool';

// 音色: ガラス／マレット系の減衰音＋深めのリバーブ（docs/design/audio.md）。
// ステップ2: 自前ボイスプールで音域ごとの音色とステレオ定位（docs/design/step2-audio.md 案2・案3）。
// ステップ4: 確定音・ティック・パッド・energy による盛り上がり・バンパーの音色・ミュート（decisions.md D11, D15）。
// ステップ5: 図形の形ごとの楽器（decisions.md D16）。line = ベル、pen = カリンバ、circle = キック〜タム、
//            triangle = チャイム／シンギングボウル、square = ウッドブロック。確定音も形の音色で鳴らす。
// 発音時刻は呼び出し側が rawContext.currentTime 基準で渡す（decisions.md D3, D8-2）。
// 楽器は instruments.ts、声部の選び方は voicePool.ts、パッドは pad.ts。
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

/** energy の平滑化の時定数（秒）と、エフェクトのパラメータを書き換える最小間隔 */
const ENERGY_TAU = 3;
const ENERGY_UPDATE_SEC = 0.1;
/** これを超えるとオクターブ上を重ね始める（平滑化後の energy） */
const DOUBLE_FROM = 0.55;

/** 止めたとき音が消えきるまで・続けたとき戻るまで（D50） */
const STOP_FADE_SEC = 3;
const PLAY_FADE_SEC = 0.6;

/** 確定音（line 以外）を衝突より小さくする量 */
const CONFIRM_DB = -7;
/** 確定音の音域の幅（半音）。一番上のスロットの音高 − ROOT_MIDI = 36（C3 … C6） */
const CONFIRM_SPAN = noteFromIndex(SLOT_MAX).midi - ROOT_MIDI;

export class Audio {
  private voices: Pool<FmVoice> = emptyPool();
  private penVoices: Pool<FmVoice> = emptyPool();
  private kickVoices: Pool<KickVoice> = emptyPool();
  private subVoices: Pool<SubVoice> = emptyPool();
  private chimeVoices: Pool<ChimeVoice> = emptyPool();
  private woodVoices: Pool<WoodVoice> = emptyPool();
  private delay!: Tone.PingPongDelay;
  private brightness!: Tone.Filter;
  private master!: Tone.Gain;
  private stereoWidth = 0.7;
  private started = false;
  private starting: Promise<void> | null = null;

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
  private readonly pad = new Pad();
  private pendingRoot: number | undefined;

  private muted = false;
  private playing = true;

  /**
   * ネイティブの AudioContext を自前で作って Tone に渡す。
   * Tone が自動で作る Context は互換ラッパーで、描画・MIDI の時刻合わせに要る生の currentTime や outputLatency を直接読めないため。
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

  /** 音の仕組みを作って鳴らし始める。何度呼んでも一度だけ作る（失敗したら呼び直せる） */
  start(bpm: number): Promise<void> {
    this.starting ??= this.build(bpm).catch((err: unknown) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  private async build(bpm: number): Promise<void> {
    await Tone.start();

    // ---- 衝突ボイス ----
    const hitBus = new Tone.Gain(1);
    this.voices = makePool(VOICES, () => makeBellVoice(hitBus));

    // ---- 共通のエフェクト ----
    const highpass = new Tone.Filter({ type: 'highpass', frequency: 120, rolloff: -12 });
    this.brightness = new Tone.Filter({ type: 'lowpass', frequency: this.brightnessHz(0), rolloff: -12, Q: 0.5 });
    this.delay = new Tone.PingPongDelay({
      delayTime: (60 / bpm) * 0.75, feedback: 0.28, wet: this.delayWet(0), maxDelay: 1.5,
    });
    const reverb = new Tone.Reverb({ decay: 6, preDelay: 0.03, wet: 0.35 });
    this.master = new Tone.Gain(this.level());
    const comp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.01, release: 0.25 });
    const limiter = new Tone.Limiter(-1);
    hitBus.chain(highpass, this.brightness, this.delay, reverb, this.master, comp, limiter, Tone.getDestination());
    Tone.getDestination().volume.value = -3;

    this.penVoices = makePool(PEN_VOICES, () => makePenVoice(hitBus));
    this.chimeVoices = makePool(CHIME_VOICES, () => makeChimeVoice(hitBus));

    // ---- square: ウッドブロック（ディレイは通さない） ----
    const percBus = new Tone.Gain(1);
    const percHighpass = new Tone.Filter({ type: 'highpass', frequency: 200, rolloff: -12 });
    percBus.chain(percHighpass, reverb);
    this.woodVoices = makePool(WOOD_VOICES, () => makeWoodVoice(percBus));

    // ---- circle: キック〜タム（ローパスで丸く、リバーブは薄く。鼓動であって EDM の押し出しではない） ----
    const kickBus = new Tone.Gain(1);
    const kickLowpass = new Tone.Filter({ type: 'lowpass', frequency: KICK_LP_HZ, rolloff: -24, Q: 0.5 });
    const kickSend = new Tone.Gain(KICK_SEND);
    kickBus.connect(kickLowpass);
    kickLowpass.connect(this.master);
    kickLowpass.chain(kickSend, reverb);
    this.kickVoices = makePool(KICK_VOICES, () => makeKickVoice(kickBus));
    this.subVoices = makePool(SUB_VOICES, () => makeSubVoice(kickBus));

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
    this.pad.build(reverb);

    await reverb.ready;
    this.started = true;
    if (this.pendingRoot !== undefined) this.setSection(this.pendingRoot, this.raw.currentTime);
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
    this.master.gain.rampTo(this.level(), 0.03);
  }

  /** 再生・停止（D50）。止めるとすべての内蔵音を STOP_FADE_SEC かけて小さくし、続けると少し早めに戻す */
  setPlaying(on: boolean): void {
    this.playing = on;
    if (!this.started) return;
    this.master.gain.rampTo(this.level(), on ? PLAY_FADE_SEC : STOP_FADE_SEC);
  }

  private level(): number {
    return this.muted || !this.playing ? 0 : 1;
  }

  // ---- 衝突 ----

  /** 形（e.form）で楽器を振り分ける（D16）。バンパーはどの形でもアタックを強める */
  play(e: HitEvent, time: number): void {
    if (!this.started) return;
    this.updateEnergy(e.energy, time);

    // 過去の時刻は Tone が現在時刻に丸めるので、同時刻の判定もそれに合わせる
    const at = Math.max(time, this.raw.currentTime);
    const pan = clamp(this.stereoWidth * ((2 * e.x) / WORLD_W - 1), -1, 1);
    const t = clamp(e.note / SLOT_MAX, 0, 1);
    const bumper = e.segKind === 'bumper';

    switch (e.form) {
      case 'circle': {
        const v = pickSlot(this.kickVoices, at);
        if (v) strikeKick(v, this.subVoices, e.midi, e.velocity, pan, at, bumper, 0);
        return;
      }
      case 'triangle': {
        const v = pickSlot(this.chimeVoices, at);
        if (v) strikeChime(v, e.midi, t, e.velocity, pan, at, bumper, 0);
        return;
      }
      case 'square': {
        const v = pickSlot(this.woodVoices, at);
        if (v) strikeWood(v, e.midi, t, e.velocity, pan, at, bumper, 0);
        return;
      }
      case 'pen':
        this.playFm(this.penVoices, PEN, e, t, pan, at, bumper);
        return;
      default:
        // line: 今までの FM ベル
        this.playFm(this.voices, BELL, e, t, pan, at, bumper);
    }
  }

  /**
   * line / pen を鳴らす。盛り上がっているときはオクターブ上を重ねる。
   * 重ねる音は空いている声部があるときだけ（本体の音を奪わない）
   */
  private playFm(pool: Pool<FmVoice>, spec: FmStrikeSpec, e: HitEvent, t: number, pan: number, at: number, bumper: boolean): void {
    const v = pickSlot(pool, at);
    if (v) strikeFm(v, spec, e.midi, t, e.velocity, pan, at, bumper, 0);
    if (this.energy <= DOUBLE_FROM || e.midi + 12 > 96) return;
    const free = freeSlot(pool, at);
    if (!free) return;
    const k = (this.energy - DOUBLE_FROM) / (1 - DOUBLE_FROM);
    strikeFm(free, spec, e.midi + 12, Math.min(1, t + 0.2), e.velocity, pan, at, false, -12 + 6 * k, 0.7);
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

  // ---- 入力へのフィードバック（D11: MIDI には送らない） ----

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
    const t = clamp((midi - ROOT_MIDI) / CONFIRM_SPAN, 0, 1);
    switch (form) {
      case 'circle': {
        const v = pickSlot(this.kickVoices, at);
        if (v) strikeKick(v, this.subVoices, midi, 0.5, 0, at, false, CONFIRM_DB);
        return;
      }
      case 'triangle': {
        const v = pickSlot(this.chimeVoices, at);
        if (v) strikeChime(v, midi, t, 0.6, 0, at, false, CONFIRM_DB);
        return;
      }
      case 'square': {
        const v = pickSlot(this.woodVoices, at);
        if (v) strikeWood(v, midi, t, 0.6, 0, at, false, CONFIRM_DB);
        return;
      }
      case 'pen': {
        const v = pickSlot(this.penVoices, at);
        if (v) strikeFm(v, PEN, midi, t, 0.6, 0, at, false, CONFIRM_DB, 0.8);
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

  /** 区間が変わったらパッドのコード（根音＋5度）をゆっくりクロスフェードで切り替える。root = 区間の根音（C 基準の音高クラス） */
  setSection(root: number, time: number): void {
    if (!this.started) {
      this.pendingRoot = root;
      return;
    }
    this.pad.setRoot(root, Math.max(time, this.raw.currentTime));
  }

  /** 曲に合わせてパッドの明るさを変える（D48） */
  setSong(song: SongId): void {
    this.pad.setSong(song, this.started);
  }

  setPad(on: boolean): void {
    this.pad.setOn(on, this.started);
  }

  /** 0..1 */
  setPadLevel(v: number): void {
    this.pad.setLevel(v, this.started);
  }
}
