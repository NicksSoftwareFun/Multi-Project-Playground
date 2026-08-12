// Generates the PWA icon set. Pure Node - no image libraries, no binary assets
// checked in that we can't regenerate.   Run:  node tools/make-icons.mjs
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

/* ------------------------------ PNG encoder ----------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------- drawing ------------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const CYAN = [0.18, 0.90, 1.0];
const VIOLET = [0.49, 0.36, 1.0];
const GOLD = [1.0, 0.82, 0.40];

/** Swept-wing hull, nose toward -y. */
const HULL = [
  [0, -0.52], [0.085, -0.14], [0.44, 0.24], [0.44, 0.36], [0.15, 0.20],
  [0.10, 0.42], [-0.10, 0.42], [-0.15, 0.20], [-0.44, 0.36], [-0.44, 0.24],
  [-0.085, -0.14],
];

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Colour of the icon at normalised coords u,v in [-1,1]. Returns [r,g,b,a]. */
function shade(u, v, scale) {
  const x = u / scale, y = v / scale;
  const r = Math.hypot(x, y);

  // Deep space base with a cool centre.
  let col = mix([0.008, 0.012, 0.032], [0.02, 0.06, 0.13], clamp01(1 - r * 0.9));

  // Perspective tunnel rings.
  for (let k = 1; k <= 7; k++) {
    const rk = 0.115 * Math.pow(k, 1.28);
    if (rk > 1.5) break;
    const w = 0.020 + k * 0.006;
    const g = Math.exp(-Math.pow((r - rk) / w, 2));
    const c = mix(CYAN, VIOLET, (k - 1) / 6);
    const amp = 0.9 * (1 - (k - 1) / 8);
    col = [col[0] + c[0] * g * amp, col[1] + c[1] * g * amp, col[2] + c[2] * g * amp];
  }

  // Core glow.
  const core = Math.exp(-Math.pow(r / 0.13, 2));
  col = [col[0] + core * 0.55, col[1] + core * 0.80, col[2] + core * 0.95];

  // Engine bloom behind the hull.
  const eng = Math.exp(-(Math.pow(x / 0.13, 2) + Math.pow((y - 0.40) / 0.16, 2)));
  col = [col[0] + eng * 0.55, col[1] + eng * 0.85, col[2] + eng * 1.0];

  // The ship itself.
  if (inPoly(x, y, HULL)) {
    const t = clamp01((y + 0.52) / 0.94);
    const body = mix([1, 1, 1], mix(CYAN, GOLD, 0.18), t);
    col = mix(col, body, 0.95);
  }

  // Halo so the hull lifts off the rings.
  const halo = Math.exp(-Math.pow((Math.hypot(x * 0.85, (y + 0.06) * 1.1) - 0.30) / 0.20, 2));
  col = [col[0] + CYAN[0] * halo * 0.20, col[1] + CYAN[1] * halo * 0.24, col[2] + CYAN[2] * halo * 0.28];

  // Outer falloff.
  const vig = clamp01(1.12 - r * 0.55);
  col = [col[0] * vig, col[1] * vig, col[2] * vig];

  return [clamp01(col[0]), clamp01(col[1]), clamp01(col[2]), 1];
}

function render(size, { scale = 1, radius = 0, fade = 0 } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (px + (sx + 0.5) / SS) / size * 2 - 1;
          const fy = (py + (sy + 0.5) / SS) / size * 2 - 1;
          const c = shade(fx, fy, scale);
          let alpha = c[3];
          if (fade > 0) {
            // Adaptive-icon foregrounds sit on their own layer, so let the art
            // dissolve into the background colour instead of ending in a hard
            // square edge the launcher would then mask.
            alpha *= clamp01(1 - (Math.hypot(fx, fy) - fade) / (1 - fade));
          }
          if (radius > 0) {
            // Rounded-square mask for the non-maskable icons.
            const q = Math.max(Math.abs(fx) - (1 - radius), 0);
            const w = Math.max(Math.abs(fy) - (1 - radius), 0);
            const d = Math.hypot(q, w) - radius;
            alpha *= clamp01(0.5 - d * size * 0.5);
          }
          r += c[0] * alpha; g += c[1] * alpha; b += c[2] * alpha; a += alpha;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(clamp01(r / n) * 255);
      buf[i + 1] = Math.round(clamp01(g / n) * 255);
      buf[i + 2] = Math.round(clamp01(b / n) * 255);
      buf[i + 3] = Math.round(clamp01(a / n) * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const jobs = [
  ['icon-192.png', 192, { radius: 0.22 }],
  ['icon-512.png', 512, { radius: 0.22 }],
  ['icon-512-maskable.png', 512, { scale: 0.62 }],
  ['apple-touch-icon.png', 180, {}],
  ['favicon-64.png', 64, { radius: 0.22 }],
];

for (const [name, size, opt] of jobs) {
  writeFileSync(join(OUT, name), render(size, opt));
  console.log('wrote', name, size + 'px');
}

// Android launcher icons. Legacy PNGs for API 23-25, plus an adaptive-icon
// foreground layer (108dp canvas, 72dp safe zone) for API 26+.
const RES = join(OUT, '..', 'android', 'res');
const DENSITIES = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];

for (const [density, px] of DENSITIES) {
  const dir = join(RES, `mipmap-${density}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ic_launcher.png'), render(px, { radius: 0.22 }));
  writeFileSync(join(dir, 'ic_launcher_fg.png'), render(Math.round(px * 2.25), { scale: 0.60, fade: 0.58 }));
  console.log('wrote', `mipmap-${density}/ic_launcher.png`, px + 'px');
}
