/**
 * RoadOptimiser v3 — Service Worker
 * Cache de la coquille applicative + CDN pour un usage hors-ligne.
 */

const VERSION = 'roadoptimizur-v5-8';
const CORE = [
  './',
  './index.html',
  './zxing.umd.js',
  './manifest.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
    './icons/logo-512.png',
    './icons/favicon.svg',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './app.js',
  './auth.js',
  './driver-server.js',
  './storage.js',
  './routing.js',
  './optimize.js',
  './driver.js',
  './pod.js',
  './analytics.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then(async (cache) => {
      await Promise.all(CORE.map((url) => cache.add(url).catch(() => null)));
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })
  );
});

const isCdn = (url) => /cdn\.tailwindcss\.com|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net|tile\.openstreetmap\.org/.test(url.hostname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;
  // Ne jamais mettre en cache les géocodages / itinéraires dynamiques.
  if (/nominatim|project-osrm|valhalla|openstreetmap\.org\/search|openstreetmap\.org\/reverse/.test(url.href)) return;

  // Navigation : réseau d'abord, coquille en secours hors-ligne.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(async () => (await caches.match('./index.html')) || (await caches.match('./')) || Response.error())
    );
    return;
  }

  if (isCdn(url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && (res.ok || res.type === 'opaque')) {
              const copy = res.clone();
              caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Ressources locales : réseau d'abord (ne sert jamais un module obsolète ou corrompu),
  // secours cache uniquement hors-ligne.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || Response.error())
  );
});
