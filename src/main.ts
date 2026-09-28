import { Audio } from './audio/audio';
import { AudioClock } from './audio/clock';
import { Input, TOOLS, type Tool } from './input/input';
import { Midi } from './midi/midi';
import { BACKDROPS, type BackdropKind } from './render/backdrop';
import type { ColorMode } from './render/palette';
import { Renderer, TOP_BAND_PX } from './render/render';
import { HISTORY, HZ } from './sim/constants';
import { DEFAULT_SONG, midiAt, SONG_IDS, type SongId } from './sim/music';
import { Sim } from './sim/sim';
import type { Command, DriftMode, SceneData, SimEvent } from './sim/types';
import { decodeScene, encodeScene, SCENE_HASH_KEY, SCENE_STORAGE_KEY, sceneFromSim } from './scene/scene';
import {
  loadLibrary, loadPrefs, pickPrefs, saveLibrary, savePrefs, sceneFromFile, sceneToFile,
} from './ui/storage';
import { Panel, Popover } from './ui/panel';
import { ScenesPopover } from './ui/scenes';
import { ShapeMenu } from './ui/shapeMenu';
import { Toolbar } from './ui/toolbar';

// 時計は AudioContext の1本（decisions.md D3, D8）。
// sim は LOOKAHEAD ぶん先行し、音は t0 + step/HZ に予約、描画は「今聴こえている時刻」の世界を表示する。

const LOOKAHEAD = 0.05;
const MAX_STEPS_PER_FRAME = 8;
const MAX_LAG = 0.1;
const LATE_DROP = 0.02;

const PATTERNS: Record<string, number[]> = {
  '2 : 3': [2, 3],
  '3 : 4': [3, 4],
  '1 : 1.5': [1, 1.5],
  '2 : 3 : 5': [2, 3, 5],
};

const DRIFT_MODES: readonly DriftMode[] = ['off', 'drift', 'phrase'];
const TRAILS = ['geometry', 'afterimage'] as const;
const PIXEL_RATIOS = [1, 1.5, 2] as const;

const DEFAULTS = {
  bpm: 90,
  pattern: '2 : 3',
  volume: -3,
  muted: false,
  tool: 'line' as Tool,
  /** 曲（D48）。配置側で持つ */
  song: DEFAULT_SONG as SongId,
  /** 後ろで鳴り続ける和音（旧 pad）。キーは保存済みの設定のためそのまま */
  pad: true,
  padLevel: 0.5,
  rotate: false,
  rotationSpeed: 0.3,
  drift: 'drift' as DriftMode,
  driftAmp: 24,
  stereoWidth: 0.7,
  trail: 'geometry' as (typeof TRAILS)[number],
  /** 色は白黒（mono）だけ（D37）。音の高さで色を付ける 'pitch' はメニューから外した */
  colorMode: 'mono' as ColorMode,
  bloomStrength: 0.9,
  afterimage: 0.8,
  drip: true,
  dripSpeed: 90,
  flowers: true,
  backdrop: 'none' as BackdropKind,
  backdropLevel: 1,
  hud: false,
  idleLine: 0.3,
  visualOffsetMs: 0,
  pixelRatio: 1 as number,
  internalSound: true,
  midiOutput: '',
  midiChannel: 1,
  midiDrumChannel: 10,
  midiNoteLength: 0.4,
  midiOffsetMs: 0,
};
const params = { ...DEFAULTS };

/** 配置（SceneData）側で持つ値と、保存しない値。残りをこの端末の設定として自動保存する（D24） */
const NOT_PREFS = new Set<string>(['bpm', 'pattern', 'song', 'rotate', 'rotationSpeed', 'drift', 'driftAmp', 'tool', 'muted', 'midiOutput', 'colorMode']);
function currentPrefs(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!NOT_PREFS.has(k)) out[k] = v;
  return out;
}

const DEMO: Command[] = [
  { kind: 'addSegment', ax: 700, ay: 300, bx: 900, by: 360 },
  { kind: 'addSegment', ax: 1050, ay: 420, bx: 1250, by: 380 },
  { kind: 'addSegment', ax: 500, ay: 640, bx: 1000, by: 700 },
  { kind: 'addSegment', ax: 1150, ay: 700, bx: 1450, by: 620 },
  { kind: 'addSegment', ax: 820, ay: 950, bx: 980, by: 900 },
];

// ---- 保存された配置（URL ハッシュ → localStorage の順） ----
function loadStoredScene(): SceneData | null {
  const m = location.hash.match(new RegExp(`[#&]${SCENE_HASH_KEY}=([^&]+)`));
  if (m) {
    const scene = decodeScene(m[1]!);
    if (scene) return scene;
  }
  try {
    const code = localStorage.getItem(SCENE_STORAGE_KEY);
    return code ? decodeScene(code) : null;
  } catch {
    return null;
  }
}

function applySceneParams(scene: SceneData): void {
  const label = scene.pattern.join(' : ');
  if (!PATTERNS[label]) PATTERNS[label] = scene.pattern;
  params.bpm = scene.bpm;
  params.pattern = label;
  params.rotate = scene.rotate;
  params.rotationSpeed = scene.rotationSpeed;
  params.drift = scene.drift.mode;
  params.driftAmp = scene.drift.amp;
  params.song = scene.song ?? DEFAULT_SONG;
}

Audio.setupContext();
const audio = new Audio();
const stored = loadStoredScene();
if (stored) applySceneParams(stored);
const prefs = pickPrefs(DEFAULTS, loadPrefs(), { trail: TRAILS, pixelRatio: PIXEL_RATIOS, backdrop: BACKDROPS });
for (const k of NOT_PREFS) delete prefs[k as keyof typeof prefs];
Object.assign(params, prefs);
const sim = new Sim({
  bpm: params.bpm,
  pattern: PATTERNS[params.pattern]!,
  drift: { mode: params.drift, amp: params.driftAmp },
  song: params.song,
});
if (stored) sim.enqueue({ kind: 'loadScene', scene: stored });
else for (const c of DEMO) sim.enqueue(c);

const app = document.getElementById('app')!;
const renderer = new Renderer(app, params);
const input = new Input(
  renderer.canvas,
  sim,
  (x, y) => renderer.toWorld(x, y),
  (x, y) => renderer.pickShape(x, y),
  () => renderer.viewBounds,
);
// ドラッグ中に音程が変わったら小さく鳴らす（D11）。音高は今の区間のもの
input.onPreviewNote = (slot) => {
  if (started && !params.muted && params.internalSound) audio.tick(midiAt(slot, sim.sectionAt(sim.step), sim.song));
};
// ボールは表示されている範囲から出るまで生かす（D23）
const syncView = () => sim.enqueue({ kind: 'setView', bounds: { ...renderer.viewBounds } });
syncView();
const setTool = (t: Tool) => {
  params.tool = t;
  input.setTool(t);
  toolbar.setTool(t);
  toolbar.flashTool(t);
};
// 図形のメニュー（D32）: 長押し・右クリックでエフェクトを付け外し、図形を消す
const shapeMenu = new ShapeMenu(document.body);
input.onShapeMenu = (group, x, y) => {
  const sh = sim.shapes.get(group);
  if (sh) shapeMenu.open(group, sh.effect, x, y);
};
shapeMenu.onChoose = (group, choice, current) => {
  if (!sim.shapes.has(group)) return;
  if (choice === 'delete') sim.enqueue({ kind: 'removeShape', group });
  else sim.enqueue({ kind: 'setEffect', group, effect: choice === current ? 'none' : choice });
};

// ---- ツールバーと設定パネル（D24） ----
const toolbar = new Toolbar(document.body, TOOLS, {
  play: () => setPaused(!paused),
  tool: (t) => setTool(t),
  mute: () => toggleMute(),
  volume: (db) => {
    params.volume = db;
    if (started) audio.setVolume(db);
  },
  tempo: (bpm) => {
    params.bpm = bpm;
    setTempo();
    refreshUI();
  },
  clear: () => sim.enqueue({ kind: 'clearSegments' }),
  motion: (anchor) => togglePopover('motion', anchor),
  light: (anchor) => togglePopover('light', anchor),
  sound: (anchor) => togglePopover('sound', anchor),
  scenes: (anchor) => togglePopover('scenes', anchor),
  settings: () => toggleSettings(),
  fullscreen: () => toggleFullscreen(),
});
toolbar.el.classList.add('ui');
toolbar.setTool(params.tool);
toolbar.setTempo(params.bpm);
toolbar.setVolume(params.volume);

// 配置の保存・読み込み（ツールバーの保存ボタンから開く）
const lib = { name: '', current: '' };
let library = loadLibrary();
const scenes = new ScenesPopover(document.body, {
  save: (name) => saveToLibrary(name),
  load: (name) => loadFromLibrary(name),
  remove: (name) => removeFromLibrary(name),
  clear: () => sim.enqueue({ kind: 'clearSegments' }),
  exportFile: () => exportSceneFile(),
  importFile: () => fileInput.click(),
  copyLink: () => void copySceneUrl(),
});

const choices = <V,>(values: readonly V[], label?: (v: V) => string) => () =>
  values.map((value) => ({ value, label: label?.(value) }));

// 動きと光: 直感的に触れるつまみだけ。0 にするとオフ
const motionPop = new Popover(document.body);
/** 最後に選んだ揺れ方と、move をオフにする前に回っていたか。オンに戻すとこれに戻す */
let lastStyle: DriftMode = 'drift';
let lastRotate = false;
const motionKnobs = {
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
};
const offOr = (f: (v: number) => string) => (v: number) => (v <= 0 ? 'off' : f(v));
const SWAY_LABELS: Partial<Record<DriftMode, string>> = { drift: 'glide', phrase: 'step' };
{
  const m = motionPop.section();
  m.toggle(motionKnobs, 'move', 'move', () => { setRotation(); setDrift(); });
  m.slider(motionKnobs, 'spin', { label: 'spin', min: 0, max: 1, step: 0.01, format: offOr((v) => v.toFixed(2)), onChange: () => setRotation() });
  m.slider(motionKnobs, 'sway', { label: 'sway', min: 0, max: 80, step: 1, format: offOr(String), onChange: () => setDrift() });
  m.choice(motionKnobs, 'style', 'sway style', choices(DRIFT_MODES.filter((d) => d !== 'off'), (d) => SWAY_LABELS[d]!), () => setDrift());
  m.hint(() => ({ off: '', drift: 'emitters slide slowly back and forth', phrase: 'emitters jump to a new spot every 16 shots' })[params.drift]);
}
const lightPop = new Popover(document.body);
{
  // 図形の光 / 当たったときに出るもの / 背景 の順に分ける（D45）
  const l = lightPop.section('shapes');
  l.slider(params, 'bloomStrength', { label: 'glow', min: 0, max: 2, step: 0.01 });
  l.hint('the halo around the light');
  l.slider(params, 'idleLine', { label: 'at rest', min: 0.15, max: 0.45, step: 0.01 });
  l.hint('how bright shapes are between hits');
  const TRAIL_LABELS = { geometry: 'tail', afterimage: 'blur' } as const;
  l.choice(params, 'trail', 'trail style', choices(TRAILS, (t) => TRAIL_LABELS[t]));
  // blur のときは残像の長さが決まっている（render の LEGACY_DAMP）ので薄くする
  l.slider(params, 'afterimage', { label: 'trail', min: 0.7, max: 0.97, step: 0.005, format: (v) => v.toFixed(2), enabled: () => params.trail === 'geometry' });
  l.hint(() => params.trail === 'geometry' ? 'balls draw a tail; this sets how long' : 'no tail, the screen keeps a short blur');
  const h = lightPop.section('on hit');
  h.toggle(params, 'drip', 'drip');
  h.slider(params, 'dripSpeed', { label: 'speed', min: 10, max: 300, step: 5, format: (v) => `${v}`, enabled: () => params.drip });
  h.hint('light runs down from the shape that was hit');
  h.toggle(params, 'flowers', 'flowers');
  h.hint('a vine grows from the hit and blooms');
  h.toggle(params, 'hud', 'readout');
  h.hint('a small frame and coordinates flash where the ball hit');
  const b = lightPop.section('backdrop');
  b.choice(params, 'backdrop', 'kind', () => BACKDROPS.map((value) => ({ value })));
  b.slider(params, 'backdropLevel', { label: 'level', min: 0.2, max: 2, step: 0.05, format: (v) => v.toFixed(2), enabled: () => params.backdrop !== 'none' });
}

// 音: 曲そのものを変えるもの（D51。弾きながら触るので settings から小窓に出した）
const soundPop = new Popover(document.body);
{
  const m = soundPop.section();
  m.choice(params, 'pattern', 'rhythm', () => Object.keys(PATTERNS).map((value) => ({ value })), () => setTempo());
  m.hint(() => {
    const beats = PATTERNS[params.pattern]!;
    return `${beats.length} emitters drop a ball every ${beats.join(' / ')} beats`;
  });
  // 曲: 和音の進み方・調・後ろの和音の音色をまとめて選ぶ（D48）
  m.choice(params, 'song', 'song', choices(SONG_IDS), () => setSong());
  m.hint('changes the chords of every sound, shapes included');
  m.toggle(params, 'pad', 'hum', (on) => started && audio.setPad(on));
  m.slider(params, 'padLevel', {
    label: 'hum vol', min: 0, max: 1, step: 0.01, enabled: () => params.pad, onInput: (v) => started && audio.setPadLevel(v),
  });
  m.hint('a soft tone that keeps playing the song\'s chord in the background');
}

type PopName = 'motion' | 'light' | 'sound' | 'scenes';
const popovers: Record<PopName, { isOpen: boolean; close(): void; onClose: (() => void) | null }> = {
  motion: motionPop, light: lightPop, sound: soundPop, scenes,
};
/** 値を外から変えたとき（テンポ・読み込み・リセット）に、パネルと小窓の表示を合わせる */
function refreshUI(): void {
  panel.refresh();
  for (const pop of [motionPop, lightPop, soundPop]) pop.refresh();
}
for (const pop of Object.values(popovers)) {
  pop.onClose = () => {
    if (!Object.values(popovers).some((p) => p.isOpen)) toolbar.setOpenPopover(null);
  };
}
function togglePopover(name: PopName, anchor: HTMLElement): void {
  const wasOpen = popovers[name].isOpen;
  closePopovers();
  if (wasOpen) return;
  toggleSettings(false);
  if (name === 'scenes') {
    scenes.update(library, lib.current, lib.name);
    scenes.open(anchor);
  } else ({ motion: motionPop, light: lightPop, sound: soundPop })[name].open(anchor);
  toolbar.setOpenPopover(name);
}
function closePopovers(): void {
  for (const pop of Object.values(popovers)) pop.close();
}

// 細かい調整（普段は出さない。, キーで開く）
// ツールバーの小窓にないものだけを置く（D46）
const panel = new Panel(document.body, 'settings');
panel.el.classList.add('ui');
panel.onClose = () => toggleSettings(false);
function toggleSettings(open = !panel.isOpen): void {
  if (open) closePopovers();
  panel.setOpen(open);
  if (open) toolbar.setOpenPopover('settings');
  else if (!Object.values(popovers).some((p) => p.isOpen)) toolbar.setOpenPopover(null);
}
function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
}
/**
 * 再生・停止（D30 → D50）。時刻は止めず、球を出すのをやめ、回転と音をゆっくり止める。
 * 落ちている途中の球はそのまま当たって鳴る（音は小さくなっていく）。続けると次の拍から球が出る
 */
function setPaused(p: boolean): void {
  if (!started || p === paused) return;
  paused = p;
  sim.enqueue({ kind: 'setPlaying', on: !p });
  audio.setPlaying(!p);
  if (p) midi.allNotesOff();
  toolbar.setPaused(p);
}
function toggleMute(): void {
  params.muted = !params.muted;
  audio.setMuted(params.muted);
  if (params.muted) midi.allNotesOff();
  toolbar.setMuted(params.muted);
}
const setTempo = () => {
  // 録音中にテンポや周期を変えると小節線が崩れるので、そこまでを保存して止める（D10）
  if (midi.isRecording) toggleRecording();
  sim.enqueue({ kind: 'setTempo', bpm: params.bpm, pattern: PATTERNS[params.pattern]! });
  if (started) audio.setBpm(params.bpm);
};
const setSong = () => {
  sim.enqueue({ kind: 'setSong', song: params.song });
  if (started) audio.setSong(params.song);
};
const setRotation = () => sim.enqueue({ kind: 'setRotation', on: params.rotate, speed: params.rotationSpeed });
const setDrift = () => {
  if (params.drift !== 'off') lastStyle = params.drift;
  sim.enqueue({ kind: 'setDrift', mode: params.drift, amp: params.driftAmp });
};

// 会場・端末に合わせて一度決めるもの（D51）。曲は sound、軌跡の見た目は light の小窓
const setup = panel.section('Setup');
setup.slider(params, 'stereoWidth', { label: 'stereo', min: 0, max: 1, step: 0.05, onInput: (v) => started && audio.setStereoWidth(v) });
setup.slider(params, 'visualOffsetMs', { label: 'light delay', min: -150, max: 40, step: 1, format: (v) => `${v} ms` });
setup.hint('lower it if the light comes before the sound (e.g. bluetooth)');
setup.choice(params, 'pixelRatio', 'resolution', choices(PIXEL_RATIOS, (r) => `×${r}`), (r) => renderer.setPixelRatio(r));
setup.hint('higher is sharper but heavier');

const midiPane = panel.section('MIDI', false);
const midi = new Midi({
  get channel() { return params.midiChannel; },
  get drumChannel() { return params.midiDrumChannel; },
  get noteLength() { return params.midiNoteLength; },
  get offsetMs() { return params.midiOffsetMs; },
});
let midiOutputs: { id: string; name: string }[] = [];
midiPane.toggle(params, 'internalSound', 'built-in');
midiPane.select(params, 'midiOutput', 'output', () => [{ value: '', label: '(none)' }, ...midiOutputs.map((o) => ({ value: o.id, label: o.name }))], (id) => midi.select(id || null));
midiPane.slider(params, 'midiChannel', { label: 'channel', min: 1, max: 16, step: 1, onChange: () => midi.allNotesOff() });
midiPane.slider(params, 'midiDrumChannel', { label: 'drums ○ □', min: 1, max: 16, step: 1, onChange: () => midi.allNotesOff() });
midiPane.slider(params, 'midiNoteLength', { label: 'note length', min: 0.05, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)} s` });
midiPane.slider(params, 'midiOffsetMs', { label: 'offset', min: -100, max: 200, step: 1, format: (v) => `${v} ms` });
const [connectBtn, recordBtn] = midiPane.actions([
  { label: 'connect', onClick: () => void connectMidi() },
  { label: '● record .mid', title: 'record to a MIDI file (R)', onClick: () => toggleRecording() },
]) as [HTMLButtonElement, HTMLButtonElement];
async function connectMidi(): Promise<void> {
  try {
    midiOutputs = await midi.connect();
    const iac = midiOutputs.find((o) => /IAC/i.test(o.name));
    if (!params.midiOutput && iac) params.midiOutput = iac.id;
    midi.select(params.midiOutput || null);
    connectBtn.textContent = midiOutputs.length ? `connected (${midiOutputs.length})` : 'no outputs found';
  } catch (err) {
    console.warn('[otosu] MIDI', err);
    connectBtn.textContent = Midi.supported ? 'permission denied' : 'unsupported (use Chrome)';
  }
  refreshUI();
}

// キー操作の一覧（画面下の案内は少しで消えるので、ここでいつでも見られるように）
if (!matchMedia('(hover: none)').matches) {
  const keys = panel.section('Keys', false);
  for (const [k, what] of [
    ['drag', 'draw'], ['shift + drag', 'bumper'], ['right-click', 'shape effects / delete'],
    ['1 – 5', 'tools'], ['space', 'pause'], ['M', 'mute'], ['C', 'clear all shapes'],
    ['S', 'copy scene link'], ['R', 'record .mid'], ['F', 'fullscreen'], ['H', 'hide ui'], [',', 'this panel'],
  ] as const) keys.info(k, what);
}

panel.section('', true).actions([{ label: 'reset settings', title: 'shapes are kept', onClick: () => resetSettings() }]);
renderer.setPixelRatio(params.pixelRatio);

function saveToLibrary(input: string): void {
  const name = input.trim() || `scene ${stamp()}`;
  if (library[name] && name !== lib.current && !confirm(`"${name}" を上書きしますか？`)) return;
  library[name] = { code: currentSceneCode(), savedAt: Date.now() };
  saveLibrary(library);
  lib.name = name;
  lib.current = name;
  scenes.update(library, lib.current, lib.name);
  scenes.flash(`saved “${name}”`);
}

function loadFromLibrary(name: string): void {
  const entry = library[name];
  const scene = entry && decodeScene(entry.code);
  if (!scene) return;
  lib.name = name;
  lib.current = name;
  loadSceneData(scene);
}

function removeFromLibrary(name: string): void {
  if (!library[name] || !confirm(`"${name}" を削除しますか？`)) return;
  delete library[name];
  saveLibrary(library);
  if (lib.current === name) lib.current = '';
  scenes.update(library, lib.current, lib.name);
}

/** 配置を読み込み、テンポや動きのつまみも合わせる */
function loadSceneData(scene: SceneData): void {
  if (midi.isRecording) toggleRecording();
  applySceneParams(scene);
  sim.enqueue({ kind: 'loadScene', scene });
  if (started) {
    audio.setBpm(scene.bpm);
    audio.setSong(params.song);
  }
  toolbar.setTempo(params.bpm);
  refreshUI();
}

function exportSceneFile(): void {
  const name = lib.name.trim() || `otosu-${stamp()}`;
  const text = sceneToFile(name, sceneFromSim(sim));
  download(new Blob([text], { type: 'application/json' }), `${name.replace(/[\\/:*?"<>|]/g, '_')}.otosu.json`);
}

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.json,application/json';
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  const loaded = sceneFromFile(await file.text());
  if (!loaded) {
    alert('otosu の配置ファイルとして読めませんでした');
    return;
  }
  lib.name = loaded.name || file.name.replace(/(\.otosu)?\.json$/i, '');
  lib.current = '';
  loadSceneData(loaded.scene);
});

/** つまみを既定値に戻す（図形は残す） */
function resetSettings(): void {
  if (!confirm('設定を初期値に戻しますか？（図形は残ります）')) return;
  const { tool, muted, midiOutput } = params;
  Object.assign(params, DEFAULTS, { tool, muted, midiOutput });
  setTempo();
  setRotation();
  setDrift();
  setSong();
  applyPrefs();
  toolbar.setTempo(params.bpm);
  toolbar.setVolume(params.volume);
  refreshUI();
}

/** 端末ごとの設定（音量・光など）を音と描画に反映する */
function applyPrefs(): void {
  renderer.setPixelRatio(params.pixelRatio);
  midi.allNotesOff();
  if (!started) return;
  audio.setVolume(params.volume);
  audio.setStereoWidth(params.stereoWidth);
  audio.setPad(params.pad);
  audio.setPadLevel(params.padLevel);
}

function toggleRecording(): void {
  if (!started) return;
  if (!midi.isRecording) {
    // 次の拍の頭から記録する（DAW で小節線が合うように）
    const em = sim.emitters[0];
    const spb = (HZ * 60) / sim.bpm;
    const anchor = em ? em.anchorStep : 0;
    const start = anchor + Math.ceil((sim.step - anchor) / spb) * spb;
    midi.startRecording(start, sim.bpm);
    recordBtn.textContent = '■ stop & save .mid';
    recordBtn.classList.add('rec');
    return;
  }
  const data = midi.stopRecording();
  recordBtn.textContent = '● record .mid';
  recordBtn.classList.remove('rec');
  if (!data) return;
  download(new Blob([data as BlobPart], { type: 'audio/midi' }), `otosu-${stamp()}.mid`);
}

/** ファイル名用の日時（例 20260927-1430） */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- キー操作・カーソル ----
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
  if (e.key === 'f' || e.key === 'F') {
    toggleFullscreen();
  } else if (e.key === 'h' || e.key === 'H') {
    document.body.classList.toggle('ui-hidden');
  } else if (e.key === 'Escape') {
    toggleSettings(false);
    closePopovers();
  } else if (e.key === ',') {
    toggleSettings();
  } else if (e.key === 'c' || e.key === 'C') {
    sim.enqueue({ kind: 'clearSegments' });
  } else if (e.key === 'r' || e.key === 'R') {
    toggleRecording();
  } else if (e.key === 's' || e.key === 'S') {
    void copySceneUrl();
  } else if (e.key === ' ') {
    e.preventDefault();
    setPaused(!paused);
  } else if (e.key === 'm' || e.key === 'M') {
    toggleMute();
  } else if (e.key >= '1' && e.key <= String(TOOLS.length)) {
    setTool(TOOLS[Number(e.key) - 1]!);
  }
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
  const band = Math.max(TOP_BAND_PX, Math.ceil(toolbar.el.getBoundingClientRect().bottom) + 6);
  document.documentElement.style.setProperty('--band', `${band}px`);
  renderer.setTopBand(band);
  syncView();
};
layout();
addEventListener('resize', layout);

// ---- 開始 ----
let started = false;
let paused = false;
let t0 = 0;
const overlay = document.getElementById('overlay')!;
// iOS Safari は pointerdown では音を出させてくれないので click で始める
overlay.addEventListener('click', async () => {
  if (started) return;
  // iOS: マナーモードでも鳴らす（対応していないブラウザでは何もしない）
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) session.type = 'playback';
  overlay.textContent = '…';
  await audio.start(params.bpm);
  audio.setVolume(params.volume);
  audio.setStereoWidth(params.stereoWidth);
  audio.setSong(params.song);
  audio.setPad(params.pad);
  audio.setPadLevel(params.padLevel);
  audio.setMuted(params.muted);
  const ctx = audio.raw;
  clock.measureLatency(ctx);
  // 出力の遅れは鳴り始めてから決まる端末があるので、少し後にもう一度だけ読む
  setTimeout(() => clock.measureLatency(ctx), 1500);
  console.info(`[otosu] baseLatency=${ctx.baseLatency} outputLatency=${ctx.outputLatency}`);
  t0 = ctx.currentTime + 0.1;
  started = true;
  overlay.remove();
  toolbar.showHelp();
});

// 音の時計（D29）: getOutputTimestamp は音声スレッドを待って固まることがあるので使わない
const clock = new AudioClock();
const toPerf = (audioTime: number): number => clock.toPerf(audioTime);

// ?fps: 実機で重さを確かめるための表示（fps と画質の段階。D27）
const fpsEl = new URLSearchParams(location.search).has('fps') ? document.body.appendChild(document.createElement('div')) : null;
if (fpsEl) fpsEl.style.cssText = 'position:fixed;right:8px;bottom:8px;font:11px monospace;color:#8f8;pointer-events:none;z-index:9';
let fpsFrames = 0;
let fpsT = performance.now();

let lastFrame = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (fpsEl && ++fpsFrames && now - fpsT >= 1000) {
    fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsT))} fps · q${renderer.qualityLevel}`;
    fpsFrames = 0;
    fpsT = now;
  }

  if (!started) {
    renderer.render(sim, -1, dt, input.preview);
    return;
  }

  const ctx = audio.raw;
  const ct = ctx.currentTime;
  clock.update(ct, now);

  // 遅れすぎたら基準を取り直し、飛ばした時間は捨てる（D8-1）
  let target = Math.floor((ct - t0 + LOOKAHEAD) * HZ);
  if (target - sim.step > MAX_LAG * HZ) {
    t0 = ct + LOOKAHEAD - (sim.step + 1) / HZ;
    target = sim.step + 1;
  }
  for (let n = 0; sim.step < target && n < MAX_STEPS_PER_FRAME; n++) sim.advance();

  const kept: SimEvent[] = [];
  for (const e of sim.drainEvents()) {
    const time = t0 + e.step / HZ;
    if (e.kind === 'hit') {
      midi.record(e); // 録音は step 基準なので、遅れて捨てる衝突も入れる
      if (time < ct - LATE_DROP) continue; // 音も光も捨てる
      if (params.internalSound) audio.play(e, Math.max(time, ct));
      if (!params.muted && !paused) midi.play(e, Math.max(time, ct), toPerf);
    } else if (e.kind === 'section') {
      audio.setSection(e.root, Math.max(time, ct));
    } else if (e.kind === 'shapeAdded') {
      // 確定音（D11: 入力へのフィードバック。MIDI には送らない）
      if (params.internalSound && time >= ct - LATE_DROP) audio.confirm(e.midi, Math.max(time, ct), e.form);
    }
    kept.push(e);
  }
  renderer.push(kept);
  midi.update();

  let rs = (clock.audible() - t0) * HZ + (params.visualOffsetMs / 1000) * HZ;
  rs = Math.min(sim.step - 1, Math.max(sim.step - HISTORY + 2, rs));
  renderer.render(sim, rs, dt, input.preview);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { otosu: { sim, audio, params, midi, renderer, input } });

// ---- 配置の自動保存と URL 共有 ----
function currentSceneCode(): string {
  return encodeScene(sceneFromSim(sim));
}

async function copySceneUrl(): Promise<void> {
  const url = `${location.origin}${location.pathname}#${SCENE_HASH_KEY}=${currentSceneCode()}`;
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    scenes.flash('link copied');
  } catch {
    console.info(`[otosu] scene URL: ${url}`);
  }
}

let lastSaved = '';
let lastPrefs = JSON.stringify(currentPrefs());
setInterval(() => {
  const prefsJson = JSON.stringify(currentPrefs());
  if (prefsJson !== lastPrefs) {
    lastPrefs = prefsJson;
    savePrefs(currentPrefs());
  }
  // 開始前（と開始直後、まだ1ステップも進んでいない間）はコマンドが sim に適用されていないので保存しない
  // （空の配置で上書きしてしまう。タブが隠れていると描画ループが止まり、この状態が続く）
  if (!started || sim.step === 0) return;
  const code = currentSceneCode();
  if (code === lastSaved) return;
  lastSaved = code;
  try {
    localStorage.setItem(SCENE_STORAGE_KEY, code);
  } catch {
    // 保存できない環境（プライベートモード等）では何もしない
  }
}, 2000);

// タブを隠すと rAF が止まり note off が送られないので、先に全部止める。
// パッドは rAF と関係なく鳴り続けるので、AudioContext ごと止める（一時停止と同じく時刻も止まる）。
// 戻ったら再開する。iOS は戻ったときに interrupted のままのことがあるので resume し直す（D41）
function hideAudio(): void {
  midi.allNotesOff();
  if (started) void audio.raw.suspend();
}
addEventListener('visibilitychange', () => {
  if (document.hidden) hideAudio();
  else if (started) void audio.raw.resume();
});
addEventListener('pagehide', hideAudio);
addEventListener('pageshow', () => {
  if (started && !document.hidden) void audio.raw.resume();
});
