// ╔══════════════════════════════════════════════════════╗
// ║          LUNA AI — Service Worker v1.0               ║
// ║  Caches app shell for offline-first experience       ║
// ╚══════════════════════════════════════════════════════╝

const CACHE_NAME = 'luna-ai-v1';

// App shell files to cache on install
const PRECACHE_URLS = [
  './',
  './index.html',
  './script.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// External fonts & Firebase — cache on first fetch (runtime cache)
const RUNTIME_CACHE_PATTERNS = [
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /cdnjs\.cloudflare\.com/,
];

// ── Install: pre-cache app shell ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        // Non-fatal: some files may 404 in dev
        console.warn('[SW] Pre-cache partial failure:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache, fall back to network ────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin API calls (Firebase, Anthropic API)
  if (request.method !== 'GET') return;
  if (url.hostname.includes('firebaseio.com')) return;
  if (url.hostname.includes('anthropic.com')) return;
  if (url.hostname.includes('googleapis.com') && url.pathname.includes('/v1')) return;

  // Runtime cache for fonts & CDN assets
  const isRuntimeCacheable = RUNTIME_CACHE_PATTERNS.some(p => p.test(request.url));

  if (isRuntimeCacheable) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // App shell: cache-first with network fallback
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Cache successful same-origin responses
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ── Push Notifications (future) ──────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Luna AI';
  const options = {
    body: data.body || 'You have a new message.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-72.png',
    tag: 'luna-notification',
    renotify: true,
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(event.notification.data.url || './');
    })
  );
});