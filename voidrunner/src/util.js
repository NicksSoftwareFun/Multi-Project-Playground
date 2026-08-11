// Small maths helpers + a seeded PRNG. No dependencies.

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

/** Frame-rate independent exponential approach. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Shortest signed angular difference a -> b, in (-PI, PI]. */
export function angDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export const angDist = (a, b) => Math.abs(angDelta(a, b));

/** Distance from point p to segment ab, all 2D. */
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t, cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

/** mulberry32 - tiny, fast, decent quality seeded PRNG. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd.range = (lo, hi) => lo + (hi - lo) * rnd();
  rnd.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * rnd());
  rnd.pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  rnd.sign = () => (rnd() < 0.5 ? -1 : 1);
  rnd.chance = (p) => rnd() < p;
  /** Weighted pick over [{w, ...}] entries. */
  rnd.weighted = (entries) => {
    let total = 0;
    for (const e of entries) total += e.w;
    let r = rnd() * total;
    for (const e of entries) {
      r -= e.w;
      if (r <= 0) return e;
    }
    return entries[entries.length - 1];
  };
  return rnd;
}

export function fmtInt(n) {
  return Math.floor(n).toLocaleString('en-US');
}

export function fmtDist(m) {
  return m >= 10000 ? (m / 1000).toFixed(2) + 'km' : Math.floor(m) + 'm';
}
