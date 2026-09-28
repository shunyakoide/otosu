import { pad2 } from '../util';
import { Popover } from './panel';
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
  /** 開くときに、保存した配置の一覧（読み直したもの）と、選ばれている名前・名前欄の名前を返す */
  reload: () => { library: Library; current: string; name: string };
};

const shortDate = (t: number): string => {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** 文字だけのボタン。押した後のフォーカスは Popover が外す（残ると Space で押し直してしまう） */
const button = (cls: string, text: string, title: string, onClick?: () => void) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.title = title;
  if (onClick) b.addEventListener('click', onClick);
  return b;
};

/** 外を押すと閉じる（ツールバーの保存ボタン自体は開閉に任せる）のは Popover と同じ */
export class ScenesPopover extends Popover {
  private readonly on: ScenesActions;
  private readonly nameInput: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private noteTimer = 0;
  private library: Library = {};
  private current = '';

  constructor(parent: HTMLElement, on: ScenesActions) {
    super(parent);
    this.on = on;
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
    row.append(this.nameInput, button('pn-action strong', 'save', 'save this scene', () => on.save(this.nameInput.value)));

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
      button('pn-action', 'new', 'clear all shapes (C)', () => { on.clear(); this.close(); }),
      button('pn-action', 'export', 'download as a file', on.exportFile),
      button('pn-action', 'import', 'open a file', () => { on.importFile(); this.close(); }),
      button('pn-action', 'copy link', 'copy a URL of this scene (S)', on.copyLink),
    );
    this.note = document.createElement('div');
    this.note.className = 'pn-note';

    this.body.append(row, this.list, actions);
    this.el.appendChild(this.note);
  }

  /** anchor（保存ボタン）の真下に開く。開くたびに一覧を読み直す */
  override open(anchor: HTMLElement): void {
    const { library, current, name } = this.on.reload();
    this.update(library, current, name);
    super.open(anchor);
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
      item.className = `pn-item${name === this.current ? ' on' : ''}`;
      item.dataset.name = name;
      const when = document.createElement('time');
      when.textContent = shortDate(this.library[name]!.savedAt);
            // 押したときの処理は一覧（this.list）でまとめて受ける
      item.append(button('pn-load', name, `load "${name}"`), when, button('pn-del', '×', 'delete'));
      return item;
    }));
  }
}
