/*
 * Velz DJ service worker (hand-rolled, Phase 9).
 *
 * Strategy: runtime cache-first for same-origin GETs. The first online
 * visit populates the cache with the app shell, hashed JS/CSS chunks and
 * the AudioWorklet files as they're fetched; after that the app loads
 * fully offline — install it as a PWA and it behaves like a local app.
 * Audio files and the Traktor collection live in IndexedDB / on disk,
 * never in this cache.
 *
 * Bump CACHE_VERSION when the caching strategy itself changes. Hashed
 * asset names make stale-chunk issues self-limiting; old caches are
 * dropped on activate.
 */
const CACHE_VERSION = 'velzdj-v1';

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
