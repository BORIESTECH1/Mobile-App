const CACHE = 'bt-cache-v1';
const ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/auth.js'
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== CACHE).map(k => caches.delete(k))
        ))
    );
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request).then(resp => resp || fetch(e.request).then(r => {
            // cache fetched basic assets
            if (e.request.url.startsWith(self.location.origin)) {
                caches.open(CACHE).then(cache => cache.put(e.request, r.clone()));
            }
            return r.clone();
        }).catch(() => caches.match('/index.html')))
    );
});