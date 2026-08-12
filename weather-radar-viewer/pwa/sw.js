/* SKYWATCH service worker: cache the app shell so the installed app launches
   instantly (and offline shows the UI with feed-error states). Weather data,
   radar tiles, and satellite imagery are always fetched from the network —
   stale radar is worse than no radar. */
const VERSION = "skywatch-v7";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
  "./css/tokens.css",
  "./css/base.css",
  "./css/chrome.css",
  "./css/views.css",
  "./css/boards.css",
  "./css/charts.css",
  "./js/config.js",
  "./js/util.js",
  "./js/state.js",
  "./js/net.js",
  "./js/store.js",
  "./js/map.js",
  "./js/timeline.js",
  "./js/sat.js",
  "./js/wx.js",
  "./js/locations.js",
  "./js/layers.js",
  "./js/boards.js",
  "./js/alerts.js",
  "./js/spc.js",
  "./js/charts.js",
  "./js/forecastx.js",
  "./js/airq.js",
  "./js/main.js",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/images/layers.png",
  "./vendor/leaflet/images/layers-2x.png",
  "./vendor/leaflet/images/marker-icon.png",
  "./vendor/leaflet/images/marker-icon-2x.png",
  "./vendor/leaflet/images/marker-shadow.png",
  "./vendor/suncalc.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
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
  if (url.origin !== self.location.origin) return;   // live data: straight to the network

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
