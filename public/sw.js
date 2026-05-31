// Searvator PWA Service Worker
const CACHE_VERSION = 'searvator-v1';
const STATIC_CACHE = [
    '/css/main.css',
    '/css/mobile.css',
    '/js/common.js',
    '/manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_CACHE))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
});

// Network-first for HTML/API, cache-first for static assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Don't cache POST/PUT/DELETE
    if (event.request.method !== 'GET') return;
    
    // API calls: network only
    if (url.pathname.startsWith('/api/')) return;
    
    // Static assets: cache first
    if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.json')) {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
                const clone = res.clone();
                caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
                return res;
            }))
        );
        return;
    }
    
    // HTML pages: network first, fallback to cache
    event.respondWith(
        fetch(event.request).then((res) => {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
            return res;
        }).catch(() => caches.match(event.request))
    );
});
