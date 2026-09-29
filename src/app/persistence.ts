import type { Audio } from '../audio/audio';
import { decodeScene, encodeScene, SCENE_HASH_KEY, SCENE_STORAGE_KEY, sceneFromSim } from '../scene/scene';
import { DEFAULT_SONG } from '../sim/music';
import type { Sim } from '../sim/sim';
import type { Command, SceneData } from '../sim/types';
import { ScenesPopover } from '../ui/scenes';
import { loadLibrary, saveLibrary, savePrefs, sceneFromFile, sceneToFile, type Library } from '../ui/storage';
import type { Toolbar } from '../ui/toolbar';
import type { MidiControl } from './midiControl';
import { currentPrefs, PATTERNS, type Params } from './params';
import type { MotionKnobs } from './popovers';
import type { EngineState } from './state';
import { download, stamp } from '../util';

// 配置の保存と読み込み（D18, D24）。URL ハッシュ → localStorage の自動保存、名前を付けた保存、ファイル、リンクのコピー。

/** 保存された配置がないときに置く線 */
export const DEMO: Command[] = [
  { kind: 'addSegment', ax: 700, ay: 300, bx: 900, by: 360, loaded: true },
  { kind: 'addSegment', ax: 1050, ay: 420, bx: 1250, by: 380, loaded: true },
  { kind: 'addSegment', ax: 500, ay: 640, bx: 1000, by: 700, loaded: true },
  { kind: 'addSegment', ax: 1150, ay: 700, bx: 1450, by: 620, loaded: true },
  { kind: 'addSegment', ax: 820, ay: 950, bx: 980, by: 900, loaded: true },
];

/** 自動保存の間隔（ms） */
const AUTOSAVE_MS = 2000;

/** 保存された配置（URL ハッシュ → localStorage の順） */
export function loadStoredScene(): SceneData | null {
  const m = location.hash.match(new RegExp(`[#&]${SCENE_HASH_KEY}=([^&]+)`));
  if (m) {
    // リンクの配置は一度だけ読む。URL に残すと、その後の編集がリロードで古いリンクの配置に戻ってしまう
    history.replaceState(null, '', location.pathname + location.search);
    const scene = decodeScene(m[1]!);
    if (scene) {
      try {
        localStorage.setItem(SCENE_STORAGE_KEY, m[1]!);
      } catch {
        // 保存できない環境では、このページの間だけ使う
      }
      return scene;
    }
  }
  try {
    const code = localStorage.getItem(SCENE_STORAGE_KEY);
    return code ? decodeScene(code) : null;
  } catch {
    return null;
  }
}

/** 配置が持つ値（テンポ・周期・動き・曲）を params に移す */
export function applySceneParams(params: Params, knobs: MotionKnobs, scene: SceneData): void {
  const label = scene.pattern.join(' : ');
  if (!PATTERNS[label]) PATTERNS[label] = scene.pattern;
  params.bpm = scene.bpm;
  params.pattern = label;
  params.rotate = scene.rotate;
  params.rotationSpeed = scene.rotationSpeed;
  params.drift = scene.drift.mode;
  params.driftAmp = scene.drift.amp;
  params.song = scene.song ?? DEFAULT_SONG;
  knobs.rememberScene();
}

export type SceneStoreDeps = {
  params: Params;
  state: EngineState;
  sim: Sim;
  audio: Audio;
  toolbar: Toolbar;
  knobs: MotionKnobs;
  midi: MidiControl;
  /** 読み込んだ値に小窓の表示を合わせる */
  refresh: () => void;
};

export class SceneStore {
  /** ツールバーの保存ボタンから開く小窓 */
  readonly scenes: ScenesPopover;
  private readonly d: SceneStoreDeps;
  private library: Library = loadLibrary();
  /** 名前欄に出す名前と、一覧で選ばれている（最後に保存・読み込みした）配置の名前 */
  private name = '';
  private current = '';
  private readonly fileInput: HTMLInputElement;

  constructor(deps: SceneStoreDeps) {
    this.d = deps;
    this.scenes = new ScenesPopover(document.body, {
      save: (name) => this.save(name),
      load: (name) => this.load(name),
      remove: (name) => this.remove(name),
      clear: () => deps.sim.enqueue({ kind: 'clearSegments' }),
      exportFile: () => this.exportFile(),
      importFile: () => this.fileInput.click(),
      copyLink: () => void this.copySceneUrl(),
      // 開くたびに読み直す（別のタブで保存したものも出す）
      reload: () => {
        this.library = loadLibrary();
        return { library: this.library, current: this.current, name: this.name };
      },
    });
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.json,application/json';
    this.fileInput.addEventListener('change', () => void this.importFile());
  }

  /** 短い知らせ。保存の小窓が開いていればそこに、なければツールバーの下に出す */
  notify(text: string): void {
    if (this.scenes.isOpen) this.scenes.flash(text);
    else this.d.toolbar.flash(text);
  }

  /** 配置を読み込み、テンポや動きのつまみも合わせる */
  loadSceneData(scene: SceneData): void {
    const { params, state, sim, audio, toolbar, knobs, midi } = this.d;
    midi.stopRecording();
    applySceneParams(params, knobs, scene);
    sim.enqueue({ kind: 'loadScene', scene });
    if (state.started) {
      audio.setBpm(scene.bpm);
      audio.setSong(params.song);
    }
    toolbar.setTempo(params.bpm);
    this.d.refresh();
  }

  async copySceneUrl(): Promise<void> {
    const url = `${location.origin}${location.pathname}#${SCENE_HASH_KEY}=${this.currentCode()}`;
    let ok = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      ok = false;
      console.info(`[otosu] scene URL: ${url}`);
    }
    this.notify(ok ? 'link copied' : 'could not copy the link');
  }

  /** この端末の設定と今の配置を、変わったときだけ保存し続ける（D24） */
  startAutosave(): void {
    const { params, state, sim } = this.d;
    let lastSaved = '';
    let lastPrefs = JSON.stringify(currentPrefs(params));
    setInterval(() => {
      const prefsJson = JSON.stringify(currentPrefs(params));
      if (prefsJson !== lastPrefs) {
        lastPrefs = prefsJson;
        savePrefs(currentPrefs(params));
      }
      // 開始前（と開始直後、まだ1ステップも進んでいない間）はコマンドが sim に適用されていないので保存しない
      // （空の配置で上書きしてしまう。タブが隠れていると描画ループが止まり、この状態が続く）
      if (!state.started || sim.step === 0) return;
      const code = this.currentCode();
      if (code === lastSaved) return;
      lastSaved = code;
      try {
        localStorage.setItem(SCENE_STORAGE_KEY, code);
      } catch {
        // 保存できない環境（プライベートモード等）では何もしない
      }
    }, AUTOSAVE_MS);
  }

  private currentCode(): string {
    return encodeScene(sceneFromSim(this.d.sim));
  }

  private save(input: string): void {
    const name = input.trim() || `scene ${stamp()}`;
    if (this.library[name] && name !== this.current && !confirm(`"${name}" を上書きしますか？`)) return;
    const next = { ...this.library, [name]: { code: this.currentCode(), savedAt: Date.now() } };
    if (!saveLibrary(next)) {
      this.scenes.flash('could not save (storage is full or blocked)');
      return;
    }
    this.library = next;
    this.name = name;
    this.current = name;
    this.scenes.update(this.library, this.current, this.name);
    this.scenes.flash(`saved “${name}”`);
  }

  private load(name: string): void {
    const entry = this.library[name];
    const scene = entry && decodeScene(entry.code);
    if (!scene) return;
    this.name = name;
    this.current = name;
    this.loadSceneData(scene);
  }

  private remove(name: string): void {
    if (!this.library[name] || !confirm(`"${name}" を削除しますか？`)) return;
    const next = { ...this.library };
    delete next[name];
    if (!saveLibrary(next)) {
      this.scenes.flash('could not delete (storage is blocked)');
      return;
    }
    this.library = next;
    if (this.current === name) this.current = '';
    this.scenes.update(this.library, this.current, this.name);
  }

  private exportFile(): void {
    const name = this.name.trim() || `otosu-${stamp()}`;
    const text = sceneToFile(name, sceneFromSim(this.d.sim));
    download(new Blob([text], { type: 'application/json' }), `${name.replace(/[\\/:*?"<>|]/g, '_')}.otosu.json`);
  }

  private async importFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    const loaded = sceneFromFile(await file.text());
    if (!loaded) {
      alert('otosu の配置ファイルとして読めませんでした');
      return;
    }
    this.name = loaded.name || file.name.replace(/(\.otosu)?\.json$/i, '');
    this.current = '';
    this.loadSceneData(loaded.scene);
  }
}
