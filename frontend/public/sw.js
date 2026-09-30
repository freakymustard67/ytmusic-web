/**
 * Service worker.
 *
 * Deliberately conservative: audio must never be cached by the SW, because the
 * server already caches tracks and a double cache doubles memory pressure on a
 * 512 MB instance. We only cache the app shell so the UI opens instantly and
 * works offline as a shell.
 */

const SHELL = 'shell-v1';
const SHELL_ASSETS = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Never touch API or audio: those must always hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  // Network-first for navigations so updates land immediately.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
    return;
  }

  // Cache-first for static shell assets.
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(event.request, copy));
      }
      return res;
    })),
  );
});
