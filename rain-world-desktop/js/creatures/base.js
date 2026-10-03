// Shared creature machinery: path following, verlet chains, procedural legs
// and the grab/eat relationship between predator and prey.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;
  const Nav = RW.Nav;

  let NEXT_ID = 1;

  // ---- Path following -------------------------------------------------------
  class Pather {
    constructor(owner, caps) {
      this.owner = owner;
      this.caps = Object.assign({}, caps);
      this.caps.key = Nav.capsKey(this.caps);
      this.nodes = null;
      this.i = 0;
      this.goal = null;
      this.timer = 0;
      this.version = -1;
      this.complete = false;
      this.interval = 1.2;
    }
    setGoal(x, y, urgent) {
      const changed = !this.goal || U.dist(this.goal.x, this.goal.y, x, y) > 30;
      this.goal = { x, y };
      if (changed || urgent) this.timer = Math.min(this.timer, urgent ? 0 : 0.15);
    }
    clear() {
      this.goal = null;
      this.nodes = null;
    }
    update(dt, x, y) {
      const W = this.owner.W;
      if (!this.goal) return;
      this.timer -= dt;
      if (this.version !== W.version) {
        this.version = W.version;
        this.timer = Math.min(this.timer, Math.random() * 0.4);
      }
      if (this.timer <= 0) {
        this.timer = this.interval * (0.75 + Math.random() * 0.5);
        const r = Nav.findPath(W, x, y, this.goal.x, this.goal.y, this.caps, 4000);
        this.nodes = r ? r.nodes : null;
        this.complete = r ? r.complete : false;
        this.i = 0;
      }
    }
    current() {
      return this.nodes && this.i < this.nodes.length ? this.nodes[this.i] : null;
    }
    peek(k) {
      return this.nodes && this.i + k < this.nodes.length ? this.nodes[this.i + k] : null;
    }
    previous() {
      return this.nodes && this.i > 0 ? this.nodes[this.i - 1] : null;
    }
    // Skip past nodes we're already close to.
    advance(x, y, radius) {
      if (!this.nodes) return;
      while (this.i < this.nodes.length) {
        const n = this.nodes[this.i];
        if (U.dist(x, y, n.x, n.y) < radius) this.i++;
        else break;
      }
    }
    done() {
      return !this.nodes || this.i >= this.nodes.length;
    }
    remaining() {
      return this.nodes ? this.nodes.length - this.i : 0;
    }
  }

  // ---- Verlet chain ---------------------------------------------------------
  class Chain {
    constructor(x, y, n, segLen, dirX, dirY) {
      this.pts = [];
      this.seg = Array.isArray(segLen) ? segLen : new Array(n).fill(segLen);
      dirX = dirX === undefined ? -1 : dirX;
      dirY = dirY || 0;
      let px = x;
      let py = y;
      for (let i = 0; i < n; i++) {
        this.pts.push({ x: px, y: py, px: px, py: py });
        px += dirX * this.seg[i];
        py += dirY * this.seg[i];
      }
    }
    // Follow-the-leader from point `start` onward.
    follow(start) {
      const P = this.pts;
      for (let i = Math.max(1, start || 1); i < P.length; i++) {
        const a = P[i - 1];
        const b = P[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1e-4;
        const L = this.seg[i - 1];
        b.x = a.x + (dx / d) * L;
        b.y = a.y + (dy / d) * L;
      }
    }
    verlet(from, damp, gx, gy, dt) {
      const P = this.pts;
      for (let i = from; i < P.length; i++) {
        const p = P[i];
        const vx = (p.x - p.px) * damp;
        const vy = (p.y - p.py) * damp;
        p.px = p.x;
        p.py = p.y;
        p.x += vx + gx * dt * dt;
        p.y += vy + gy * dt * dt;
      }
    }
    collide(W, r, from) {
      const P = this.pts;
      for (let i = from || 0; i < P.length; i++) W.collideCircle(P[i], r);
    }
    shift(dx, dy) {
      for (const p of this.pts) {
        p.x += dx;
        p.y += dy;
        p.px += dx;
        p.py += dy;
      }
    }
  }

  // ---- Procedural leg -------------------------------------------------------
  class Leg {
    constructor(l1, l2, opts) {
      opts = opts || {};
      this.l1 = l1;
      this.l2 = l2;
      this.reach = (l1 + l2) * 0.92;
      this.stepDur = opts.stepDur || 0.16;
      this.lift = opts.lift || 6;
      this.group = opts.group || 0;
      this.forward = opts.forward || 0.5; // how far ahead of the hip to plant
      this.spread = opts.spread || 0; // sideways bias along the body
      this.foot = { x: 0, y: 0 };
      this.from = { x: 0, y: 0 };
      this.to = { x: 0, y: 0 };
      this.n = { x: 0, y: -1 };
      this.planted = false;
      this.stepping = false;
      this.t = 0;
      this.searchT = 0;
      this.surfId = null;
    }
    place(x, y) {
      this.foot.x = x;
      this.foot.y = y;
    }
    // hip: attach point. fwd: body heading. up: away from the main surface.
    update(dt, W, hx, hy, fx, fy, ux, uy, mask, canStep, speedK) {
      const reach = this.reach;
      if (this.stepping) {
        this.t += dt / (this.stepDur / Math.max(0.6, speedK || 1));
        const t = Math.min(1, this.t);
        const e = U.smooth(t);
        const arc = Math.sin(Math.PI * t) * this.lift;
        this.foot.x = U.lerp(this.from.x, this.to.x, e) + this.n.x * arc;
        this.foot.y = U.lerp(this.from.y, this.to.y, e) + this.n.y * arc;
        if (t >= 1) {
          this.stepping = false;
          this.planted = true;
        }
        return;
      }
      const d = U.dist(hx, hy, this.foot.x, this.foot.y);
      if (this.planted) {
        // Is the foot lagging too far behind, or simply out of reach?
        const ahead = (this.foot.x - hx) * fx + (this.foot.y - hy) * fy;
        const need = d > reach * 1.02 || ahead < -reach * 0.55 || ahead > reach * 0.95;
        if (need && canStep) {
          if (!this.tryStep(W, hx, hy, fx, fy, ux, uy, mask) && d > reach * 1.25) this.planted = false;
        } else if (d > reach * 1.5) {
          this.planted = false;
        }
        return;
      }
      // Dangling: hang below the hip with a little flail, keep looking for grip.
      const tx = hx - ux * reach * 0.55 + fx * reach * 0.25;
      const ty = hy - uy * reach * 0.55 + fy * reach * 0.25 + 4;
      const k = U.approach(14, dt);
      this.foot.x += (tx - this.foot.x) * k + (Math.random() - 0.5) * 1.5;
      this.foot.y += (ty - this.foot.y) * k + (Math.random() - 0.5) * 1.5;
      W.collideCircle(this.foot, 1);
      this.searchT -= dt;
      if (this.searchT <= 0 && canStep) {
        this.searchT = 0.08;
        this.tryStep(W, hx, hy, fx, fy, ux, uy, mask);
      }
    }
    tryStep(W, hx, hy, fx, fy, ux, uy, mask) {
      const reach = this.reach;
      const sx = -fy * this.spread;
      const sy = fx * this.spread;
      const px = hx + fx * reach * this.forward - ux * reach * 0.6 + sx * reach;
      const py = hy + fy * reach * this.forward - uy * reach * 0.6 + sy * reach;
      const s = W.nearestSurface(px, py, reach * 0.95, mask);
      if (!s) return false;
      if (U.dist(hx, hy, s.x, s.y) > reach) return false;
      this.from.x = this.foot.x;
      this.from.y = this.foot.y;
      this.to.x = s.x;
      this.to.y = s.y;
      this.n.x = s.nx;
      this.n.y = s.ny;
      this.surfId = s.id;
      this.t = 0;
      this.stepping = true;
      this.planted = false;
      return true;
    }
    shift(dx, dy) {
      this.foot.x += dx;
      this.foot.y += dy;
      this.to.x += dx;
      this.to.y += dy;
      this.from.x += dx;
      this.from.y += dy;
    }
    // Returns the knee for drawing.
    solve(hx, hy, ux, uy) {
      return U.ikToward(hx, hy, this.foot.x, this.foot.y, this.l1, this.l2, ux, uy);
    }
  }

  // ---- Creature base --------------------------------------------------------
  class Creature {
    constructor(eco, species, x, y) {
      this.eco = eco;
      this.W = eco.world;
      this.species = species;
      this.scfg = eco.cfg.species[species] || { params: {} };
      this.p = this.scfg.params || {};
      this.id = NEXT_ID++;
      this.dead = false;
      this.alpha = 0;
      this.leaving = false;
      this.age = 0;
      this.grabbedBy = null;
      this.holding = null;
      this.state = 'idle';
      this.stateT = 0;
      this.label = '';
      this.diet = [];
      this.threats = [];
      this.isFlier = false;
      this.mass = 1;
      this.spawnX = x;
      this.spawnY = y;
      this.contactId = null;
      this.migrateCheck = U.rand(5, 20);
    }
    get x() {
      return this.mainPoint().x;
    }
    get y() {
      return this.mainPoint().y;
    }
    mainPoint() {
      return { x: this.spawnX, y: this.spawnY };
    }
    setState(s) {
      if (this.state !== s) {
        this.state = s;
        this.stateT = 0;
      }
    }
    // Common lifecycle; returns false if the creature should skip its own logic.
    tick(dt) {
      this.age += dt;
      this.stateT += dt;
      if (this.leaving) {
        this.alpha -= dt * 2;
        if (this.alpha <= 0) this.dead = true;
        return false;
      }
      this.alpha = Math.min(1, this.alpha + dt * 1.6);
      return true;
    }
    // Eaten, despawned or left the screen.
    remove() {
      this.dead = true;
      if (this.holding) this.release();
    }
    leave() {
      if (this.holding) this.release();
      this.leaving = true;
    }

    // --- grabbing ---
    canBeGrabbed() {
      return !this.dead && !this.leaving && !this.grabbedBy && this.alpha > 0.5;
    }
    grab(prey) {
      if (!prey.canBeGrabbed()) return false;
      prey.grabbedBy = this;
      this.holding = prey;
      prey.onGrabbed(this);
      return true;
    }
    release() {
      const prey = this.holding;
      if (prey) {
        prey.grabbedBy = null;
        prey.onReleased(this);
      }
      this.holding = null;
    }
    onGrabbed() {}
    onReleased() {}
    // Point where a held creature should be pinned.
    holdPoint() {
      return this.mainPoint();
    }
    // Prey struggles; returns true if it escaped this frame.
    struggle(dt) {
      const chance = this.p.escapeChance || 0.04;
      if (Math.random() < chance * dt) {
        const holder = this.grabbedBy;
        if (holder) holder.release();
        return true;
      }
      return false;
    }

    // --- perception ---
    canSee(x, y, range) {
      const m = this.mainPoint();
      if (U.dist2(m.x, m.y, x, y) > range * range) return false;
      return this.W.lineClear(m.x, m.y, x, y);
    }
    nearestOf(species, range, filter) {
      const m = this.mainPoint();
      let best = null;
      let bd = range * range;
      for (const c of this.eco.creatures) {
        if (c === this || c.dead || c.leaving || c.alpha < 0.6) continue;
        if (species.indexOf(c.species) < 0) continue;
        if (filter && !filter(c)) continue;
        const d = U.dist2(m.x, m.y, c.x, c.y);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      return best;
    }
    threatNear(range) {
      const t = this.nearestOf(this.threats, range, (c) => !c.holding && !c.lurking && this.canSee(c.x, c.y, range));
      return t;
    }
    // Pick somewhere reachable that's away from (fx, fy).
    fleeGoal(caps, fx, fy, dist) {
      const m = this.mainPoint();
      const a = Math.atan2(m.y - fy, m.x - fx);
      let best = null;
      let bs = -Infinity;
      for (let i = 0; i < 8; i++) {
        const aa = a + U.rand(-1.1, 1.1);
        const tx = U.clamp(m.x + Math.cos(aa) * dist, 10, this.W.w - 10);
        const ty = U.clamp(m.y + Math.sin(aa) * dist * 0.6, 10, this.W.h - 10);
        const n = Nav.nearestValid(this.W, tx, ty, caps, 4);
        if (!n) continue;
        const x = this.W.centerX(n.cx);
        const y = this.W.centerY(n.cy);
        const s = U.dist(x, y, fx, fy) - U.dist(x, y, m.x, m.y) * 0.3;
        if (s > bs) {
          bs = s;
          best = { x, y };
        }
      }
      return best;
    }
    wanderGoal(caps, radius, filter) {
      const m = this.mainPoint();
      return Nav.randomValid(this.W, caps, m.x, m.y, radius, filter);
    }
    // Shelter / migration: head for the nearest den and vanish into it.
    wantsToLeave(dt) {
      if (this.eco.shouldShelter()) return true;
      this.migrateCheck -= dt;
      if (this.migrateCheck <= 0) {
        this.migrateCheck = 10;
        const perMin = this.eco.cfg.ecosystem.migrationPerMinute || 0;
        if (this.age > 40 && Math.random() < perMin / 6) this.migrating = true;
      }
      return !!this.migrating;
    }

    // Window dragged under us: ride along.
    carry(dx, dy) {}

    drawDebug(ctx) {
      if (!this.eco.cfg.debug.showLabels) return;
      const m = this.mainPoint();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '11px monospace';
      ctx.fillText(this.species.replace('lizard_', '') + ':' + this.state, m.x + 10, m.y - 14);
    }
    drawPath(ctx, pather) {
      if (!this.eco.cfg.debug.showPaths || !pather || !pather.nodes) return;
      ctx.strokeStyle = 'rgba(255,220,80,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const m = this.mainPoint();
      ctx.moveTo(m.x, m.y);
      for (let i = pather.i; i < pather.nodes.length; i++) {
        const n = pather.nodes[i];
        ctx.lineTo(n.x, n.y);
      }
      ctx.stroke();
      for (let i = pather.i; i < pather.nodes.length; i++) {
        const n = pather.nodes[i];
        if (n.type === Nav.JUMP) ctx.fillStyle = '#5cf';
        else if (n.type === Nav.FALL) ctx.fillStyle = '#f75';
        else continue;
        ctx.fillRect(n.x - 3, n.y - 3, 6, 6);
      }
    }
  }

  RW.Creatures = RW.Creatures || {};
  RW.Pather = Pather;
  RW.Chain = Chain;
  RW.Leg = Leg;
  RW.Creature = Creature;
})();
