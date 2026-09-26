import GUI from 'lil-gui';
import { Audio } from './audio/audio';
import { Input } from './input/input';
import { Renderer } from './render/render';
import { HISTORY, HZ } from './sim/constants';
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
  (x, y) => renderer.pickSegment(x, y),
);

// ---- GUI ----
const gui = new GUI({ title: 'otosu' });
const setTempo = () => {
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
gui.close();

// ---- キー操作・カーソル ----
addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  } else if (e.key === 'h' || e.key === 'H') {
    gui.show(gui._hidden);
    document.getElementById('hint')!.classList.toggle('hidden');
  } else if (e.key === 'c' || e.key === 'C') {
    sim.enqueue({ kind: 'clearSegments' });
  } else if (e.key === 's' || e.key === 'S') {
    void copySceneUrl();
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
  const ctx = audio.raw;
  console.info(`[otosu] baseLatency=${ctx.baseLatency} outputLatency=${ctx.outputLatency}`);
  t0 = ctx.currentTime + 0.1;
  started = true;
  overlay.remove();
});

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
    if (e.kind === 'hit') {
      const time = t0 + e.step / HZ;
      if (time < ct - LATE_DROP) continue; // 音も光も捨てる
      audio.play(e, Math.max(time, ct));
    }
    kept.push(e);
  }
  renderer.push(kept);

  let rs = (audibleTime(ctx) - t0) * HZ + (params.visualOffsetMs / 1000) * HZ;
  rs = Math.min(sim.step - 1, Math.max(sim.step - HISTORY + 2, rs));
  renderer.render(sim, rs, dt, input.preview);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { otosu: { sim, audio, params } });

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
