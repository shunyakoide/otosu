import type { Audio } from '../audio/audio';
import { BACKDROPS } from '../render/backdrop';
import { FLOWER_KINDS, FLOWER_LABELS } from '../render/flowers';
import { QUALITY_MODES } from '../render/quality';
import type { Renderer } from '../render/render';
import { SONG_IDS } from '../sim/music';
import type { DriftMode } from '../sim/types';
import { Panel, Popover } from '../ui/panel';
import type { ScenesPopover } from '../ui/scenes';
import type { PopName, Toolbar } from '../ui/toolbar';
import type { Controls } from './controls';
import type { MidiControl } from './midiControl';
import { DRIFT_MODES, PATTERNS, PIXEL_RATIOS, TRAILS, type Params } from './params';
import { SHORTCUTS } from './shortcuts';
import type { EngineState } from './state';

// ツールバーの小窓（motion・light・sound・settings）の中身と、開け閉め（D24 → D51, D52）。

/**
 * 動きの小窓のつまみ（D47）。直感的に触れるものだけで、0 にするとオフ。
 * params の rotate / drift を読み書きする見かけの値
 */
export function createMotionKnobs(params: Params) {
  /** 最後に選んだ揺れ方と、move をオフにする前に回っていたか。オンに戻すとこれに戻す */
  let lastStyle: DriftMode = 'drift';
  let lastRotate = false;
  return {
    /** 回るか揺れるか。オフにすると両方止め、オンで止める前に戻す */
    get move() { return params.rotate || params.drift !== 'off'; },
    set move(on: boolean) {
      if (!on) lastRotate = params.rotate;
      params.rotate = on && lastRotate;
      params.drift = on ? lastStyle : 'off';
    },
    get spin() { return params.rotate ? params.rotationSpeed : 0; },
    set spin(v: number) {
      params.rotate = v > 0;
      if (v > 0) params.rotationSpeed = Math.max(0.05, v);
    },
    get sway() { return params.drift === 'off' ? 0 : params.driftAmp; },
    set sway(v: number) {
      if (v <= 0) params.drift = 'off';
      else {
        if (params.drift === 'off') params.drift = lastStyle;
        params.driftAmp = v;
      }
    },
    /** 揺れ方。止まっているときは選ばれていない（選ぶと揺れ始める） */
    get style() { return params.drift; },
    set style(m: DriftMode) { params.drift = m; },
    /** 今の揺れ方を覚える（揺れているときだけ） */
    rememberStyle(): void {
      if (params.drift !== 'off') lastStyle = params.drift;
    },
    /** 読み込んだ配置の動きを覚える。読み込んだ後の move のオン・オフで、これに戻る（D55） */
    rememberScene(): void {
      this.rememberStyle();
      if (params.rotate) lastRotate = true;
    },
  };
}
export type MotionKnobs = ReturnType<typeof createMotionKnobs>;

export type PopoversDeps = {
  params: Params;
  state: EngineState;
  audio: Audio;
  renderer: Renderer;
  knobs: MotionKnobs;
  ctl: Controls;
  midi: MidiControl;
  toolbar: Toolbar;
  scenes: ScenesPopover;
};

const choices = <V,>(values: readonly V[], label?: (v: V) => string) => () =>
  values.map((value) => ({ value, label: label?.(value) }));
const offOr = (f: (v: number) => string) => (v: number) => (v <= 0 ? 'off' : f(v));
const SWAY_LABELS: Partial<Record<DriftMode, string>> = { drift: 'glide', phrase: 'step' };
const TRAIL_LABELS = { geometry: 'tail', afterimage: 'blur' } as const;

function motionPopover({ knobs, ctl, params }: PopoversDeps): Popover {
  const pop = new Popover(document.body);
  const m = pop.section();
  m.toggle(knobs, 'move', 'move', () => { ctl.setRotation(); ctl.setDrift(); });
  m.slider(knobs, 'spin', { label: 'spin', min: 0, max: 1, step: 0.01, format: offOr((v) => v.toFixed(2)), onChange: () => ctl.setRotation() });
  m.slider(knobs, 'sway', { label: 'sway', min: 0, max: 80, step: 1, format: offOr(String), onChange: () => ctl.setDrift() });
  m.choice(knobs, 'style', 'sway style', choices(DRIFT_MODES.filter((d) => d !== 'off'), (d) => SWAY_LABELS[d]!), () => ctl.setDrift());
  m.hint(() => ({ off: '', drift: 'emitters slide slowly back and forth', phrase: 'emitters jump to a new spot every 16 shots' })[params.drift]);
  return pop;
}

function lightPopover({ params }: PopoversDeps): Popover {
  const pop = new Popover(document.body);
  // 図形の光 / 当たったときに出るもの / 背景 の順に分ける（D45）
  const l = pop.section('shapes');
  l.slider(params, 'bloomStrength', { label: 'glow', min: 0, max: 2, step: 0.01 });
  l.hint('the halo around the light');
  l.slider(params, 'idleLine', { label: 'at rest', min: 0.15, max: 0.45, step: 0.01 });
  l.hint('how bright shapes are between hits');
  l.choice(params, 'trail', 'trail style', choices(TRAILS, (t) => TRAIL_LABELS[t]));
  l.hint(() => params.trail === 'geometry' ? 'balls draw a tail' : 'no tail, the screen keeps a short blur');
  // blur のときは残像の長さが決まっている（render の LEGACY_DAMP）ので出さない（D64）
  l.slider(params, 'afterimage', { label: 'tail', min: 0.7, max: 0.97, step: 0.005, format: (v) => v.toFixed(2) });
  l.showIf(() => params.trail === 'geometry');
  l.hint('how long the tail is');
  // 当たったときに出るもの: スイッチの行を積むと長くなったので、並べたボタン1行にまとめる（D63）
  const h = pop.section('on hit');
  h.chips(params, 'show', [
    { key: 'drip', label: 'drip', hint: 'light runs down from the shape that was hit' },
    { key: 'flowers', label: 'flowers', hint: 'a vine grows from the hit and blooms' },
    { key: 'hud', label: 'readout', hint: 'a small frame and coordinates flash where the ball hit' },
    { key: 'crosshair', label: 'crosshair', hint: 'lines reach out to the edges from the hit' },
    { key: 'noteNames', label: 'notes', hint: 'the name of the note floats up from the hit' },
    { key: 'scope', label: 'scope', hint: 'the sound\'s waveform stretches out from the hit' },
    { key: 'constellation', label: 'stars', hint: 'hits stay as stars, joined in a row; they clear every 8 bars' },
  ], 'turn on what shows up where a ball hits');
  h.slider(params, 'dripSpeed', { label: 'drip speed', min: 10, max: 300, step: 5, format: (v) => `${v}` });
  h.showIf(() => params.drip);
  h.choice(params, 'flowerKind', 'flowers', choices(FLOWER_KINDS, (k) => FLOWER_LABELS[k] ?? k));
  h.showIf(() => params.flowers);
  const b = pop.section('backdrop');
  b.choice(params, 'backdrop', 'kind', () => BACKDROPS.map((value) => ({ value })));
  b.slider(params, 'backdropLevel', { label: 'level', min: 0.2, max: 2, step: 0.05, format: (v) => v.toFixed(2) });
  b.showIf(() => params.backdrop !== 'none');
  return pop;
}

// 音: 曲そのものを変えるもの（D51。弾きながら触るので settings から小窓に出した）
function soundPopover({ params, state, audio, ctl }: PopoversDeps): Popover {
  const pop = new Popover(document.body);
  const m = pop.section();
  m.choice(params, 'pattern', 'rhythm', () => Object.keys(PATTERNS).map((value) => ({ value })), () => ctl.setTempo());
  m.hint(() => {
    const beats = PATTERNS[params.pattern]!;
    return `${beats.length} emitters drop a ball every ${beats.join(' / ')} beats`;
  });
  // 曲: 和音の進み方・調・後ろの和音の音色をまとめて選ぶ（D48）
  m.choice(params, 'song', 'song', choices(SONG_IDS), () => ctl.setSong());
  m.hint('changes the chords of every sound, shapes included');
  m.toggle(params, 'pad', 'hum', (on) => state.started && audio.setPad(on));
  m.hint('a soft tone that keeps playing the song\'s chord in the background');
  m.slider(params, 'padLevel', {
    label: 'hum vol', min: 0, max: 1, step: 0.01, onInput: (v) => state.started && audio.setPadLevel(v),
  });
  m.showIf(() => params.pad);
  return pop;
}

// 細かい調整（D24 → D52）。ツールバーの小窓にないものだけを置き、ほかの小窓と同じくボタンの下に開く
function settingsPanel({ params, state, audio, renderer, ctl, midi }: PopoversDeps, refresh: () => void): Panel {
  const panel = new Panel(document.body);
  // 会場・端末に合わせて一度決めるもの（D51）。曲は sound、軌跡の見た目は light の小窓
  const setup = panel.section('Setup');
  setup.slider(params, 'stereoWidth', { label: 'stereo', min: 0, max: 1, step: 0.05, onInput: (v) => state.started && audio.setStereoWidth(v) });
  setup.slider(params, 'visualOffsetMs', { label: 'light delay', min: -150, max: 40, step: 1, format: (v) => `${v} ms` });
  setup.hint('lower it if the light comes before the sound (e.g. bluetooth)');
  setup.choice(params, 'pixelRatio', 'resolution', choices(PIXEL_RATIOS, (r) => `×${r}`), (r) => renderer.setPixelRatio(r));
  setup.hint('higher is sharper but heavier');
  setup.choice(params, 'quality', 'quality', choices(QUALITY_MODES), (q) => renderer.setQuality(q));
  setup.hint(() => params.quality === 'auto'
    ? 'lowers itself when the frame rate drops, and comes back when it recovers'
    : 'stays as it is, even when the frame rate drops');

  midi.fill(panel.section('MIDI', false), refresh);

  // キー操作の一覧（画面下の案内は少しで消えるので、ここでいつでも見られるように）
  if (!matchMedia('(hover: none)').matches) {
    const keys = panel.section('Keys', false);
    for (const s of SHORTCUTS) if (s.label) keys.info(s.label, s.what ?? '');
  }

  panel.section('', true).actions([{ label: 'reset settings', title: 'shapes are kept', onClick: () => ctl.resetSettings() }]);
  return panel;
}

/** 小窓をまとめて開け閉めする。一度に開くのは1つだけで、開いている小窓のボタンを光らせる */
export class Popovers {
  private readonly all: Record<PopName, Popover>;
  private readonly toolbar: Toolbar;

  constructor(d: PopoversDeps) {
    this.toolbar = d.toolbar;
    const refresh = () => this.refresh();
    this.all = {
      motion: motionPopover(d),
      light: lightPopover(d),
      sound: soundPopover(d),
      settings: settingsPanel(d, refresh),
      scenes: d.scenes,
    };
    for (const pop of Object.values(this.all)) {
      pop.onClose = () => {
        if (!Object.values(this.all).some((p) => p.isOpen)) this.toolbar.setOpenPopover(null);
      };
    }
  }

  toggle(name: PopName, anchor: HTMLElement = this.toolbar.button(name)): void {
    const wasOpen = this.all[name].isOpen;
    this.closeAll();
    if (wasOpen) return;
    this.all[name].open(anchor);
    this.toolbar.setOpenPopover(name);
  }

  closeAll(): void {
    for (const pop of Object.values(this.all)) pop.close();
  }

  /** 値を外から変えたとき（テンポ・読み込み・リセット）に、小窓の表示を合わせる */
  refresh(): void {
    for (const pop of Object.values(this.all)) pop.refresh();
  }
}
