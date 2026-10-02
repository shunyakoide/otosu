// オフライン用の Service Worker を登録する（D74）。sw.js はビルドのときだけ作るので、開発時は登録しない

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // 始めの読み込み（three・tone）と取り合わないよう、読み終わってから
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[otosu] service worker', err));
  });
}
