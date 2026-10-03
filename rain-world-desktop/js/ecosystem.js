// The ecosystem: owns creatures, items and particles, runs the weighted
// spawner, and answers questions creatures ask about the world (where's the
// nearest den, is it raining, where's the cursor).
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;
  const Nav = RW.Nav;

  const FLOOR_CAPS = { walls: false, ceil: false, poles: false, fall: true, key: 'floor' };
  const AIR_CAPS = { fly: true, key: 'air' };

  class Ecosystem {
    constructor(cfg, world) {
      this.cfg = cfg;
      this.world = world;
      this.creatures = [];
      this.items = [];
      this.particles = [];
      this.dens = [];
      this.plants = [];
      this.grass = [];
      this.weather = null;
      this.t = 0;
      this.spawnT = 1;
      this.populated = false;
      this.cursor = { x: -9999, y: -9999, vx: 0, vy: 0, speed: 0, still: 0, inside: false };
      this.stats = { born: 0, eaten: 0, left: 0 };
    }

    setDecor(decor) {
      this.dens = decor.dens.map((d) => Object.assign({}, d));
      this.grass = decor.grass.map((g) => Object.assign({}, g));
      this.plants = decor.fruitPlants.map((p) => new RW.FruitPlant(this, p.x, p.y, p.len));
    }

    // ---- cursor -----------------------------------------------------------
    setCursor(x, y, inside, dt) {
      const c = this.cursor;
      if (inside && c.inside && dt > 0) {
        const vx = (x - c.x) / dt;
        const vy = (y - c.y) / dt;
        c.vx += (vx - c.vx) * 0.3;
        c.vy += (vy - c.vy) * 0.3;
      } else {
        c.vx = c.vy = 0;
      }
      c.speed = Math.hypot(c.vx, c.vy);
      if (Math.abs(x - c.x) + Math.abs(y - c.y) > 2) c.still = 0;
      else c.still += dt;
      c.x = x;
      c.y = y;
      c.inside = inside;
    }

    // ---- queries ------------------------------------------------------------
    shouldShelter() {
      return !!(this.cfg.rain.enabled && this.cfg.rain.shelterDuringDownpour && this.weather && this.weather.downpour);
    }

    denSpawnPoint(d) {
      if (d.wall) return { x: d.x + d.dir * 16, y: d.y };
      return { x: d.x, y: d.y - 10 };
    }

    openDens() {
      const W = this.world;
      return this.dens.filter((d) => {
        const p = this.denSpawnPoint(d);
        return !W.solid(W.cellX(p.x), W.cellY(p.y)) && !W.isSolidPt(p.x, p.y) && !W.isSolidPt(p.x, p.y - 14);
      });
    }

    nearestDen(x, y) {
      let best = null;
      let bd = Infinity;
      for (const d of this.openDens()) {
        const p = this.denSpawnPoint(d);
        const dd = U.dist2(x, y, p.x, p.y);
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
      return best;
    }

    // The open den farthest from (ox, oy) that a creature at (x, y) with
    // these caps can actually walk to (falls back to the farthest outright).
    farthestDen(ox, oy, x, y, caps) {
      const pts = this.openDens().map((d) => this.denSpawnPoint(d));
      pts.sort((a, b) => U.dist2(b.x, b.y, ox, oy) - U.dist2(a.x, a.y, ox, oy));
      for (const p of pts.slice(0, 4)) {
        const r = Nav.findPath(this.world, x, y, p.x, p.y, caps, 6000);
        if (r && r.complete) return p;
      }
      return pts[0] || null;
    }

    count(species) {
      let n = 0;
      for (const c of this.creatures) if (c.species === species && !c.dead && !c.corpse) n++;
      return n;
    }

    population() {
      let p = 0;
      for (const c of this.creatures) {
        if (c.dead || c.corpse) continue;
        const s = this.cfg.species[c.species];
        p += s && s.popCost !== undefined ? +s.popCost : 1; // 0 is a real cost (batflies)
      }
      return p;
    }

    // ---- spawning -----------------------------------------------------------
    classFor(species) {
      const C = RW.Creatures;
      if (species.indexOf('lizard') === 0) return C.Lizard;
      if (species.indexOf('centipede') === 0) return C.Centipede;
      return {
        slugcat: C.Slugcat,
        daddy: C.Daddy,
        dropwig: C.Dropwig,
        batfly: C.Batfly,
        centipede: C.Centipede,
      }[species];
    }

    spawn(species, x, y) {
      const Cls = this.classFor(species);
      if (!Cls) return null;
      if (x === undefined) {
        const pos = this.pickSpawnPoint(species, false);
        if (!pos) return null;
        x = pos.x;
        y = pos.y;
      }
      if (species === 'batfly') {
        const sz = this.cfg.species.batfly.params.flockSize || [3, 6];
        const room = Math.max(1, (this.cfg.species.batfly.max || 10) - this.count('batfly'));
        const n = Math.min(room, U.randInt(sz[0], sz[1]));
        const flock = {};
        let first = null;
        for (let i = 0; i < n; i++) {
          const b = new Cls(this, species, x + U.rand(-12, 12), y + U.rand(-12, 12), flock);
          this.creatures.push(b);
          first = first || b;
        }
        this.stats.born += n;
        return first;
      }
      const c = new Cls(this, species, x, y);
      this.creatures.push(c);
      this.stats.born++;
      return c;
    }

    // From a den normally; anywhere sensible when first populating.
    pickSpawnPoint(species, anywhere) {
      const W = this.world;
      if (!anywhere) {
        const dens = this.openDens();
        if (dens.length) {
          // Wall dens suit everything; ledge dens suit walkers.
          const d = U.pick(dens);
          return this.denSpawnPoint(d);
        }
      }
      let caps = FLOOR_CAPS;
      let filter = null;
      if (species === 'batfly' || species === 'daddy') {
        caps = AIR_CAPS;
        filter = (cx, cy) => W.surfDist(cx, cy) >= 3;
      } else if (species === 'dropwig') {
        caps = { walls: true, ceil: true, key: 'ceil' };
        filter = (cx, cy) => W.solid(cx, cy - 1);
      }
      const g = Nav.randomValid(W, caps, W.w / 2, W.h / 2, Math.max(W.w, W.h), filter, 80);
      return g ? { x: g.x, y: g.y } : { x: W.w / 2, y: W.h / 2 };
    }

    chooseSpecies() {
      const cfg = this.cfg;
      const pop = this.population();
      const entries = [];
      for (const k of Object.keys(cfg.species)) {
        const s = cfg.species[k];
        if (!s.enabled || !(s.weight > 0)) continue;
        if (this.count(k) >= (s.max || 0)) continue;
        if (pop + (s.popCost !== undefined ? +s.popCost : 1) > cfg.ecosystem.maxPopulation + 0.01) continue;
        entries.push([k, s.weight]);
      }
      return U.weighted(entries);
    }

    populate() {
      for (let i = 0; i < 60; i++) {
        const sp = this.chooseSpecies();
        if (!sp) break;
        const pos = this.pickSpawnPoint(sp, true);
        this.spawn(sp, pos.x, pos.y);
      }
      this.populated = true;
    }

    // ---- lifecycle ----------------------------------------------------------
    consume(prey, by) {
      if (!prey || prey.dead) return;
      const m = prey.mainPoint();
      this.burst(m.x, m.y, prey.bloodColor || '#2a1418', 10);
      prey.grabbedBy = null;
      prey.remove();
      if (by && by.holding === prey) by.holding = null;
      this.stats.eaten++;
    }

    burst(x, y, color, n) {
      for (let i = 0; i < n; i++) {
        const a = U.rand(0, U.TAU);
        const s = U.rand(30, 140);
        this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: U.rand(0.4, 0.9), t: 0, color, size: U.rand(1.5, 3) });
      }
    }

    carry(moves) {
      for (const m of moves) {
        for (const c of this.creatures) if (c.contactId === m.id && !c.grabbedBy) c.carry(m.dx, m.dy);
        for (const it of this.items) if (it.contactId === m.id && !it.heldBy) it.carry(m.dx, m.dy);
      }
    }

    // After the pixel snap: each translucent creature is drawn opaque on a
    // scratch layer, snapped there, then blended onto the sprite layer at its
    // see-through alpha. k is world units -> sprite pixels.
    drawLate(spriteCanvas, k) {
      if (!this.late || !this.late.length) return;
      const sc = spriteCanvas.getContext('2d');
      const W = spriteCanvas.width;
      const H = spriteCanvas.height;
      if (!this.scratch) this.scratch = document.createElement('canvas');
      const cv = this.scratch;
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      const x = cv.getContext('2d', { willReadFrequently: true });
      for (const c of this.late) {
        const b = c.bounds();
        const x0 = Math.max(0, Math.floor(b[0] * k) - 1);
        const y0 = Math.max(0, Math.floor(b[1] * k) - 1);
        const x1 = Math.min(W, Math.ceil(b[2] * k) + 1);
        const y1 = Math.min(H, Math.ceil(b[3] * k) + 1);
        if (x1 <= x0 || y1 <= y0) continue;
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.clearRect(x0, y0, x1 - x0, y1 - y0);
        x.setTransform(k, 0, 0, k, 0, 0);
        c.draw(x, true);
        U.crispRects(cv, [[x0, y0, x1, y1]]);
        sc.save();
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalAlpha = c.ghostAlpha();
        sc.drawImage(cv, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        sc.restore();
      }
    }

    // Keep a few rocks and spears lying about (about one in four a spear).
    stockWeapons(all) {
      const E = this.cfg.ecosystem;
      const want = { rock: E.rocks === undefined ? 6 : +E.rocks, spear: E.spears === undefined ? 2 : +E.spears };
      const have = { rock: 0, spear: 0 };
      for (const it of this.items) if (it instanceof RW.Weapon && !it.dead) have[it.kind]++;
      for (const kind of ['spear', 'rock']) {
        let n = Math.min(all ? 99 : 1, want[kind] - have[kind]);
        while (n-- > 0) this.spawnWeapon(kind);
      }
    }
    spawnWeapon(kind) {
      const W = this.world;
      const tops = W.solids.filter((s) => s.kind !== 'edge' && s.kind !== 'icon' && s.w >= 40 && s.y > 20);
      for (let t = 0; t < 10 && tops.length; t++) {
        const s = U.pick(tops);
        const x = s.x + U.rand(8, s.w - 8);
        const y = s.y - 4;
        if (W.isSolidPt(x, y) || W.isSolidPt(x, y - 8)) continue;
        this.items.push(new RW.Weapon(this, kind, x, y));
        return;
      }
    }
    // A loud clatter: nearby lizards come to see what it was.
    noise(x, y) {
      for (const c of this.creatures) {
        if (c.hearNoise && !c.dead && U.dist(c.x, c.y, x, y) < 280) c.hearNoise(x, y);
      }
    }

    dropFood(x, y) {
      if (this.world.isSolidPt(x, y)) return;
      const f = new RW.Fruit(this, x, y);
      f.vy = 30;
      this.items.push(f);
    }

    update(dt) {
      this.t += dt;
      const cfg = this.cfg;
      if (!this.populated && cfg.ecosystem.startPopulated) this.populate();
      if (!this.populated) this.stockWeapons(true);
      this.populated = true;
      this.weaponT = (this.weaponT || 0) - dt;
      if (this.weaponT <= 0) {
        this.weaponT = 6;
        this.stockWeapons(false);
      }

      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnT = 60 / Math.max(0.1, +cfg.ecosystem.spawnPerMinute || 0.1);
        if (!this.shouldShelter()) {
          const sp = this.chooseSpecies();
          if (sp) this.spawn(sp);
        }
      }

      for (const p of this.plants) p.update(dt);
      const Wd = this.world;
      for (const c of this.creatures) {
        c.update(dt);
        // anything that has fallen or been flung far out of the world is gone
        if (c.y > Wd.h + 500 || c.y < -500 || c.x < -500 || c.x > Wd.w + 500 || !isFinite(c.x) || !isFinite(c.y)) c.remove();
      }
      for (const it of this.items) it.update(dt);

      for (const c of this.creatures) {
        if (c.dead && c.holding) c.release();
        if (c.dead && c.leaving) this.stats.left++;
      }
      this.creatures = this.creatures.filter((c) => !c.dead);
      this.items = this.items.filter((i) => !i.dead);

      for (const p of this.particles) {
        p.t += dt;
        p.vy += 500 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      this.particles = this.particles.filter((p) => p.t < p.life);
    }

    // Draw order roughly follows Rain World's layering: big background
    // creatures first, small skittering things on top.
    draw(ctx) {
      const dirty = (this.dirty = []);
      for (const g of this.grass) {
        this.drawGrass(ctx, g);
        dirty.push([g.x - 20, g.y - g.h - 8, g.x + 20, g.y + 2]);
      }
      for (const p of this.plants) {
        p.draw(ctx);
        dirty.push([p.x - 14, p.y - 2, p.x + 14, p.y + p.len + 14]);
      }
      for (const it of this.items) dirty.push(it.bounds ? it.bounds() : [it.x - 9, it.y - 9, it.x + 9, it.y + 9]);
      for (const c of this.creatures) if (c.alpha > 0) dirty.push(c.bounds());
      for (const p of this.particles) dirty.push([p.x - 3, p.y - 3, p.x + 3, p.y + 3]);
      for (const d of this.dens) dirty.push([d.x - 24, d.y - 18, d.x + 24, d.y + 18]);
      const order = { daddy: 0, dropwig: 2, centipede: 3, slugcat: 4, batfly: 5 };
      const sorted = this.creatures.slice().sort((a, b) => (order[a.species] ?? 1) - (order[b.species] ?? 1));
      // weapons stuck in creatures or in flight draw over them; the rest under
      const over = (it) => it.state === 'embedded' || it.state === 'flying';
      for (const it of this.items) if (!over(it)) it.draw(ctx);
      // Translucent creatures (a camouflaged white lizard) can't go through
      // the hard-edged pixel pass, which would snap them to all-or-nothing:
      // they're drawn afterwards, by drawLate.
      this.late = [];
      for (const c of sorted) {
        if (c.ghostAlpha && c.ghostAlpha() < 0.99) this.late.push(c);
        else c.draw(ctx);
      }
      for (const it of this.items) if (over(it)) it.draw(ctx);
      for (const p of this.particles) {
        ctx.fillStyle = U.rgba(p.color, 1 - p.t / p.life);
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      // Den indicator dots blink like Rain World's shortcut entrances.
      for (const d of this.dens) {
        const on = Math.sin(this.t * 3 + d.x * 0.01) > 0.3;
        if (!on) continue;
        const p = this.denSpawnPoint(d);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        for (let k = -1; k <= 1; k++) {
          if (d.wall) ctx.fillRect(p.x + d.dir * 4 - 1, p.y + k * 5 - 1, 2, 2);
          else ctx.fillRect(p.x + k * 5 - 1, p.y - 6, 2, 2);
        }
      }
    }

    drawGrass(ctx, g) {
      const pal = this.palette;
      if (!pal) return;
      ctx.strokeStyle = U.rgba(U.mix(pal.near, '#7a9a5c', 0.35));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let k = 0; k < 7; k++) {
        const bx = g.x + (k - 3) * 2.5;
        const sway = Math.sin(this.t * 1.3 + g.phase + k) * 3;
        const h = g.h * (0.6 + 0.4 * Math.sin(k * 2.1 + g.phase) ** 2);
        ctx.moveTo(bx, g.y);
        ctx.quadraticCurveTo(bx + sway * 0.3, g.y - h * 0.6, bx + sway + (k - 3) * 2, g.y - h);
      }
      ctx.stroke();
    }
  }

  RW.Ecosystem = Ecosystem;
})();
