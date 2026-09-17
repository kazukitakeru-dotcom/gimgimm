// ファイルを足したり中身を変えたら必ずこの版数を上げること。
// 上げないと古いキャッシュが配られて変更が反映されない。
const CACHE_NAME = 'ironlog-v21';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './obsidian.js',
  './aitext.js',
  './sync.js',
  './style.css',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    // cache: 'reload' … ブラウザ側の一時保存を通さず必ず取り直す。
    // 通すと新しい版のキャッシュに古いファイルが入り、更新したのに古い画面のままになる
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // 同期(Supabase)への通信や POST はキャッシュを通さず素通しする
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
