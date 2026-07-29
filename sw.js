/* Bootstraps service worker — shell cache for installability + offline reopen */
const CACHE = 'bootstraps-shell-v1';

const PRECACHE = [
  './',
  './index.html',
  './src/styles.css',
  './src/main.js',
  './src/app.js',
  './src/config.js',
  './src/storage/db.js',
  './src/ai/client.js',
  './src/ai/prompts.js',
  './src/jobs/sources.js',
  './src/jobs/match.js',
  './src/jobs/learning.js',
  './src/jobs/hints.js',
  './src/lib/export.js',
  './src/lib/diff.js',
  './src/lib/sample.js',
  './public/bootstraps-logo.jpg',
  './public/icon-192.png',
  './public/icon-512.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch((err) => {
        // Partial precache is fine — fetch handler still works
        console.warn('[Bootstraps SW] precache partial', err);
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Network-first for navigations and JS (fresh app while developing).
 * Cache fallback so installed app still opens offline.
 * Never cache cross-origin (Remotive, LLM APIs, Google Fonts).
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw new Error('Offline and not cached');
  }
}
