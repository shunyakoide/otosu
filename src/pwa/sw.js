// オフラインでも開けるようにする Service Worker（D74）。
// ビルドのとき vite.config.ts の pwa() が版の名前と取っておくファイルの一覧を埋めて dist/sw.js に書き出す。開発時は登録しない

const CACHE = 'otosu-__VERSION__';
const PRECACHE = __PRECACHE__;
// ページを開くときはネットを先に見る（新しい版を出したらすぐ届くように）。会場の弱い回線で待たされないよう、この時間で手元の版に切り替える
const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  // HTTP のキャッシュを通さずに取る。古いファイルが混ざると、HTML とスクリプトの版がずれる
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('otosu-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(navigate(req));
    return;
  }
  // ファイル名にハッシュが付いているので、手元にあればそれを使う。ないものはネットから（保存はしない）。
  // Vary は見ない: Vary: Origin が付いていると、取っておいたとき（Origin なし）とスクリプトの読み込み（Origin あり）で合わなくなる
  e.respondWith(caches.match(req, { cacheName: CACHE, ignoreVary: true }).then((hit) => hit ?? fetch(req)));
});

/** ページ（?fps などの付いた URL も）は 1 枚の index.html。ネットが遅いか繋がらないときは手元の版を返す */
async function navigate(req) {
  const cached = () => caches.match('/', { cacheName: CACHE, ignoreVary: true });
  const net = fetch(req);
  const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS));
  try {
    const res = await Promise.race([net, timeout]);
    if (res) return res;
    return (await cached()) ?? (await net);
  } catch {
    return (await cached()) ?? Response.error();
  }
}
