// 小さな道具（日時の書式・ファイルの保存・全画面）。

/** 2 桁にそろえる（例 7 → 07） */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** ファイル名用の日時（例 20260927-1430） */
export function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
}
