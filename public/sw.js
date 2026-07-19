// Minimal service worker — caches nothing (offline mode is out of scope for MVP).
// Presence of this file satisfies PWA installability requirements.
self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim())
})

self.addEventListener('fetch', (event) => {
  // Pass through all requests — no caching strategy for MVP
  event.respondWith(fetch(event.request))
})
