// Bump this on any real change to app shell files. Also — see the fetch
// strategy below — this is now the SECOND line of defense, not the first:
// local app files use network-first, so a stale cache alone can't hide a
// real update anymore. Bumping still matters for the offline fallback case.
const CACHE_NAME = 'guardian-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/relay.js',
  './js/riskModel.js',
  './js/auth.js',
  './js/presenceCheck.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // CDN model weights: network-first, falling back to cache — versioned
  // by the CDN URL itself, so this was already correct.
  if (event.request.url.includes('cdn.jsdelivr.net') || event.request.url.includes('huggingface.co')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell (local files): NETWORK-FIRST now, not cache-first. This is
  // the actual fix for the stale-UI bug — previously, once a file was
  // cached, replacing it on disk had NO EFFECT until the cache was
  // manually cleared or the version bumped. Now the browser always tries
  // the real file first, and only falls back to the cached copy if the
  // network is genuinely unavailable (true offline use).
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
