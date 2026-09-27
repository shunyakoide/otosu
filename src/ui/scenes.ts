import './panel.css';
import { placeUnder } from './panel';
import { libraryNames, type Library } from './storage';

// 配置の保存・読み込み（D24）。ツールバーの保存ボタンの下に小さく開き、外を押すか選ぶと閉じる。

export type ScenesActions = {
  save: (name: string) => void;
  load: (name: string) => void;
  remove: (name: string) => void;
  clear: () => void;
  exportFile: () => void;
  importFile: () => void;
  copyLink: () => void;
};

const shortDate = (t: number): string => {
  if (!t) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const button = (cls: string, text: string, onClick: () => void, title?: string) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
};

export class ScenesPopover {
  readonly el: HTMLElement;
  /** 閉じたとき（ツールバーの表示を戻す用） */
  onClose: (() => void) | null = null;
  private readonly nameInput: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private noteTimer = 0;
  private library: Library = {};
  private current = '';

  constructor(parent: HTMLElement, on: ScenesActions) {
    this.el = document.createElement('aside');
    this.el.className = 'pn pop ui';

    const row = document.createElement('div');
    row.className = 'pn-row';
    this.nameInput = document.createElement('input');
    this.nameInput.className = 'pn-input';
    this.nameInput.placeholder = 'name this scene';
    this.nameInput.spellcheck = false;
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') on.save(this.nameInput.value);
      if (e.key === 'Escape') this.close();
    });
    row.append(this.nameInput, button('pn-action strong', 'save', () => on.save(this.nameInput.value)));

    this.list = document.createElement('div');
    this.list.className = 'pn-list';
    this.list.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const name = t.closest<HTMLElement>('.pn-item')?.dataset.name;
      if (name === undefined) return;
      if (t.classList.contains('pn-del')) on.remove(name);
      else if (t.classList.contains('pn-load')) {
        on.load(name);
        this.close();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'pn-actions';
    actions.append(
      button('pn-action', 'new', () => { on.clear(); this.close(); }, 'clear all shapes (C)'),
      button('pn-action', 'export', on.exportFile, 'download as a file'),
      button('pn-action', 'import', () => { on.importFile(); this.close(); }, 'open a file'),
      button('pn-action', 'copy link', on.copyLink, 'copy a URL of this scene (S)'),
    );
    this.note = document.createElement('div');
    this.note.className = 'pn-note';

    const body = document.createElement('div');
    body.className = 'pn-scroll';
    body.append(row, this.list, actions);
    this.el.append(body, this.note);
    parent.appendChild(this.el);

    // 外を押したら閉じる（ツールバーの保存ボタン自体は開閉に任せる）
    addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      const t = e.target as Node;
      if (this.el.contains(t) || (t instanceof Element && t.closest('#toolbar'))) return;
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  /** anchor（保存ボタン）の真下に開く */
  open(anchor: HTMLElement): void {
    placeUnder(this.el, anchor);
    this.el.classList.add('open');
    this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    this.onClose?.();
  }

  /** 一覧と名前欄を合わせる */
  update(library: Library, current: string, name: string): void {
    this.library = library;
    this.current = current;
    if (document.activeElement !== this.nameInput) this.nameInput.value = name;
    this.render();
  }

  flash(text: string): void {
    this.note.textContent = text;
    this.note.classList.add('show');
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => this.note.classList.remove('show'), 1800);
  }

  private render(): void {
    const names = libraryNames(this.library);
    if (!names.length) {
      const empty = document.createElement('div');
      empty.className = 'pn-empty';
      empty.textContent = 'no saved scenes yet';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...names.map((name) => {
      const item = document.createElement('div');
      item.className = 'pn-item' + (name === this.current ? ' on' : '');
      item.dataset.name = name;
      const when = document.createElement('time');
      when.textContent = shortDate(this.library[name]!.savedAt);
      item.append(button('pn-load', name, () => {}, `load "${name}"`), when, button('pn-del', '×', () => {}, 'delete'));
      return item;
    }));
  }
}
