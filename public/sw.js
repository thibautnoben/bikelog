// Bikelog service worker: makes the app installable and shows an offline page.
// Pages hold personal data and must be fresh, so HTML is never cached; only static assets are.
const CACHE = 'bikelog-v2';
const OFFLINE_URL = '/offline.html';
const PRECACHE = ['/icons/icon.svg', '/icons/icon-192.png'];

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(PRECACHE);
  // Cloudflare may redirect /offline.html to /offline, and browsers refuse to serve a redirected
  // response for a navigation, so store a fresh, non-redirected copy.
  const offline = await fetch(OFFLINE_URL);
  await cache.put(
    OFFLINE_URL,
    new Response(await offline.blob(), { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Astro's hashed build assets never change, so serve them cache-first.
  if (url.pathname.startsWith('/_astro/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
