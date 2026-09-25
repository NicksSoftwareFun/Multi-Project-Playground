#!/usr/bin/env python3
"""PWA shell: dot-matrix icons, web manifest, and an offline service worker whose
precache list is every file the app needs (versioned by content hash)."""
import os, json, hashlib
from PIL import Image, ImageDraw
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')
G = {'M': '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', 'I': '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
     'H': '#...#|#...#|#...#|#####|#...#|#...#|#...#'}


def icon(size, pad):
    ss = 4
    S = size * ss
    im = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(im)
    cols = 17
    pitch = (S - 2 * pad * S) / cols
    x0 = pad * S
    y0 = (S - 7 * pitch) / 2
    # faint LED grid across the tile, lit dots for MIH
    for gy in range(-3, 10):
        for gx in range(cols):
            cx, cy = x0 + (gx + .5) * pitch, y0 + (gy + .5) * pitch
            if 0 < cy < S:
                r = 0.14 * pitch
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=46)
    for ci, ch in enumerate('MIH'):
        rows = G[ch].split('|')
        for r in range(7):
            for c in range(5):
                if rows[r][c] == '#':
                    cx, cy = x0 + (ci * 6 + c + .5) * pitch, y0 + (r + .5) * pitch
                    rr = 0.42 * pitch
                    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=238)
    return im.resize((size, size), Image.LANCZOS).convert('RGB')


os.makedirs(os.path.join(WEB, 'icons'), exist_ok=True)
icon(192, .12).save(os.path.join(WEB, 'icons', 'icon-192.png'))
icon(512, .12).save(os.path.join(WEB, 'icons', 'icon-512.png'))
icon(512, .2).save(os.path.join(WEB, 'icons', 'icon-maskable-512.png'))
icon(180, .14).save(os.path.join(WEB, 'icons', 'apple-touch-icon.png'))
manifest = {
    'name': 'MIH Tower Explorer', 'short_name': 'MIH Tower', 'start_url': './', 'scope': './',
    'display': 'fullscreen', 'orientation': 'any', 'background_color': '#000000', 'theme_color': '#000000',
    'description': 'Exploded floor stack of the MIH Tower: pick a floor, then a room.',
    'icons': [{'src': 'icons/icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
              {'src': 'icons/icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
              {'src': 'icons/icon-maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'}],
}
json.dump(manifest, open(os.path.join(WEB, 'manifest.webmanifest'), 'w'), indent=2)
files, h = [], hashlib.sha256()
for dp, _, fs in os.walk(WEB):
    for f in sorted(fs):
        rel = os.path.relpath(os.path.join(dp, f), WEB).replace(os.sep, '/')
        if rel in ('sw.js',) or rel.endswith('.txt'):
            continue
        files.append(rel)
        h.update(rel.encode()); h.update(open(os.path.join(dp, f), 'rb').read())
files.sort()
ver = h.hexdigest()[:12]
sw = f"""// MIH Tower Explorer service worker: everything is precached so the app runs offline at the booth.
const VERSION = 'mih-{ver}';
const FILES = {json.dumps(['./'] + files)};
self.addEventListener('install', (e) => {{
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
}});
self.addEventListener('activate', (e) => {{
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
}});
self.addEventListener('fetch', (e) => {{
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, {{ ignoreSearch: true }}).then((hit) => hit ||
    fetch(e.request).then((res) => {{
      if (res.ok) {{ const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }}
      return res;
    }}).catch(() => (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
}});
"""
open(os.path.join(WEB, 'sw.js'), 'w').write(sw)
print('precache', len(files) + 1, 'files, version', ver)
