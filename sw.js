const CACHE_NAME = 'num10-game-v8';

// All assets needed for a fully offline run are precached on install,
// including the OCR engine files (worker script, wasm core, language
// data). These are now ~9MB total after removing dead-weight files
// (standalone .wasm binaries that were never fetched separately -- the
// wasm binary is embedded as base64 inside the .wasm.js loader) and
// unused Legacy-engine variants (this app only uses LSTM mode).
//
// cache.add() is used individually (not cache.addAll()) so that a
// single failing asset does not abort the entire install -- addAll()
// fails atomically on any single 404/network error, which previously
// caused silent total offline-cache failure whenever this list drifted
// out of sync with the actual vendor/ directory contents.
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './js/grid-detect.js',
  './js/ocr.js',
  './js/solver.js',
  './js/branch-solver.js',
  './js/renderer.js',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './vendor/tesseract-core-lstm.wasm.js',
  './vendor/tesseract-core-simd-lstm.wasm.js',
  './vendor/eng.traineddata.gz',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] failed to precache', url, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Do NOT intercept range/partial requests (used by wasm streaming
  // compilation and large-file fetches) -- some WebKit versions hang
  // indefinitely if a Service Worker answers a Range request with a
  // full 200 response instead of passing it straight to the network.
  if (event.request.headers.has('range')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful same-origin ("basic") responses AND readable
        // cross-origin CORS responses (e.g. the jsDelivr GitHub-mirror
        // fallback used when GitHub Pages itself is slow/unreliable on
        // some mobile carrier networks). Opaque no-cors responses are
        // intentionally excluded since their body can't be verified and
        // caching them provides little value here.
        if (response && response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
