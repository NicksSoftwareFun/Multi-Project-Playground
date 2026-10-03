// Procedural Rain World-style wallpaper: fogged layers of industrial ruin,
// plus the "play layer" decor that is also real geometry (ledges, poles,
// creature dens). The static part is rendered once to an offscreen canvas;
// rain, fog drift and swaying chains are drawn every frame.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  RW.PALETTES = {
    industrial: {
      skyTop: '#86938a', skyBot: '#3b4541', fog: '#5a6862', far: '#4a5651', mid: '#2e3734',
      near: '#181e1c', dark: '#0b0e0d', rust: '#7c4528', light: '#d8c88f', glow: '#ffb45c',
      rain: '#c8d4d0',
    },
    shoreline: {
      skyTop: '#a2b8c2', skyBot: '#405663', fog: '#64808e', far: '#506877', mid: '#2f404b',
      near: '#161f26', dark: '#080b0e', rust: '#5f6c5b', light: '#d6e8ec', glow: '#9fe0ff',
      rain: '#d6e6ee',
    },
    outskirts: {
      skyTop: '#e6c093', skyBot: '#715444', fog: '#a98a6b', far: '#8b705a', mid: '#4d3b31',
      near: '#251b16', dark: '#100b09', rust: '#a05a30', light: '#ffe2aa', glow: '#ffcf7a',
      rain: '#f0dcc0',
    },
    chimney: {
      skyTop: '#a3aec0', skyBot: '#4b5263', fog: '#717b8c', far: '#5d6677', mid: '#363c49',
      near: '#1b1e26', dark: '#0b0c10', rust: '#6e5a72', light: '#e9eeff', glow: '#c4d3ff',
      rain: '#dfe5f5',
    },
    subterranean: {
      skyTop: '#323946', skyBot: '#0f1116', fog: '#272d39', far: '#1f242e', mid: '#151820',
      near: '#0c0e12', dark: '#050608', rust: '#3f302a', light: '#8394b5', glow: '#5ab0ff',
      rain: '#8e9bb5',
    },
  };

  // ---- decor generation (static geometry) ----------------------------------
  function generateDecor(W, H, cfg, rnd) {
    const R = (a, b) => a + rnd() * (b - a);
    const ledges = [];
    const nL = cfg.world.decorLedges | 0;
    const overlaps = (a, pad) =>
      ledges.some((b) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y);
    for (let i = 0, tries = 0; i < nL && tries < 300; tries++) {
      const w = Math.round(R(130, 320));
      const h = Math.round(R(22, 38));
      let x;
      const side = rnd();
      if (side < 0.15) x = 0;
      else if (side < 0.3) x = W - w;
      else x = Math.round(R(W * 0.06, W * 0.94 - w));
      const y = Math.round(R(H * 0.2, H * 0.74));
      const L = { id: 'ledge-' + i, kind: 'ledge', x, y, w, h, seed: rnd() * 1000 };
      if (overlaps(L, 70)) continue;
      ledges.push(L);
      i++;
    }

    const poles = [];
    const blocked = (x, y1, y2) => ledges.some((l) => x > l.x - 6 && x < l.x + l.w + 6 && y2 > l.y && y1 < l.y + l.h);
    const nP = cfg.world.decorPoles | 0;
    for (let i = 0, tries = 0; i < nP && tries < 200; tries++) {
      let x;
      let y1;
      const y2 = H + 5;
      if (ledges.length && rnd() < 0.65) {
        const l = ledges[Math.floor(rnd() * ledges.length)];
        x = rnd() < 0.5 ? l.x - 14 : l.x + l.w + 14;
        y1 = l.y - R(30, 90);
      } else {
        x = R(W * 0.04, W * 0.96);
        y1 = R(H * 0.15, H * 0.6);
      }
      x = Math.round(x);
      if (x < 8 || x > W - 8) continue;
      if (blocked(x, y1, y2)) continue;
      if (poles.some((p) => Math.abs(p.x - x) < 40)) continue;
      poles.push({ id: 'pole-' + i, x, y1: Math.round(y1), y2 });
      i++;
    }

    // Dens ("shortcut" pipe mouths) in the screen walls and on ledges.
    const dens = [];
    for (const side of [0, 1]) {
      const n = 2;
      for (let k = 0; k < n; k++) {
        const y = Math.round(H * (0.3 + 0.45 * ((k + R(0.1, 0.9)) / n)));
        dens.push({ x: side ? W - 1 : 1, y, dir: side ? -1 : 1, wall: true });
      }
    }
    for (const l of ledges) {
      if (rnd() < 0.5) dens.push({ x: Math.round(l.x + R(20, l.w - 20)), y: l.y, dir: 0, wall: false });
    }

    // Dangle fruit plants hang from ledge undersides and the top of the screen.
    const fruitPlants = [];
    const nF = cfg.world.fruitPlants | 0;
    for (let i = 0; i < nF; i++) {
      if (ledges.length && rnd() < 0.7) {
        const l = ledges[Math.floor(rnd() * ledges.length)];
        fruitPlants.push({ x: Math.round(l.x + R(15, l.w - 15)), y: l.y + l.h, len: R(28, 55) });
      } else {
        fruitPlants.push({ x: Math.round(R(W * 0.1, W * 0.9)), y: 0, len: R(40, 90) });
      }
    }

    // Batfly grass (roosts) on ledge tops.
    const grass = [];
    for (const l of ledges) {
      if (rnd() < 0.6) grass.push({ x: Math.round(l.x + R(12, l.w - 12)), y: l.y, h: R(22, 38), phase: rnd() * 10 });
    }

    const chains = [];
    const nC = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < nC; i++) {
      chains.push({ x: R(W * 0.05, W * 0.95), len: R(60, H * 0.35), phase: rnd() * 10, depth: R(0.25, 0.6) });
    }

    return { ledges, poles, dens, fruitPlants, grass, chains };
  }

  // ---- static painting ----------------------------------------------------
  function paint(canvas, W, H, ps, pal, decor, seed) {
    const rnd = U.mulberry32(seed * 7919 + 13);
    const R = (a, b) => a + rnd() * (b - a);
    canvas.width = Math.ceil(W / ps);
    canvas.height = Math.ceil(H / ps);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1 / ps, 0, 0, 1 / ps, 0, 0);
    const depthCol = (base, d) => U.rgba(U.mix(base, pal.fog, d));

    // Sky
    let g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, pal.skyTop);
    g.addColorStop(0.55, U.rgba(U.mix(pal.skyTop, pal.skyBot, 0.55)));
    g.addColorStop(1, pal.skyBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Light shafts
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const x = R(-W * 0.2, W);
      const wTop = R(30, 120);
      const lean = R(0.25, 0.55) * H;
      const sg = ctx.createLinearGradient(0, 0, 0, H);
      sg.addColorStop(0, U.rgba(pal.light, 0.08));
      sg.addColorStop(1, U.rgba(pal.light, 0));
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + wTop, 0);
      ctx.lineTo(x + wTop * 2.4 + lean, H);
      ctx.lineTo(x + lean, H);
      ctx.fill();
    }
    ctx.restore();

    // Each silhouette layer is painted separately and snapped to hard pixel
    // edges before compositing, so shapes read as pixel art, not vectors.
    const layer = (fn) => {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      const l = c.getContext('2d', { willReadFrequently: true });
      l.setTransform(1 / ps, 0, 0, 1 / ps, 0, 0);
      fn(l);
      U.crisp(c, 128);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(c, 0, 0);
      ctx.restore();
    };
    // Far superstructure
    layer((l) => farLayer(l, W, H, pal, R, rnd, 0.62));
    fogWash(ctx, W, H, pal, 0.35, 0.45);
    // Mid industrial layer
    layer((l) => midLayer(l, W, H, pal, R, rnd, 0.38));
    fogWash(ctx, W, H, pal, 0.18, 0.35);
    // Near layer
    layer((l) => nearLayer(l, W, H, pal, R, rnd, 0.12));

    // Play layer: poles then ledges
    layer((l) => {
      for (const p of decor.poles) drawPole(l, p, pal);
      for (const lg of decor.ledges) drawLedge(l, lg, pal);
      for (const d of decor.dens) drawDenStatic(l, d, pal);
    });

    // Grain + vignette at native internal resolution.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    grain(ctx, canvas.width, canvas.height, rnd);
    const vg = ctx.createRadialGradient(
      canvas.width / 2, canvas.height * 0.45, Math.min(canvas.width, canvas.height) * 0.35,
      canvas.width / 2, canvas.height * 0.5, Math.max(canvas.width, canvas.height) * 0.8
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, U.rgba(pal.dark, 0.55));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;

    function fogWash(ctx, W, H, pal, a0, a1) {
      const fg = ctx.createLinearGradient(0, 0, 0, H);
      fg.addColorStop(0, U.rgba(pal.fog, a0 * 0.4));
      fg.addColorStop(0.6, U.rgba(pal.fog, a0));
      fg.addColorStop(1, U.rgba(pal.fog, a1));
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function farLayer(ctx, W, H, pal, R, rnd, d) {
    const col = U.rgba(U.mix(pal.far, pal.fog, d * 0.6));
    const colLit = U.rgba(U.mix(pal.far, pal.light, 0.08));
    ctx.fillStyle = col;
    let x = R(-80, 0);
    while (x < W + 80) {
      const w = R(40, 170);
      const top = R(H * 0.06, H * 0.55);
      ctx.fillStyle = col;
      ctx.fillRect(x, top, w, H - top);
      // stepped crown
      if (rnd() < 0.7) {
        const cw = w * R(0.3, 0.7);
        const ch = R(15, 60);
        ctx.fillRect(x + (w - cw) * R(0, 1), top - ch, cw, ch + 1);
      }
      // antenna / spire
      if (rnd() < 0.5) {
        ctx.fillRect(x + w * R(0.2, 0.8), top - R(40, 140), R(2, 4), R(40, 140));
      }
      // horizontal banding
      ctx.fillStyle = colLit;
      for (let y = top + R(10, 30); y < H; y += R(18, 60)) ctx.fillRect(x, y, w, R(1, 3));
      // occasional dim windows
      if (rnd() < 0.35) {
        ctx.fillStyle = U.rgba(pal.glow, 0.12);
        for (let k = 0; k < 6; k++) ctx.fillRect(x + R(4, w - 8), R(top + 10, H * 0.9), 3, 4);
      }
      x += w + R(-20, 60);
    }
    // Bridges between towers
    ctx.fillStyle = col;
    for (let i = 0; i < 3; i++) {
      const y = R(H * 0.2, H * 0.6);
      const x0 = R(-50, W * 0.6);
      const len = R(W * 0.2, W * 0.6);
      ctx.fillRect(x0, y, len, R(6, 14));
      for (let ax = x0; ax < x0 + len; ax += R(40, 90)) {
        ctx.beginPath();
        ctx.arc(ax + 20, y + 8, 20, Math.PI, 0, true);
        ctx.lineWidth = 3;
        ctx.strokeStyle = col;
        ctx.stroke();
      }
    }
  }

  function midLayer(ctx, W, H, pal, R, rnd, d) {
    const col = U.rgba(U.mix(pal.mid, pal.fog, d));
    const colHi = U.rgba(U.mix(U.mix(pal.mid, pal.fog, d), pal.light, 0.12));
    const rust = U.rgba(U.mix(pal.rust, pal.fog, d + 0.4));
    // Ground-up blocks
    let x = R(-40, 0);
    while (x < W) {
      const w = R(60, 220);
      const top = R(H * 0.45, H * 0.85);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x, top);
      // jagged broken top
      const steps = Math.floor(R(3, 8));
      for (let s = 1; s <= steps; s++) ctx.lineTo(x + (w * s) / steps, top + R(-25, 25));
      ctx.lineTo(x + w, H);
      ctx.fill();
      // ruined machinery detail: vents, ribs, broken openings, overgrown crown
      ctx.fillStyle = U.rgba(pal.dark, 0.22);
      for (let k = 0; k < w / 25; k++) {
        const r = rnd();
        const vx = x + R(4, w - 20);
        const vy = R(top + 15, H - 30);
        if (r < 0.35) ctx.fillRect(vx, vy, R(10, 30), R(3, 6)); // vent slot
        else if (r < 0.6) ctx.fillRect(vx, vy, R(3, 5), R(30, 90)); // rib
        else if (r < 0.75) {
          ctx.beginPath();
          ctx.arc(vx + 8, vy, R(5, 12), 0, U.TAU);
          ctx.fill();
        }
      }
      ctx.fillStyle = U.rgba(U.mix(U.mix(pal.mid, '#33502f', 0.3), pal.fog, d));
      for (let k = 0; k < w / 12; k++) {
        ctx.beginPath();
        ctx.ellipse(x + R(0, w), top + R(-6, 10), R(6, 16), R(3, 8), 0, 0, U.TAU);
        ctx.fill();
      }
      x += w + R(30, 160);
    }
    // Trusses
    for (let i = 0; i < 3; i++) {
      const y = R(H * 0.12, H * 0.62);
      const th = R(12, 22);
      const x0 = rnd() < 0.5 ? -10 : R(0, W * 0.5);
      const x1 = rnd() < 0.5 ? W + 10 : R(W * 0.5, W);
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.moveTo(x0, y + th);
      ctx.lineTo(x1, y + th);
      let up = true;
      for (let tx = x0; tx < x1; tx += th) {
        ctx.moveTo(tx, up ? y : y + th);
        ctx.lineTo(tx + th, up ? y + th : y);
        up = !up;
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = colHi;
      ctx.beginPath();
      ctx.moveTo(x0, y - 1);
      ctx.lineTo(x1, y - 1);
      ctx.stroke();
      // supports down to the ground
      ctx.fillStyle = col;
      for (let sx = x0 + R(40, 200); sx < x1; sx += R(200, 450)) ctx.fillRect(sx, y + th, R(6, 12), H);
    }
    // Big pipes
    for (let i = 0; i < 4; i++) {
      const horizontal = rnd() < 0.6;
      const th = R(8, 22);
      ctx.fillStyle = rnd() < 0.4 ? rust : col;
      if (horizontal) {
        const y = R(H * 0.1, H * 0.8);
        ctx.fillRect(-10, y, W + 20, th);
        ctx.fillStyle = colHi;
        ctx.fillRect(-10, y + 1, W + 20, 1.5);
        ctx.fillStyle = col;
        for (let fx = R(0, 120); fx < W; fx += R(90, 220)) ctx.fillRect(fx, y - 3, 6, th + 6);
      } else {
        const px = R(0, W);
        const top = R(-10, H * 0.5);
        ctx.fillRect(px, top, th, H - top);
        ctx.fillStyle = col;
        for (let fy = top + R(0, 60); fy < H; fy += R(80, 200)) ctx.fillRect(px - 3, fy, th + 6, 6);
      }
    }
    // Cables
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      const x0 = R(-50, W);
      const x1 = x0 + R(100, 500);
      const y0 = R(0, H * 0.4);
      const y1 = y0 + R(-40, 40);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + x1) / 2, Math.max(y0, y1) + R(30, 120), x1, y1);
      ctx.stroke();
    }
  }

  function nearLayer(ctx, W, H, pal, R, rnd, d) {
    const col = U.rgba(U.mix(pal.near, pal.fog, d));
    const leaf = U.rgba(U.mix(U.mix(pal.near, '#3b5a35', 0.35), pal.fog, d));
    // Columns at edges
    ctx.fillStyle = col;
    for (let i = 0; i < 3; i++) {
      const w = R(18, 50);
      const x = rnd() < 0.5 ? R(-20, W * 0.15) : R(W * 0.85, W);
      ctx.fillRect(x, -5, w, H + 10);
      ctx.fillStyle = U.rgba(pal.dark, 0.35);
      for (let y = R(0, 40); y < H; y += R(30, 70)) ctx.fillRect(x, y, w, 3);
      ctx.fillStyle = col;
    }
    // Foreground machinery silhouettes hugging the bottom corners
    for (const side of [0, 1]) {
      const bx = side ? W - R(120, 260) : R(-60, 20);
      const bw = R(160, 300);
      const bt = H - R(80, 200);
      ctx.fillStyle = col;
      ctx.fillRect(bx, bt, bw, H - bt);
      ctx.beginPath();
      ctx.arc(bx + bw * R(0.3, 0.7), bt, R(30, 60), Math.PI, 0);
      ctx.fill();
      ctx.fillRect(bx + bw * R(0.1, 0.8), bt - R(60, 160), R(8, 16), H);
      ctx.fillStyle = U.rgba(pal.dark, 0.4);
      for (let k = 0; k < 6; k++) ctx.fillRect(bx + R(0, bw - 20), R(bt + 10, H - 10), R(10, 40), 3);
    }
    ctx.fillStyle = col;
    // Hanging growth from the top
    ctx.strokeStyle = leaf;
    ctx.lineCap = 'round';
    for (let i = 0; i < 40; i++) {
      const x = R(0, W);
      const len = R(20, H * 0.28);
      ctx.lineWidth = R(1, 2.5);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      const sway = R(-15, 15);
      ctx.quadraticCurveTo(x + sway, len * 0.6, x + sway * 0.4, len);
      ctx.stroke();
      if (rnd() < 0.6) {
        ctx.fillStyle = leaf;
        for (let k = 0; k < 4; k++) {
          const t = R(0.3, 1);
          ctx.beginPath();
          ctx.ellipse(x + sway * t * 0.6, len * t, R(2, 5), R(1, 2), R(-1, 1), 0, U.TAU);
          ctx.fill();
        }
      }
    }
    // Ground clutter and grass at the bottom
    ctx.fillStyle = col;
    for (let i = 0; i < 30; i++) {
      const x = R(0, W);
      const w = R(10, 60);
      const h = R(4, 26);
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x + w * 0.2, H - h);
      ctx.lineTo(x + w * 0.7, H - h * R(0.5, 1));
      ctx.lineTo(x + w, H);
      ctx.fill();
    }
    ctx.strokeStyle = leaf;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 120; i++) {
      const x = R(0, W);
      const h = R(6, 40);
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.quadraticCurveTo(x + R(-4, 4), H - h * 0.5, x + R(-10, 10), H - h);
      ctx.stroke();
    }
    // Rust streaks
    for (let i = 0; i < 25; i++) {
      const x = R(0, W);
      const y = R(0, H * 0.7);
      const sg = ctx.createLinearGradient(0, y, 0, y + 120);
      sg.addColorStop(0, U.rgba(pal.rust, 0.18));
      sg.addColorStop(1, U.rgba(pal.rust, 0));
      ctx.fillStyle = sg;
      ctx.fillRect(x, y, R(2, 6), 120);
    }
  }

  function drawPole(ctx, p, pal) {
    const c = U.mix(pal.dark, pal.near, 0.5);
    ctx.fillStyle = U.rgba(c);
    ctx.fillRect(p.x - 2, p.y1, 4, p.y2 - p.y1);
    ctx.fillStyle = U.rgba(U.mix(c, pal.light, 0.25), 0.7);
    ctx.fillRect(p.x - 2, p.y1, 1, p.y2 - p.y1);
    // bent tip and clamps, like scavenged rebar
    ctx.fillStyle = U.rgba(c);
    ctx.fillRect(p.x - 2, p.y1 - 3, 7, 3);
    for (let y = p.y1 + 40; y < p.y2; y += 110) ctx.fillRect(p.x - 4, y, 8, 4);
  }

  function drawLedge(ctx, l, pal) {
    const rnd = U.mulberry32((l.seed * 1000) | 0);
    const R = (a, b) => a + rnd() * (b - a);
    const base = U.mix(pal.dark, pal.near, 0.6);
    ctx.fillStyle = U.rgba(base);
    ctx.fillRect(l.x, l.y, l.w, l.h);
    // crumbling underside
    ctx.beginPath();
    ctx.moveTo(l.x, l.y + l.h);
    for (let x = l.x; x <= l.x + l.w; x += R(6, 14)) ctx.lineTo(Math.min(x, l.x + l.w), l.y + l.h + R(0, 7));
    ctx.lineTo(l.x + l.w, l.y + l.h);
    ctx.fill();
    // masonry seams
    ctx.fillStyle = U.rgba(pal.dark, 0.6);
    for (let x = l.x + R(10, 30); x < l.x + l.w - 4; x += R(22, 48)) ctx.fillRect(x, l.y + 4, 1.5, l.h - 6);
    ctx.fillRect(l.x, l.y + l.h * 0.5, l.w, 1);
    // lit top edge
    ctx.fillStyle = U.rgba(U.mix(base, pal.light, 0.28));
    ctx.fillRect(l.x, l.y, l.w, 2);
    // moss strands hanging off
    ctx.strokeStyle = U.rgba(U.mix(pal.near, '#4d6b3c', 0.3));
    ctx.lineWidth = 1.2;
    for (let i = 0; i < l.w / 18; i++) {
      const x = l.x + R(2, l.w - 2);
      const len = R(4, 26);
      ctx.beginPath();
      ctx.moveTo(x, l.y + l.h);
      ctx.lineTo(x + R(-2, 2), l.y + l.h + len);
      ctx.stroke();
    }
  }

  function drawDenStatic(ctx, d, pal) {
    const rim = U.mix(pal.dark, pal.light, 0.18);
    ctx.save();
    ctx.translate(d.x, d.y);
    if (d.wall) {
      // pipe mouth set into the screen wall
      ctx.fillStyle = U.rgba(rim);
      ctx.fillRect(d.dir > 0 ? 0 : -14, -14, 14, 28);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(d.dir > 0 ? 6 : -6, 0, 5, 10, 0, 0, U.TAU);
      ctx.fill();
    } else {
      ctx.fillStyle = U.rgba(rim);
      ctx.fillRect(-14, -5, 28, 7);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(0, -2, 10, 3.5, 0, 0, U.TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function grain(ctx, w, h, rnd) {
    const img = ctx.getImageData(0, 0, w, h);
    const a = img.data;
    for (let i = 0; i < a.length; i += 4) {
      const n = (rnd() - 0.5) * 10;
      a[i] += n;
      a[i + 1] += n;
      a[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---- dynamic layer --------------------------------------------------------
  class Weather {
    constructor() {
      this.drops = [];
      this.splashes = [];
      this.fog = [];
      this.t = 0;
      this.intensity = 0.2;
      this.phase = 0;
      this.flash = 0;
      this.drips = null;
      this.decor = null;
      this.world = null;
      this.curtains = [];
    }

    reset(W, H) {
      this.fog = [];
      for (let i = 0; i < 6; i++) {
        this.fog.push({ x: U.rand(0, W), y: U.rand(H * 0.2, H), r: U.rand(150, 400), v: U.rand(4, 14) * U.sign(), a: U.rand(0.05, 0.12) });
      }
      // Broad, faint sheets of rain drifting across the scene.
      this.curtains = [];
      for (let i = 0; i < 4; i++) this.curtains.push({ x: U.rand(-W * 0.3, W), w: U.rand(W * 0.12, W * 0.35), v: U.rand(8, 22), a: U.rand(0.5, 1) });
      this.drips = RW.Drips ? new RW.Drips() : null;
    }

    // Rain cycle: drizzle for most of it, building to a downpour at the end.
    update(dt, cfg, W, H, world) {
      this.t += dt;
      const rc = cfg.rain;
      const cycle = Math.max(0.5, rc.cycleMinutes) * 60;
      this.phase = (this.t % cycle) / cycle;
      const dp = U.clamp(rc.downpourFraction, 0.02, 0.6);
      const buildStart = 1 - dp - 0.12;
      let target = rc.drizzle;
      if (this.phase > buildStart) target = U.lerp(rc.drizzle, 1, U.smooth(U.clamp((this.phase - buildStart) / 0.12, 0, 1)));
      if (!rc.enabled) target = 0;
      this.intensity = target;
      this.downpour = rc.enabled && this.phase > 1 - dp;

      // Drips: present from the start of the cycle, building as it goes on.
      if (this.drips && world) {
        const amount = rc.enabled ? (rc.drips ?? 0.7) * (0.6 + 0.6 * this.phase + this.intensity * 1.2) : 0;
        this.drips.update(dt, world, this.decor, amount, 60 + this.intensity * 220, this.t);
        this.world = world;
      }
      for (const c of this.curtains) {
        c.x += (c.v + this.intensity * 60) * dt;
        if (c.x > W + 200) c.x = -c.w - 200;
      }
      this.curtainsOn = rc.enabled && rc.curtains !== false;

      const want = Math.floor(this.intensity * 520);
      while (this.drops.length < want) this.drops.push(this.newDrop(W, H, true));
      if (this.drops.length > want) this.drops.length = want;
      const wind = 60 + this.intensity * 220;
      for (const d of this.drops) {
        d.y += d.v * dt;
        d.x += wind * d.z * dt;
        if (d.z > 0.6 && world && world.isSolidPt(d.x, d.y) && !world.isSolidPt(d.x, d.y - 12)) {
          if (this.splashes.length < 160) this.splashes.push({ x: d.x, y: d.y, t: 0 });
          Object.assign(d, this.newDrop(W, H, false));
        } else if (d.y > H + 20 || d.x > W + 40) {
          Object.assign(d, this.newDrop(W, H, false));
        }
      }
      for (const s of this.splashes) s.t += dt;
      this.splashes = this.splashes.filter((s) => s.t < 0.25);
      for (const f of this.fog) {
        f.x += f.v * dt;
        if (f.x > W + f.r) f.x = -f.r;
        if (f.x < -f.r) f.x = W + f.r;
      }
    }

    newDrop(W, H, anywhere) {
      const z = Math.random();
      return {
        x: U.rand(-100, W),
        y: anywhere ? U.rand(-H * 0.1, H) : U.rand(-80, -10),
        v: 700 + z * 900,
        len: 8 + z * 22,
        z,
      };
    }

    // Fog puffs are one pre-rendered gradient sprite, stretched and faded;
    // building six radial gradients every frame was a measurable cost.
    drawFog(ctx, pal) {
      if (this.fogSpritePal !== pal) {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g2 = c.getContext('2d');
        const g = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
        g.addColorStop(0, U.rgba(pal.fog, 1));
        g.addColorStop(1, U.rgba(pal.fog, 0));
        g2.fillStyle = g;
        g2.fillRect(0, 0, 128, 128);
        this.fogSprite = c;
        this.fogSpritePal = pal;
      }
      const a0 = ctx.globalAlpha;
      for (const f of this.fog) {
        ctx.globalAlpha = Math.min(1, f.a * (0.6 + this.intensity));
        ctx.drawImage(this.fogSprite, f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
      }
      ctx.globalAlpha = a0;
    }

    drawChains(ctx, decor, pal, t) {
      for (const c of decor.chains) {
        const col = U.rgba(U.mix(pal.near, pal.fog, c.depth));
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        const sway = Math.sin(t * 0.6 + c.phase) * 6 * (0.5 + this.intensity);
        const n = Math.floor(c.len / 7);
        for (let i = 0; i < n; i++) {
          const k = i / n;
          const x = c.x + sway * k * k;
          const y = i * 7;
          ctx.beginPath();
          if (i % 2) ctx.ellipse(x, y, 1.2, 3.5, sway * 0.01, 0, U.TAU);
          else ctx.ellipse(x, y, 2.6, 3.5, sway * 0.01, 0, U.TAU);
          ctx.stroke();
        }
      }
    }

    drawRain(ctx, pal) {
      ctx.lineCap = 'butt';
      const slant = 0.12 + this.intensity * 0.18;
      if (this.curtainsOn && this.world) {
        const H = this.world.h;
        const a = 0.035 * (0.6 + this.intensity * 2.5);
        for (const c of this.curtains) {
          const g = ctx.createLinearGradient(c.x, 0, c.x + c.w, 0);
          g.addColorStop(0, U.rgba(pal.rain, 0));
          g.addColorStop(0.5, U.rgba(pal.rain, a * c.a));
          g.addColorStop(1, U.rgba(pal.rain, 0));
          ctx.fillStyle = g;
          const lean = H * slant;
          ctx.beginPath();
          ctx.moveTo(c.x + lean, 0);
          ctx.lineTo(c.x + c.w + lean, 0);
          ctx.lineTo(c.x + c.w, H);
          ctx.lineTo(c.x, H);
          ctx.fill();
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        // opaque colours pre-mixed toward the fog read as crisp pixel streaks
        ctx.strokeStyle = U.rgba(U.mix(pal.fog, pal.rain, pass ? 0.7 : 0.35));
        ctx.lineWidth = this.artPx || 1;
        ctx.beginPath();
        for (const d of this.drops) {
          if ((d.z > 0.6) !== !!pass) continue;
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - d.len * slant, d.y - d.len);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = U.rgba(pal.rain, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const s of this.splashes) {
        const r = 2 + s.t * 30;
        ctx.moveTo(s.x - r, s.y - s.t * 10);
        ctx.lineTo(s.x - r * 0.4, s.y);
        ctx.moveTo(s.x + r, s.y - s.t * 10);
        ctx.lineTo(s.x + r * 0.4, s.y);
      }
      ctx.stroke();
      if (this.drips && this.world) this.drips.draw(ctx, pal, this.world);
      if (this.downpour) {
        ctx.fillStyle = U.rgba(pal.fog, 0.18);
        ctx.fillRect(0, 0, 1e5, 1e5);
      }
    }

    // Rain World's cycle indicator: a ring of pips that empties as the rain approaches.
    drawHud(ctx, W, H, pal) {
      const pips = 16;
      const left = Math.ceil((1 - this.phase) * pips);
      const cx = W - 70;
      const cy = H - 110;
      for (let i = 0; i < pips; i++) {
        const a = -Math.PI / 2 + (i / pips) * U.TAU;
        const on = i < left;
        // opaque square pips: crisp like the rest of the pixel art
        ctx.fillStyle = U.rgba(on ? U.mix(pal.fog, pal.light, 0.6) : U.mix(pal.fog, pal.dark, 0.5));
        ctx.fillRect(Math.round(cx + Math.cos(a) * 18) - 2, Math.round(cy + Math.sin(a) * 18) - 2, 4, 4);
      }
    }
  }

  RW.Background = { generateDecor, paint, Weather };
})();
