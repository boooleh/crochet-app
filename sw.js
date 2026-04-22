const CACHE = 'crochet-app-v1-4-9';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './styles.css',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// JS files and version.txt are NOT pre-cached — always fetched fresh from network
const NETWORK_FIRST = [
  'app.js',
  'supabase-config.js',
  'supabase-sync.js',
  'version.txt'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Always network-first for JS files and HTML — never serve stale code
  const isScript = NETWORK_FIRST.some(f => url.includes(f));
  if (isScript || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          // Update cache with fresh copy
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for everything else (images, icons, CSS)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
