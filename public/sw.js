// Claudio Service Worker — network-first strategy
// Bump CACHE_VERSION whenever the precache list changes.
const CACHE_VERSION = 'claudio-v2';

const PRECACHE_URLS = [
  '/',
  '/library',
  '/stack',
  '/base.css',
  '/style.css',
  '/library.css',
  '/stack.css',
  '/app.js',
  '/audio-state.js',
  '/view-player.js',
  '/view-library.js',
  '/view-stack.js',
  '/manifest.json',
  '/icons/icon.svg',
];

// ── Install: precache the app shell ──────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // Skip waiting so the new SW activates immediately.
  self.skipWaiting();
});

// ── Activate: purge stale caches ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Claim all open clients so the new SW controls them without a reload.
  self.clients.claim();
});

// ── Fetch: routing logic ──────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Only handle same-origin requests (pass through cross-origin as-is).
  if (url.origin !== self.location.origin) return;

  // 2. Never intercept WebSocket upgrades.
  if (request.headers.get('upgrade') === 'websocket') return;

  // 3. API calls — network only, never cache.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // 4. Audio and TTS streams — network only (huge, dynamic, range-requested).
  if (url.pathname.startsWith('/audio/') || url.pathname.startsWith('/tts/')) {
    event.respondWith(fetch(request));
    return;
  }

  // 5. HTML navigations — network first, fall back to cached '/' shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Update cache on success.
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          // Offline: serve the cached shell so the SPA can still mount.
          caches.match('/').then((cached) => cached || Response.error())
        )
    );
    return;
  }

  // 6. Everything else (CSS, JS, icons, manifest) — stale-while-revalidate.
  if (request.method === 'GET') {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
          // Return cached immediately; revalidate in background.
          return cached || networkFetch;
        })
      )
    );
  }
});

// ── WebPush ──────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Claudio';
  const opts = {
    body:  data.body  || 'A new pick is on air.',
    icon:  data.icon  || '/icons/icon.svg',
    badge: data.badge || '/icons/icon.svg',
    tag:   data.tag   || 'claudio-now-playing',
    data:  data.data  || {}
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing Claudio tab if any
    for (const client of allClients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        client.navigate(target).catch(() => {});
        return client.focus();
      }
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow(target);
    }
  })());
});
