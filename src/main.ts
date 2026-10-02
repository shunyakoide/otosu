import { Controls } from './app/controls';
import { startLoop } from './app/loop';
import { MidiControl } from './app/midiControl';
import { DEFAULTS, PATTERNS, storedPrefs, type Params } from './app/params';
import { DEMO } from './app/demo';
import { applySceneParams, hasSavedScene, loadStoredScene, SceneStore } from './app/persistence';
import { createMotionKnobs, Popovers } from './app/popovers';
import { bindShortcuts } from './app/shortcuts';
import { setupStart, suspendWhenHidden } from './app/start';
import { createState } from './app/state';
import { VideoRecorder } from './app/videoRecorder';
import { toggleFullscreen } from './util';
import { Audio } from './audio/audio';
import { AudioClock } from './audio/clock';
import { Input, TOOLS } from './input/input';
import { Renderer, TOP_BAND_PX } from './render/render';
import { midiAt } from './sim/music';
import { Sim } from './sim/sim';
import { registerServiceWorker } from './pwa/register';
import { PointerHint } from './ui/hint';
import { Intro } from './ui/intro';
import { ShapeMenu } from './ui/shapeMenu';
import { Toolbar } from './ui/toolbar';

// 組み立てと配線だけを置く。中身は src/app/ に分けた（D55）:
// params（つまみの値）・controls（操作）・popovers（小窓）・persistence（配置の保存）・midiControl・shortcuts・start・loop

Audio.setupContext();
const state = createState();
const params: Params = { ...DEFAULTS };
const knobs = createMotionKnobs(params);
const audio = new Audio();
// 初めての端末でだけ、最初の 1 本を描くまで案内する（D71）。リンクで開いた配置は保存されるので、読む前に調べる
const intro = new Intro(document.body, hasSavedScene());
const stored = loadStoredScene();
if (stored) applySceneParams(params, knobs, stored);
Object.assign(params, storedPrefs());
const sim = new Sim({
  bpm: params.bpm,
  pattern: PATTERNS[params.pattern]!,
  drift: { mode: params.drift, amp: params.driftAmp },
  song: params.song,
  skipFirstDrop: true,
});
if (stored) sim.enqueue({ kind: 'loadScene', scene: stored });
else for (const c of DEMO) sim.enqueue(c);

const renderer = new Renderer(document.getElementById('app')!, params);
// scope（D62）: 出力の波形。音を始める前は 0 を返し、そのあいだは音高から描く
renderer.waveSource = (out) => audio.waveform(out);
const input = new Input(
  renderer.canvas,
  sim,
  (x, y) => renderer.toWorld(x, y),
  (x, y) => renderer.pickShape(x, y),
  () => renderer.viewBounds,
);
// ドラッグ中に音程が変わったら小さく鳴らす（D11）。音高は今の区間のもの
input.onPreviewNote = (slot) => {
  if (state.started && !params.muted && params.internalSound) audio.tick(midiAt(slot, sim.sectionAt(sim.step), sim.song));
};
// ボールは表示されている範囲から出るまで生かす（D23）
const syncView = () => sim.enqueue({ kind: 'setView', bounds: { ...renderer.viewBounds } });
syncView();
// 図形のメニュー（D32）: 長押し・右クリックでエフェクトを付け外し、図形を消す
const shapeMenu = new ShapeMenu(document.body);
input.onShapeMenu = (group, x, y) => {
  const sh = sim.shapes.get(group);
  if (sh) shapeMenu.open(group, sh.effect, x, y);
};
shapeMenu.onTarget = (group) => (renderer.selected = group);
shapeMenu.onChoose = (group, choice, current) => {
  if (!sim.shapes.has(group)) return;
  if (choice === 'delete') sim.enqueue({ kind: 'removeShape', group });
  else sim.enqueue({ kind: 'setEffect', group, effect: choice === current ? 'none' : choice });
};
// 操作しているときだけ、画面の下にその場で使える操作を出す（D53）
const pointerHint = new PointerHint(document.body);
input.onHint = (kind, ms) => (kind ? pointerHint.show(kind, ms) : pointerHint.hide());
input.onDraw = () => intro.drew();

// 動画の録画（D70）: iOS の画面収録では内蔵音が雑音になるので、ページの中で書き出す
const recorder = VideoRecorder.supported() ? new VideoRecorder(renderer.canvas, () => audio.recordStream()) : null;
const onRecord = () => {
  if (!recorder) return;
  if (recorder.state === 'recording') recorder.stop();
  else if (recorder.state === 'ready') {
    recorder.save().catch((err: unknown) => {
      console.warn('[otosu] save video', err);
      toolbar.flash('could not save the video');
    });
  } else {
    const reason = recorder.start();
    if (reason) toolbar.flash(reason);
  }
};

// ---- ツールバー・小窓・保存（D24） ----
// ボタンの処理は押されたときに呼ぶので、下で作る ctl・pops を参照してよい
const toolbar = new Toolbar(document.body, TOOLS, {
  play: () => ctl.togglePaused(),
  tool: (t) => ctl.setTool(t),
  mute: () => ctl.toggleMute(),
  volume: (db) => ctl.setVolume(db),
  tempo: (bpm) => ctl.setBpm(bpm),
  clear: () => ctl.clear(),
  motion: (anchor) => pops.toggle('motion', anchor),
  light: (anchor) => pops.toggle('light', anchor),
  sound: (anchor) => pops.toggle('sound', anchor),
  scenes: (anchor) => pops.toggle('scenes', anchor),
  settings: (anchor) => pops.toggle('settings', anchor),
  fullscreen: toggleFullscreen,
  record: recorder ? onRecord : null,
});
toolbar.el.classList.add('ui');
if (recorder) {
  recorder.onChange = (s) => {
    toolbar.setRecord(s);
    if (s === 'ready') toolbar.flash('tap again to save the video');
  };
}
toolbar.setTool(params.tool);
toolbar.setTempo(params.bpm);
toolbar.setVolume(params.volume);
intro.onDone = () => toolbar.showHelp();

const midi = new MidiControl(params, state, sim);
const refresh = () => pops.refresh();
const ctl = new Controls({ params, state, sim, audio, midi, renderer, input, toolbar, knobs, refresh });
const store = new SceneStore({ params, state, sim, audio, toolbar, knobs, midi, refresh });
const pops = new Popovers({ params, state, audio, renderer, knobs, ctl, midi, toolbar, scenes: store.scenes });
renderer.setPixelRatio(params.pixelRatio);
renderer.setQuality(params.quality);

// ---- キー操作・カーソル ----
bindShortcuts({
  tool: (t) => ctl.setTool(t),
  pause: () => ctl.togglePaused(),
  mute: () => ctl.toggleMute(),
  clear: () => ctl.clear(),
  copyLink: () => void store.copySceneUrl(),
  record: () => midi.toggleRecording(),
  fullscreen: toggleFullscreen,
  settings: () => pops.toggle('settings'),
  closePopovers: () => pops.closeAll(),
});
let cursorTimer = 0;
addEventListener('pointermove', (e) => {
  document.body.classList.remove('idle');
  clearTimeout(cursorTimer);
  // タッチではカーソルがなく、消えたツールバーを出し直す手段もないので隠さない
  if (e.pointerType === 'touch') return;
  cursorTimer = window.setTimeout(() => document.body.classList.add('idle'), 2000);
});

// 狭い画面ではツールバーが折り返すので、その高さの分だけワールドを下げる（D24）
const layout = () => {
  toolbar.fitRows();
  const band = Math.max(TOP_BAND_PX, Math.ceil(toolbar.el.getBoundingClientRect().bottom) + 6);
  document.documentElement.style.setProperty('--band', `${band}px`);
  renderer.setTopBand(band);
  syncView();
};
layout();
addEventListener('resize', layout);

// ---- 開始・描画ループ・自動保存 ----
// 音の時計（D29）
const clock = new AudioClock();
setupStart(document.getElementById('overlay')!, {
  params, state, audio, clock,
  applyPrefs: () => ctl.applyPrefs(),
  onStarted: () => intro.start(),
});
startLoop({ params, state, sim, audio, midi: midi.midi, renderer, input, clock });
store.startAutosave();
suspendWhenHidden({ state, audio, midi: midi.midi });
// オフラインでも開けるように（D74）
registerServiceWorker();

if (import.meta.env.DEV) Object.assign(window, { otosu: { sim, audio, params, midi: midi.midi, renderer, input, recorder } });
