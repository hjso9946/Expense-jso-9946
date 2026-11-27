/* 记账本 PWA Service Worker（只缓存本机资源；跨域请求一律放行不缓存） */
const CACHE = 'expense-v5';
const ASSETS = [
  './',
  'index.html',
  'app.js',
  'parse.js',
  'rules-seed.js',
  'rules.json',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-96.png',
  'apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // 不碰外域

  // 页面/脚本：网络优先（保证更新能生效），断网才用缓存
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
