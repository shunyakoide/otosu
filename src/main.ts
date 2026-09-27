import GUI from 'lil-gui';
import { Audio } from './audio/audio';
import { Input, TOOLS, type Tool } from './input/input';
import { Midi } from './midi/midi';
import { Renderer } from './render/render';
import { HISTORY, HZ, WORLD_H, WORLD_W } from './sim/constants';
import { midiAt } from './sim/music';
import { Sim } from './sim/sim';
import type { Command, DriftMode, SceneData, SimEvent } from './sim/types';
import { decodeScene, encodeScene, SCENE_HASH_KEY, SCENE_STORAGE_KEY, sceneFromSim } from './scene/scene';

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

const params = {
  bpm: 90,
  pattern: '2 : 3',
  volume: -3,
  muted: false,
  tool: 'line' as Tool,
  pad: true,
  padLevel: 0.5,
  rotate: false,
  rotationSpeed: 0.3,
  drift: 'drift' as DriftMode,
  driftAmp: 24,
  stereoWidth: 0.7,
  trail: 'geometry' as 'geometry' | 'afterimage',
  colorMode: 'pitch' as 'pitch' | 'mono',
  bloomStrength: 0.9,
  afterimage: 0.8,
  idleLine: 0.3,
  visualOffsetMs: 0,
  pixelRatio: 1,
  internalSound: true,
  midiOutput: '',
  midiChannel: 1,
  midiDrumChannel: 10,
  midiNoteLength: 0.4,
  midiOffsetMs: 0,
};

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
}

Audio.setupContext();
const audio = new Audio();
const stored = loadStoredScene();
if (stored) applySceneParams(stored);
const sim = new Sim({
  bpm: params.bpm,
  pattern: PATTERNS[params.pattern]!,
  drift: { mode: params.drift, amp: params.driftAmp },
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
);
// ドラッグ中に音程が変わったら小さく鳴らす（D11）。音高は今の区間のもの
input.onPreviewNote = (slot) => {
  if (started && !params.muted && params.internalSound) audio.tick(midiAt(slot, sim.sectionAt(sim.step)));
};
// 図形を置ける範囲の枠（UI と一緒に H で隠す）
const worldFrame = document.getElementById('frame')!;
const layoutFrame = () => {
  const s = renderer.worldScale;
  const o = renderer.toWorld(0, 0);
  Object.assign(worldFrame.style, {
    left: `${-o.x * s}px`, top: `${-o.y * s}px`, width: `${WORLD_W * s}px`, height: `${WORLD_H * s}px`,
  });
};
layoutFrame();
addEventListener('resize', layoutFrame);
const setTool = (t: Tool) => {
  params.tool = t;
  input.setTool(t);
  toolCtrl.updateDisplay();
};

// ---- GUI ----
const gui = new GUI({ title: 'otosu' });
const toolCtrl = gui.add(params, 'tool', [...TOOLS]).name('tool (1-5, Shift = bumper)').onChange(setTool);
const muteCtrl = gui.add({ mute: () => toggleMute() }, 'mute').name('🔊 mute (M)');
function toggleMute(): void {
  params.muted = !params.muted;
  audio.setMuted(params.muted);
  if (params.muted) midi.allNotesOff();
  muteCtrl.name(params.muted ? '🔇 unmute (M)' : '🔊 mute (M)');
}
const setTempo = () => {
  // 録音中にテンポや周期を変えると小節線が崩れるので、そこまでを保存して止める（D10）
  if (midi.isRecording) toggleRecording();
  sim.enqueue({ kind: 'setTempo', bpm: params.bpm, pattern: PATTERNS[params.pattern]! });
  if (started) audio.setBpm(params.bpm);
};
const setRotation = () => sim.enqueue({ kind: 'setRotation', on: params.rotate, speed: params.rotationSpeed });
const setDrift = () => sim.enqueue({ kind: 'setDrift', mode: params.drift, amp: params.driftAmp });
const music = gui.addFolder('Music');
music.add(params, 'bpm', 60, 140, 1).onFinishChange(setTempo);
music.add(params, 'pattern', Object.keys(PATTERNS)).onChange(setTempo);
music.add(params, 'volume', -30, 0, 1).onChange((v: number) => started && audio.setVolume(v));
music.add(params, 'stereoWidth', 0, 1, 0.05).onChange((v: number) => started && audio.setStereoWidth(v));
music.add(params, 'pad').onChange((on: boolean) => started && audio.setPad(on));
music.add(params, 'padLevel', 0, 1, 0.01).name('pad level').onChange((v: number) => started && audio.setPadLevel(v));
const motion = gui.addFolder('Motion');
motion.add(params, 'rotate').onChange(setRotation);
motion.add(params, 'rotationSpeed', 0.05, 1, 0.01).onFinishChange(setRotation);
motion.add(params, 'drift', ['off', 'drift', 'phrase']).onChange(setDrift);
motion.add(params, 'driftAmp', 0, 80, 1).onFinishChange(setDrift);
const visual = gui.addFolder('Visual');
visual.add(params, 'trail', ['geometry', 'afterimage']);
visual.add(params, 'colorMode', ['pitch', 'mono']);
visual.add(params, 'bloomStrength', 0, 2, 0.01);
visual.add(params, 'afterimage', 0.7, 0.97, 0.005);
visual.add(params, 'idleLine', 0.15, 0.45, 0.01);
visual.add(params, 'visualOffsetMs', -150, 40, 1);
visual.add(params, 'pixelRatio', [1, 1.5, 2]).onChange((r: number) => renderer.setPixelRatio(r));
gui.add({ clear: () => sim.enqueue({ kind: 'clearSegments' }) }, 'clear').name('clear lines (C)');
gui.add({ demo: () => DEMO.forEach((c) => sim.enqueue(c)) }, 'demo').name('add demo lines');
gui.add({ copy: () => void copySceneUrl() }, 'copy').name('copy scene URL (S)');
const midiFolder = gui.addFolder('MIDI');
const midi = new Midi({
  get channel() { return params.midiChannel; },
  get drumChannel() { return params.midiDrumChannel; },
  get noteLength() { return params.midiNoteLength; },
  get offsetMs() { return params.midiOffsetMs; },
});
midiFolder.add(params, 'internalSound').name('internal sound');
let outputCtrl = midiFolder.add(params, 'midiOutput', { '(none)': '' }).name('output');
const midiActions = {
  connect: async () => {
    try {
      const outs = await midi.connect();
      const options: Record<string, string> = { '(none)': '' };
      for (const o of outs) options[o.name] = o.id;
      const iac = outs.find((o) => /IAC/i.test(o.name));
      if (!params.midiOutput && iac) params.midiOutput = iac.id;
      outputCtrl = outputCtrl.options(options).name('output').onChange((id: string) => midi.select(id || null));
      midi.select(params.midiOutput || null);
      connectCtrl.name(outs.length ? `MIDI connected (${outs.length})` : 'no MIDI outputs found');
    } catch (err) {
      console.warn('[otosu] MIDI', err);
      connectCtrl.name(Midi.supported ? 'MIDI permission denied' : 'Web MIDI unsupported (use Chrome)');
    }
  },
  record: () => toggleRecording(),
};
const connectCtrl = midiFolder.add(midiActions, 'connect').name('connect MIDI');
midiFolder.add(params, 'midiChannel', 1, 16, 1).name('channel').onChange(() => midi.allNotesOff());
midiFolder.add(params, 'midiDrumChannel', 1, 16, 1).name('drum channel (○ □)').onChange(() => midi.allNotesOff());
midiFolder.add(params, 'midiNoteLength', 0.05, 2, 0.05).name('note length (s)');
midiFolder.add(params, 'midiOffsetMs', -100, 200, 1).name('offset (ms)');
const recordCtrl = midiFolder.add(midiActions, 'record').name('● record .mid (R)');
gui.close();

function toggleRecording(): void {
  if (!started) return;
  if (!midi.isRecording) {
    // 次の拍の頭から記録する（DAW で小節線が合うように）
    const em = sim.emitters[0];
    const spb = (HZ * 60) / sim.bpm;
    const anchor = em ? em.anchorStep : 0;
    const start = anchor + Math.ceil((sim.step - anchor) / spb) * spb;
    midi.startRecording(start, sim.bpm);
    recordCtrl.name('■ stop & save .mid (R)');
    return;
  }
  const data = midi.stopRecording();
  recordCtrl.name('● record .mid (R)');
  if (!data) return;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `otosu-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.mid`;
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/midi' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- キー操作・カーソル ----
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  } else if (e.key === 'h' || e.key === 'H') {
    gui.show(gui._hidden);
    document.getElementById('hint')!.classList.toggle('hidden');
    worldFrame.classList.toggle('hidden');
  } else if (e.key === 'c' || e.key === 'C') {
    sim.enqueue({ kind: 'clearSegments' });
  } else if (e.key === 'r' || e.key === 'R') {
    toggleRecording();
  } else if (e.key === 's' || e.key === 'S') {
    void copySceneUrl();
  } else if (e.key === 'm' || e.key === 'M') {
    toggleMute();
  } else if (e.key >= '1' && e.key <= String(TOOLS.length)) {
    setTool(TOOLS[Number(e.key) - 1]!);
  }
});
let cursorTimer = 0;
addEventListener('pointermove', () => {
  document.body.classList.remove('idle');
  clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => document.body.classList.add('idle'), 2000);
});

// ---- 開始 ----
let started = false;
let t0 = 0;
const overlay = document.getElementById('overlay')!;
overlay.addEventListener('pointerdown', async () => {
  if (started) return;
  overlay.textContent = '…';
  await audio.start(params.bpm);
  audio.setVolume(params.volume);
  audio.setStereoWidth(params.stereoWidth);
  audio.setPad(params.pad);
  audio.setPadLevel(params.padLevel);
  audio.setMuted(params.muted);
  const ctx = audio.raw;
  console.info(`[otosu] baseLatency=${ctx.baseLatency} outputLatency=${ctx.outputLatency}`);
  t0 = ctx.currentTime + 0.1;
  started = true;
  overlay.remove();
});

/** AudioContext 時刻 → その音がスピーカーから聞こえる performance.now 時刻（出力遅延込み） */
function toPerf(audioTime: number): number {
  const ctx = audio.raw;
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.contextTime && ts.performanceTime) {
    return ts.performanceTime + (audioTime - ts.contextTime) * 1000;
  }
  return performance.now() + (audioTime - ctx.currentTime + (ctx.outputLatency || 0)) * 1000;
}

/** 今スピーカーから出ている音のコンテキスト時刻（滑らかにしたもの） */
function audibleTime(ctx: AudioContext): number {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.contextTime && ts.performanceTime) {
    return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || 0);
}

let lastFrame = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (!started) {
    renderer.render(sim, -1, dt, input.preview);
    return;
  }

  const ctx = audio.raw;
  const ct = ctx.currentTime;

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
      if (!params.muted) midi.play(e, Math.max(time, ct), toPerf);
    } else if (e.kind === 'section') {
      audio.setSection(e.section, Math.max(time, ct));
    } else if (e.kind === 'shapeAdded') {
      // 確定音（D11: 入力へのフィードバック。MIDI には送らない）
      if (params.internalSound && time >= ct - LATE_DROP) audio.confirm(e.midi, Math.max(time, ct), e.form);
    }
    kept.push(e);
  }
  renderer.push(kept);
  midi.update();

  let rs = (audibleTime(ctx) - t0) * HZ + (params.visualOffsetMs / 1000) * HZ;
  rs = Math.min(sim.step - 1, Math.max(sim.step - HISTORY + 2, rs));
  renderer.render(sim, rs, dt, input.preview);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { otosu: { sim, audio, params, midi, renderer } });

// ---- 配置の自動保存と URL 共有 ----
function currentSceneCode(): string {
  return encodeScene(sceneFromSim(sim));
}

async function copySceneUrl(): Promise<void> {
  const url = `${location.origin}${location.pathname}#${SCENE_HASH_KEY}=${currentSceneCode()}`;
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    console.info('[otosu] scene URL copied');
  } catch {
    console.info(`[otosu] scene URL: ${url}`);
  }
}

let lastSaved = '';
setInterval(() => {
  // 開始前はコマンドが sim に適用されていないので保存しない（空の配置で上書きしてしまう）
  if (!started) return;
  const code = currentSceneCode();
  if (code === lastSaved) return;
  lastSaved = code;
  try {
    localStorage.setItem(SCENE_STORAGE_KEY, code);
  } catch {
    // 保存できない環境（プライベートモード等）では何もしない
  }
}, 2000);

// タブを隠すと rAF が止まり note off が送られないので、先に全部止める
addEventListener('visibilitychange', () => {
  if (document.hidden) midi.allNotesOff();
});
addEventListener('pagehide', () => midi.allNotesOff());
