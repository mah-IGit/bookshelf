// Caches the app shell so Bookshelf opens offline.
// Book files are NOT cached here; they live in IndexedDB (see js/storage.js).

const CACHE = 'bookshelf-shell-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/github.js',
  './js/storage.js',
  './js/reader.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => { /* a missing shell file shouldn't block install */ })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never touch GitHub API traffic: it's authenticated and must stay fresh.
  if (url.hostname === 'api.github.com') return;
  if (e.request.method !== 'GET') return;

  // Shell: cache first, revalidate in the background.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const live = fetch(e.request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || live;
      })
    );
    return;
  }

  // CDN libraries: cache first, they're version-pinned so they never change.
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      }))
    );
  }
});
