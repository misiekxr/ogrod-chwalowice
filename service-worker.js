const CACHE_VERSION = "ogrod-pwa-v1";

const CORE_FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "plant_db.json",
  "plan-plansza2.png",
  "plan-plansza3.png",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "vendor/idb.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(CORE_FILES);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
      self.clients.claim();
    })()
  );
});

// Cache-first dla wlasnej powloki appki. Zewnetrzne zadania (pogoda Open-Meteo,
// analiza Gemini) sa innego originu — przechodza normalnie przez siec, service
// worker ich nie dotyka (nigdy nie maja byc cache'owane/nieaktualne).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      try {
        const fresh = await fetch(event.request);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(event.request, fresh.clone());
        return fresh;
      } catch (err) {
        return cached || Response.error();
      }
    })()
  );
});
