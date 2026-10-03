// Dripping water, as early in a Rain World cycle: beads swell on the
// undersides of windows, desktop icons and ledges, stretch, let go, and
// splash (spray + ripple) on whatever they hit. A few steady trickles run off
// ledge ends. Drips follow the solid they hang from, so dragging a window
// carries its drips along.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  const GRAV = 1300;
  const DRIP_KINDS = { window: 1, icon: 1, ledge: 1 };

  class Drips {
    constructor() {
      this.bySolid = new Map(); // solid id -> { w, list: [source] }
      this.free = []; // sources not tied to a solid (vine tips, screen top)
      this.drops = [];
      this.spray = [];
      this.ripples = [];
      this.trickles = [];
      this.version = -1;
      this.t = 0;
    }

    // Keep sources stable across geometry changes: only solids that are new
    // or were resized get fresh sources, so a dragged window keeps its beads.
    rebuild(world, decor) {
      const seen = new Set();
      for (const s of world.solids) {
        if (!DRIP_KINDS[s.kind] || s.w < 16) continue;
        seen.add(s.id);
        const prev = this.bySolid.get(s.id);
        if (prev && Math.abs(prev.w - s.w) < 1) continue;
        const list = [];
        const n = Math.max(1, Math.round((s.w / 70) * U.rand(0.6, 1.4)));
        for (let i = 0; i < n; i++) {
          list.push({ ox: U.rand(6, s.w - 6), t: Math.random(), speed: U.rand(0.12, 0.55), wob: U.rand(0, 10) });
        }
        // painted ledges have a ragged underside; hang beads from its tips
        this.bySolid.set(s.id, { w: s.w, list, drop: s.kind === 'ledge' ? 4 : 0 });
      }
      for (const id of [...this.bySolid.keys()]) if (!seen.has(id)) this.bySolid.delete(id);

      if (this.version < 0) {
        // Static sources: hanging chain/vine tips and seeps along the top edge.
        this.free = [];
        if (decor) {
          for (const c of decor.chains) this.free.push({ x: c.x, y: c.len, t: Math.random(), speed: U.rand(0.1, 0.35), wob: U.rand(0, 10), chain: c });
          for (const p of decor.fruitPlants) this.free.push({ x: p.x + 2, y: p.y + 6, t: Math.random(), speed: U.rand(0.08, 0.25), wob: U.rand(0, 10) });
        }
        const nTop = Math.round(world.w / 160);
        for (let i = 0; i < nTop; i++) this.free.push({ x: U.rand(10, world.w - 10), y: 0, t: Math.random(), speed: U.rand(0.1, 0.4), wob: U.rand(0, 10) });
        // Trickles off a couple of ledge ends.
        this.trickles = [];
        if (decor) {
          const ledges = decor.ledges.filter((l) => l.x > 4 && l.x + l.w < world.w - 4);
          for (let i = 0; i < Math.min(2, ledges.length); i++) {
            const l = ledges[Math.floor(Math.random() * ledges.length)];
            const right = Math.random() < 0.5;
            this.trickles.push({ x: right ? l.x + l.w + 1 : l.x - 1, y: l.y + 3, phase: U.rand(0, 10), flow: U.rand(0.6, 1) });
          }
        }
      }
      this.version = world.version;
    }

    sources(world) {
      const out = [];
      const byId = new Map();
      for (const s of world.solids) byId.set(s.id, s);
      for (const [id, rec] of this.bySolid) {
        const s = byId.get(id);
        if (!s) continue;
        for (const src of rec.list) {
          src.x = s.x + src.ox;
          src.y = s.y + s.h + rec.drop;
          out.push(src);
        }
      }
      return out.concat(this.free);
    }

    update(dt, world, decor, amount, wind, t, flow) {
      this.t = t;
      this.flow = flow === undefined ? 1 : flow; // how hard the ledge ends pour (0 = dry)
      if (world.version !== this.version) this.rebuild(world, decor);
      const H = world.h;
      for (const src of this.sources(world)) {
        if (src.chain) {
          const sway = Math.sin(t * 0.6 + src.chain.phase) * 6;
          src.x = src.chain.x + sway;
        }
        // A covered source (another window over it) doesn't drip.
        src.hidden = world.isSolidPt(src.x, src.y + 1);
        if (src.hidden || amount <= 0) continue;
        src.t += dt * src.speed * amount;
        if (src.t >= 1) {
          src.t = -U.rand(0, 0.6); // a pause before the next bead forms
          this.drops.push({ x: src.x, y: src.y + 3, vy: 30, vx: 0 });
        }
      }

      for (const d of this.drops) {
        d.vy += GRAV * dt;
        d.vx += (wind * 0.15 - d.vx) * dt;
        d.y += d.vy * dt;
        d.x += d.vx * dt;
        if (world.isSolidPt(d.x, d.y)) {
          // find the surface we hit
          let sy = d.y;
          for (let k = 0; k < 30 && world.isSolidPt(d.x, sy); k++) sy -= 1;
          this.splash(d.x, sy, Math.min(1, d.vy / 900));
          d.dead = true;
        } else if (d.y > H + 10) {
          d.dead = true;
        }
      }
      this.drops = this.drops.filter((d) => !d.dead);

      for (const tr of this.trickles) {
        if (world.isSolidPt(tr.x, tr.y)) {
          tr.land = null;
          continue;
        }
        const hit = world.raycast(tr.x, tr.y, tr.x, H + 5);
        tr.land = hit ? hit.y : H;
        if (Math.random() < dt * 14 * tr.flow * this.flow * Math.max(0.3, amount)) this.splash(tr.x + U.rand(-1, 1), tr.land, 0.5, true);
      }

      for (const p of this.spray) {
        p.vy += GRAV * 0.6 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.t += dt;
      }
      this.spray = this.spray.filter((p) => p.t < p.life);
      for (const r of this.ripples) r.t += dt;
      this.ripples = this.ripples.filter((r) => r.t < r.life);
    }

    splash(x, y, force, quiet) {
      const n = quiet ? 1 : 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n && this.spray.length < 300; i++) {
        this.spray.push({
          x,
          y: y - 1,
          vx: U.rand(-70, 70) * (0.5 + force),
          vy: -U.rand(60, 170) * (0.4 + force),
          t: 0,
          life: U.rand(0.18, 0.4),
        });
      }
      if (!quiet || Math.random() < 0.3) {
        if (this.ripples.length < 120) this.ripples.push({ x, y, t: 0, life: U.rand(0.45, 0.8), size: U.rand(8, 16) * (0.6 + force) });
      }
    }

    draw(ctx, pal, world) {
      const water = U.mix(U.mix(pal.rain, pal.light, 0.4), '#ffffff', 0.35);
      const waterCol = (a) => U.rgba(water, a);

      // Trickles: a thin broken stream with a little mist at the bottom.
      const fl = this.flow === undefined ? 1 : this.flow;
      for (const tr of this.trickles) {
        if (tr.land == null || fl < 0.02) continue;
        const waterCol = (a) => U.rgba(water, a * fl); // fades out as the rain eases
        ctx.strokeStyle = waterCol(0.18);
        ctx.lineWidth = 1.8 * (0.5 + 0.5 * fl);
        ctx.beginPath();
        for (let y = tr.y; y < tr.land; y += 6) {
          const wob = Math.sin(y * 0.05 + this.t * 3) * 0.6 * Math.min(1, (y - tr.y) / 60);
          if (y === tr.y) ctx.moveTo(tr.x + wob, y);
          else ctx.lineTo(tr.x + wob, y);
        }
        ctx.lineTo(tr.x, tr.land);
        ctx.stroke();
        ctx.strokeStyle = waterCol(0.4);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        const seg = 7;
        const off = (this.t * 260 + tr.phase * 50) % (seg * 2);
        for (let y = tr.y - seg * 2 + off; y < tr.land; y += seg * 2) {
          const a = Math.max(tr.y, y);
          const b = Math.min(tr.land, y + seg * 1.4);
          if (b <= a) continue;
          const wob = Math.sin(y * 0.05 + this.t * 3) * 0.6 * Math.min(1, (y - tr.y) / 60);
          ctx.moveTo(tr.x + wob, a);
          ctx.lineTo(tr.x + wob, b);
        }
        ctx.stroke();
        ctx.fillStyle = waterCol(0.5);
        ctx.fillRect(tr.x - 1, tr.y - 1, 2, 3);
        const mist = ctx.createRadialGradient(tr.x, tr.land, 0, tr.x, tr.land, 14);
        mist.addColorStop(0, waterCol(0.18));
        mist.addColorStop(1, waterCol(0));
        ctx.fillStyle = mist;
        ctx.fillRect(tr.x - 14, tr.land - 14, 28, 14);
      }

      // Beads swelling under overhangs.
      for (const src of this.sources(world)) {
        if (src.hidden || src.t <= 0.05) continue;
        const k = src.t;
        const r = 0.6 + 2 * k;
        const sag = 1 + k * 0.9;
        const wob = Math.sin(this.t * 7 + src.wob) * 0.25 * k;
        ctx.fillStyle = waterCol(0.65 + 0.3 * k);
        ctx.beginPath();
        ctx.ellipse(src.x + wob, src.y + r * sag * 0.8, r, r * sag, 0, 0, U.TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(src.x - r * 0.4 + wob, src.y + r * sag * 0.5, 1.1, 1.1);
      }

      // Falling drops: a short streak that lengthens as they speed up.
      ctx.strokeStyle = waterCol(0.9);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const d of this.drops) {
        const len = Math.min(18, 3 + d.vy * 0.016);
        ctx.moveTo(d.x - d.vx * 0.01, d.y - len);
        ctx.lineTo(d.x, d.y);
      }
      ctx.stroke();

      // Splash spray
      ctx.fillStyle = waterCol(0.85);
      for (const p of this.spray) {
        const s = 2 * (1 - p.t / p.life) + 0.6;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }

      // Ripples: only the half above the surface shows.
      ctx.lineWidth = 1.3;
      for (const r of this.ripples) {
        const k = r.t / r.life;
        const rx = 1.5 + k * r.size;
        ctx.strokeStyle = waterCol(0.7 * (1 - k));
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, rx, rx * 0.22, 0, Math.PI, U.TAU);
        ctx.stroke();
      }
    }
  }

  RW.Drips = Drips;
})();
