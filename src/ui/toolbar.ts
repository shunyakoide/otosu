import type { Tool } from '../input/input';

// 画面上端のツールバー（D24）。道具・テンポ・音量・保存だけを置き、ワールドに重ならない帯に収める。
// 操作が止まると他の UI と一緒に消える（投影中に映り込まないように）。

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  line: svg('<path d="M5 17 19 7"/>'),
  pen: svg('<path d="M4 16c3-7 5 3 8-3s5 2 8-4"/>'),
  circle: svg('<circle cx="12" cy="12" r="7"/>'),
  triangle: svg('<path d="M12 5 19.5 18h-15z"/>'),
  square: svg('<rect x="5.5" y="5.5" width="13" height="13"/>'),
  sound: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>'),
  muted: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  clear: svg('<path d="M5 7h14M9.5 7V5h5v2M7 7l1 12h8l1-12"/>'),
  scenes: svg('<path d="M6 4h9l3 3v13H6z"/><path d="M9 4v5h6V4M9 20v-6h6v6"/>'),
  motion: svg('<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4.5V8h-3.5"/>'),
  light: svg('<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'),
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
  tool: (t: Tool) => void;
  mute: () => void;
  /** 音量（dB）。つまみを動かしている間ずっと呼ぶ */
  volume: (db: number) => void;
  /** テンポ。連続で押している間はまとめて、止まってから1回呼ぶ */
  tempo: (bpm: number) => void;
  clear: () => void;
  motion: (anchor: HTMLElement) => void;
  light: (anchor: HTMLElement) => void;
  scenes: (anchor: HTMLElement) => void;
  fullscreen: () => void;
};

export const TEMPO_MIN = 60;
export const TEMPO_MAX = 140;
export const VOLUME_MIN = -30;
export const VOLUME_MAX = 0;

export class Toolbar {
  readonly el: HTMLElement;
  private readonly tools = new Map<Tool, HTMLButtonElement>();
  private readonly muteBtn: HTMLButtonElement;
  /** 小窓を開くボタン */
  private readonly popBtns: Record<'motion' | 'light' | 'scenes', HTMLButtonElement>;
  private readonly volumeInput: HTMLInputElement;
  private readonly tempoOut: HTMLElement;
  private bpm = 90;
  private tempoTimer = 0;

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

    tools.forEach((t, i) => this.tools.set(t, btn(ICONS[t], `${TOOL_LABELS[t]} (${i + 1})`, () => on.tool(t))));
    sep();

    // テンポ: − 90 +（ホイールでも変えられる）
    const tempo = document.createElement('div');
    tempo.className = 'tb-tempo';
    tempo.title = 'tempo (bpm) — scroll to change';
    const nudge = (d: number) => {
      this.setTempo(this.bpm + d);
      clearTimeout(this.tempoTimer);
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
    sep();
    const scenesBtn: HTMLButtonElement = btn(ICONS.scenes, 'save / load scenes', () => on.scenes(scenesBtn));
    this.popBtns = { motion: motionBtn, light: lightBtn, scenes: scenesBtn };
    btn(ICONS.fullscreen, 'fullscreen (F)', on.fullscreen);

    const help = document.createElement('div');
    help.id = 'toolbar-help';
    help.textContent = 'drag: draw · shift: bumper · right-click: erase · H: hide ui · , : fine-tune';
    help.classList.add('ui');
    parent.append(this.el, help);
  }

  setTool(tool: Tool): void {
    for (const [t, b] of this.tools) b.classList.toggle('on', t === tool);
  }

  setMuted(muted: boolean): void {
    this.muteBtn.innerHTML = muted ? ICONS.muted : ICONS.sound;
    this.muteBtn.classList.toggle('warn', muted);
    this.muteBtn.title = muted ? 'unmute (M)' : 'mute (M)';
    this.el.classList.toggle('muted', muted);
  }

  setVolume(db: number): void {
    this.volumeInput.value = String(db);
    this.paintVolume();
  }

  setTempo(bpm: number): void {
    this.bpm = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(bpm)));
    this.tempoOut.textContent = String(this.bpm);
  }

  /** 開いている小窓のボタンを光らせる（null で全部消す） */
  setOpenPopover(which: 'motion' | 'light' | 'scenes' | null): void {
    for (const [k, b] of Object.entries(this.popBtns)) b.classList.toggle('on', k === which);
  }

  private paintVolume(): void {
    const v = Number(this.volumeInput.value);
    this.volumeInput.style.setProperty('--p', `${((v - VOLUME_MIN) / (VOLUME_MAX - VOLUME_MIN)) * 100}%`);
  }
}
