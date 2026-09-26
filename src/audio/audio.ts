import * as Tone from 'tone';
import { WORLD_W } from '../sim/constants';
import type { HitEvent } from '../sim/types';

// 音色: ガラス／マレット系の減衰音＋深めのリバーブ（docs/design/audio.md）。
// ステップ2: 自前ボイスプールで音域ごとの音色とステレオ定位（docs/design/step2-audio.md 案2・案3）。
// 発音時刻は呼び出し側が rawContext.currentTime 基準で渡す（decisions.md D3, D8-2）。

const VOICES = 24;
/** 1声部あたりの基準音量（旧 PolySynth 全体の -14dB と同じ。24声の和はコンプ＋リミッターで収める） */
const VOICE_BASE_DB = -15;
/** 音程スロットの最大値（0..15） */
const SLOT_MAX = 15;
const RELEASE = 0.4;

type Voice = {
  synth: Tone.FMSynth;
  panner: Tone.Panner;
  /** 最後に発音を始めた時刻。一番古い声部を選ぶのに使う */
  startedAt: number;
  /** リリースまで鳴り終わる時刻 */
  endsAt: number;
};

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export class Audio {
  private readonly voices: Voice[] = [];
  private delay!: Tone.PingPongDelay;
  private stereoWidth = 0.7;

  /** 他のノードより先に Context を作る必要があるので、生成とは分けて呼ぶ */
  static setupContext(): void {
    Tone.setContext(new Tone.Context({ latencyHint: 'interactive', lookAhead: 0 }));
  }

  get raw(): AudioContext {
    return Tone.getContext().rawContext as AudioContext;
  }

  async start(bpm: number): Promise<void> {
    await Tone.start();

    const bus = new Tone.Gain(1);
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
      synth.chain(panner, bus);
      this.voices.push({ synth, panner, startedAt: -Infinity, endsAt: -Infinity });
    }

    const highpass = new Tone.Filter({ type: 'highpass', frequency: 120, rolloff: -12 });
    this.delay = new Tone.PingPongDelay({ delayTime: (60 / bpm) * 0.75, feedback: 0.28, wet: 0.18, maxDelay: 1.5 });
    const reverb = new Tone.Reverb({ decay: 6, preDelay: 0.03, wet: 0.35 });
    const comp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.01, release: 0.25 });
    const limiter = new Tone.Limiter(-1);
    bus.chain(highpass, this.delay, reverb, comp, limiter, Tone.getDestination());
    Tone.getDestination().volume.value = -3;
    await reverb.ready;
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

  play(e: HitEvent, time: number): void {
    const v = this.pickVoice(time);

    // 音域 t: 0 = 最低音（丸く長い）… 1 = 最高音（きらめいて短い）
    const t = clamp(e.note / SLOT_MAX, 0, 1);
    const harmonicity = t < 0.34 ? 2 : t < 0.67 ? 3 : 4;
    const modIndex = (1.2 + 2.8 * t) * (0.6 + 0.4 * e.velocity);
    const decay = 2.4 - 1.5 * t;
    const gainDb = VOICE_BASE_DB + 2 - 4 * t;
    const pan = clamp(this.stereoWidth * ((2 * e.x) / WORLD_W - 1), -1, 1);

    const s = v.synth;
    s.harmonicity.setValueAtTime(harmonicity, time);
    s.modulationIndex.setValueAtTime(modIndex, time);
    s.volume.setValueAtTime(gainDb, time);
    v.panner.pan.setValueAtTime(pan, time);
    // エンベロープの decay は triggerAttack の時点で読まれる（声部は同時に1音だけなので、ここで書き換えてよい）
    s.envelope.decay = decay;
    const dur = decay * 0.85;
    s.triggerAttackRelease(midiToFreq(e.midi), dur, time, e.velocity);
    v.startedAt = time;
    v.endsAt = time + dur + RELEASE;
  }

  /** 鳴り終わった声部があればその中で一番古いもの、なければ一番古く発音を始めた声部を止めて使う */
  private pickVoice(time: number): Voice {
    let free: Voice | undefined;
    let oldest = this.voices[0]!;
    for (const v of this.voices) {
      if (v.endsAt <= time && (!free || v.startedAt < free.startedAt)) free = v;
      if (v.startedAt < oldest.startedAt) oldest = v;
    }
    return free ?? oldest;
  }
}
