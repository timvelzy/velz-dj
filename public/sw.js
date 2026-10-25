/*
 * Velz DJ service worker (hand-rolled, Phase 9).
 *
 * Strategy: runtime cache-first for same-origin GETs, EXCEPT navigation
 * requests, which are network-first with a cache fallback. The first
 * online visit populates the cache with the app shell, hashed JS/CSS
 * chunks and the AudioWorklet files as they're fetched; after that the
 * app loads fully offline — install it as a PWA and it behaves like a
 * local app. Audio files and the Traktor collection live in IndexedDB /
 * on disk, never in this cache.
 *
 * Round-4 fix: the old cache-first-everything strategy never served a
 * new build. sw.js itself only changes when this file changes, so the
 * browser never reinstalled the worker, and the cached old index.html
 * kept referencing the cached old hashed chunks forever — deployed
 * detector fixes never reached an existing install. Navigation requests
 * are therefore network-first (falling back to cache offline), and
 * CACHE_VERSION is bumped so existing clients drop the old cache on
 * the next worker update.
 */
const CACHE_VERSION = 'velzdj-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Navigation requests are network-first: the app shell (index.html)
  // is what points at the current hashed chunks, so serving a cached
  // shell after a deploy would pin the install to the old build
  // forever. Offline, fall back to the cached shell.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(event.request);
          if (res.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(event.request, res.clone());
          }
          return res;
        } catch {
          const cache = await caches.open(CACHE_VERSION);
          const hit = await cache.match(event.request, { ignoreSearch: true });
          if (hit) return hit;
          throw new Error('offline and no cached app shell');
        }
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    })(),
  );
});
