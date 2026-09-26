import * as Tone from 'tone';
import { midiToFreq, NOTE_COUNT, noteFromIndex } from '../sim/music';
import type { HitEvent } from '../sim/types';

// 音色: ガラス／マレット系の減衰音＋深めのリバーブ（docs/design/audio.md）。
// 発音時刻は呼び出し側が rawContext.currentTime 基準で渡す（decisions.md D3, D8-2）。

export class Audio {
  private synth!: Tone.PolySynth<Tone.FMSynth>;
  private delay!: Tone.FeedbackDelay;
  private readonly freqs: number[] = [];

  /** 他のノードより先に Context を作る必要があるので、生成とは分けて呼ぶ */
  static setupContext(): void {
    Tone.setContext(new Tone.Context({ latencyHint: 'interactive', lookAhead: 0 }));
  }

  get raw(): AudioContext {
    return Tone.getContext().rawContext as AudioContext;
  }

  async start(bpm: number): Promise<void> {
    await Tone.start();

    this.synth = new Tone.PolySynth(Tone.FMSynth);
    this.synth.maxPolyphony = 24;
    this.synth.volume.value = -14;
    this.synth.set({
      harmonicity: 3,
      modulationIndex: 3.5,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.004, decay: 1.4, sustain: 0, release: 0.4 },
      modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.2 },
    });

    const highpass = new Tone.Filter({ type: 'highpass', frequency: 120, rolloff: -12 });
    this.delay = new Tone.FeedbackDelay({ delayTime: (60 / bpm) * 0.75, feedback: 0.28, wet: 0.18 });
    const reverb = new Tone.Reverb({ decay: 6, preDelay: 0.03, wet: 0.35 });
    const comp = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.01, release: 0.25 });
    const limiter = new Tone.Limiter(-1);
    this.synth.chain(highpass, this.delay, reverb, comp, limiter, Tone.getDestination());
    Tone.getDestination().volume.value = -3;
    await reverb.ready;

    for (let i = 0; i < NOTE_COUNT; i++) this.freqs.push(midiToFreq(noteFromIndex(i).midi));
  }

  setBpm(bpm: number): void {
    this.delay.delayTime.rampTo((60 / bpm) * 0.75, 0.1);
  }

  setVolume(db: number): void {
    Tone.getDestination().volume.rampTo(db, 0.05);
  }

  play(e: HitEvent, time: number): void {
    this.synth.triggerAttackRelease(this.freqs[e.note]!, 1.2, time, e.velocity);
  }
}
