import './hint.css';

// 操作しているときだけ、画面の下に出す案内（D53）。
// 始めにしばらく出す一覧では気づきにくい操作（右クリック・長押し・Shift）を、使える場面でだけ見せる。
// - マウス: 図形に乗ったとき「right-click」、描いているとき「shift」
// - タッチ: 図形を押さえているとき、下の線を満たしていき、満ちたらメニューが開く

/** 案内を出す場面 */
export type HintKind = 'shape' | 'drag' | 'bumper' | 'hold';

const TEXT: Record<HintKind, string> = {
  shape: '<kbd>right-click</kbd> effects / delete',
  drag: 'hold <kbd>shift</kbd> for a bumper',
  bumper: '<kbd>bumper</kbd>',
  hold: 'keep holding · effects / delete',
};

export class PointerHint {
  private readonly el: HTMLElement;
  private readonly label: HTMLElement;
  private readonly bar: HTMLElement;
  private kind: HintKind | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'pointer-hint';
    this.el.className = 'ui';
    this.label = document.createElement('div');
    this.bar = document.createElement('div');
    this.bar.className = 'ph-bar';
    this.el.append(this.label, this.bar);
    parent.appendChild(this.el);
  }

  /** kind の案内を出す。hold のときは ms かけて線を満たす */
  show(kind: HintKind, ms = 0): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.label.innerHTML = TEXT[kind];
    this.el.dataset.kind = kind;
    if (kind === 'hold') {
      // アニメーションを最初からやり直す
      this.bar.style.animation = 'none';
      void this.bar.offsetWidth;
      this.bar.style.animation = '';
      this.bar.style.animationDuration = `${ms}ms`;
    }
    this.el.classList.add('show');
    // 始めに出す操作の一覧と重ならないように、そちらを隠す
    document.body.classList.add('hinting');
  }

  hide(): void {
    if (!this.kind) return;
    this.kind = null;
    this.el.classList.remove('show');
    document.body.classList.remove('hinting');
  }
}
