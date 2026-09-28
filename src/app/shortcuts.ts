import { TOOLS, type Tool } from '../input/input';

// キー操作（D24）。この表から、キーを押したときの処理と、settings の Keys の一覧の両方を作る。
// ツールバーのボタンの説明と始めの案内は、それぞれの文言のまま（toolbar.ts）。

export type ShortcutActions = {
  tool: (t: Tool) => void;
  pause: () => void;
  mute: () => void;
  clear: () => void;
  copyLink: () => void;
  record: () => void;
  fullscreen: () => void;
  settings: () => void;
  closePopovers: () => void;
};

export type Shortcut = {
  /** 受け付けるキー（KeyboardEvent.key を小文字にしたもの）。ないものは一覧に出すだけ */
  keys?: readonly string[];
  /** Keys の一覧に出す名前と説明。label がないものは一覧に出さない */
  label?: string;
  what?: string;
  run?: (a: ShortcutActions, e: KeyboardEvent) => void;
};

export const SHORTCUTS: readonly Shortcut[] = [
  { label: 'drag', what: 'draw' },
  { label: 'shift + drag', what: 'bumper' },
  { label: 'right-click', what: 'shape effects / delete' },
  {
    keys: TOOLS.map((_, i) => String(i + 1)), label: `1 – ${TOOLS.length}`, what: 'tools',
    run: (a, e) => a.tool(TOOLS[Number(e.key) - 1]!),
  },
  {
    keys: [' '], label: 'space', what: 'pause',
    run: (a, e) => {
      e.preventDefault();
      a.pause();
    },
  },
  { keys: ['m'], label: 'M', what: 'mute', run: (a) => a.mute() },
  { keys: ['c'], label: 'C', what: 'clear all shapes', run: (a) => a.clear() },
  { keys: ['s'], label: 'S', what: 'copy scene link', run: (a) => a.copyLink() },
  { keys: ['r'], label: 'R', what: 'record .mid', run: (a) => a.record() },
  { keys: ['f'], label: 'F', what: 'fullscreen', run: (a) => a.fullscreen() },
  { keys: ['h'], label: 'H', what: 'hide ui', run: () => document.body.classList.toggle('ui-hidden') },
  { keys: [','], label: ',', what: 'this panel', run: (a) => a.settings() },
  { keys: ['escape'], run: (a) => a.closePopovers() },
];

/** 文字を打っている欄（そこではキー操作を受けない） */
function isTyping(t: EventTarget | null): boolean {
  if (t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return true;
  return t instanceof HTMLInputElement && !['range', 'checkbox', 'button'].includes(t.type);
}

export function bindShortcuts(a: ShortcutActions): void {
  const byKey = new Map<string, Shortcut>();
  for (const s of SHORTCUTS) for (const k of s.keys ?? []) byKey.set(k, s);
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return;
    byKey.get(e.key.toLowerCase())?.run?.(a, e);
  });
}
