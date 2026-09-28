import type { ShapeEffect } from '../sim/types';

// 図形のメニュー（D32）。図形を長押し（マウスは右クリック）すると、押した場所のそばに開く。
// エフェクトを選ぶと付き、付いているものをもう一度選ぶと外れる。いちばん下で図形を消す。
// 外を押すと閉じる。

export type ShapeMenuChoice = Exclude<ShapeEffect, 'none'> | 'delete';

const ITEMS: readonly { value: ShapeMenuChoice; label: string; hint: string }[] = [
  { value: 'echo', label: 'echo', hint: 'repeats on the beat' },
  { value: 'rise', label: 'rise', hint: 'repeats going up' },
  { value: 'chord', label: 'chord', hint: 'adds harmony' },
  { value: 'delete', label: 'delete', hint: '' },
];

/** 押した指に隠れないよう、押した場所からこれだけ離して開く（CSS px） */
const OFFSET = 14;

export class ShapeMenu {
  /** 選んだとき。current は開いたときに付いていたエフェクト */
  onChoose: ((group: number, choice: ShapeMenuChoice, current: ShapeEffect) => void) | null = null;
  /** 開いた・閉じたとき（group は閉じたとき -1）。main が図形を明滅させる（D54） */
  onTarget: ((group: number) => void) | null = null;
  private readonly el: HTMLElement;
  private readonly buttons = new Map<ShapeMenuChoice, HTMLButtonElement>();
  private group = -1;
  private current: ShapeEffect = 'none';

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'pn shape-menu ui';
    this.el.setAttribute('role', 'menu');
    for (const it of ITEMS) {
      const b = document.createElement('button');
      b.className = `sm-item${it.value === 'delete' ? ' sm-delete' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span class="sm-label">${it.label}</span><span class="sm-hint">${it.hint}</span>`;
      b.addEventListener('click', () => {
        const g = this.group;
        this.close();
        this.onChoose?.(g, it.value, this.current);
      });
      this.buttons.set(it.value, b);
      this.el.appendChild(b);
    }
    parent.appendChild(this.el);
    addEventListener('pointerdown', (e) => {
      if (this.isOpen && !this.el.contains(e.target as Node)) this.close();
    }, true);
    addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  /** x, y（画面の座標）のそばに開く。effect = その図形に今付いているエフェクト */
  open(group: number, effect: ShapeEffect, x: number, y: number): void {
    this.group = group;
    this.current = effect;
    for (const [v, b] of this.buttons) b.classList.toggle('on', v === effect);
    this.el.classList.add('open');
    this.onTarget?.(group);
    // 右上に開き、はみ出すなら反対側へ
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    let left = x + OFFSET;
    if (left + w > innerWidth - 8) left = x - OFFSET - w;
    // ツールバーの帯に重ねない（重なると押したつもりのボタンがツールバー側に取られる）
    const band = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--band')) || 52) + 8;
    let top = y - OFFSET - h;
    if (top < band) top = y + OFFSET;
    this.el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, left))}px`;
    this.el.style.top = `${Math.max(band, Math.min(innerHeight - h - 8, top))}px`;
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    this.group = -1;
    this.onTarget?.(-1);
  }
}
