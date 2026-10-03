// Daddy Long Legs (and its brown cousin, Brother Long Legs): a pulsing knot
// of rot with long verlet tentacles. Tentacles grope for anchor points on real
// surfaces; the body is only held up and dragged along by the ones that have
// a grip. Anything that wanders within reach gets seized and reeled in.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  const GRAV = 500;
  const VARIANTS = {
    daddy: { body: '#1b1e3c', bulb: '#262b55', spot: '#86a9ff', tent: '#191b34' },
    brother: { body: '#2c281e', bulb: '#3a3426', spot: '#d1b071', tent: '#27231a' },
  };

  class Tentacle {
    constructor(d, ang, segs, segLen) {
      this.ang = ang;
      this.chain = new RW.Chain(d.body.x, d.body.y, segs, segLen, Math.cos(ang), Math.sin(ang));
      this.segLen = segLen;
      this.curLen = segLen;
      this.reach = segs * segLen * 0.92;
      this.state = 'seek';
      this.target = null;
      this.anchor = null;
      this.prey = null;
      this.timer = U.rand(0, 0.5);
      this.wig = U.rand(0, 10);
    }
    tip() {
      const P = this.chain.pts;
      return P[P.length - 1];
    }
    release() {
      this.state = 'seek';
      this.anchor = null;
      this.target = null;
      this.prey = null;
      this.timer = U.rand(0.05, 0.4);
    }
  }

  class Daddy extends RW.Creature {
    constructor(eco, species, x, y) {
      super(eco, species, x, y);
      const p = this.p;
      this.variant = U.weighted(Object.entries(p.variants || { daddy: 1 })) || 'daddy';
      const v = VARIANTS[this.variant] || VARIANTS.daddy;
      this.colBody = U.hex(v.body);
      this.colBulb = U.hex(v.bulb);
      this.colSpot = U.hex(v.spot);
      this.colTent = U.hex(v.tent);
      this.R = p.bodyRadius || 24;
      this.body = { x, y };
      this.vx = 0;
      this.vy = 0;
      this.reach = p.reach || 250;
      const n = p.tentacles || 8;
      const segs = 22;
      this.tentacles = [];
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * U.TAU + U.rand(-0.2, 0.2);
        this.tentacles.push(new Tentacle(this, ang, segs, (this.reach * U.rand(0.85, 1.1)) / segs));
      }
      this.bulbs = [];
      for (let i = 0; i < 4; i++) {
        const a = U.rand(0, U.TAU);
        const d = i === 0 ? 0 : this.R * U.rand(0.35, 0.6);
        this.bulbs.push({ ox: Math.cos(a) * d, oy: Math.sin(a) * d, r: this.R * (i === 0 ? 0.85 : U.rand(0.45, 0.65)), ph: U.rand(0, 10) });
      }
      this.lumps = [];
      for (let i = 0; i < 9; i++) {
        const a = U.rand(0, U.TAU);
        this.lumps.push({ a, d: this.R * U.rand(0.65, 0.95), r: U.rand(3, 7), ph: U.rand(0, 10) });
      }
      this.spots = [];
      for (let i = 0; i < 16; i++) {
        const a = U.rand(0, U.TAU);
        this.spots.push({ a, d: Math.sqrt(Math.random()) * this.R * 0.9, r: U.rand(1.2, 3.2), ph: U.rand(0, 10) });
      }
      this.flecks = [];
      for (let i = 0; i < 40; i++) this.flecks.push({ a: U.rand(0, U.TAU), d: U.rand(0.85, 1.25), s: U.randInt(1, 3), ph: U.rand(0, 10) });
      const reachCells = Math.max(3, Math.floor(this.reach / eco.world.cell));
      this.caps = { fly: true, surfacePenalty: Math.floor(reachCells * 0.45) };
      this.pather = new RW.Pather(this, this.caps);
      this.pather.interval = 2;
      this.speed = p.speed || 42;
      this.fullT = U.rand(5, 20);
      this.huntT = 0;
      this.diet = ['slugcat', 'lizard_*', 'dropwig', 'centipede', 'batfly'];
      this.isFlier = true;
      this.mass = 6;
      this.bloodColor = '#151830';
    }

    mainPoint() {
      return this.body;
    }
    bounds() {
      const all = [{ x: this.body.x - this.R * 1.4, y: this.body.y - this.R * 1.4 }, { x: this.body.x + this.R * 1.4, y: this.body.y + this.R * 1.4 }];
      for (const t of this.tentacles) for (const p of t.chain.pts) all.push(p);
      return RW.Creature.ptsBounds(all, 8);
    }
    holdPoint() {
      for (const t of this.tentacles) if (t.state === 'hold') return t.tip();
      return this.body;
    }
    canBeGrabbed() {
      return false;
    }
    carry(dx, dy) {
      this.body.x += dx;
      this.body.y += dy;
    }
    // --- weapons: too big to stun or kill with these, but a hit makes it
    // flinch, drop its catch and let go of what it's gripping
    hitParts() {
      return [{ x: this.body.x, y: this.body.y, r: this.R || 12, part: 'body' }];
    }
    stun() {
      this.flinch();
      return false;
    }
    flinch() {
      if (this.holding) this.release();
      for (const t of this.tentacles) if (t.state === 'grip' && Math.random() < 0.5) t.release();
    }
    onRockHit() {
      this.flinch();
    }
    onSpearHit() {
      this.flinch();
      return 'embed';
    }
    shiftAll(dx, dy) {
      this.carry(dx, dy);
      for (const t of this.tentacles) t.chain.shift(dx, dy);
    }
    // Dug out of a window: let go of grips inside it so they don't haul the
    // body straight back in.
    onUnburrowed() {
      super.onUnburrowed();
      for (const t of this.tentacles) if (t.state === 'grip') t.release();
    }

    think(dt) {
      const eco = this.eco;
      const b = this.body;
      this.fullT -= dt;
      this.huntT -= dt;
      const holding = this.tentacles.some((t) => t.state === 'hold');

      if (!holding && this.wantsToLeave(dt)) {
        this.setState('leave');
        const den = eco.nearestDen(b.x, b.y);
        if (den) {
          this.pather.setGoal(den.x, den.y);
          if (U.dist(b.x, b.y, den.x, den.y) < 35) this.leave();
        }
        return;
      }

      if (holding) {
        this.setState('eat');
        this.pather.clear();
        return;
      }

      // Grab at anything in reach.
      if (this.huntT <= 0) {
        this.huntT = 0.35;
        const hunting = this.tentacles.filter((t) => t.state === 'hunt').length;
        if (this.fullT <= 0 && hunting < 2) {
          const prey =
            this.nearestOf(this.diet, this.reach * 0.9, (c) => c.canBeGrabbed() && !this.tentacles.some((t) => t.prey === c)) ||
            this.nearestCorpse(this.diet, this.reach * 0.9); // happy to eat the dead
          if (prey) this.assign('hunt', prey);
        }
        const cur = eco.cursor;
        if (eco.cfg.ecosystem.cursorInteraction && cur.inside && cur.still > 0.3 && U.dist(cur.x, cur.y, b.x, b.y) < this.reach * 0.85) {
          if (!this.tentacles.some((t) => t.state === 'cursor')) this.assign('cursor', null);
        }
      }

      if (this.state !== 'wander') this.setState('wander');
      if (this.pather.done() || !this.pather.goal || this.stateT > 25) {
        const W = this.W;
        const rc = this.caps.surfacePenalty;
        const g = this.wanderGoal(this.caps, 450, (cx, cy) => W.surfDist(cx, cy) <= rc && W.surfDist(cx, cy) >= 4);
        if (g) this.pather.setGoal(g.x, g.y, true);
        this.stateT = 0;
      }
    }

    // Send the free tentacle best aimed at the target.
    assign(state, prey) {
      const tx = prey ? prey.x : this.eco.cursor.x;
      const ty = prey ? prey.y : this.eco.cursor.y;
      const a = Math.atan2(ty - this.body.y, tx - this.body.x);
      let best = null;
      let bs = Infinity;
      for (const t of this.tentacles) {
        if (t.state === 'hunt' || t.state === 'hold' || t.state === 'cursor') continue;
        const s = Math.abs(U.angleDiff(t.ang, a)) + (t.state === 'grip' ? 0.6 : 0);
        if (s < bs) {
          bs = s;
          best = t;
        }
      }
      if (!best) return;
      best.state = state;
      best.prey = prey;
      best.anchor = null;
    }

    update(dt) {
      if (!this.tick(dt)) {
        for (const t of this.tentacles) this.updateTentacle(t, dt);
        return;
      }
      const W = this.W;
      const b = this.body;
      this.think(dt);
      this.pather.update(dt, b.x, b.y);
      this.pather.advance(b.x, b.y, W.cell * 1.2);

      let grips = 0;
      let pullX = 0;
      let pullY = 0;
      for (const t of this.tentacles) {
        if (t.state !== 'grip') continue;
        grips++;
        const d = U.dist(b.x, b.y, t.anchor.x, t.anchor.y);
        if (d > t.reach * 0.85) {
          pullX += ((t.anchor.x - b.x) / d) * (d - t.reach * 0.85);
          pullY += ((t.anchor.y - b.y) / d) * (d - t.reach * 0.85);
        }
      }
      const support = Math.min(1, grips / 3);
      // Stalled with lots of grips: let go of the two anchors furthest behind.
      this.regripT = (this.regripT || 0) - dt;
      const goalNode = this.pather.current();
      if (goalNode && grips >= 5 && Math.hypot(this.vx, this.vy) < 8 && this.regripT <= 0) {
        this.regripT = 0.6;
        const hx = goalNode.x - b.x;
        const hy = goalNode.y - b.y;
        const behind = this.tentacles
          .filter((t) => t.state === 'grip')
          .sort((p, q) => (p.anchor.x - b.x) * hx + (p.anchor.y - b.y) * hy - ((q.anchor.x - b.x) * hx + (q.anchor.y - b.y) * hy));
        for (const t of behind.slice(0, 2)) t.release();
      }
      const node = this.pather.current();
      let dvx = 0;
      let dvy = 0;
      if (node && this.state !== 'eat') {
        const dx = node.x - b.x;
        const dy = node.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        dvx = (dx / d) * this.speed;
        dvy = (dy / d) * this.speed;
      }
      const k = U.approach(1.5, dt);
      this.vx += (dvx * support - this.vx) * k + pullX * 2 * dt;
      this.vy += (dvy * support - this.vy) * k + pullY * 2 * dt + GRAV * (1 - support) * dt;
      // gentle breathing bob
      this.vy += Math.sin(this.age * 1.3) * 6 * dt;
      b.x += this.vx * dt;
      b.y += this.vy * dt;
      const c = W.collideCircle(b, this.R * 0.8);
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx;
          this.vy -= vn * c.ny;
        }
        this.contactId = c.id;
      }

      for (const t of this.tentacles) this.updateTentacle(t, dt);
    }

    updateTentacle(t, dt) {
      const W = this.W;
      const b = this.body;
      const P = t.chain.pts;
      const n = P.length;
      const base = P[0];
      base.x = b.x + Math.cos(t.ang) * this.R * 0.55;
      base.y = b.y + Math.sin(t.ang) * this.R * 0.55;
      base.px = base.x;
      base.py = base.y;
      const tip = P[n - 1];
      t.timer -= dt;

      switch (t.state) {
        case 'seek': {
          if (!t.target && t.timer <= 0) {
            t.timer = 0.3;
            let a = t.ang + U.rand(-0.9, 0.9);
            // reach mostly toward where we're going, so grips pull us along
            const node = this.pather.current();
            if (node && Math.random() < 0.85) a = Math.atan2(node.y - b.y, node.x - b.x) + U.rand(-0.9, 0.9);
            const ex = b.x + Math.cos(a) * t.reach;
            const ey = b.y + Math.sin(a) * t.reach;
            const hit = W.raycast(b.x, b.y, ex, ey);
            if (hit && hit.t > 0.4) t.target = { x: hit.x + hit.nx, y: hit.y + hit.ny, nx: hit.nx, ny: hit.ny, surface: true };
            else t.target = { x: b.x + Math.cos(a) * t.reach * 0.55, y: b.y + Math.sin(a) * t.reach * 0.55, surface: false };
          }
          if (t.target) {
            const wig = t.target.surface ? 0 : 5;
            const wx = t.target.x + Math.sin(this.age * 5 + t.wig) * wig;
            const wy = t.target.y + Math.cos(this.age * 4 + t.wig) * wig;
            if (this.moveTip(tip, wx, wy, 190, dt)) {
              if (t.target.surface) {
                t.state = 'grip';
                t.anchor = t.target;
                t.timer = U.rand(3, 9);
              }
              t.target = null;
            }
          }
          break;
        }
        case 'grip': {
          const a = t.anchor;
          tip.x = a.x;
          tip.y = a.y;
          const d = U.dist(b.x, b.y, a.x, a.y);
          const gone = !W.isSolidPt(a.x - a.nx * 3, a.y - a.ny * 3);
          const behind = this.vx * (a.x - b.x) + this.vy * (a.y - b.y) < 0 && d > t.reach * 0.6;
          if (gone || d > t.reach * 1.08 || (t.timer <= 0 && (behind || Math.random() < 0.3))) t.release();
          break;
        }
        case 'hunt': {
          const prey = t.prey;
          if (!prey || prey.dead || prey.leaving || prey.grabbedBy || U.dist(b.x, b.y, prey.x, prey.y) > t.reach * 1.1) {
            t.release();
            break;
          }
          this.moveTip(tip, prey.x, prey.y, 520, dt);
          if (U.dist(tip.x, tip.y, prey.x, prey.y) < 10) {
            if (this.eco.cfg.ecosystem.predation && !this.holding && this.grab(prey)) {
              t.state = 'hold';
              for (const o of this.tentacles) if (o !== t && o.state === 'hunt') o.release();
            } else {
              if (prey.onBitten) prey.onBitten(this);
              t.release();
              this.fullT = 6;
            }
          }
          break;
        }
        case 'hold': {
          const prey = this.holding;
          if (!prey || prey.dead || prey.grabbedBy !== this) {
            this.holding = null;
            t.release();
            break;
          }
          this.moveTip(tip, b.x, b.y, 55, dt);
          if (U.dist(tip.x, tip.y, b.x, b.y) < this.R * 0.9) {
            this.eco.consume(prey, this);
            this.holding = null;
            this.fullT = U.rand(35, 70);
            t.release();
          }
          break;
        }
        case 'cursor': {
          const cur = this.eco.cursor;
          if (!cur.inside || cur.still < 0.1 || U.dist(b.x, b.y, cur.x, cur.y) > t.reach) {
            t.release();
            break;
          }
          const w = this.age * 3 + t.wig;
          this.moveTip(tip, cur.x + Math.cos(w) * 14, cur.y + Math.sin(w * 1.3) * 10, 300, dt);
          break;
        }
      }

      // Reel in slack while anchored so tentacles stay taut instead of piling up.
      let want = t.segLen;
      if (t.state === 'grip' || t.state === 'hold') {
        const d = U.dist(base.x, base.y, tip.x, tip.y);
        want = U.clamp((d * 1.12) / (n - 1), t.segLen * 0.3, t.segLen);
      }
      t.curLen += (want - t.curLen) * U.approach(3, dt);

      // Rope: verlet + distance constraints, base and (when anchored) tip pinned.
      t.chain.verlet(1, 0.9, 0, 260, dt);
      const pinTip = t.state !== 'seek' || !!t.target;
      const L = t.curLen;
      for (let it = 0; it < 5; it++) {
        for (let i = 1; i < n; i++) {
          const a = P[i - 1];
          const c = P[i];
          const dx = c.x - a.x;
          const dy = c.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-4;
          const diff = (d - L) / d;
          const aFixed = i === 1;
          const cFixed = pinTip && i === n - 1;
          if (aFixed && cFixed) continue;
          if (aFixed) {
            c.x -= dx * diff;
            c.y -= dy * diff;
          } else if (cFixed) {
            a.x += dx * diff;
            a.y += dy * diff;
          } else {
            a.x += dx * diff * 0.5;
            a.y += dy * diff * 0.5;
            c.x -= dx * diff * 0.5;
            c.y -= dy * diff * 0.5;
          }
        }
        base.x = b.x + Math.cos(t.ang) * this.R * 0.55;
        base.y = b.y + Math.sin(t.ang) * this.R * 0.55;
      }
      // a slow writhe
      for (let i = 2; i < n - 1; i += 2) {
        const s = Math.sin(this.age * 2.2 + t.wig + i * 0.5) * 0.35;
        P[i].x += s;
        P[i].y += Math.cos(this.age * 1.7 + t.wig + i * 0.4) * 0.25;
      }
      for (let i = 2; i < n - 1; i += 2) W.collideCircle(P[i], 2);
    }

    moveTip(tip, tx, ty, speed, dt) {
      const dx = tx - tip.x;
      const dy = ty - tip.y;
      const d = Math.hypot(dx, dy);
      const step = speed * dt;
      if (d <= step) {
        tip.x = tx;
        tip.y = ty;
      } else {
        tip.x += (dx / d) * step;
        tip.y += (dy / d) * step;
      }
      tip.px = tip.x;
      tip.py = tip.y;
      return d <= Math.max(step, 4);
    }

    draw(ctx) {
      const b = this.body;
      const t = this.age;
      ctx.save();
      ctx.globalAlpha = this.alpha;
      // tentacles
      for (const tn of this.tentacles) {
        const P = tn.chain.pts;
        const n = P.length;
        const widths = P.map((_, i) => U.lerp(4.6, 1.1, i / (n - 1)));
        ctx.fillStyle = U.rgba(this.colTent);
        U.taperPath(ctx, P, widths);
        ctx.fill();
        ctx.fillStyle = U.rgba(this.colSpot, 0.22);
        for (let i = 3; i < n - 1; i += 3) {
          ctx.beginPath();
          ctx.arc(P[i].x, P[i].y, widths[i] * 0.45, 0, U.TAU);
          ctx.fill();
        }
        const tip = P[n - 1];
        if (tn.state === 'grip' || tn.state === 'hold') {
          ctx.fillStyle = U.rgba(this.colTent);
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, 2.6, 0, U.TAU);
          ctx.fill();
        }
      }
      // body: knot of bulbs with lumpy rim
      for (const l of this.lumps) {
        const r = l.r * (1 + 0.12 * Math.sin(t * 2 + l.ph));
        ctx.fillStyle = U.rgba(this.colBulb);
        ctx.beginPath();
        ctx.arc(b.x + Math.cos(l.a) * l.d, b.y + Math.sin(l.a) * l.d, r, 0, U.TAU);
        ctx.fill();
      }
      // Flat two-tone bulbs (no gradients) so the pixel pass keeps them crisp.
      for (const bl of this.bulbs) {
        const r = bl.r * (1 + 0.06 * Math.sin(t * 1.6 + bl.ph));
        ctx.fillStyle = U.rgba(this.colBody);
        ctx.beginPath();
        ctx.arc(b.x + bl.ox, b.y + bl.oy, r, 0, U.TAU);
        ctx.fill();
      }
      for (const bl of this.bulbs) {
        const r = bl.r * (1 + 0.06 * Math.sin(t * 1.6 + bl.ph));
        ctx.fillStyle = U.rgba(this.colBulb);
        ctx.beginPath();
        ctx.arc(b.x + bl.ox - r * 0.22, b.y + bl.oy - r * 0.25, r * 0.55, 0, U.TAU);
        ctx.fill();
      }
      const px = this.eco.artPx || 1;
      // ragged rot flecks around the knot's edge
      ctx.fillStyle = U.rgba(this.colBody);
      for (const f of this.flecks) {
        const a = f.a + Math.sin(t * 0.7 + f.ph) * 0.05;
        const d = this.R * f.d;
        const sz = f.s * px;
        ctx.fillRect(Math.round((b.x + Math.cos(a) * d) / px) * px, Math.round((b.y + Math.sin(a) * d) / px) * px, sz, sz);
      }
      // Eye-spots: hard pixel dots that pulse between dim and bright.
      for (const s of this.spots) {
        const pulse = Math.sin(t * 2.4 + s.ph);
        const x = b.x + Math.cos(s.a) * s.d;
        const y = b.y + Math.sin(s.a) * s.d;
        const sz = Math.max(px * 2, s.r * 1.4);
        ctx.fillStyle = U.rgba(pulse > 0.2 ? U.mix(this.colSpot, '#ffffff', 0.25) : U.mix(this.colSpot, this.colBody, 0.45));
        ctx.fillRect(Math.round(x / px) * px - sz / 2, Math.round(y / px) * px - sz / 2, sz, sz);
      }
      ctx.restore();
      this.drawPath(ctx, this.pather);
      this.drawDebug(ctx);
    }
  }

  RW.Creatures.Daddy = Daddy;
})();
