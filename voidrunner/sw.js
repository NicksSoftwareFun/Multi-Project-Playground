// Offline cache. Everything the game needs is precached on install, so after
// one visit VOIDRUNNER runs with the radio off.

const VERSION = 'voidrunner-v1';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'vendor/three.module.js',
  'vendor/three.core.min.js',
  'src/main.js',
  'src/game.js',
  'src/world.js',
  'src/ship.js',
  'src/ships.js',
  'src/hazards.js',
  'src/spawner.js',
  'src/pickups.js',
  'src/geom.js',
  'src/path.js',
  'src/zones.js',
  'src/textures.js',
  'src/fx.js',
  'src/audio.js',
  'src/input.js',
  'src/hud.js',
  'src/save.js',
  'src/util.js',
  'src/config.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    }),
  );
});
