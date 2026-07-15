const CACHE_NAME = 'num10-game-v2';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './js/grid-detect.js',
  './js/ocr.js',
  './js/solver.js',
  './js/renderer.js',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './vendor/tesseract-core.wasm.js',
  './vendor/tesseract-core.wasm',
  './vendor/tesseract-core-simd.wasm.js',
  './vendor/tesseract-core-simd.wasm',
  './vendor/tesseract-core-lstm.wasm.js',
  './vendor/tesseract-core-lstm.wasm',
  './vendor/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract-core-simd-lstm.wasm',
  './vendor/eng.traineddata.gz',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
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
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
