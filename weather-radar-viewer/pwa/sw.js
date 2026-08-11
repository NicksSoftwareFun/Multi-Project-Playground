/* SKYWATCH service worker: cache the app shell so the installed app launches
   instantly (and offline shows the UI with feed-error states). Weather data,
   radar tiles, and satellite imagery are always fetched from the network —
   stale radar is worse than no radar. */
const VERSION = "skywatch-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png"
];
const CDN = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      // CDN entries are cached opaque (no-cors); fine for script/style tags
      return Promise.all([
        c.addAll(SHELL),
        Promise.all(CDN.map(function (u) {
          return fetch(u, { mode: "no-cors" })
            .then(function (r) { return c.put(u, r); })
            .catch(function () { /* cached on a later fetch instead */ });
        }))
      ]);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  const url = new URL(e.request.url);
  const isShell = url.origin === self.location.origin;
  const isCdn = url.hostname === "unpkg.com";
  if (!isShell && !isCdn) return;   // live data: straight to the network

  if (isCdn) {
    // cache-first: the pinned Leaflet version never changes
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (r) {
          const copy = r.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
          return r;
        });
      })
    );
    return;
  }

  // shell: network-first so updates land, cache fallback for offline launch
  e.respondWith(
    fetch(e.request).then(function (r) {
      const copy = r.clone();
      caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
      return r;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    })
  );
});
