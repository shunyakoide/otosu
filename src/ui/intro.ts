import './intro.css';

// 初めての人への案内（D71）。始めの一覧（D45）は左下に薄く 12 秒出るだけで、何をすればよいかが伝わりにくかった。
// 初めて開いた端末でだけ、画面の下の真ん中に 2 段で出す:
// 1. 始めたら「ドラッグで線を描く」を、最初の 1 本を描くまで出し続ける（時間では消さない）
// 2. 描いたら、大きさで音の高さが、形で音色が変わることを少しだけ出し、いつもの一覧へ渡す
// 使える場面で出す案内（D53）が出ている間は隠す（hint.css の body.hinting）。

const DONE_KEY = 'otosu.intro.v1';
/** 2 段目を出しておく秒数 */
const NEXT_SEC = 9;

const touch = () => matchMedia('(hover: none)').matches;

const TEXT = {
  draw: () =>
    touch()
      ? 'drag a finger to draw a line — falling balls ring it'
      : 'drag anywhere to draw a line — falling balls ring it',
  next: () =>
    touch()
      ? 'bigger is lower · ○ △ □ up top change the sound · long-press a shape for effects'
      : 'bigger is lower · ○ △ □ up top (or <kbd>1</kbd>–<kbd>5</kbd>) change the sound',
};

/** この端末で案内を最後まで見たか。localStorage が使えないときは見たことにする（毎回出さない） */
function done(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) !== null;
  } catch {
    return true;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    // 保存できない環境では、このページの間だけ
  }
}

export class Intro {
  /** 案内を出すか（初めての端末か）。始める前に決める */
  readonly active: boolean;
  private readonly el: HTMLElement;
  private step: 'idle' | 'draw' | 'next' | 'done' = 'idle';
  private timer = 0;
  /** 案内が終わったとき（いつもの一覧を出す） */
  onDone: (() => void) | null = null;

  /** returning: 前から使っている端末（配置が保存されている）。案内を出さない */
  constructor(parent: HTMLElement, returning: boolean) {
    this.active = !returning && !done();
    if (returning) markDone();
    this.el = document.createElement('div');
    this.el.id = 'intro';
    this.el.className = 'ui';
    this.el.setAttribute('role', 'status');
    parent.appendChild(this.el);
  }

  /** 音を始めたとき。案内を出さない端末では、すぐに onDone を呼ぶ */
  start(): void {
    if (!this.active) {
      this.onDone?.();
      return;
    }
    this.show('draw', TEXT.draw());
  }

  /** 人が図形を描いたとき */
  drew(): void {
    if (this.step !== 'draw') return;
    markDone();
    this.show('next', TEXT.next());
    this.timer = window.setTimeout(() => this.finish(), NEXT_SEC * 1000);
  }

  private show(step: 'draw' | 'next', html: string): void {
    this.step = step;
    this.el.innerHTML = html;
    this.el.dataset.step = step;
    this.el.classList.add('show');
  }

  private finish(): void {
    clearTimeout(this.timer);
    this.step = 'done';
    this.el.classList.remove('show');
    this.onDone?.();
  }
}
