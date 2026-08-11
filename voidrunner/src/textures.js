// Every texture in the game is drawn at runtime on a <canvas>.
// No image files means nothing to download, nothing to cache-bust, and the
// whole game stays under a megabyte of source.

import * as THREE from '../vendor/three.module.js';
import { makeRng, TAU } from './util.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function finish(c, { repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 1;
  t.needsUpdate = true;
  return t;
}

let _glow, _star, _spark, _nebula, _flare;

/** Soft round glow, used for halos, explosions and engine flame. */
export function glowTexture() {
  if (_glow) return _glow;
  const s = 128, c = canvas(s, s), g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.14, 'rgba(255,255,255,0.92)');
  grd.addColorStop(0.34, 'rgba(255,255,255,0.38)');
  grd.addColorStop(0.62, 'rgba(255,255,255,0.09)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  _glow = finish(c);
  return _glow;
}

/** Tiny hard point with a faint cross flare - starfield. */
export function starTexture() {
  if (_star) return _star;
  const s = 64, c = canvas(s, s), g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,255,255,0.28)';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(4, s / 2); g.lineTo(s - 4, s / 2);
  g.moveTo(s / 2, 4); g.lineTo(s / 2, s - 4);
  g.stroke();
  _star = finish(c);
  return _star;
}

/** Elongated spark for debris trails. */
export function sparkTexture() {
  if (_spark) return _spark;
  const w = 32, h = 128, c = canvas(w, h), g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.95)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(w * 0.32, 0, w * 0.36, h);
  g.filter = 'blur(4px)';
  g.fillStyle = grd;
  g.fillRect(w * 0.2, 0, w * 0.6, h);
  _spark = finish(c);
  return _spark;
}

/** Ring flare used behind gates so they read at distance. */
export function flareTexture() {
  if (_flare) return _flare;
  const s = 128, c = canvas(s, s), g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  _flare = finish(c);
  return _flare;
}

/** Monochrome cloud backdrop. Tinted per-zone by the material colour. */
export function nebulaTexture() {
  if (_nebula) return _nebula;
  const w = 1024, h = 512, c = canvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  const rng = makeRng(0x5eed17);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 46; i++) {
    const x = rng() * w, y = rng.range(0.1, 0.9) * h;
    const r = rng.range(60, 240);
    const a = rng.range(0.04, 0.16);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // A scatter of far stars baked into the backdrop.
  for (let i = 0; i < 900; i++) {
    const x = rng() * w, y = rng() * h;
    const a = rng.range(0.15, 0.85);
    const s = rng.range(0.6, 1.7);
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.beginPath();
    g.arc(x, y, s, 0, TAU);
    g.fill();
  }
  _nebula = finish(c, { repeat: true });
  return _nebula;
}
