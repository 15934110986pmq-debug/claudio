const CACHE = 'claudio-v1';
const STATIC = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(STATIC))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    // TTS 音频和网易云音频不缓存，直接走网络
    if (e.request.url.includes('/tts/') || e.request.url.includes('music.126.net')) {
        return;
    }
    // API 请求走网络优先
    if (e.request.url.includes('/api/')) {
        e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
        return;
    }
    // 静态资源缓存优先
    e.respondWith(
        caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
});
