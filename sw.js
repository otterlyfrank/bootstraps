/* Bootstraps service worker — shell cache for installability + offline reopen */
const CACHE = 'bootstraps-shell-v13';

const PRECACHE = [
  './',
  './index.html',
  './src/styles.css',
  './src/main.js',
  './src/app.js',
  './src/config.js',
  './src/pwa.js',
  './src/storage/db.js',
  './src/ai/client.js',
  './src/ai/prompts.js',
  './src/jobs/sources.js',
  './src/jobs/match.js',
  './src/jobs/learning.js',
  './src/jobs/hints.js',
  './src/jobs/discovery.js',
  './src/jobs/links.js',
  './src/lib/export.js',
  './src/lib/pdf-resume.js',
  './src/lib/resume-format.js',
  './src/lib/cover-letter.js',
  './src/lib/diff.js',
  './src/lib/sample.js',
  './src/lib/job-filters.js',
  './src/lib/hunt-presets.js',
  './src/lib/onboarding-wizard.js',
  './src/lib/extract-document.js',
  './src/lib/a11y.js',
  './src/ui/dom.js',
  './src/ui/score-ui.js',
  './src/ui/job-cards.js',
  './src/ui/climb-timeline.js',
  './src/ui/command-palette.js',
  './src/ui/print-pack.js',
  './src/ui/discover-progress.js',
  './src/ui/session-mode.js',
  './src/resume/ingest.js',
  './public/bootstraps-logo.jpg',
  './public/bootstraps-mark.png',
  './public/bootstraps-mark.svg',
  './public/icon-192.png',
  './public/icon-512.png',
  './public/apple-touch-icon.png',
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
    const fresh = await fetch(req, { cache: 'no-store' });
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
    throw new Error('Offline and not cached: ' + req.url);
  }
}
