// Batflies: tiny flocking prey. Boids-style flight with surface avoidance,
// they scatter from predators and a moving cursor, and roost on batfly grass
// and pole tops between flights.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  class Batfly extends RW.Creature {
    constructor(eco, species, x, y, flock) {
      super(eco, species, x, y);
      this.pos = { x, y };
      const a = U.rand(0, U.TAU);
      this.vx = Math.cos(a) * 40;
      this.vy = Math.sin(a) * 40 - 30;
      this.flock = flock || {};
      if (this.flock.roostT === undefined) this.flock.roostT = U.rand(8, 20);
      this.flap = U.rand(0, 10);
      this.perched = false;
      this.perchT = 0;
      this.wanderA = a;
      this.isFlier = true;
      this.squeezeClear = 1; // tiny: only a real crack traps a batfly
      this.threats = ['lizard_*', 'slugcat', 'dropwig', 'daddy'];
      this.bloodColor = '#2a2a33';
      this.scanT = 0;
    }
    mainPoint() {
      return this.pos;
    }
    bounds() {
      return [this.pos.x - 10, this.pos.y - 10, this.pos.x + 10, this.pos.y + 10];
    }
    shiftAll(dx, dy) {
      this.pos.x += dx;
      this.pos.y += dy;
    }
    onUnburrowed() {
      this.perched = false;
    }
    // --- weapons: a rock knocks it out of the air; a spear skewers it
    hitParts() {
      return [{ x: this.pos.x, y: this.pos.y, r: 5, part: 'body' }];
    }
    limp(dt) {
      const p = this.pos;
      this.perched = false;
      this.vy += 700 * dt;
      this.vx *= Math.pow(0.3, dt);
      p.x += this.vx * dt;
      p.y += this.vy * dt;
      const c = this.W.collideCircle(p, 2.5);
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx * 1.3;
          this.vy -= vn * c.ny * 1.3;
        }
        this.vx *= 0.7;
      }
      this.flap += dt * 4; // a feeble twitch
    }
    onRockHit() {
      this.stun(U.rand(3.5, 5));
    }
    onSpearHit() {
      this.remove();
      return 'skewer';
    }
    onRecovered() {
      this.vy = -150;
    }
    carry(dx, dy) {
      if (this.perched) {
        this.pos.x += dx;
        this.pos.y += dy;
      }
    }

    roostSpot() {
      const f = this.flock;
      if (f.roost && !this.W.isSolidPt(f.roost.x, f.roost.y)) return f.roost;
      const opts = [];
      for (const g of this.eco.grass) opts.push({ x: g.x, y: g.y - g.h * 0.8 });
      for (const p of this.W.poles) opts.push({ x: p.x, y: p.y1 - 2 });
      const valid = opts.filter((o) => !this.W.isSolidPt(o.x, o.y));
      f.roost = valid.length ? U.pick(valid) : null;
      return f.roost;
    }

    update(dt) {
      if (!this.tick(dt)) return;
      const p = this.pos;
      const W = this.W;
      const eco = this.eco;
      if (this.grabbedBy) {
        const hp = this.grabbedBy.holdPoint();
        p.x = hp.x;
        p.y = hp.y;
        this.flap += dt * 50;
        this.struggle(dt);
        return;
      }
      const maxSp = this.p.speed || 110;
      this.flap += dt * (this.perched ? 0 : 38);

      // Threat check
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 0.2;
        this.threat = this.nearestOf(this.threats, 110);
        const cur = eco.cursor;
        if (eco.cfg.ecosystem.cursorInteraction && cur.inside && cur.speed > 250 && U.dist(cur.x, cur.y, p.x, p.y) < 100) this.threat = cur;
        if (this.threat && this.perched) {
          this.perched = false;
          this.vy = -120;
          this.flock.roostT = U.rand(10, 20);
        }
      }

      // Leaving / sheltering
      if (this.wantsToLeave(dt)) {
        const den = eco.nearestDen(p.x, p.y);
        if (den) {
          this.perched = false;
          this.goal = den;
          if (U.dist(p.x, p.y, den.x, den.y) < 20) this.leave();
        }
      } else {
        this.goal = null;
      }

      if (this.perched) {
        this.perchT -= dt;
        if (this.perchT <= 0 || W.isSolidPt(p.x, p.y)) {
          this.perched = false;
          this.vy = -80;
        }
        return;
      }

      // Flock bookkeeping
      const f = this.flock;
      f.roostT -= dt / Math.max(1, f.size || 1);
      let ax = 0;
      let ay = 0;
      let cx = 0;
      let cy = 0;
      let avx = 0;
      let avy = 0;
      let n = 0;
      for (const o of eco.creatures) {
        if (o === this || o.flock !== f || o.dead) continue;
        n++;
        cx += o.pos.x;
        cy += o.pos.y;
        avx += o.vx;
        avy += o.vy;
        const d = U.dist(p.x, p.y, o.pos.x, o.pos.y);
        if (d < 14 && d > 0.01) {
          ax += ((p.x - o.pos.x) / d) * (14 - d) * 18;
          ay += ((p.y - o.pos.y) / d) * (14 - d) * 18;
        }
      }
      f.size = n + 1;
      if (n) {
        ax += (cx / n - p.x) * 1.2 + (avx / n - this.vx) * 0.8;
        ay += (cy / n - p.y) * 1.2 + (avy / n - this.vy) * 0.8;
      }
      // wander
      this.wanderA += U.rand(-3, 3) * dt;
      ax += Math.cos(this.wanderA) * 60;
      ay += Math.sin(this.wanderA) * 60 - 8;

      let target = this.goal;
      if (!target && f.roostT <= 0) {
        target = this.roostSpot();
        if (!target) f.roostT = 10;
      }
      if (target) {
        const d = U.dist(p.x, p.y, target.x, target.y);
        ax += ((target.x - p.x) / (d || 1)) * 220;
        ay += ((target.y - p.y) / (d || 1)) * 220;
        if (!this.goal && d < 10) {
          this.perched = true;
          this.perchT = U.rand(5, 14);
          p.x = target.x + U.rand(-4, 4);
          p.y = target.y + U.rand(-4, 4);
          this.vx = this.vy = 0;
          if (f.roostT <= 0) f.roostT = U.rand(14, 30);
          return;
        }
      }
      if (this.threat) {
        const t = this.threat;
        const d = U.dist(p.x, p.y, t.x, t.y) || 1;
        ax += ((p.x - t.x) / d) * 900;
        ay += ((p.y - t.y) / d) * 900;
      }
      // keep off walls and away from screen edges
      const s = W.nearestSurface(p.x, p.y, 30, null);
      if (s) {
        const k = (30 - s.d) * 14;
        ax += s.nx * k;
        ay += s.ny * k;
      }
      this.vx += ax * dt;
      this.vy += ay * dt + Math.sin(this.flap * 0.5) * 20 * dt;
      const sp = Math.hypot(this.vx, this.vy);
      const lim = this.threat ? maxSp * 1.8 : maxSp;
      if (sp > lim) {
        this.vx *= lim / sp;
        this.vy *= lim / sp;
      }
      p.x += this.vx * dt;
      p.y += this.vy * dt;
      W.collideCircle(p, 3);
    }

    draw(ctx) {
      const p = this.pos;
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.translate(p.x, p.y);
      const face = this.vx >= 0 ? 1 : -1;
      // dark wing blades that flap; pale only at the leading edge
      const w = this.perched ? -0.9 : Math.sin(this.flap);
      for (const s of [-1, 1]) {
        const tipX = s * 5.5;
        const tipY = -1 - w * 4;
        ctx.fillStyle = '#7d8792';
        ctx.beginPath();
        ctx.moveTo(0, -0.5);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(s * 2.5, 1.2);
        ctx.fill();
      }
      ctx.fillStyle = '#17171d';
      ctx.beginPath();
      ctx.ellipse(0, 0.5, 2.2, 3, this.perched ? 0 : face * 0.3, 0, U.TAU);
      ctx.fill();
      ctx.restore();
      this.drawDebug(ctx);
    }
  }

  RW.Creatures.Batfly = Batfly;
})();
