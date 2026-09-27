import * as Tone from 'tone';
import { WORLD_W } from '../sim/constants';
import type { HitEvent } from '../sim/types';

// 音色: ガラス／マレット系の減衰音＋深めのリバーブ（docs/design/audio.md）。
// ステップ2: 自前ボイスプールで音域ごとの音色とステレオ定位（docs/design/step2-audio.md 案2・案3）。
// ステップ4: 確定音・ティック・パッド・energy による盛り上がり・バンパーの音色・ミュート（decisions.md D11, D15）。
// 発音時刻は呼び出し側が rawContext.currentTime 基準で渡す（decisions.md D3, D8-2）。
//
// 信号の流れ（すべてリミッターの前で音量を揃える）:
//   衝突ボイス ×24 → Panner → hitBus → highpass → brightness(lowpass) → PingPongDelay → reverb → master
//   確定音 ×2 ──────────────────────────────────────────────────────────→ reverb
//   パッド A/B（根音＋5度）→ padFilter → padGain ──────────────────────→ reverb
//   ティック ───────────────────────────────────────────────────────────────────→ master
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

type Voice = {
  synth: Tone.FMSynth;
  panner: Tone.Panner;
  /** 最後に発音を始めた時刻。一番古い声部を選ぶのに使う */
  startedAt: number;
  /** リリースまで鳴り終わる時刻 */
  endsAt: number;
};

type PadLayer = { root: Tone.FatOscillator; fifth: Tone.FatOscillator; gain: Tone.Gain };

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export class Audio {
  private readonly voices: Voice[] = [];
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

  play(e: HitEvent, time: number): void {
    this.updateEnergy(e.energy, time);

    const v = this.pickVoice(time);
    const pan = clamp(this.stereoWidth * ((2 * e.x) / WORLD_W - 1), -1, 1);
    const t = clamp(e.note / SLOT_MAX, 0, 1);
    this.strike(v, e.midi, t, e.velocity, pan, time, e.segKind === 'bumper', 0);

    // 盛り上がっているときはオクターブ上を重ねる。空いている声部があるときだけ（本体の音を奪わない）
    if (this.energy > DOUBLE_FROM && e.midi + 12 <= 96) {
      const free = this.freeVoice(time);
      if (free) {
        const k = (this.energy - DOUBLE_FROM) / (1 - DOUBLE_FROM);
        this.strike(free, e.midi + 12, Math.min(1, t + 0.2), e.velocity, pan, time, false, -12 + 6 * k, 0.7);
      }
    }
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

  /** 鳴り終わった声部があればその中で一番古いもの、なければ一番古く発音を始めた声部を止めて使う */
  private pickVoice(time: number): Voice {
    let oldest = this.voices[0]!;
    for (const v of this.voices) if (v.startedAt < oldest.startedAt) oldest = v;
    return this.freeVoice(time) ?? oldest;
  }

  private freeVoice(time: number): Voice | undefined {
    let free: Voice | undefined;
    for (const v of this.voices) {
      if (v.endsAt <= time && (!free || v.startedAt < free.startedAt)) free = v;
    }
    return free;
  }

  // ---- 入力へのフィードバック（D11: MIDI には送らない） ----

  /** 図形を置いた確定音（控えめなポロン） */
  confirm(midi: number, time: number): void {
    if (!this.started) return;
    const at = Math.max(time, this.raw.currentTime);
    // 配置の読み込みなどで同じステップに何個も来たときは1回だけ鳴らす（同時刻の再発音は Tone が例外を投げる）
    if (at < this.lastConfirmAt + 0.03) return;
    this.lastConfirmAt = at;
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
