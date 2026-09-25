/* MIH Tower Explorer
 * Exploded stack -> floor -> room, rendered in WebGL2 with the booth loop's look:
 * white linework on black, an LED dot-matrix halftone and a soft glow.
 * Plan geometry is in canonical sheet points (Level 2 sheet, y down); 4.5 pt = 1 ft.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ constants
  const DATA = 'data/';
  const D2R = Math.PI / 180;
  const PT_PER_FT = 4.5;
  const GAP = 215;                              // stack spacing, pt
  const LEVELS = [1, 2, 3, 4];
  const CODE = { 1: '01', 2: '02', 3: '03', 4: 'PH' };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const S_MAX = 11;                             // max zoom, CSS px per pt
  const IDLE_MS = 120000;                       // booth mode: back to the stack after 2 min
  const TYPE_LABEL = {
    patient: 'PATIENT ROOM', icu: 'INTENSIVE CARE', nicu: 'NEWBORN INTENSIVE CARE', csection: 'C-SECTION / DELIVERY',
    ldr: 'LABOR · DELIVERY · RECOVERY', trauma: 'TRAUMA', aii: 'ISOLATION', triage: 'TRIAGE', edwait: 'ED WAITING',
    decon: 'DECONTAMINATION', xray: 'IMAGING', recovery: 'RECOVERY', exam: 'EXAM / TREATMENT', toilet: 'TOILET / SHOWER',
    soiled: 'SOILED HOLDING', meds: 'MEDICATION', clean: 'CLEAN SUPPLY', evs: 'ENVIRONMENTAL SERVICES',
    nourish: 'NOURISHMENT', mep: 'MEP / BUILDING SYSTEMS', vertical: 'VERTICAL CIRCULATION', corridor: 'CIRCULATION',
    general: 'SUPPORT / GENERAL',
  };

  const $ = (id) => document.getElementById(id);
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, u) => a + (b - a) * u;
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  // ------------------------------------------------------------------ 5x7 dot-matrix type
  const G = {
    A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
    C: '.###.|#...#|#....|#....|#....|#...#|.###.', D: '###..|#..#.|#...#|#...#|#...#|#..#.|###..',
    E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
    G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
    I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.', J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
    K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
    M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
    O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
    Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
    S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
    U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
    W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
    Y: '#...#|#...#|#...#|.#.#.|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
    0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
    2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '#####|...#.|..#..|...#.|....#|#...#|.###.',
    4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
    6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
    8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
    ' ': '.....|.....|.....|.....|.....|.....|.....', '.': '.....|.....|.....|.....|.....|.##..|.##..',
    '-': '.....|.....|.....|#####|.....|.....|.....', '/': '.....|....#|...#.|..#..|.#...|#....|.....',
    '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.', '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  };
  const SCR = 'ABCDEFGHJKLMNPRSTUVXYZ0123456789#+/';
  function dmSVG(text, pitch = 10, offLevel = 0.13) {
    const chars = [...String(text).toUpperCase()];
    const cols = chars.length * 6 - 1;
    const w = cols * pitch, h = 7 * pitch;
    let lit = '', off = '';
    chars.forEach((ch, ci) => {
      const g = (G[ch] || G[' ']).split('|');
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
        const x = ((ci * 6 + c) + 0.5) * pitch, y = (r + 0.5) * pitch;
        if (g[r][c] === '#') lit += `<circle cx="${x}" cy="${y}" r="${0.42 * pitch}"/>`;
        else if (offLevel > 0) off += `<circle cx="${x}" cy="${y}" r="${0.16 * pitch}"/>`;
      }
    });
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="#ececec"><g opacity="${offLevel}">${off}</g><g>${lit}</g></svg>`;
  }
  // scrambled type-on for the big titles
  const scrambles = new WeakMap();
  function setDM(el, text, pitch, offLevel) {
    const prev = scrambles.get(el);
    if (prev && prev.text === text) return;
    if (REDUCED) { el.innerHTML = dmSVG(text, pitch, offLevel); scrambles.set(el, { text }); return; }
    const t0 = performance.now(), n = text.length;
    const job = { text };
    scrambles.set(el, job);
    const tick = () => {
      if (scrambles.get(el) !== job) return;
      const u = (performance.now() - t0) / 1000;
      let s = '';
      for (let i = 0; i < n; i++) {
        const t = i * 0.028;
        if (u < t) s += ' ';
        else if (u < t + 0.12 && text[i] !== ' ') s += SCR[(Math.random() * SCR.length) | 0];
        else s += text[i];
      }
      el.innerHTML = dmSVG(s, pitch, offLevel);
      if (u < n * 0.028 + 0.14) requestAnimationFrame(tick);
    };
    tick();
  }

  // ------------------------------------------------------------------ app state
  const S = {
    view: 'stack', level: null, room: null, hoverLevel: null, hoverRoom: null,
    cam: { px: 973, py: 620, z: 0, s: 0.5, yaw: -30, pitch: 55, fov: 32 },
    lv: {}, fx: { dim: 1, sel: 0, duct: 1, riser: 1, tiles: 0, grid: 1, edge: 1 },
    tween: null, orbitBase: -30, pitchBase: 55, orbitT: 0,
    lastInput: performance.now(), intro: 0, ready: false,
    W: 1, H: 1, dpr: 1,
  };
  LEVELS.forEach((n) => (S.lv[n] = { z: 0, a: 0, slab: 0, led: 0, ctx: 0, edge: 0 }));
  let DATAJ = null, IMG = null, ROOMS = [], BYTAG = new Map(), BYLEVEL = {}, FOOT = {}, RECT = {}, UNION = null;
  const CW = 1946, CH = 1240, CX = 973, CY = 620;

  // ------------------------------------------------------------------ camera
  function camera(p, W, H) {
    const th = p.pitch * D2R, ps = p.yaw * D2R, c = Math.cos(ps), s = Math.sin(ps);
    const rot = (v) => [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
    const r = rot([1, 0, 0]), d = rot([0, -Math.cos(th), -Math.sin(th)]), f = rot([0, Math.sin(th), -Math.cos(th)]);
    const F = (W / 2) / Math.tan((p.fov * D2R) / 2);
    const dist = F / p.s;
    const T = [p.px - CX, -(p.py - CY), p.z];
    const pos = [T[0] - f[0] * dist, T[1] - f[1] * dist, T[2] - f[2] * dist];
    return { r, d, f, F, dist, pos, W, H, p };
  }
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function project(cam, x, y, z) {
    const q = [x - CX - cam.pos[0], -(y - CY) - cam.pos[1], z - cam.pos[2]];
    const zc = dot3(cam.f, q);
    return [cam.F * dot3(cam.r, q) / zc + cam.W / 2, cam.F * dot3(cam.d, q) / zc + cam.H / 2, zc];
  }
  function viewProj(cam) {
    const { r, d, f, F, W, H, pos, dist } = cam;
    const n = dist * 0.02, fa = dist * 40, A = (fa + n) / (fa - n), B = (-2 * fa * n) / (fa - n);
    const sx = F / (W / 2), sy = F / (H / 2);
    const row0 = [sx * r[0], sx * r[1], sx * r[2], -sx * dot3(r, pos)];
    const row1 = [-sy * d[0], -sy * d[1], -sy * d[2], sy * dot3(d, pos)];
    const row2 = [A * f[0], A * f[1], A * f[2], -A * dot3(f, pos) + B];
    const row3 = [f[0], f[1], f[2], -dot3(f, pos)];
    const m = new Float32Array(16);
    for (let col = 0; col < 4; col++) { m[col * 4] = row0[col]; m[col * 4 + 1] = row1[col]; m[col * 4 + 2] = row2[col]; m[col * 4 + 3] = row3[col]; }
    return m;
  }
  function rayPlane(cam, sx, sy, z) {
    const a = (sx - cam.W / 2) / cam.F, b = (sy - cam.H / 2) / cam.F;
    const dir = [cam.r[0] * a + cam.d[0] * b + cam.f[0], cam.r[1] * a + cam.d[1] * b + cam.f[1], cam.r[2] * a + cam.d[2] * b + cam.f[2]];
    if (Math.abs(dir[2]) < 1e-6) return null;
    const t = (z - cam.pos[2]) / dir[2];
    if (t <= 0) return null;
    return [cam.pos[0] + dir[0] * t + CX, CY - (cam.pos[1] + dir[1] * t)];
  }

  // ------------------------------------------------------------------ geometry helpers
  function inRings(rings, x, y) {
    let inside = false;
    for (const R of rings) {
      for (let i = 0, j = R.length - 2; i < R.length; j = i, i += 2) {
        const xi = R[i], yi = R[i + 1], xj = R[j], yj = R[j + 1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }
  function ringsBBox(rings) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const R of rings) for (let i = 0; i < R.length; i += 2) {
      x0 = Math.min(x0, R[i]); x1 = Math.max(x1, R[i]); y0 = Math.min(y0, R[i + 1]); y1 = Math.max(y1, R[i + 1]);
    }
    return [x0, y0, x1, y1];
  }
  const levelZ = (n) => S.lv[n].z;
  function viewport() {
    const W = S.W, H = S.H, narrow = W < 760;
    const panel = S.view === 'room' || (S.tween && S.tween.toView === 'room');
    let x0 = narrow ? 16 : 48, x1 = W - (narrow ? 16 : 48), y0 = narrow ? 118 : 150, y1 = H - (narrow ? 118 : 90);
    if (panel) {
      if (narrow) { y1 = H * 0.42 - 8; y0 = narrow ? 104 : y0; }
      else x1 = W - 384 - 36;
    }
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.max(40, x1 - x0), h: Math.max(40, y1 - y0) };
  }

  // ------------------------------------------------------------------ view targets
  function fitStack(yaw, pitch) {
    const vp = viewport(), narrow = S.W < 760;
    const labelW = narrow ? 64 : 372;
    const av = { x0: vp.x0, x1: S.W - labelW - (narrow ? 12 : 48), y0: narrow ? 120 : 130, y1: S.H - (narrow ? 130 : 70) };
    av.cx = (av.x0 + av.x1) / 2; av.cy = (av.y0 + av.y1) / 2;
    const p = { px: (UNION[0] + UNION[2]) / 2, py: (UNION[1] + UNION[3]) / 2, z: 0, s: 0.5, yaw, pitch, fov: 32 };
    const corners = [];
    LEVELS.forEach((n, i) => {
      const [x0, y0, x1, y1] = RECT[n], z = (i - 1.5) * GAP;
      corners.push([x0, y0, z], [x1, y0, z], [x0, y1, z], [x1, y1, z]);
    });
    for (let it = 0; it < 3; it++) {
      const cam = camera(p, S.W, S.H);
      let sx0 = 1e9, sx1 = -1e9, sy0 = 1e9, sy1 = -1e9;
      for (const c of corners) {
        const q = project(cam, c[0], c[1], c[2]);
        sx0 = Math.min(sx0, q[0]); sx1 = Math.max(sx1, q[0]); sy0 = Math.min(sy0, q[1]); sy1 = Math.max(sy1, q[1]);
      }
      const k = Math.min((av.x1 - av.x0) / (sx1 - sx0), (av.y1 - av.y0) / (sy1 - sy0));
      const dx = av.cx - (sx0 + sx1) / 2, dy = av.cy - (sy0 + sy1) / 2;
      const w = [-(cam.r[0] * dx + cam.d[0] * dy) / p.s, -(cam.r[1] * dx + cam.d[1] * dy) / p.s, -(cam.r[2] * dx + cam.d[2] * dy) / p.s];
      p.px += w[0]; p.py -= w[1]; p.z += w[2];
      p.s *= it < 2 ? k : 1;
    }
    return p;
  }
  function fitRect(rect, vp, sMin, sMax) {
    const [x0, y0, x1, y1] = rect;
    let s = Math.min(vp.w / (x1 - x0), vp.h / (y1 - y0));
    s = clamp(s, sMin, sMax);
    const rcx = (x0 + x1) / 2, rcy = (y0 + y1) / 2;
    return { px: rcx - (vp.cx - S.W / 2) / s, py: rcy - (vp.cy - S.H / 2) / s, z: 0, s, yaw: 0, pitch: 0, fov: 18 };
  }
  function floorScale(n) {
    const vp = viewport();
    const [x0, y0, x1, y1] = RECT[n];
    return Math.min(vp.w / (x1 - x0 + 60), vp.h / (y1 - y0 + 60));
  }
  function target(view, level, room) {
    const t = { view, cam: null, lv: {}, fx: {} };
    if (view === 'stack') {
      t.cam = fitStack(S.orbitBase, S.pitchBase);
      LEVELS.forEach((n, i) => (t.lv[n] = { z: (i - 1.5) * GAP, a: 0.92, slab: 0.9, led: 0.2, ctx: 0, edge: 1 }));
      t.fx = { dim: 1, sel: 0, duct: 1, riser: 1, tiles: 0, grid: 1, edge: 1 };
    } else {
      const idx = LEVELS.indexOf(level);
      const vp = viewport();
      const fs = floorScale(level);
      if (view === 'floor') {
        const [x0, y0, x1, y1] = RECT[level];
        t.cam = fitRect([x0 - 30, y0 - 30, x1 + 30, y1 + 30], vp, 0.05, S_MAX);
      } else {
        const [x0, y0, x1, y1] = room.bbox;
        const m = Math.max(24, 0.35 * Math.max(x1 - x0, y1 - y0));
        t.cam = fitRect([x0 - m, y0 - m, x1 + m, y1 + m], vp, fs, Math.min(S_MAX, 9));
      }
      LEVELS.forEach((n, i) => {
        t.lv[n] = n === level
          ? { z: 0, a: 1, slab: 0, led: 0.16, ctx: 0.4, edge: 0 }
          : { z: (i - idx) * GAP * 2.6, a: 0, slab: 0, led: 0, ctx: 0, edge: 0 };
      });
      t.fx = { dim: view === 'room' ? 0.36 : 1, sel: view === 'room' ? 1 : 0, duct: level === 4 ? 1 : 0, riser: 0, tiles: 1, grid: 1, edge: 0 };
    }
    return t;
  }
  function snapshot() {
    return { cam: { ...S.cam }, lv: Object.fromEntries(LEVELS.map((n) => [n, { ...S.lv[n] }])), fx: { ...S.fx } };
  }
  function applyState(view, level, room, instant) {
    const from = snapshot();
    const prevView = S.view, prevLevel = S.level;
    S.view = view; S.level = level; S.room = room || null;
    const to = target(view, level, room);
    let dur = 1.0;
    if (prevView === 'stack' || view === 'stack') dur = 1.35;
    else if (prevLevel !== level) dur = 1.15;
    else dur = 0.85;
    if (REDUCED) dur = 0.25;
    if (instant) dur = 0.001;
    S.tween = { from, to, t0: performance.now(), dur: dur * 1000, toView: view, cross: prevView === 'stack' || view === 'stack' || prevLevel !== level };
    S.selT0 = view === 'room' ? performance.now() + dur * 1000 * 0.62 : null;
    if (view !== 'stack') S.hoverLevel = null;
    updateUI();
    writeHash();
  }
  function stepTween(now) {
    const T = S.tween;
    if (!T) return;
    const u = clamp((now - T.t0) / T.dur);
    const e = ease(u);
    const a = T.from, b = T.to;
    for (const k of ['px', 'py', 'z', 'yaw', 'pitch', 'fov']) S.cam[k] = lerp(a.cam[k], b.cam[k], e);
    S.cam.s = Math.exp(lerp(Math.log(a.cam.s), Math.log(b.cam.s), e));
    LEVELS.forEach((n) => {
      const A = a.lv[n], B = b.lv[n];
      const fadeOut = B.a < A.a;
      const ua = fadeOut ? easeOut(clamp(u / 0.55)) : clamp((u - 0.25) / 0.6);
      S.lv[n] = {
        z: lerp(A.z, B.z, e), a: lerp(A.a, B.a, ua), slab: lerp(A.slab, B.slab, e), ctx: lerp(A.ctx, B.ctx, e), edge: lerp(A.edge, B.edge, e),
        // the LED matrix flares mid-move, the way the booth loop re-renders a floor
        led: lerp(A.led, B.led, e) + (T.cross && !REDUCED ? 0.85 * Math.sin(Math.PI * u) * (B.a > 0.5 ? 1 : 0.5) : 0),
      };
    });
    for (const k in b.fx) S.fx[k] = lerp(a.fx[k], b.fx[k], k === 'tiles' ? (u > 0.96 ? 1 : 0) * e : e);
    if (u >= 1) S.tween = null;
  }

  // ------------------------------------------------------------------ WebGL
  const canvas = $('gl');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) {
    $('fatal').hidden = false;
    $('fatal').innerHTML = '<div><b>WEBGL 2 IS NOT AVAILABLE</b>This viewer draws the floor plans with WebGL 2. Open it in a current version of Chrome, Edge, Safari or Firefox.</div>';
    $('loader').classList.add('done');
    return;
  }
  const ANISO = gl.getExtension('EXT_texture_filter_anisotropic');
  const ANISO_MAX = ANISO ? Math.min(8, gl.getParameter(ANISO.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 0;

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, '#version 300 es\nprecision highp float;\n' + vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;\n' + fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  const VS_PLANE = `
    layout(location=0) in vec2 aPos;
    uniform mat4 uVP; uniform vec3 uOrigin; uniform vec2 uCanvas; uniform vec4 uTile;
    out vec2 vUV; out vec2 vPlanUV;
    void main() {
      vec4 w = vec4(aPos.x - uOrigin.x, -(aPos.y - uOrigin.y), uOrigin.z, 1.0);
      gl_Position = uVP * w;
      vPlanUV = aPos / uCanvas;
      vUV = (aPos - uTile.xy) / uTile.zw;
    }`;
  const FS_LINES = `
    uniform sampler2D uTex; uniform sampler2D uMask; uniform float uA, uCtx, uLed, uFade;
    in vec2 vUV; in vec2 vPlanUV; out vec4 o;
    void main() {
      if (vUV.x < 0.0 || vUV.y < 0.0 || vUV.x > 1.0 || vUV.y > 1.0) discard;
      float v = texture(uTex, vUV).r;
      float m = texture(uMask, vPlanUV).r;
      v *= uA * mix(uCtx, 1.0, m);
      o = vec4(v, 0.0, v * uLed, uFade);
    }`;
  const FS_SLAB = `
    uniform sampler2D uMask; uniform float uSlab;
    in vec2 vUV; in vec2 vPlanUV; out vec4 o;
    void main() { o = vec4(0.0, 0.0, 0.0, texture(uMask, vPlanUV).r * uSlab); }`;
  const FS_ROOM = `
    uniform vec4 uVal; out vec4 o;
    in vec2 vUV; in vec2 vPlanUV;
    void main() { o = uVal; }`;
  const VS_PTS = `
    layout(location=0) in vec3 aP;
    uniform mat4 uVP; uniform vec3 uOrigin; uniform float uTime, uSize;
    out float vB;
    void main() {
      gl_Position = uVP * vec4(aP.x - uOrigin.x, -(aP.y - uOrigin.y), uOrigin.z, 1.0);
      float ph = fract((aP.z - uTime * 70.0) / 34.0);
      vB = exp(-ph * 5.0);
      gl_PointSize = uSize;
    }`;
  const FS_PTS = `
    uniform float uA; in float vB; out vec4 o;
    void main() {
      float d = length(gl_PointCoord - 0.5) * 2.0;
      float c = clamp((1.0 - d) * 2.0, 0.0, 1.0) * vB * uA;
      o = vec4(c, 0.0, c * 0.6, 0.0);
    }`;
  const VS_OV = `
    layout(location=0) in vec2 aPos; layout(location=1) in vec4 aE;
    out vec4 vE;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); vE = aE; }`;
  const FS_OV = `
    in vec4 vE; out vec4 o;
    void main() {
      float c = clamp(vE.w - length(vE.xy) + 0.5, 0.0, 1.0) * vE.z;
      o = vec4(c, 0.0, c * 0.5, 0.0);
    }`;
  const VS_FS = `
    const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;
  const FS_POST = `
    uniform sampler2D uScene; uniform vec2 uRes; uniform float uCell, uDim, uSel, uGrid, uGridR, uGridAmt, uReveal, uRevealW, uSelT;
    uniform vec4 uRoomBox;
    out vec4 o;
    void main() {
      vec2 fc = gl_FragCoord.xy, uv = fc / uRes;
      vec4 s = texture(uScene, uv);
      vec2 cc = (floor(fc / uCell) + 0.5) * uCell;
      vec4 a = textureLod(uScene, cc / uRes, log2(uCell));
      float dist = length(fc - cc);
      float inSel = clamp(max(s.g, a.g) * 1.4, 0.0, 1.0);
      float dimK = mix(uDim, 1.0, inSel);
      float d = pow(clamp(a.r * 1.9, 0.0, 1.0), 0.9);
      float bright = clamp(a.b / max(a.r, 1e-3), 0.0, 1.0);
      float led = clamp(d * 0.5 * uCell - dist + 0.5, 0.0, 1.0) * bright;
      float fs = clamp(a.g * 0.36 * uCell - dist + 0.5, 0.0, 1.0);
      float fh = clamp(a.a * 0.30 * uCell - dist + 0.5, 0.0, 1.0);
      vec2 px = 1.25 / uRes;
      vec2 gg = vec2(texture(uScene, uv + vec2(px.x, 0.0)).g - texture(uScene, uv - vec2(px.x, 0.0)).g,
                     texture(uScene, uv + vec2(0.0, px.y)).g - texture(uScene, uv - vec2(0.0, px.y)).g);
      vec2 gh = vec2(texture(uScene, uv + vec2(px.x, 0.0)).a - texture(uScene, uv - vec2(px.x, 0.0)).a,
                     texture(uScene, uv + vec2(0.0, px.y)).a - texture(uScene, uv - vec2(0.0, px.y)).a);
      float edge = clamp(length(gg) * 1.8, 0.0, 1.0);
      float hedge = clamp(length(gh) * 2.4, 0.0, 1.0);
      // selection: the room's dots sweep in corner to corner, then sweep out the same way
      vec2 ct = vec2(cc.x, uRes.y - cc.y);
      vec2 dd = uRoomBox.zw - uRoomBox.xy;
      float w = clamp(dot(ct - uRoomBox.xy, dd) / max(dot(dd, dd), 1.0), 0.0, 1.0);
      float fIn = uSelT / 0.42 * 1.3 - 0.15;
      float fOut = (uSelT - 0.55) / 0.6 * 1.3 - 0.15;
      float sweep = (1.0 - smoothstep(fIn - 0.06, fIn + 0.02, w)) * smoothstep(fOut - 0.06, fOut + 0.02, w);
      float crest = exp(-pow((w - fIn) / 0.05, 2.0)) * (1.0 - smoothstep(0.45, 0.65, uSelT));
      float v = max(s.r * dimK, led * dimK);
      v = max(v, fs * 0.95 * sweep * uSel);
      v = max(v, fs * 1.35 * crest * uSel);
      v = max(v, fh * 0.5);
      v = max(v, edge * uSel);
      v = max(v, hedge * 0.6);
      vec2 g = mod(fc, uGrid) - 0.5 * uGrid;
      v = max(v, clamp(uGridR - length(g) + 0.5, 0.0, 1.0) * 0.11 * uGridAmt);
      if (uReveal > 0.0) {
        float r = length(fc - 0.5 * uRes);
        v *= smoothstep(uReveal, uReveal - uRevealW, r);
        v = max(v, exp(-pow((r - uReveal) / 3.0, 2.0)) * 0.8 * step(1.0, uReveal));
      }
      o = vec4(v, v, v, 1.0);
    }`;
  const FS_DOWN = `
    uniform sampler2D uTex; uniform vec2 uTexel; out vec4 o;
    void main() {
      vec2 uv = gl_FragCoord.xy * 2.0 * uTexel;
      o = 0.25 * (texture(uTex, uv + uTexel * vec2(-0.5, -0.5)) + texture(uTex, uv + uTexel * vec2(0.5, -0.5)) +
                  texture(uTex, uv + uTexel * vec2(-0.5, 0.5)) + texture(uTex, uv + uTexel * vec2(0.5, 0.5)));
    }`;
  const FS_BLUR = `
    uniform sampler2D uTex; uniform vec2 uDir; uniform vec2 uRes; out vec4 o;
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      vec4 c = texture(uTex, uv) * 0.2270270270;
      c += (texture(uTex, uv + uDir * 1.3846153846) + texture(uTex, uv - uDir * 1.3846153846)) * 0.3162162162;
      c += (texture(uTex, uv + uDir * 3.2307692308) + texture(uTex, uv - uDir * 3.2307692308)) * 0.0702702703;
      o = c;
    }`;
  const FS_FINAL = `
    uniform sampler2D uPost, uG1, uG2, uG3; uniform vec2 uRes; uniform float uSeed, uGrain;
    out vec4 o;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      float v = texture(uPost, uv).r;
      float g = 0.35 * texture(uG1, uv).r + 0.45 * texture(uG2, uv).r + 0.35 * texture(uG3, uv).r;
      v += 0.55 * g;
      vec2 q = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
      v *= 1.0 - 0.2 * smoothstep(0.45, 1.2, length(q));
      v += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
      v = v / (1.0 + 0.12 * max(v - 0.8, 0.0));
      o = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
    }`;

  let P;
  try {
    P = {
      lines: program(VS_PLANE, FS_LINES), slab: program(VS_PLANE, FS_SLAB), room: program(VS_PLANE, FS_ROOM),
      pts: program(VS_PTS, FS_PTS), ov: program(VS_OV, FS_OV), post: program(VS_FS, FS_POST),
      down: program(VS_FS, FS_DOWN), blur: program(VS_FS, FS_BLUR), final: program(VS_FS, FS_FINAL),
    };
  } catch (err) {
    console.error(err);
    $('fatal').hidden = false;
    $('fatal').innerHTML = '<div><b>THE VIEWER COULD NOT START</b>This device\'s graphics driver rejected a shader. Try another browser.</div>';
    $('loader').classList.add('done');
    return;
  }

  const vao = gl.createVertexArray();          // attributeless full-screen passes
  function quadBuf(x0, y0, x1, y1) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]), gl.STATIC_DRAW);
    const v = gl.createVertexArray();
    gl.bindVertexArray(v);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return v;
  }
  const sheetVAO = quadBuf(0, 0, CW, CH);

  function texFromBitmap(bmp, mips, single) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (single) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, bmp);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mips) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (ANISO) gl.texParameterf(gl.TEXTURE_2D, ANISO.TEXTURE_MAX_ANISOTROPY_EXT, ANISO_MAX);
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return t;
  }
  async function loadBitmap(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ' ' + res.status);
    const blob = await res.blob();
    return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }

  // render targets
  const RT = {};
  function makeRT(w, h, mips) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }
  function freeRT(rt) { if (rt) { gl.deleteTexture(rt.tex); gl.deleteFramebuffer(rt.fb); } }
  function resize() {
    const cssW = Math.max(1, canvas.clientWidth), cssH = Math.max(1, canvas.clientHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxPx = 3.8e6;
    if (cssW * cssH * dpr * dpr > maxPx) dpr = Math.sqrt(maxPx / (cssW * cssH));
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    S.W = cssW; S.H = cssH; S.dpr = w / cssW;
    if (canvas.width === w && canvas.height === h && RT.scene) return;
    canvas.width = w; canvas.height = h;
    for (const k in RT) freeRT(RT[k]);
    RT.scene = makeRT(w, h, true);
    RT.post = makeRT(w, h, false);
    const h2 = [Math.max(1, w >> 1), Math.max(1, h >> 1)], h4 = [Math.max(1, w >> 2), Math.max(1, h >> 2)], h8 = [Math.max(1, w >> 3), Math.max(1, h >> 3)];
    RT.a1 = makeRT(...h2, false); RT.b1 = makeRT(...h2, false);
    RT.a2 = makeRT(...h4, false); RT.b2 = makeRT(...h4, false);
    RT.a3 = makeRT(...h8, false); RT.b3 = makeRT(...h8, false);
  }

  // screen-space line / dot batch (device px), drawn into the scene with MAX blending
  class Batch {
    constructor() { this.v = []; this.buf = gl.createBuffer(); this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
      gl.bindVertexArray(null); }
    clear() { this.v.length = 0; }
    _q(pts, e, val, half) {
      const W = canvas.width, H = canvas.height;
      for (const i of [0, 1, 2, 2, 1, 3]) this.v.push(pts[i][0] / W * 2 - 1, 1 - pts[i][1] / H * 2, e[i][0], e[i][1], val, half);
    }
    line(x0, y0, x1, y1, w, val) {
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
      if (L < 0.01 || val <= 0.002) return;
      const h = w / 2 + 1, tx = dx / L * h, ty = dy / L * h, nx = -ty, ny = tx;
      this._q([[x0 - tx + nx, y0 - ty + ny], [x0 - tx - nx, y0 - ty - ny], [x1 + tx + nx, y1 + ty + ny], [x1 + tx - nx, y1 + ty - ny]],
        [[h, 0], [-h, 0], [h, 0], [-h, 0]], val, w / 2);
    }
    dot(x, y, r, val) {
      if (val <= 0.002) return;
      const h = r + 1;
      this._q([[x - h, y - h], [x + h, y - h], [x - h, y + h], [x + h, y + h]], [[-h, -h], [h, -h], [-h, h], [h, h]], val, r);
    }
    draw() {
      if (!this.v.length) return;
      gl.useProgram(P.ov.p);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.v), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, this.v.length / 6);
    }
  }
  const batch = new Batch();

  // ------------------------------------------------------------------ assets
  const TEX = { over: {}, mask: {} };
  const TILES = new Map();
  let tileInflight = 0;
  function tileKey(n, i, j) { return n + ':' + i + ':' + j; }
  function requestTile(n, i, j) {
    const key = tileKey(n, i, j);
    if (TILES.has(key) || tileInflight >= 4) return;
    const rec = { state: 'loading', tex: null, t: 0, used: performance.now(), n, i, j, vao: null };
    TILES.set(key, rec);
    tileInflight++;
    loadBitmap(`${DATA}tiles/L${n}_${i}_${j}.webp`).then((bmp) => {
      rec.tex = texFromBitmap(bmp, true, true);
      bmp.close && bmp.close();
      const size = IMG.tileSize / IMG.tileK, ox = IMG.tileOrigin[0] + i * size, oy = IMG.tileOrigin[1] + j * size;
      rec.vao = quadBuf(ox, oy, ox + size, oy + size);
      rec.box = [ox, oy, size, size];
      rec.state = 'ready'; rec.t = performance.now();
    }).catch(() => { rec.state = 'error'; }).finally(() => { tileInflight--; });
    // keep GPU memory bounded
    if (TILES.size > 22) {
      const old = [...TILES.values()].filter((r) => r.state === 'ready').sort((a, b) => a.used - b.used).slice(0, TILES.size - 22);
      for (const r of old) { gl.deleteTexture(r.tex); TILES.delete(tileKey(r.n, r.i, r.j)); }
    }
  }
  let ductVAO = null, ductCount = 0;

  // ------------------------------------------------------------------ frame
  let lastT = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    if (!S.ready || document.hidden) return;
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    resize();
    stepTween(now);
    // idle orbit of the stack
    if (S.view === 'stack' && !S.tween) {
      if (S.hoverLevel == null) S.orbitT += REDUCED ? 0 : dt;     // hold still while a floor is under the pointer
      S.cam.yaw = S.orbitBase + (REDUCED ? 0 : 9 * Math.sin(S.orbitT * 0.13));
      S.cam.pitch = S.pitchBase + (REDUCED ? 0 : 2.5 * Math.sin(S.orbitT * 0.09));
      const hov = S.hoverLevel;
      LEVELS.forEach((n) => {
        const L = S.lv[n], want = hov == null ? 0.92 : n === hov ? 1 : 0.5;
        L.a += (want - L.a) * Math.min(1, dt * 8);
        const wl = hov === n ? 0.55 : 0.2;
        L.led += (wl - L.led) * Math.min(1, dt * 6);
      });
    }
    if (S.view !== 'stack' && now - S.lastInput > IDLE_MS) { S.lastInput = now; applyState('stack', null, null); }
    S.intro = Math.min(1, S.intro + dt / (REDUCED ? 0.01 : 1.6));
    render(now);
    updateOverlayDOM();
  }

  function render(now) {
    const W = canvas.width, H = canvas.height, t = now / 1000;
    const cam = camera(S.cam, S.W, S.H);
    S.camObj = cam;
    const VP = viewProj(cam);
    gl.bindFramebuffer(gl.FRAMEBUFFER, RT.scene.fb);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);

    const order = LEVELS.slice().sort((a, b) => S.lv[a].z - S.lv[b].z);
    const pxPerPt = S.cam.s * S.dpr;
    const useTiles = S.fx.tiles > 0.5 && S.level && pxPerPt > 2.6 && S.cam.pitch < 1;
    const dpr = S.dpr;
    for (const n of order) {
      const L = S.lv[n];
      if (L.a < 0.003 && L.slab < 0.003) continue;
      const origin = [CX, CY, L.z];
      // slab: darken what is below
      if (L.slab > 0.003) {
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(P.slab.p);
        setPlane(P.slab, VP, origin);
        gl.uniform1f(P.slab.u.uSlab, L.slab);
        bindTex(0, TEX.mask[n]); gl.uniform1i(P.slab.u.uMask, 0);
        gl.bindVertexArray(sheetVAO); gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      if (L.a < 0.003) continue;
      // linework (overview)
      gl.blendEquation(gl.MAX);
      gl.useProgram(P.lines.p);
      setPlane(P.lines, VP, origin, [0, 0, CW, CH]);
      gl.uniform1f(P.lines.u.uA, L.a);
      gl.uniform1f(P.lines.u.uCtx, L.ctx);
      gl.uniform1f(P.lines.u.uLed, clamp(L.led));
      gl.uniform1f(P.lines.u.uFade, 0);
      bindTex(0, TEX.over[n]); gl.uniform1i(P.lines.u.uTex, 0);
      bindTex(1, TEX.mask[n]); gl.uniform1i(P.lines.u.uMask, 1);
      gl.bindVertexArray(sheetVAO); gl.drawArrays(gl.TRIANGLES, 0, 6);
      // sharp detail tiles replace the overview where loaded
      if (useTiles && n === S.level) drawTiles(n, VP, origin, L, now);
      // room fills: selection -> G, hover -> A
      if (n === S.level && S.view !== 'stack') {
        gl.blendEquation(gl.MAX);
        gl.useProgram(P.room.p);
        setPlane(P.room, VP, origin);
        if (S.room && S.fx.sel > 0.01) { gl.colorMask(false, true, false, false); drawRoom(S.room, [0, S.fx.sel, 0, 0]); }
        if (S.hoverRoom && S.hoverRoom !== S.room) { gl.colorMask(false, false, false, true); drawRoom(S.hoverRoom, [0, 0, 0, 1]); }
        gl.colorMask(true, true, true, true);
      }
      // penthouse airflow along the duct centrelines
      if (n === 4 && ductVAO && S.fx.duct > 0.01) {
        gl.blendEquation(gl.MAX);
        gl.useProgram(P.pts.p);
        gl.uniformMatrix4fv(P.pts.u.uVP, false, VP);
        gl.uniform3f(P.pts.u.uOrigin, CX, CY, L.z);
        gl.uniform1f(P.pts.u.uTime, REDUCED ? 0 : t);
        gl.uniform1f(P.pts.u.uSize, clamp(S.cam.s * dpr * 2.2, 1.5, 6));
        gl.uniform1f(P.pts.u.uA, S.fx.duct * L.a * 0.95);
        gl.bindVertexArray(ductVAO); gl.drawArrays(gl.POINTS, 0, ductCount);
      }
      // slab edge
      if (L.edge > 0.01) {
        batch.clear();
        for (const R of FOOT[n]) {
          let prev = null;
          for (let i = 0; i <= R.length; i += 2) {
            const k = i % R.length;
            const q = project(cam, R[k], R[k + 1], L.z);
            if (prev && q[2] > 0 && prev[2] > 0) batch.line(prev[0] * dpr, prev[1] * dpr, q[0] * dpr, q[1] * dpr, 1.1 * dpr, 0.85 * L.edge * L.a);
            prev = q;
          }
        }
        gl.blendEquation(gl.MAX);
        batch.draw();
      }
    }
    // risers + elevator core (stack view)
    if (S.fx.riser > 0.01 && IMG) {
      batch.clear();
      const z2 = S.lv[2].z, z4 = S.lv[4].z + 70;
      for (const r of IMG.risers) {
        const a = project(cam, r.x, r.y, z2), b = project(cam, r.x, r.y, z4);
        batch.line(a[0] * dpr, a[1] * dpr, b[0] * dpr, b[1] * dpr, 2 * dpr, 0.95 * S.fx.riser);
        batch.dot(a[0] * dpr, a[1] * dpr, 3.2 * dpr, 0.9 * S.fx.riser);
        for (let k = 0; k < 9; k++) {
          const ph = ((REDUCED ? 0 : t * 0.45) + k / 9) % 1;
          const q = project(cam, r.x, r.y, lerp(z2, z4, ph));
          batch.dot(q[0] * dpr, q[1] * dpr, 3.0 * dpr, S.fx.riser);
        }
      }
      const [x0, y0, x1, y1] = IMG.core, z1 = S.lv[1].z, zp = S.lv[4].z;
      for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        const a = project(cam, x, y, z1), b = project(cam, x, y, zp);
        const segs = 26;
        for (let k = 0; k < segs; k += 2) {
          const u0 = k / segs, u1 = (k + 1) / segs;
          batch.line(lerp(a[0], b[0], u0) * dpr, lerp(a[1], b[1], u0) * dpr, lerp(a[0], b[0], u1) * dpr, lerp(a[1], b[1], u1) * dpr, 1 * dpr, 0.4 * S.fx.riser);
        }
      }
      gl.blendEquation(gl.MAX);
      batch.draw();
    }
    // intro shock ring
    if (S.intro < 1) {
      batch.clear();
      const u = S.intro, R = Math.hypot(W, H) * 0.62 * easeOut(clamp(u / 0.8));
      const ring = Math.max(1, R);
      for (let k = 0; k < 96; k++) {
        const a0 = (k / 96) * Math.PI * 2, a1 = ((k + 1) / 96) * Math.PI * 2;
        batch.line(W / 2 + Math.cos(a0) * ring, H / 2 + Math.sin(a0) * ring, W / 2 + Math.cos(a1) * ring, H / 2 + Math.sin(a1) * ring, 2 * dpr, 0.9 * (1 - u));
      }
      batch.dot(W / 2, H / 2, 5 * dpr * (1 - easeOut(clamp(u / 0.35))), 1);
      gl.blendEquation(gl.MAX);
      batch.draw();
    }
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, RT.scene.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // LED halftone + selection + background grid
    gl.bindFramebuffer(gl.FRAMEBUFFER, RT.post.fb);
    gl.viewport(0, 0, W, H);
    gl.useProgram(P.post.p);
    gl.bindVertexArray(vao);
    bindTex(0, RT.scene.tex); gl.uniform1i(P.post.u.uScene, 0);
    gl.uniform2f(P.post.u.uRes, W, H);
    gl.uniform1f(P.post.u.uCell, Math.max(4, Math.round(6 * dpr)));
    gl.uniform1f(P.post.u.uDim, S.fx.dim);
    gl.uniform1f(P.post.u.uSel, S.fx.sel);
    gl.uniform1f(P.post.u.uGrid, 24 * dpr);
    gl.uniform1f(P.post.u.uGridR, 1.05 * dpr);
    gl.uniform1f(P.post.u.uGridAmt, S.fx.grid);
    const reveal = S.intro < 1 ? Math.hypot(W, H) * 0.62 * easeOut(clamp(S.intro / 0.8)) : 0;
    gl.uniform1f(P.post.u.uReveal, reveal);
    // flash timing + the selected room's screen box (device px, top-left origin)
    let selT = 99, box = [0, 0, 1, 1];
    if (S.room && S.selT0 != null) {
      selT = (now - S.selT0) / 1000;
      const [bx0, by0, bx1, by1] = S.room.bbox;
      const c = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]].map(([x, y]) => project(cam, x, y, S.lv[S.room.level].z));
      box = [Math.min(...c.map((q) => q[0])) * dpr, Math.min(...c.map((q) => q[1])) * dpr,
             Math.max(...c.map((q) => q[0])) * dpr, Math.max(...c.map((q) => q[1])) * dpr];
    }
    gl.uniform1f(P.post.u.uSelT, REDUCED ? 99 : selT);
    gl.uniform4f(P.post.u.uRoomBox, ...box);
    gl.uniform1f(P.post.u.uRevealW, 160 * dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // glow
    const pass = (prog, dst, src, setup) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, dst.w, dst.h);
      gl.useProgram(prog.p); bindTex(0, src.tex); gl.uniform1i(prog.u.uTex, 0); setup(prog); gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const down = (dst, src) => pass(P.down, dst, src, (p) => gl.uniform2f(p.u.uTexel, 1 / src.w, 1 / src.h));
    const blur = (a, b) => {
      pass(P.blur, b, a, (p) => { gl.uniform2f(p.u.uDir, 1 / a.w, 0); gl.uniform2f(p.u.uRes, b.w, b.h); });
      pass(P.blur, a, b, (p) => { gl.uniform2f(p.u.uDir, 0, 1 / b.h); gl.uniform2f(p.u.uRes, a.w, a.h); });
    };
    down(RT.a1, RT.post); blur(RT.a1, RT.b1);
    down(RT.a2, RT.a1); blur(RT.a2, RT.b2); blur(RT.a2, RT.b2);
    down(RT.a3, RT.a2); blur(RT.a3, RT.b3); blur(RT.a3, RT.b3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(P.final.p);
    bindTex(0, RT.post.tex); gl.uniform1i(P.final.u.uPost, 0);
    bindTex(1, RT.a1.tex); gl.uniform1i(P.final.u.uG1, 1);
    bindTex(2, RT.a2.tex); gl.uniform1i(P.final.u.uG2, 2);
    bindTex(3, RT.a3.tex); gl.uniform1i(P.final.u.uG3, 3);
    gl.uniform2f(P.final.u.uRes, W, H);
    gl.uniform1f(P.final.u.uSeed, REDUCED ? 0 : (t % 10));
    gl.uniform1f(P.final.u.uGrain, 0.018);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function bindTex(unit, tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); }
  function setPlane(prog, VP, origin, tile) {
    gl.uniformMatrix4fv(prog.u.uVP, false, VP);
    gl.uniform3f(prog.u.uOrigin, origin[0], origin[1], origin[2]);
    gl.uniform2f(prog.u.uCanvas, CW, CH);
    if (prog.u.uTile) gl.uniform4f(prog.u.uTile, ...(tile || [0, 0, CW, CH]));
  }
  function drawTiles(n, VP, origin, L, now) {
    const s = S.cam.s, x0 = S.cam.px - S.W / 2 / s, x1 = S.cam.px + S.W / 2 / s, y0 = S.cam.py - S.H / 2 / s, y1 = S.cam.py + S.H / 2 / s;
    const size = IMG.tileSize / IMG.tileK;
    const avail = IMG.levels[n].tileSet;
    gl.useProgram(P.lines.p);
    gl.uniform1f(P.lines.u.uA, L.a);
    gl.uniform1f(P.lines.u.uCtx, L.ctx);
    gl.uniform1f(P.lines.u.uLed, clamp(L.led));
    bindTex(1, TEX.mask[n]); gl.uniform1i(P.lines.u.uMask, 1);
    gl.colorMask(true, false, true, false);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    const i0 = Math.max(0, Math.floor((x0 - IMG.tileOrigin[0]) / size)), i1 = Math.min(IMG.tileGrid[0] - 1, Math.floor((x1 - IMG.tileOrigin[0]) / size));
    const j0 = Math.max(0, Math.floor((y0 - IMG.tileOrigin[1]) / size)), j1 = Math.min(IMG.tileGrid[1] - 1, Math.floor((y1 - IMG.tileOrigin[1]) / size));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!avail.has(i + ',' + j)) continue;
      const rec = TILES.get(tileKey(n, i, j));
      if (!rec) { requestTile(n, i, j); continue; }
      rec.used = now;
      if (rec.state !== 'ready') continue;
      const fade = clamp((now - rec.t) / 250);
      setPlane(P.lines, VP, origin, rec.box);
      gl.uniform1f(P.lines.u.uFade, fade);
      bindTex(0, rec.tex); gl.uniform1i(P.lines.u.uTex, 0);
      gl.bindVertexArray(rec.vao); gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.colorMask(true, true, true, true);
  }
  function drawRoom(room, val) {
    if (!room.vao) {
      const v = new Float32Array(room.tri.v), idx = new Uint32Array(room.tri.i);
      const a = new Float32Array(idx.length * 2);
      for (let k = 0; k < idx.length; k++) { a[2 * k] = v[2 * idx[k]]; a[2 * k + 1] = v[2 * idx[k] + 1]; }
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
      room.vao = gl.createVertexArray(); gl.bindVertexArray(room.vao);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      room.nv = idx.length;
    }
    gl.uniform4f(P.room.u.uVal, ...val);
    gl.bindVertexArray(room.vao); gl.drawArrays(gl.TRIANGLES, 0, room.nv);
  }

  // ------------------------------------------------------------------ DOM overlay (labels, leaders, readouts)
  const leaders = $('leaders'), stackLabels = $('stackLabels');
  const labelEls = {};
  function buildStackLabels() {
    stackLabels.innerHTML = '';
    LEVELS.slice().reverse().forEach((n) => {
      const L = DATAJ.levels.find((l) => l.n === n);
      const b = document.createElement('button');
      b.className = 'stack-label';
      b.type = 'button';
      b.setAttribute('aria-label', `Open ${L.name.toLowerCase()}: ${L.sub.toLowerCase()}`);
      b.innerHTML = `${dmSVG(CODE[n], 4, 0)}<div><span>${esc(shortSub(L))}</span><small>${BYLEVEL[n].length} ROOMS</small></div>`;
      b.addEventListener('click', () => { S.lastInput = performance.now(); applyState('floor', n, null); });
      b.addEventListener('pointerenter', () => { if (S.view === 'stack') S.hoverLevel = n; });
      b.addEventListener('pointerleave', () => { if (S.hoverLevel === n) S.hoverLevel = null; });
      stackLabels.appendChild(b);
      labelEls[n] = b;
    });
  }
  function shortSub(L) {
    return { 1: 'EMERGENCY · LOBBY', 2: 'LABOR & DELIVERY · NICU', 3: 'PATIENT CARE · ICU', 4: 'PENTHOUSE · MEP' }[L.n];
  }
  let leaderHTML = '';
  function updateOverlayDOM() {
    const cam = S.camObj;
    const inStack = S.view === 'stack' || (S.tween && (S.tween.from && S.tween.to.view === 'stack'));
    let html = '';
    const showLabels = S.view === 'stack' && !S.tween;
    const narrow = S.W < 760;
    const labelX = S.W - 360;
    stackLabels.style.display = S.view === 'stack' ? '' : 'none';
    if (S.view === 'stack') {
      const vis = S.tween ? clamp((performance.now() - S.tween.t0) / S.tween.dur) : 1;
      LEVELS.forEach((n) => {
        const [x0, y0, x1, y1] = RECT[n];
        const q = project(cam, x1 - 12, (y0 + y1) / 2 + (n === 4 ? 70 : 0), S.lv[n].z);
        const el = labelEls[n];
        const y = q[1];
        const lx = narrow ? q[0] + 22 : labelX;                     // phones: code tag beside the floor
        el.style.transform = `translate(${lx}px, ${y}px)`;
        el.style.opacity = String(vis);
        el.classList.toggle('dim', S.hoverLevel != null && S.hoverLevel !== n);
        el.classList.toggle('hot', S.hoverLevel === n);
        const a = S.hoverLevel == null || S.hoverLevel === n ? 0.75 : 0.3;
        html += `<line x1="${q[0].toFixed(1)}" y1="${q[1].toFixed(1)}" x2="${(lx - (narrow ? 4 : 18)).toFixed(1)}" y2="${y.toFixed(1)}" opacity="${(a * vis).toFixed(2)}"/>` +
                `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="3" opacity="${vis.toFixed(2)}"/>`;
      });
    }
    // room callout: leader from the room to the panel edge
    if (S.view === 'room' && S.room && !S.tween && S.W >= 760) {
      const [ax, ay] = S.room.anchor;
      const q = project(cam, ax, ay, 0);
      const x2 = S.W - 384 - 1;
      html += `<polyline points="${q[0].toFixed(1)},${q[1].toFixed(1)} ${(q[0] + (x2 - q[0]) * 0.35).toFixed(1)},${(q[1] - 40).toFixed(1)} ${x2},${(q[1] - 40).toFixed(1)}" opacity="0.7"/>` +
              `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="3.5"/>`;
    }
    if (html !== leaderHTML) { leaders.innerHTML = html; leaderHTML = html; }
    // readouts
    const ro1 = $('ro1'), ro2 = $('ro2');
    if (S.view === 'stack') {
      ro1.textContent = `STACK · ${ROOMS.length} ROOMS ON ${LEVELS.length} LEVELS`;
      ro2.textContent = `YAW ${S.cam.yaw.toFixed(1)}°  PITCH ${S.cam.pitch.toFixed(1)}°  SCALE 1/16" = 1'-0" SOURCE`;
    } else {
      const g = S.cursorPlan ? gridRef(S.cursorPlan[0], S.cursorPlan[1]) : null;
      ro1.textContent = g ? `CURSOR  GRID ${g}` : `LEVEL ${CODE[S.level]}`;
      ro2.textContent = `ZOOM ${(S.cam.s / floorScale(S.level)).toFixed(1)}×   ${(S.cam.s * PT_PER_FT).toFixed(1)} PX / FT`;
    }
    // scale bar in plan views
    const sb = $('scalebar');
    if (S.view !== 'stack' && !S.tween) {
      const pxPerFt = S.cam.s * PT_PER_FT;
      const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((f) => f * pxPerFt >= 70) || 200;
      sb.hidden = false;
      sb.querySelector('i').style.width = (nice * pxPerFt).toFixed(0) + 'px';
      sb.querySelector('span').textContent = nice + ' FT';
    } else sb.hidden = true;
  }
  function gridRef(x, y) {
    const g = DATAJ.grid;
    const pick = (lines, v, natural) => {
      if (v < lines[0].pos - 25 || v > lines[lines.length - 1].pos + 25) return null;
      for (const L of lines) if (Math.abs(v - L.pos) < 2.5) return L.label;
      if (v < lines[0].pos) return lines[0].label + '±';
      if (v > lines[lines.length - 1].pos) return lines[lines.length - 1].label + '±';
      let i = 0; while (lines[i + 1].pos < v) i++;
      const pair = [lines[i].label, lines[i + 1].label].sort(natural);
      return pair[0] + '–' + pair[1];
    };
    const r = pick(g.rows, y, (a, b) => (a < b ? -1 : 1)), c = pick(g.cols, x, (a, b) => parseFloat(a) - parseFloat(b));
    return r && c ? `${r} / ${c}` : null;
  }

  // ------------------------------------------------------------------ UI: title, levels, crumbs, panel
  const levelNav = $('levels');
  function buildLevelNav() {
    levelNav.innerHTML = '';
    LEVELS.slice().reverse().forEach((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.level = n;
      b.setAttribute('aria-label', DATAJ.levels.find((l) => l.n === n).name.toLowerCase());
      b.innerHTML = `${CODE[n]}<i></i><b></b>`;
      b.addEventListener('click', () => { S.lastInput = performance.now(); applyState('floor', n, null); });
      b.addEventListener('pointerenter', () => { if (S.view === 'stack') S.hoverLevel = n; });
      b.addEventListener('pointerleave', () => { if (S.hoverLevel === n) S.hoverLevel = null; });
      levelNav.appendChild(b);
    });
    const all = document.createElement('button');
    all.type = 'button'; all.className = 'all'; all.textContent = 'STACK';
    all.setAttribute('aria-label', 'Show the exploded stack');
    all.addEventListener('click', () => { S.lastInput = performance.now(); applyState('stack', null, null); });
    levelNav.appendChild(all);
  }
  function updateUI() {
    const app = $('app');
    app.dataset.view = S.view;
    const L = S.level ? DATAJ.levels.find((l) => l.n === S.level) : null;
    if (S.view === 'stack') {
      setDM($('title'), 'MIH TOWER', 7, 0.1);
      $('sub').textContent = 'EXPLODED STACK · 4 LEVELS';
      $('hinttext').textContent = matchMedia('(hover: hover)').matches ? 'SELECT A FLOOR · DRAG TO TURN' : 'TAP A FLOOR · DRAG TO TURN';
    } else if (S.view === 'floor') {
      setDM($('title'), L.name, 7, 0.1);
      $('sub').textContent = L.sub;
      $('hinttext').textContent = matchMedia('(hover: hover)').matches ? 'SELECT A ROOM · DRAG TO PAN · SCROLL TO ZOOM · ESC BACK' : 'TAP A ROOM · DRAG TO PAN · PINCH TO ZOOM';
    } else {
      setDM($('title'), S.room.tag, 7, 0.1);
      $('sub').textContent = `${L.name} · ${S.room.name}`;
      $('hinttext').textContent = 'ESC · BACK TO FLOOR';
    }
    for (const b of levelNav.querySelectorAll('button[data-level]')) b.setAttribute('aria-current', String(+b.dataset.level === S.level));
    // breadcrumbs
    const cr = $('crumbs');
    const parts = [];
    parts.push(S.view === 'stack' ? '<span>STACK</span>' : '<button type="button" data-go="stack">STACK</button>');
    if (S.level) parts.push(S.view === 'floor' ? `<span>LEVEL ${CODE[S.level]}</span>` : `<button type="button" data-go="floor">LEVEL ${CODE[S.level]}</button>`);
    if (S.room) parts.push(`<span>${esc(S.room.tag)}</span>`);
    cr.innerHTML = parts.join('<span class="sep">/</span>');
    renderPanel();
    $('tip').hidden = true;
  }
  $('crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-go]');
    if (!b) return;
    S.lastInput = performance.now();
    if (b.dataset.go === 'stack') applyState('stack', null, null);
    else applyState('floor', S.level, null);
  });

  function roomLabel(tag) {
    const r = BYTAG.get(tag);
    return r ? r.name : tag;
  }
  function renderPanel() {
    const panel = $('panel');
    if (S.view !== 'room' || !S.room) { panel.hidden = true; panel.innerHTML = ''; return; }
    const r = S.room, L = DATAJ.levels.find((l) => l.n === r.level);
    const area = r.area >= 1 ? `${r.open ? '≈ ' : ''}${fmt(r.area)} FT²` : '< 1 FT²';
    const size = r.dims ? `≈ ${r.dims[0].toFixed(0)} × ${r.dims[1].toFixed(0)} FT` : null;
    const stacked = [['▲', r.level + 1, r.above], ['▼', r.level - 1, r.below]].filter((x) => x[1] >= 1 && x[1] <= 4);
    const link = (ar, lv, tag) => tag
      ? `<li><button type="button" data-tag="${esc(tag)}"><span class="ar">${ar}</span><span class="tg">${esc(tag)}</span><span class="nm">${esc(roomLabel(tag))}</span></button></li>`
      : `<li class="none">${ar} LEVEL ${CODE[lv]} · NO ROOM DIRECTLY ${ar === '▲' ? 'ABOVE' : 'BELOW'}</li>`;
    const list = BYLEVEL[r.level];
    const idx = list.indexOf(r);
    panel.innerHTML = `
      <div class="p-top"><div class="p-eyebrow">${esc(L.name)} · ${esc(shortSub(L))}</div>
        <button type="button" class="p-close" id="pClose" aria-label="Close room details">×</button></div>
      <div class="p-tag" aria-hidden="true">${dmSVG(r.tag, 4.2, 0.1)}</div>
      <h2 class="p-name">${esc(r.name)}</h2>
      ${r.drawn && r.drawn !== r.name ? `<div class="p-drawn">ON DRAWING: ${esc(r.drawn)}</div>` : ''}
      <div class="p-type">${esc(TYPE_LABEL[r.type] || 'SPACE')}</div>
      <section class="p-sec"><h2>ROOM</h2><dl class="p-kv">
        <dt>NUMBER</dt><dd>${esc(r.tag)}</dd>
        <dt>AREA</dt><dd>${area}${r.open ? '<small>Open to adjoining space; boundary split at the opening.</small>' : ''}</dd>
        ${size ? `<dt>SIZE</dt><dd>${size}</dd>` : ''}
        <dt>GRID</dt><dd>${r.grid ? esc(r.grid) : '—<small>Outside the main column grid.</small>'}</dd>
        <dt>LEVEL</dt><dd>${esc(L.name)}</dd>
      </dl></section>
      <section class="p-sec"><h2>STACKED</h2><ul class="p-links">${stacked.map((x) => link(x[0], x[1], x[2])).join('')}</ul></section>
      <section class="p-sec"><h2>ADJACENT</h2><ul class="p-links">${(r.near || []).slice(0, 8).map((t) => link('·', r.level, t)).join('') || '<li class="none">NONE FOUND</li>'}</ul></section>
      <div class="p-nav">
        <button type="button" id="pPrev" aria-label="Previous room">◀ PREV</button>
        <button type="button" id="pBack">LEVEL ${CODE[r.level]}</button>
        <button type="button" id="pNext" aria-label="Next room">NEXT ▶</button>
      </div>
      <p class="p-note">Areas and sizes are measured from the drawing linework at 1/16" = 1'-0" (inside face of walls). Room names are expanded from the drawing labels.</p>`;
    panel.hidden = false;
    $('pClose').onclick = $('pBack').onclick = () => { S.lastInput = performance.now(); applyState('floor', r.level, null); };
    $('pPrev').onclick = () => { S.lastInput = performance.now(); gotoRoom(list[(idx - 1 + list.length) % list.length]); };
    $('pNext').onclick = () => { S.lastInput = performance.now(); gotoRoom(list[(idx + 1) % list.length]); };
    panel.querySelectorAll('button[data-tag]').forEach((b) => (b.onclick = () => { S.lastInput = performance.now(); gotoRoom(BYTAG.get(b.dataset.tag)); }));
  }
  function gotoRoom(r) {
    if (!r) return;
    applyState('room', r.level, r);
  }

  // ------------------------------------------------------------------ search
  const q = $('q'), results = $('results');
  let hits = [], hitSel = 0;
  function runSearch() {
    const s = q.value.trim().toUpperCase();
    if (!s) { results.hidden = true; hits = []; return; }
    const toks = s.split(/\s+/);
    hits = ROOMS.filter((r) => toks.every((t) => r._s.includes(t)));
    // whole-word matches first ("ICU 8" -> ICU PATIENT ROOM 8 before NICU 8)
    const score = (r) => (r.tag === s ? -10 : 0) + toks.reduce((acc, t) =>
      acc + (r._w.includes(t) ? 0 : r._w.some((w) => w.startsWith(t)) ? 1 : 3), 0);
    hits.sort((a, b) => score(a) - score(b) || a.level - b.level || a.tag.localeCompare(b.tag, 'en', { numeric: true }));
    hits = hits.slice(0, 12);
    hitSel = 0;
    results.innerHTML = hits.length
      ? hits.map((r, i) => `<li role="option" id="hit${i}" aria-selected="${i === hitSel}" data-i="${i}"><span class="lv">${CODE[r.level]}</span><span class="tg">${esc(r.tag)}</span><span class="nm">${esc(r.name)}</span></li>`).join('')
      : '<li class="none">NO MATCHING ROOMS</li>';
    results.hidden = false;
  }
  q.addEventListener('input', runSearch);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      hitSel = (hitSel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      results.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === hitSel)));
    } else if (e.key === 'Enter' && hits[hitSel]) {
      pickHit(hitSel);
    } else if (e.key === 'Escape') {
      q.value = ''; results.hidden = true; q.blur();
    }
    e.stopPropagation();
  });
  results.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); pickHit(+li.dataset.i); }
  });
  q.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 120));
  function pickHit(i) {
    const r = hits[i];
    results.hidden = true; q.value = ''; q.blur();
    S.lastInput = performance.now();
    gotoRoom(r);
  }

  // ------------------------------------------------------------------ input
  const pointers = new Map();
  let drag = null, pinch = null;
  function planAt(sx, sy) {
    const cam = S.camObj;
    if (!cam) return null;
    return rayPlane(cam, sx, sy, S.level ? S.lv[S.level].z : 0);
  }
  function pickLevel(sx, sy) {
    const cam = S.camObj;
    const order = LEVELS.slice().sort((a, b) => S.lv[b].z - S.lv[a].z);
    for (const n of order) {
      if (S.lv[n].a < 0.2) continue;
      const p = rayPlane(cam, sx, sy, S.lv[n].z);
      if (p && inRings(FOOT[n], p[0], p[1])) return n;
    }
    return null;
  }
  function pickRoom(sx, sy) {
    const p = planAt(sx, sy);
    if (!p) return null;
    S.cursorPlan = p;
    let best = null;
    for (const r of BYLEVEL[S.level] || []) {
      const b = r.bbox;
      if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
      if (inRings(r.rings, p[0], p[1]) && (!best || r.area < best.area)) best = r;
    }
    return best;
  }
  function hover(sx, sy) {
    const tip = $('tip');
    if (S.tween) { tip.hidden = true; return; }
    if (S.view === 'stack') {
      S.hoverLevel = pickLevel(sx, sy);
      canvas.classList.toggle('pick', S.hoverLevel != null);
      tip.hidden = true;
      return;
    }
    const r = pickRoom(sx, sy);
    S.hoverRoom = r;
    canvas.classList.toggle('pick', !!r);
    if (r && matchMedia('(hover: hover)').matches) {
      tip.innerHTML = `<b>${esc(r.name)}</b><span>${esc(r.tag)} · ${r.open ? '≈' : ''}${fmt(r.area)} FT²</span>`;
      tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = sx + 16, y = sy + 18;
      if (x + w > S.W - 8) x = sx - w - 16;
      if (y + h > S.H - 8) y = sy - h - 14;
      tip.style.transform = `translate(${x}px, ${y}px)`;
    } else tip.hidden = true;
  }
  function click(sx, sy) {
    if (S.view === 'stack') {
      const n = pickLevel(sx, sy);
      if (n) applyState('floor', n, null);
      return;
    }
    const r = pickRoom(sx, sy);
    if (r) { if (r !== S.room) applyState('room', r.level, r); }
    else if (S.view === 'room') applyState('floor', S.level, null);
  }
  canvas.addEventListener('pointerdown', (e) => {
    S.lastInput = performance.now();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 1) drag = { x: e.offsetX, y: e.offsetY, x0: e.offsetX, y0: e.offsetY, t: performance.now(), moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: S.cam.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      drag = null;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const x = e.offsetX, y = e.offsetY;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y });
    if (pinch && pointers.size === 2) {
      S.lastInput = performance.now();
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.s * d / pinch.d) / S.cam.s);
      return;
    }
    if (drag) {
      const dx = x - drag.x, dy = y - drag.y;
      if (Math.hypot(x - drag.x0, y - drag.y0) > 5) drag.moved = true;
      if (drag.moved) {
        S.lastInput = performance.now();
        canvas.classList.add('grab');
        $('tip').hidden = true;
        if (S.view === 'stack') {
          if (!S.tween) { S.orbitBase += dx * 0.25; S.pitchBase = clamp(S.pitchBase - dy * 0.15, 30, 72); S.orbitT = 0; }
        } else if (!S.tween) {
          S.cam.px -= dx / S.cam.s; S.cam.py -= dy / S.cam.s;
          clampPan();
        }
      }
      drag.x = x; drag.y = y;
      return;
    }
    hover(x, y);
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    canvas.classList.remove('grab');
    if (pinch && pointers.size < 2) { pinch = null; drag = null; return; }
    if (drag && !drag.moved && performance.now() - drag.t < 600) click(e.offsetX, e.offsetY);
    drag = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { if (!drag) { S.hoverRoom = null; if (S.view === 'stack') S.hoverLevel = null; $('tip').hidden = true; S.cursorPlan = null; } });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    S.lastInput = performance.now();
    const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    zoomAt(e.offsetX, e.offsetY, k);
  }, { passive: false });
  function zoomAt(sx, sy, k) {
    if (S.tween) return;
    if (S.view === 'stack') {
      const fit = fitStack(S.orbitBase, S.pitchBase).s;
      S.cam.s = clamp(S.cam.s * k, fit * 0.6, fit * 2.2);
      return;
    }
    const before = [S.cam.px + (sx - S.W / 2) / S.cam.s, S.cam.py + (sy - S.H / 2) / S.cam.s];
    S.cam.s = clamp(S.cam.s * k, floorScale(S.level) * 0.8, S_MAX);
    S.cam.px = before[0] - (sx - S.W / 2) / S.cam.s;
    S.cam.py = before[1] - (sy - S.H / 2) / S.cam.s;
    clampPan();
  }
  function clampPan() {
    const [x0, y0, x1, y1] = RECT[S.level];
    S.cam.px = clamp(S.cam.px, x0 - 60, x1 + 60);
    S.cam.py = clamp(S.cam.py, y0 - 60, y1 + 60);
  }
  window.addEventListener('keydown', (e) => {
    if (e.target === q) return;
    S.lastInput = performance.now();
    if (e.key === 'Escape') {
      if (S.view === 'room') applyState('floor', S.level, null);
      else if (S.view === 'floor') applyState('stack', null, null);
    } else if (e.key === '/') {
      e.preventDefault(); q.focus();
    } else if (/^[1-4]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      applyState('floor', +e.key, null);
    } else if (S.view !== 'stack' && !S.tween && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      if (S.view === 'room' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const list = BYLEVEL[S.level], i = list.indexOf(S.room);
        gotoRoom(list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]);
      } else {
        const step = 80 / S.cam.s;
        if (e.key === 'ArrowLeft') S.cam.px -= step; if (e.key === 'ArrowRight') S.cam.px += step;
        if (e.key === 'ArrowUp') S.cam.py -= step; if (e.key === 'ArrowDown') S.cam.py += step;
        clampPan();
      }
    } else if ((e.key === '+' || e.key === '=') && S.view !== 'stack') zoomAt(S.W / 2, S.H / 2, 1.25);
    else if ((e.key === '-' || e.key === '_') && S.view !== 'stack') zoomAt(S.W / 2, S.H / 2, 0.8);
  });
  window.addEventListener('resize', () => {
    resize();
    if (!S.ready) return;
    // re-fit the current view to the new size without animation
    const t = target(S.view, S.level, S.room);
    if (S.view === 'stack' || !S.tween) Object.assign(S.cam, t.cam);
  });

  // ------------------------------------------------------------------ deep links (#L2, #T2501)
  function writeHash() {
    const h = S.view === 'room' ? S.room.tag : S.view === 'floor' ? 'L' + S.level : '';
    try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch (e) { /* sandboxed */ }
  }
  function readHash() {
    const h = decodeURIComponent((location.hash || '').slice(1)).toUpperCase();
    if (/^L[1-4]$/.test(h)) return { view: 'floor', level: +h[1] };
    if (h === 'PH') return { view: 'floor', level: 4 };
    if (BYTAG.has(h)) { const r = BYTAG.get(h); return { view: 'room', level: r.level, room: r }; }
    return null;
  }
  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (h) applyState(h.view, h.level, h.room || null);
  });

  // ------------------------------------------------------------------ boot
  async function boot() {
    setDM($('loaderTitle'), 'MIH TOWER', 6, 0.12);
    const bar = $('loaderBar'), txt = $('loaderText');
    const steps = 2 + LEVELS.length * 2;
    let done = 0;
    const tick = (label) => { done++; bar.style.width = (100 * done / steps).toFixed(0) + '%'; txt.textContent = label; };
    try {
      const [rj, ij] = await Promise.all([fetch(DATA + 'rooms.json').then((r) => r.json()), fetch(DATA + 'imagery.json').then((r) => r.json())]);
      DATAJ = rj; IMG = ij;
      tick('READING ROOMS'); tick('READING SHEETS');
      ROOMS = rj.rooms;
      for (const r of ROOMS) {
        r.rings = r.rings.map((a) => a);
        r._s = `${r.tag} ${r.name} ${r.drawn || ''} ${CODE[r.level]} L${r.level} ${TYPE_LABEL[r.type] || ''}`.toUpperCase();
        r._w = r._s.split(/[\s/·()]+/).filter(Boolean);
        BYTAG.set(r.tag, r);
        (BYLEVEL[r.level] = BYLEVEL[r.level] || []).push(r);
      }
      for (const n of LEVELS) BYLEVEL[n].sort((a, b) => a.tag.localeCompare(b.tag, 'en', { numeric: true }));
      for (const n of LEVELS) {
        const lv = IMG.levels[n];
        FOOT[n] = lv.footprint;
        RECT[n] = ringsBBox(lv.footprint);
        lv.tileSet = new Set(lv.tiles.map(([i, j]) => i + ',' + j));
      }
      UNION = [Math.min(...LEVELS.map((n) => RECT[n][0])), Math.min(...LEVELS.map((n) => RECT[n][1])),
               Math.max(...LEVELS.map((n) => RECT[n][2])), Math.max(...LEVELS.map((n) => RECT[n][3]))];
      await Promise.all(LEVELS.map(async (n) => {
        const [o, m] = await Promise.all([loadBitmap(DATA + IMG.levels[n].overview), loadBitmap(DATA + IMG.levels[n].mask)]);
        TEX.over[n] = texFromBitmap(o, true, true); tick(`LEVEL ${CODE[n]} LINEWORK`);
        TEX.mask[n] = texFromBitmap(m, false, true); tick(`LEVEL ${CODE[n]} OUTLINE`);
        o.close && o.close(); m.close && m.close();
      }));
      const d = new Float32Array(IMG.ducts);
      ductCount = d.length / 3;
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
      ductVAO = gl.createVertexArray(); gl.bindVertexArray(ductVAO);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);
    } catch (err) {
      console.error(err);
      $('fatal').hidden = false;
      $('fatal').innerHTML = `<div><b>THE DRAWINGS DID NOT LOAD</b>${esc(err.message || err)}<br>Check the connection and reload.</div>`;
      return;
    }
    buildLevelNav();
    buildStackLabels();
    resize();
    const h = readHash();
    const t0 = target('stack');
    Object.assign(S.cam, t0.cam);
    LEVELS.forEach((n) => Object.assign(S.lv[n], t0.lv[n]));
    Object.assign(S.fx, t0.fx);
    S.ready = true;
    S.intro = h ? 1 : 0;
    updateUI();
    if (h) applyState(h.view, h.level, h.room || null, true);
    $('loader').classList.add('done');
  }
  // test hook: only with ?debug in the URL
  if (/[?&]debug(=|&|$)/.test(location.search)) {
    window.__mih = { S, BYTAG, BYLEVEL, applyState, project: (x, y, z) => project(S.camObj, x, y, z || 0) };
  }
  requestAnimationFrame(frame);
  boot();
})();
