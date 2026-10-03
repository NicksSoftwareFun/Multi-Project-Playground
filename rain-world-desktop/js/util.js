// Shared math, colour and drawing helpers. Everything hangs off window.RW so the
// project runs from file:// (and inside Lively Wallpaper) without a bundler or
// ES modules.
(function () {
  'use strict';
  const RW = (window.RW = window.RW || {});
  const U = (RW.U = {});

  U.TAU = Math.PI * 2;
  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.smooth = (t) => t * t * (3 - 2 * t);
  U.dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  U.dist2 = (ax, ay, bx, by) => (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  U.angleDiff = (a, b) => {
    let d = (b - a) % U.TAU;
    if (d > Math.PI) d -= U.TAU;
    if (d < -Math.PI) d += U.TAU;
    return d;
  };
  U.lerpAngle = (a, b, t) => a + U.angleDiff(a, b) * t;
  // Frame-rate independent exponential approach: fraction to move this step.
  U.approach = (rate, dt) => 1 - Math.exp(-rate * dt);

  // ---- randomness -------------------------------------------------------
  U.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  U.rand = (a = 0, b = 1) => a + Math.random() * (b - a);
  U.randInt = (a, b) => Math.floor(U.rand(a, b + 1));
  U.chance = (p) => Math.random() < p;
  U.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  U.sign = () => (Math.random() < 0.5 ? -1 : 1);
  // entries: [[value, weight], ...]
  U.weighted = function (entries, rnd = Math.random) {
    let total = 0;
    for (const e of entries) total += Math.max(0, e[1]);
    if (total <= 0) return null;
    let r = rnd() * total;
    for (const e of entries) {
      r -= Math.max(0, e[1]);
      if (r <= 0) return e[0];
    }
    return entries[entries.length - 1][0];
  };

  // Smooth 1D value noise, deterministic for a given seed.
  U.noise1 = function (x, seed = 0) {
    const i = Math.floor(x);
    const f = x - i;
    const h = (n) => {
      const s = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
      return s - Math.floor(s);
    };
    return U.lerp(h(i), h(i + 1), U.smooth(f)) * 2 - 1;
  };

  // ---- colour -----------------------------------------------------------
  U.hex = function (hex) {
    if (Array.isArray(hex)) return hex;
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  U.mix = (a, b, t) => {
    a = U.hex(a);
    b = U.hex(b);
    return [U.lerp(a[0], b[0], t), U.lerp(a[1], b[1], t), U.lerp(a[2], b[2], t)];
  };
  U.rgba = (c, alpha = 1) => {
    c = U.hex(c);
    return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
  };
  U.scale = (c, k) => {
    c = U.hex(c);
    return [U.clamp(c[0] * k, 0, 255), U.clamp(c[1] * k, 0, 255), U.clamp(c[2] * k, 0, 255)];
  };

  // ---- geometry ---------------------------------------------------------
  // Two-bone IK. Returns knee and (possibly clamped) end point. `bend` picks
  // which side the knee falls on (+1 / -1).
  U.ik2 = function (ax, ay, bx, by, l1, l2, bend) {
    let dx = bx - ax;
    let dy = by - ay;
    let d = Math.hypot(dx, dy);
    const ux = d > 1e-6 ? dx / d : 1;
    const uy = d > 1e-6 ? dy / d : 0;
    const maxD = l1 + l2 - 0.01;
    const minD = Math.abs(l1 - l2) + 0.01;
    if (d > maxD) d = maxD;
    if (d < minD) d = minD;
    const ex = ax + ux * d;
    const ey = ay + uy * d;
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    return {
      kx: ax + ux * a - uy * h * bend,
      ky: ay + uy * a + ux * h * bend,
      ex,
      ey,
    };
  };

  // Pick the IK bend so the knee points along (nx, ny) — i.e. away from the
  // surface a foot is gripping.
  U.ikToward = function (ax, ay, bx, by, l1, l2, nx, ny) {
    const s1 = U.ik2(ax, ay, bx, by, l1, l2, 1);
    const s2 = U.ik2(ax, ay, bx, by, l1, l2, -1);
    const d1 = (s1.kx - ax) * nx + (s1.ky - ay) * ny;
    const d2 = (s2.kx - ax) * nx + (s2.ky - ay) * ny;
    return d1 >= d2 ? s1 : s2;
  };

  // Build a smooth filled outline around a polyline with per-point half widths.
  U.taperPath = function (ctx, pts, widths) {
    const n = pts.length;
    if (n < 2) return;
    const L = new Array(n);
    const R = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const w = widths[i];
      L[i] = [pts[i].x - ty * w, pts[i].y + tx * w];
      R[i] = [pts[i].x + ty * w, pts[i].y - tx * w];
    }
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (L[i][0] + L[i + 1][0]) / 2;
      const my = (L[i][1] + L[i + 1][1]) / 2;
      ctx.quadraticCurveTo(L[i][0], L[i][1], mx, my);
    }
    ctx.lineTo(L[n - 1][0], L[n - 1][1]);
    ctx.lineTo(R[n - 1][0], R[n - 1][1]);
    for (let i = n - 2; i > 0; i--) {
      const mx = (R[i][0] + R[i - 1][0]) / 2;
      const my = (R[i][1] + R[i - 1][1]) / 2;
      ctx.quadraticCurveTo(R[i][0], R[i][1], mx, my);
    }
    ctx.lineTo(R[0][0], R[0][1]);
    ctx.closePath();
  };

  U.strokeLimb = function (ctx, pts, width, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.stroke();
  };

  U.deepMerge = function (target, src) {
    if (!src || typeof src !== 'object') return target;
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
        U.deepMerge(target[k], v);
      } else {
        target[k] = v;
      }
    }
    return target;
  };
  U.clone = (o) => JSON.parse(JSON.stringify(o));
})();
