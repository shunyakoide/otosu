import * as Tone from 'tone';
import { midiToFreq, ROOT_MIDI, type SongId } from '../sim/music';

// 後ろの和音（パッド。D11: 音だけで MIDI には送らない。D48: 曲で明るさが変わる）。
// 根音＋5度の2層を、区間が変わるたびにゆっくりクロスフェードで入れ替える。

/** パッドの根音の基準（C3）。区間の根音（sim/music.ts の曲で決まる）をこの上に置く */
const PAD_ROOT_MIDI = ROOT_MIDI;
const PAD_XFADE_SEC = 3;
/** 入ってくる層がまだ鳴り残っているときに、高さを変える前に小さくする時間（プツッと鳴らないように） */
const PAD_DUCK_SEC = 0.08;
/** 切ったときに小さくしきるまで・入れたときに戻るまで（秒） */
const PAD_OFF_SEC = 1.5;
const PAD_ON_SEC = 2;
/** setLevel(1) のときのパッドの音量（線形） */
const PAD_MAX_GAIN = 0.1;
/** 曲ごとの後ろの和音の明るさ（ローパスの周波数、Hz。D48） */
const PAD_CUTOFF: Record<SongId, number> = { bright: 900, dusk: 560, wistful: 1300, still: 700 };

type PadLayer = { root: Tone.FatOscillator; fifth: Tone.FatOscillator; gain: Tone.Gain };

/**
 * 設定（曲・オン／オフ・音量）は build の前から受け付けて覚えておく。
 * set* の live は、音の仕組みができていてすぐ反映してよいか（Audio の started）
 */
export class Pad {
  private readonly layers: PadLayer[] = [];
  private gain!: Tone.Gain;
  private filter!: Tone.Filter;
  private active = -1;
  private root = -1;
  private song: SongId = 'bright';
  private on = true;
  private level = 0.5;

  /** 2層を作って鳴らし始める（音量 0 から） */
  build(dest: Tone.InputNode): void {
    this.filter = new Tone.Filter({ type: 'lowpass', frequency: PAD_CUTOFF[this.song], rolloff: -24 });
    this.gain = new Tone.Gain(this.target());
    this.filter.chain(this.gain, dest);
    for (let i = 0; i < 2; i++) {
      const gain = new Tone.Gain(0).connect(this.filter);
      const root = new Tone.FatOscillator({ frequency: 130.8, type: 'sine', count: 2, spread: 14 }).connect(gain);
      const fifth = new Tone.FatOscillator({ frequency: 196, type: 'triangle', count: 2, spread: 10, volume: -6 })
        .connect(gain);
      this.layers.push({ root, fifth, gain });
    }
    if (this.on) this.startOscillators(Tone.now());
  }

  /** 和音（根音＋5度）を at からクロスフェードで切り替える。root = 区間の根音（C 基準の音高クラス） */
  setRoot(root: number, at: number): void {
    if (root === this.root) return;
    this.root = root;
    const rootMidi = PAD_ROOT_MIDI + root;

    const next = this.active === 0 ? 1 : 0;
    const layer = this.layers[next]!;
    // 直前の切り替えで消えていく途中かもしれないので、今の大きさから一度 0 まで下げてから高さを変える
    const swap = at + PAD_DUCK_SEC;
    layer.gain.gain.cancelAndHoldAtTime(at);
    layer.gain.gain.linearRampToValueAtTime(0, swap);
    layer.root.frequency.setValueAtTime(midiToFreq(rootMidi), swap);
    layer.fifth.frequency.setValueAtTime(midiToFreq(rootMidi + 7), swap);
    layer.gain.gain.linearRampToValueAtTime(1, swap + PAD_XFADE_SEC);
    if (this.active >= 0) {
      const old = this.layers[this.active]!.gain.gain;
      old.cancelAndHoldAtTime(at);
      old.linearRampToValueAtTime(0, at + PAD_XFADE_SEC);
    }
    this.active = next;
  }

  /** 曲に合わせて明るさを変える（D48） */
  setSong(song: SongId, live: boolean): void {
    this.song = song;
    if (live) this.filter.frequency.rampTo(PAD_CUTOFF[song], 2);
  }

  /** 切ると小さくしきってから発振器を止める（鳴っていない間も発振器を回し続けないように） */
  setOn(on: boolean, live: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (!live) return;
    const now = Tone.now();
    this.gain.gain.rampTo(this.target(), on ? PAD_ON_SEC : PAD_OFF_SEC, now);
    // 止める予約が残っていても、start はその予約を取り消して鳴らし続ける
    if (on) this.startOscillators(now);
    else for (const l of this.layers) {
      l.root.stop(now + PAD_OFF_SEC);
      l.fifth.stop(now + PAD_OFF_SEC);
    }
  }

  /** 0..1 */
  setLevel(v: number, live: boolean): void {
    this.level = Math.min(1, Math.max(0, v));
    if (live) this.gain.gain.rampTo(this.target(), 0.3);
  }

  private startOscillators(at: number): void {
    for (const l of this.layers) {
      l.root.start(at);
      l.fifth.start(at);
    }
  }

  private target(): number {
    return this.on ? this.level * PAD_MAX_GAIN : 0;
  }
}
