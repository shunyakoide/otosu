import type { Audio } from '../audio/audio';
import type { Input, Tool } from '../input/input';
import type { Renderer } from '../render/render';
import type { Sim } from '../sim/sim';
import type { Toolbar } from '../ui/toolbar';
import type { MidiControl } from './midiControl';
import { DEFAULTS, PATTERNS, type Params } from './params';
import type { MotionKnobs } from './popovers';
import type { EngineState } from './state';

// つまみ・ボタン・キーから呼ぶ操作。値（params）を変え、sim・音・表示に伝える。

export type ControlsDeps = {
  params: Params;
  state: EngineState;
  sim: Sim;
  audio: Audio;
  midi: MidiControl;
  renderer: Renderer;
  input: Input;
  toolbar: Toolbar;
  knobs: MotionKnobs;
  /** 値を外から変えたとき（テンポ・リセット）に、小窓の表示を合わせる */
  refresh: () => void;
};

export class Controls {
  private readonly d: ControlsDeps;

  constructor(deps: ControlsDeps) {
    this.d = deps;
  }

  setTool(t: Tool): void {
    const { params, input, toolbar } = this.d;
    params.tool = t;
    input.setTool(t);
    toolbar.setTool(t);
    toolbar.flashTool(t);
  }

  /**
   * 再生・停止（D30 → D50）。時刻は止めず、球を出すのをやめ、回転と音をゆっくり止める。
   * 落ちている途中の球はそのまま当たって鳴る（音は小さくなっていく）。続けると次の拍から球が出る
   */
  setPaused(p: boolean): void {
    const { state, sim, audio, midi, toolbar } = this.d;
    if (!state.started || p === state.paused) return;
    state.paused = p;
    sim.enqueue({ kind: 'setPlaying', on: !p });
    audio.setPlaying(!p);
    if (p) midi.midi.allNotesOff();
    toolbar.setPaused(p);
  }

  togglePaused(): void {
    this.setPaused(!this.d.state.paused);
  }

  toggleMute(): void {
    const { params, audio, midi, toolbar } = this.d;
    params.muted = !params.muted;
    audio.setMuted(params.muted);
    if (params.muted) midi.midi.allNotesOff();
    toolbar.setMuted(params.muted);
  }

  setVolume(db: number): void {
    this.d.params.volume = db;
    if (this.d.state.started) this.d.audio.setVolume(db);
  }

  /** ツールバーのテンポ */
  setBpm(bpm: number): void {
    this.d.params.bpm = bpm;
    this.setTempo();
    this.d.refresh();
  }

  /** テンポと発射の周期を sim と音に伝える */
  setTempo(): void {
    const { params, state, sim, audio, midi } = this.d;
    // 録音中にテンポや周期を変えると小節線が崩れるので、そこまでを保存して止める（D10）
    midi.stopRecording();
    sim.enqueue({ kind: 'setTempo', bpm: params.bpm, pattern: PATTERNS[params.pattern]! });
    if (state.started) audio.setBpm(params.bpm);
  }

  setSong(): void {
    const { params, state, sim, audio } = this.d;
    sim.enqueue({ kind: 'setSong', song: params.song });
    if (state.started) audio.setSong(params.song);
  }

  setRotation(): void {
    const { params, sim } = this.d;
    sim.enqueue({ kind: 'setRotation', on: params.rotate, speed: params.rotationSpeed });
  }

  setDrift(): void {
    const { params, sim, knobs } = this.d;
    knobs.rememberStyle();
    sim.enqueue({ kind: 'setDrift', mode: params.drift, amp: params.driftAmp });
  }

  clear(): void {
    this.d.sim.enqueue({ kind: 'clearSegments' });
  }

  /** 端末ごとの設定（音量・光など）を音と描画に反映する */
  applyPrefs(): void {
    const { params, state, audio, midi, renderer } = this.d;
    renderer.setPixelRatio(params.pixelRatio);
    midi.midi.allNotesOff();
    if (!state.started) return;
    audio.setVolume(params.volume);
    audio.setStereoWidth(params.stereoWidth);
    audio.setPad(params.pad);
    audio.setPadLevel(params.padLevel);
  }

  /** つまみを既定値に戻す（図形は残す） */
  resetSettings(): void {
    if (!confirm('設定を初期値に戻しますか？（図形は残ります）')) return;
    const { params, toolbar } = this.d;
    const { tool, muted, midiOutput } = params;
    Object.assign(params, DEFAULTS, { tool, muted, midiOutput });
    this.setTempo();
    this.setRotation();
    this.setDrift();
    this.setSong();
    this.applyPrefs();
    toolbar.setTempo(params.bpm);
    toolbar.setVolume(params.volume);
    this.d.refresh();
  }
}
