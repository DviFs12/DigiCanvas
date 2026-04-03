/**
 * service-worker.js
 * ─────────────────
 * PWA Service Worker para DigiCanvas.
 * Cache dos assets estáticos para funcionamento offline
 * (o celular pode abrir a interface mesmo sem internet após o primeiro acesso).
 * A sinalização WebRTC ainda precisa de internet para conectar.
 */

const CACHE_NAME = 'digicanvas-v1';

// Assets para cache offline
const STATIC_ASSETS = [
  './celular.html',
  './css/shared.css',
  './css/mobile.css',
  './js/firebase-config.js',
  './js/signaling.js',
  './js/webrtc.js',
  './js/mobile.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install: faz cache dos assets estáticos ─────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Falha no cache de alguns assets:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: limpa caches antigos ─────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first para assets estáticos, network-first para o resto ───
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Não intercepta requisições ao Firebase ou CDNs externos
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('cdnjs')
  ) {
    return;
  }

  // Cache-first para assets locais
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Salva no cache se for um asset válido
          if (
            response.ok &&
            response.type === 'basic' &&
            event.request.method === 'GET'
          ) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback: retorna celular.html para navegação
          if (event.request.destination === 'document') {
            return caches.match('./celular.html');
          }
        });
    })
  );
});
