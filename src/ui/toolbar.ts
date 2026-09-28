import type { Tool } from '../input/input';
import { BPM_MAX, BPM_MIN } from '../sim/constants';
import './toolbar.css';

// 画面上端のツールバー（D24）。道具・テンポ・音量・保存だけを置き、ワールドに重ならない帯に収める。
// 操作が止まると他の UI と一緒に消える（投影中に映り込まないように）。

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  play: svg('<path d="M8 5.5v13l10.5-6.5z"/>'),
  pause: svg('<path d="M9 5.5v13M15 5.5v13"/>'),
  line: svg('<path d="M5 17 19 7"/>'),
  pen: svg('<path d="M4 16c3-7 5 3 8-3s5 2 8-4"/>'),
  circle: svg('<circle cx="12" cy="12" r="7"/>'),
  triangle: svg('<path d="M12 5 19.5 18h-15z"/>'),
  square: svg('<rect x="5.5" y="5.5" width="13" height="13"/>'),
  sound: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>'),
  muted: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  clear: svg('<path d="M5 7h14M9.5 7V5h5v2M7 7l1 12h8l1-12"/>'),
  scenes: svg('<path d="M6 4h9l3 3v13H6z"/><path d="M9 4v5h6V4M9 20v-6h6v6"/>'),
  // 回る・揺れる: 軌道と、その上の小さな玉（再読み込みの矢印に見えないように。D45）
  motion: svg('<ellipse cx="12" cy="12" rx="8.5" ry="4" transform="rotate(-25 12 12)"/><circle cx="12" cy="12" r="1.6"/><circle cx="19.2" cy="8.6" r="1.1" fill="currentColor"/>'),
  // 曲・リズム（D51）: 音符（ミュートのスピーカーと見分けがつくように）
  music: svg('<path d="M9 17.5V6.5l10-2.5v11"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>'),
  light: svg('<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'),
  settings: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  minus: svg('<path d="M7 12h10"/>'),
  plus: svg('<path d="M7 12h10M12 7v10"/>'),
  fullscreen: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
};

const TOOL_LABELS: Record<Tool, string> = {
  line: 'line — bell',
  pen: 'pen — kalimba',
  circle: 'circle — kick',
  triangle: 'triangle — chime',
  square: 'square — wood',
};

export type ToolbarActions = {
  play: () => void;
  tool: (t: Tool) => void;
  mute: () => void;
  /** 音量（dB）。つまみを動かしている間ずっと呼ぶ */
  volume: (db: number) => void;
  /** テンポ。連続で押している間はまとめて、止まってから1回呼ぶ */
  tempo: (bpm: number) => void;
  clear: () => void;
  motion: (anchor: HTMLElement) => void;
  sound: (anchor: HTMLElement) => void;
  light: (anchor: HTMLElement) => void;
  scenes: (anchor: HTMLElement) => void;
  /** 細かい設定のパネル（, キーと同じ） */
  settings: (anchor: HTMLElement) => void;
  fullscreen: () => void;
};

/** 小窓・パネルを開くボタン */
export type PopName = 'motion' | 'light' | 'sound' | 'settings' | 'scenes';

const VOLUME_MIN = -30;
const VOLUME_MAX = 0;
/** 操作の案内を出しておく秒数 */
const HELP_SEC = 12;
/** 道具を選んだときに出す名前と音色の表示の秒数 */
const TIP_SEC = 1.6;

export class Toolbar {
  readonly el: HTMLElement;
  private readonly tools = new Map<Tool, HTMLButtonElement>();
  private readonly muteBtn: HTMLButtonElement;
  private readonly playBtn: HTMLButtonElement;
  /** 小窓を開くボタン */
  private readonly popBtns: Record<PopName, HTMLButtonElement>;
  private readonly volumeInput: HTMLInputElement;
  private readonly tempoOut: HTMLElement;
  private bpm = 90;
  private tempoTimer = 0;
  private readonly help: HTMLElement;
  private helpTimer = 0;
  private readonly tip: HTMLElement;
  private tipTimer = 0;

  constructor(parent: HTMLElement, tools: readonly Tool[], on: ToolbarActions) {
    this.el = document.createElement('nav');
    this.el.id = 'toolbar';
    const btn = (icon: string, title: string, onClick: () => void, into: HTMLElement = this.el) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = icon;
      b.title = title;
      b.setAttribute('aria-label', title);
      // フォーカスが残ると Space/Enter で押し直してしまうので、押したら外す
      b.addEventListener('click', () => {
        onClick();
        b.blur();
      });
      into.appendChild(b);
      return b;
    };
    const sep = () => this.el.appendChild(document.createElement('i'));

    this.playBtn = btn(ICONS.pause, 'pause (space)', on.play);
    sep();
    tools.forEach((t, i) => this.tools.set(t, btn(ICONS[t], `${TOOL_LABELS[t]} (${i + 1})`, () => on.tool(t))));
    sep();

    // テンポ: − 90 +（ホイールでも変えられる）
    const tempo = document.createElement('div');
    tempo.className = 'tb-tempo';
    tempo.title = 'tempo (bpm) — scroll to change';
    const nudge = (d: number) => {
      this.setTempo(this.bpm + d);
      this.tempoTimer = window.setTimeout(() => on.tempo(this.bpm), 250);
    };
    btn(ICONS.minus, 'slower', () => nudge(-1), tempo);
    this.tempoOut = document.createElement('span');
    tempo.appendChild(this.tempoOut);
    btn(ICONS.plus, 'faster', () => nudge(1), tempo);
    tempo.addEventListener('wheel', (e) => {
      e.preventDefault();
      nudge(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this.el.appendChild(tempo);
    sep();

    // 音量: スピーカー（押すとミュート）と細いスライダー
    const vol = document.createElement('div');
    vol.className = 'tb-volume';
    this.muteBtn = btn(ICONS.sound, 'mute (M)', on.mute, vol);
    this.volumeInput = document.createElement('input');
    this.volumeInput.type = 'range';
    this.volumeInput.min = String(VOLUME_MIN);
    this.volumeInput.max = String(VOLUME_MAX);
    this.volumeInput.step = '1';
    this.volumeInput.title = 'volume';
    this.volumeInput.addEventListener('input', () => {
      this.paintVolume();
      on.volume(Number(this.volumeInput.value));
    });
    this.volumeInput.addEventListener('change', () => this.volumeInput.blur());
    vol.appendChild(this.volumeInput);
    this.el.appendChild(vol);
    btn(ICONS.clear, 'clear all shapes (C)', on.clear);
    sep();
    const motionBtn: HTMLButtonElement = btn(ICONS.motion, 'motion', () => on.motion(motionBtn));
    const lightBtn: HTMLButtonElement = btn(ICONS.light, 'light', () => on.light(lightBtn));
    const soundBtn: HTMLButtonElement = btn(ICONS.music, 'sound', () => on.sound(soundBtn));
    const settingsBtn: HTMLButtonElement = btn(ICONS.settings, 'settings (,)', () => on.settings(settingsBtn));
    sep();
    const scenesBtn: HTMLButtonElement = btn(ICONS.scenes, 'save / load scenes', () => on.scenes(scenesBtn));
    this.popBtns = { motion: motionBtn, light: lightBtn, sound: soundBtn, settings: settingsBtn, scenes: scenesBtn };
    this.setOpenPopover(null);
    // iPhone の Safari のように全画面にできない環境ではボタンを出さない
    if (document.fullscreenEnabled) btn(ICONS.fullscreen, 'fullscreen (F)', on.fullscreen);

    // 操作の案内: 始めるまでは出さず、始めてからしばらくで消す（showHelp）。右クリックと Shift は、使える場面でカーソルのそばに出す（D53）
    this.help = document.createElement('div');
    this.help.id = 'toolbar-help';
    this.help.className = 'ui gone';
    this.help.innerHTML = matchMedia('(hover: none)').matches
      ? 'drag to draw · long-press a shape: effects / delete'
      : 'drag to draw · <kbd>space</kbd> pause · <kbd>H</kbd> hide ui · <kbd>,</kbd> fine-tune';
    // 道具の名前と音色（タッチではホバーの説明が出ないので、選んだときに少しだけ出す）
    this.tip = document.createElement('div');
    this.tip.id = 'toolbar-tip';
    this.tip.className = 'ui gone';
    parent.append(this.el, this.help, this.tip);
  }

  /** 道具を選んだときに、名前と音色（例: circle — kick）をツールバーの下に少しだけ出す */
  flashTool(tool: Tool): void {
    this.flash(TOOL_LABELS[tool]);
  }

  /** 短い知らせをツールバーの下に少しだけ出す */
  flash(text: string): void {
    this.tip.textContent = text;
    this.tip.style.top = `${this.el.getBoundingClientRect().bottom + 6}px`;
    this.tip.classList.remove('gone');
    clearTimeout(this.tipTimer);
    this.tipTimer = window.setTimeout(() => this.tip.classList.add('gone'), TIP_SEC * 1000);
  }

  /** 操作の案内を出し、HELP_SEC 秒で消す */
  showHelp(): void {
    this.help.classList.remove('gone');
    clearTimeout(this.helpTimer);
    this.helpTimer = window.setTimeout(() => this.help.classList.add('gone'), HELP_SEC * 1000);
  }

  setTool(tool: Tool): void {
    for (const [t, b] of this.tools) b.classList.toggle('on', t === tool);
  }

  setMuted(muted: boolean): void {
    this.muteBtn.innerHTML = muted ? ICONS.muted : ICONS.sound;
    this.muteBtn.classList.toggle('on', muted);
    this.muteBtn.title = muted ? 'unmute (M)' : 'mute (M)';
    this.muteBtn.setAttribute('aria-label', this.muteBtn.title);
    this.el.classList.toggle('muted', muted);
  }

  setPaused(paused: boolean): void {
    this.playBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
    this.playBtn.title = paused ? 'play (space)' : 'pause (space)';
    this.playBtn.setAttribute('aria-label', this.playBtn.title);
    this.playBtn.classList.toggle('on', paused);
  }

  setVolume(db: number): void {
    this.volumeInput.value = String(db);
    this.paintVolume();
  }

  /** 表示を合わせる。外から（読み込み・リセット）合わせたときは、押している途中の変更を捨てる */
  setTempo(bpm: number): void {
    clearTimeout(this.tempoTimer);
    this.bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm)));
    this.tempoOut.textContent = String(this.bpm);
  }

  /** 小窓を開くボタン（キーで開くときの位置合わせ用） */
  button(which: PopName): HTMLButtonElement {
    return this.popBtns[which];
  }

  /** 開いている小窓のボタンを光らせる（null で全部消す） */
  setOpenPopover(which: PopName | null): void {
    for (const [k, b] of Object.entries(this.popBtns)) {
      b.classList.toggle('on', k === which);
      b.setAttribute('aria-expanded', String(k === which));
    }
  }

  private paintVolume(): void {
    const v = Number(this.volumeInput.value);
    this.volumeInput.style.setProperty('--p', `${((v - VOLUME_MIN) / (VOLUME_MAX - VOLUME_MIN)) * 100}%`);
  }
}
