import './panel.css';

// 設定パネルと小窓（D24）。細い線のスライダー・文字だけのボタン・並べた選択肢で、画面に溶け込ませる。
// 値はオブジェクトを直接書き換え、refresh() で表示を合わせる（外から値を変えたとき用）。

type Obj = Record<string, unknown>;

export type SliderOpts = {
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  /** つまみを動かしている間 */
  onInput?: (v: number) => void;
  /** 離したとき */
  onChange?: (v: number) => void;
  /** false のあいだ薄くする（drip がオフのときの drip speed など） */
  enabled?: () => boolean;
};

export type Choice<V> = { value: V; label?: string };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length;

export class Section {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  private readonly refreshers: (() => void)[];

  constructor(parent: HTMLElement, title: string, open: boolean, refreshers: (() => void)[]) {
    this.refreshers = refreshers;
    this.root = el('section', 'pn-section');
    const head = el('button', 'pn-head', title);
    head.type = 'button';
    this.body = el('div', 'pn-body');
    // 見出しのない区切り（パネルの一番下など）は畳めない
    if (title) this.root.append(head, this.body);
    else this.root.append(this.body);
    this.root.classList.toggle('closed', !open);
    head.addEventListener('click', () => this.root.classList.toggle('closed'));
    parent.appendChild(this.root);
  }

  private row(label: string): HTMLElement {
    const r = el('div', 'pn-row');
    r.appendChild(el('span', 'pn-label', label));
    this.body.appendChild(r);
    return r;
  }

  slider<T extends Obj>(obj: T, key: keyof T & string, o: SliderOpts): void {
    const r = this.row(o.label);
    const input = el('input', 'pn-range');
    input.type = 'range';
    input.min = String(o.min);
    input.max = String(o.max);
    input.step = String(o.step);
    const out = el('span', 'pn-value');
    const fmt = o.format ?? ((v: number) => v.toFixed(decimals(o.step)));
    const show = () => {
      const v = obj[key] as number;
      input.value = String(v);
      input.style.setProperty('--p', `${((v - o.min) / (o.max - o.min)) * 100}%`);
      out.textContent = fmt(v);
      if (o.enabled) r.classList.toggle('off', !o.enabled());
    };
    input.addEventListener('input', () => {
      (obj as Obj)[key] = Number(input.value);
      // ほかの行（motion の move など）がこの値で変わることがあるので、全部合わせる
      for (const fn of this.refreshers) fn();
      o.onInput?.(obj[key] as number);
    });
    input.addEventListener('change', () => o.onChange?.(obj[key] as number));
    r.append(input, out);
    show();
    this.refreshers.push(show);
  }

  toggle<T extends Obj>(obj: T, key: keyof T & string, label: string, onChange?: (v: boolean) => void): void {
    const r = this.row(label);
    const b = el('button', 'pn-switch');
    b.type = 'button';
    const show = () => b.classList.toggle('on', Boolean(obj[key]));
    b.addEventListener('click', () => {
      (obj as Obj)[key] = !obj[key];
      // これに付くつまみ（enabled）の表示も合わせる
      for (const fn of this.refreshers) fn();
      onChange?.(obj[key] as boolean);
    });
    r.appendChild(b);
    show();
    this.refreshers.push(show);
  }

  /** 並べた選択肢。options は呼ぶたびに読み直す（あとから選択肢が増える場合用） */
  choice<T extends Obj, V>(
    obj: T, key: keyof T & string, label: string, options: () => readonly Choice<V>[], onChange?: (v: V) => void,
  ): void {
    const r = this.row(label);
    const box = el('div', 'pn-choices');
    r.appendChild(box);
    let shown = '';
    const show = () => {
      const opts = options();
      const sig = opts.map((c) => String(c.value)).join('|');
      if (sig !== shown) {
        shown = sig;
        box.replaceChildren(
          ...opts.map((c) => {
            const b = el('button', 'pn-choice', c.label ?? String(c.value));
            b.type = 'button';
            b.addEventListener('click', () => {
              (obj as Obj)[key] = c.value;
              for (const fn of this.refreshers) fn();
              onChange?.(c.value);
            });
            return b;
          }),
        );
      }
      opts.forEach((c, i) => box.children[i]!.classList.toggle('on', c.value === obj[key]));
    };
    show();
    this.refreshers.push(show);
  }

  /** プルダウン（MIDI の出力先のように、選択肢が長い・変わるもの） */
  select<T extends Obj>(
    obj: T, key: keyof T & string, label: string, options: () => readonly Choice<string>[], onChange?: (v: string) => void,
  ): void {
    const r = this.row(label);
    const s = el('select', 'pn-select');
    s.addEventListener('change', () => {
      (obj as Obj)[key] = s.value;
      onChange?.(s.value);
    });
    const show = () => {
      const opts = options();
      s.replaceChildren(...opts.map((c) => {
        const o = el('option', undefined, c.label ?? c.value);
        o.value = c.value;
        return o;
      }));
      s.value = String(obj[key]);
    };
    r.appendChild(s);
    show();
    this.refreshers.push(show);
  }

  /** 文字だけのボタンを横に並べる */
  actions(items: readonly { label: string; title?: string; onClick: () => void }[]): HTMLButtonElement[] {
    const box = el('div', 'pn-actions');
    const buttons = items.map((it) => {
      const b = el('button', 'pn-action', it.label);
      b.type = 'button';
      if (it.title) b.title = it.title;
      b.addEventListener('click', () => it.onClick());
      box.appendChild(b);
      return b;
    });
    this.body.appendChild(box);
    return buttons;
  }

  /** 文字だけの行（キー操作の一覧など） */
  info(label: string, text: string): void {
    this.row(label).appendChild(el('span', 'pn-info', text));
  }

  /** 直前の行の下に出す小さな説明。選んでいる値で変えるときは関数で渡す */
  hint(text: string | (() => string)): void {
    const h = el('div', 'pn-hint');
    this.body.appendChild(h);
    this.onRefresh(() => { h.textContent = typeof text === 'string' ? text : text(); });
  }

  /** 表示を合わせる処理を足す（自前の要素用） */
  onRefresh(fn: () => void): void {
    this.refreshers.push(fn);
    fn();
  }
}

/** ツールバーのボタンの真下に開く小窓。外を押すと閉じる */
export class Popover {
  readonly el: HTMLElement;
  onClose: (() => void) | null = null;
  protected readonly body: HTMLElement;
  protected readonly refreshers: (() => void)[] = [];

  constructor(parent: HTMLElement) {
    this.el = el('aside', 'pn pop ui');
    this.body = el('div', 'pn-scroll');
    this.el.appendChild(this.body);
    this.el.addEventListener('click', (e) => {
      if (e.target instanceof HTMLButtonElement) e.target.blur();
    });
    parent.appendChild(this.el);
    addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      const t = e.target as Node;
      if (this.el.contains(t) || (t instanceof Element && t.closest('#toolbar'))) return;
      this.close();
    });
  }

  /** 区切り。title は畳まない小見出し */
  section(title = ''): Section {
    const s = new Section(this.body, '', true, this.refreshers);
    if (title) s.root.prepend(el('div', 'pn-sub', title));
    return s;
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  open(anchor: HTMLElement): void {
    placeUnder(this.el, anchor);
    this.el.classList.add('open');
    this.refresh();
  }

  /** 値を外から変えたとき（読み込み・リセット）に表示を合わせる */
  refresh(): void {
    for (const fn of this.refreshers) fn();
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    this.onClose?.();
  }
}

/**
 * 設定（D24 → D52）。ほかの小窓と同じくボタンの下に開き、外を押すと閉じる。
 * 中身が多いので、区切りは見出しを押して畳める
 */
export class Panel extends Popover {
  override section(title = '', open = true): Section {
    return new Section(this.body, title, open, this.refreshers);
  }
}

/** anchor の真下・中央に置く（画面からはみ出さないように） */
export function placeUnder(pop: HTMLElement, anchor: HTMLElement, width = 280): void {
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, r.left + r.width / 2 - width / 2))}px`;
}
