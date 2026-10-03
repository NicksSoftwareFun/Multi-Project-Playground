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
        if (need && (canStep || d > reach * 1.2)) {
          if (!this.tryStep(W, hx, hy, fx, fy, ux, uy, mask) && d > reach * 1.25) this.planted = false;
        } else if (d > reach * 1.2) {
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
      if (this.burrow) return this.burrowStep(dt);
      if (this.leaving) {
        this.alpha -= dt * 2;
        if (this.alpha <= 0) this.dead = true;
        return false;
      }
      this.alpha = Math.min(1, this.alpha + dt * 1.6);
      if (this.unburrowStep(dt)) return false;
      // Dead: a limp ragdoll until something eats it (or it rots away). A
      // carried corpse lets its own grabbed-branch hang it from the jaws.
      if (this.corpse) {
        this.corpseT += dt;
        if (this.corpseT > 100 && !this.grabbedBy) {
          this.alpha -= dt * 0.4;
          if (this.alpha <= 0) this.dead = true;
        }
        if (this.grabbedBy) return true;
        this.limp(dt);
        return false;
      }
      // Stunned (a rock, say): limp until it wears off.
      if (this.stunT > 0 && !this.grabbedBy) {
        this.stunT -= dt;
        this.limp(dt);
        if (this.stunT <= 0) {
          this.flipped = false;
          this.onRecovered();
        }
        return false;
      }
      // No den reachable from here: slip away quietly rather than wait forever.
      if (this.state === 'leave' && this.stateT > 30) this.leave();
      // Safety net for odd geometry (e.g. a window dropped on top of us):
      // anything that hasn't budged in 25s while trying to go somewhere leaves.
      this.stuckCheckT = (this.stuckCheckT || 0) + dt;
      if (this.stuckCheckT > 5) {
        this.stuckCheckT = 0;
        const m = this.mainPoint();
        const moved = this.lastCheck ? Math.hypot(m.x - this.lastCheck.x, m.y - this.lastCheck.y) : 99;
        this.lastCheck = { x: m.x, y: m.y };
        const busy = this.pather && this.pather.goal && !this.grabbedBy && !this.holding;
        this.stillFor = moved < 3 && busy ? (this.stillFor || 0) + 5 : 0;
        if (this.stillFor >= 25) this.burrowAway();
      }
      return true;
    }
    // Scrambling: stepping off a pole onto the ledge right beside it means
    // hauling up over the corner, which plain steering bumps into. Returns the
    // ledge-top node when that's the next move and `pt` is down by the lip.
    cornerAhead(pt) {
      const W = this.W;
      const n = this.pather.current();
      const pv = this.pather.previous();
      if (!n || !pv || n.type !== RW.Nav.WALK || n.cy > pv.cy || Math.abs(n.cx - pv.cx) !== 1) return null;
      if (W.pole(n.cx, n.cy) || !W.solid(n.cx, n.cy + 1) || !W.pole(pv.cx, pv.cy) || W.solid(pv.cx, pv.cy + 1)) return null;
      const top = (n.cy + 1) * W.cell;
      if (pt.y < top - W.cell * 0.3 || pt.y > top + W.cell * 2.5 || Math.abs(pt.x - n.x) > W.cell * 1.8) return null;
      return n;
    }
    // Start a scramble for ledge-top node `n`: `r` is how far `pt` keeps off
    // the ledge face, `lift` how high it rides above a surface, `chance` the
    // odds this attempt gets over (smaller, nimbler creatures do better).
    startScramble(n, pt, r, lift, chance) {
      const cell = this.W.cell;
      const side = Math.sign(n.x - pt.x) || 1; // toward the ledge
      const face = side > 0 ? n.cx * cell : (n.cx + 1) * cell;
      const top = (n.cy + 1) * cell;
      this.scramble = {
        t: 0,
        dur: U.rand(0.5, 0.75) + Math.max(0, pt.y - top) / 140, // longer from further down
        x0: pt.x,
        y0: pt.y,
        side,
        lip: { x: face, y: top },
        p1: { x: face - side * r, y: top - lift * 0.5 },
        p2: { x: face + side * (r + 3), y: top - lift },
        ok: Math.random() < chance,
      };
    }
    // Advance a scramble, steering `pt` by setting vx/vy. Returns 'done' once
    // over the lip, 'slip' when this attempt fails, otherwise null.
    stepScramble(dt, pt) {
      const s = this.scramble;
      if (s.last !== undefined && this.age - s.last > 0.1) {
        // interrupted (stunned, grabbed, fighting): start over from scratch
        this.scramble = null;
        this.scrambleCd = 0.3;
        return 'slip';
      }
      s.last = this.age;
      s.t += dt;
      const u = s.t / s.dur;
      if (!s.ok && u > 0.5) {
        // couldn't get a grip on the lip: slide back down and try again
        this.scramble = null;
        this.scrambleCd = U.rand(0.35, 0.8);
        this.vx = -s.side * 25;
        this.vy = 70;
        this.scrambleFails = (this.scrambleFails || 0) + 1;
        if (this.scrambleFails >= 4) {
          this.scrambleFails = 0;
          this.pather.clear(); // give up on this route for now
        }
        return 'slip';
      }
      let tx;
      let ty;
      if (u < 0.6) {
        // claw up the face to the lip, wriggling side to side
        const k = U.smooth(u / 0.6);
        tx = U.lerp(s.x0, s.p1.x, Math.min(1, k * 1.6));
        ty = U.lerp(s.y0, s.p1.y, k);
        tx += Math.sin(s.t * 34) * 2.2 * (1 - k * 0.5);
        ty += Math.sin(s.t * 23) * 1.5;
      } else {
        // then haul over the top
        const k = Math.min(1, (u - 0.6) / 0.4);
        tx = U.lerp(s.p1.x, s.p2.x, k);
        ty = U.lerp(s.p1.y, s.p2.y, k) - Math.sin(k * Math.PI) * 3;
      }
      this.vx = U.clamp((tx - pt.x) / dt, -400, 400);
      this.vy = U.clamp((ty - pt.y) / dt, -400, 400);
      if (u >= 1) {
        this.scramble = null;
        this.scrambleFails = 0;
        this.vx = s.side * 30;
        this.vy = 0;
        return 'done';
      }
      return null;
    }

    // Stuck too long (or walled in): dig down into the surface underfoot and
    // disappear. The surface clips the creature as it sinks (see
    // Ecosystem.draw), with a little dirt kicked up.
    burrowAway() {
      if (this.burrow || this.dead) return;
      if (this.holding) this.release();
      if (this.grabbedBy) return; // not while something has hold of it
      const W = this.W;
      const m = this.mainPoint();
      let s = W.nearestSurface(m.x, m.y, 80, { floor: true, walls: true, ceil: true, poles: false });
      if (!s) {
        const hit = W.raycast(m.x, m.y, m.x, m.y + 400);
        s = hit ? { x: hit.x, y: hit.y, nx: 0, ny: -1 } : { x: m.x, y: m.y + 10, nx: 0, ny: -1 };
      }
      this.burrow = { t: 0, dur: 1.4, sx: s.x, sy: s.y, nx: s.nx, ny: s.ny, dustT: 0 };
      this.label = '';
      if (this.pather) this.pather.clear();
    }
    burrowStep(dt) {
      const b = this.burrow;
      b.t += dt;
      // sink into the surface (against its normal), slowly then quicker
      const sp = 18 + 40 * (b.t / b.dur);
      this.shiftAll(-b.nx * sp * dt, -b.ny * sp * dt);
      b.dustT -= dt;
      if (b.dustT <= 0) {
        b.dustT = 0.12;
        const m = this.mainPoint();
        // dirt flicks up where the body meets the surface
        const d = (m.x - b.sx) * b.nx + (m.y - b.sy) * b.ny;
        this.eco.burst(m.x - b.nx * d, m.y - b.ny * d, '#2b241d', 3);
      }
      if (b.t >= b.dur) {
        this.dead = true;
        this.eco.stats.left++;
      }
      return false;
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
    // The nearest corpse of one of these species (scavenging).
    nearestCorpse(species, range) {
      const m = this.mainPoint();
      let best = null;
      let bd = range * range;
      for (const c of this.eco.creatures) {
        if (!c.corpse || c.dead || c.grabbedBy || c.alpha < 0.5 || c === this) continue;
        if (!species.some((s) => (s.endsWith('*') ? c.species.startsWith(s.slice(0, -1)) : s === c.species))) continue;
        const d = U.dist2(m.x, m.y, c.x, c.y);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      return best;
    }
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
      if (this.corpse || (this.grabbedBy && this.grabbedBy.isHand)) return false; // limp in the hand
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
        if (c === this || c.dead || c.corpse || c.leaving || c.alpha < 0.6) continue;
        if (!species.some((s) => (s.endsWith('*') ? c.species.startsWith(s.slice(0, -1)) : s === c.species))) continue;
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
    // Time to pick somewhere new? Not mid-fall or from somewhere no route can
    // start (an empty route reads as "arrived"), and at most about once a
    // second, so a failed plan doesn't churn a new goal every frame.
    readyForGoal(dt, timeout, footing) {
      this.goalCd = (this.goalCd || 0) - dt;
      if (this.goalCd > 0 || footing === false) return false;
      const p = this.pather;
      if (!(p.done() || !p.goal || this.stateT > timeout)) return false;
      this.goalCd = 0.8;
      return true;
    }
    wanderGoal(caps, radius, filter) {
      if (!filter && Math.random() < 0.6) {
        const g = this.exploreGoal(caps);
        if (g) return g;
      }
      const m = this.mainPoint();
      return Nav.randomValid(this.W, caps, m.x, m.y, radius, filter);
    }
    // Somewhere anywhere on the map, favouring high ground (window tops,
    // ledges, perches) so creatures don't all pool on the floor; only a
    // place we can actually get to.
    exploreGoal(caps) {
      const W = this.W;
      const vc = Nav.validCells(W, caps);
      const list = vc.stand.length && Math.random() < 0.8 ? vc.stand : vc.all;
      const n = list.length / 2;
      if (!n) return null;
      const m = this.mainPoint();
      // a handful of random candidates, the best by height and freshness
      const cands = [];
      for (let k = 0; k < 14; k++) {
        const i = Math.floor(Math.random() * n) * 2;
        const x = W.centerX(list[i]);
        const y = W.centerY(list[i + 1]);
        const d = U.dist(m.x, m.y, x, y);
        if (d < 80) continue;
        // height only counts where you can stand (not clinging to the top edge)
        const hw = list === vc.stand ? 1.2 : 0.2;
        cands.push({ x, y, sc: (1 - y / W.h) * hw * this.heightBias() + Math.random() * 0.6 - d / 3000 });
      }
      cands.sort((a, b) => b.sc - a.sc);
      for (const c of cands.slice(0, 5)) {
        const r = Nav.findPath(W, m.x, m.y, c.x, c.y, caps, 5000);
        if (r && r.complete) return c;
      }
      return null;
    }
    // How strongly roaming favours high ground (negative: keeps low).
    heightBias() {
      return 1;
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

    // --- weapons ---
    // Circles a thrown rock or spear can hit: { x, y, r, part }.
    hitParts() {
      const m = this.mainPoint();
      return [{ x: m.x, y: m.y, r: 8, part: 'body' }];
    }
    stun(t, flip) {
      if (this.p.stunImmune || this.dead) return false;
      this.stunT = Math.max(this.stunT || 0, t);
      this.flipped = !!flip;
      if (this.holding) this.release();
      return true;
    }
    limp(dt) {}
    onRecovered() {}
    // Killed: a spray, then a corpse that lies where it falls (X'd-out eyes)
    // until a predator carries it off and swallows it.
    die(n) {
      const m = this.mainPoint();
      this.eco.burst(m.x, m.y, this.bloodColor || '#2a1418', n || 12);
      this.kill();
    }
    kill() {
      if (this.corpse || this.dead) return;
      this.corpse = true;
      this.corpseT = 0;
      this.stunT = 0;
      this.flipped = Math.random() < 0.5;
      if (this.holding) this.release();
      this.state = 'dead';
      this.label = '';
    }

    // Window dragged under us: ride along.
    carry(dx, dy) {}
    // Move the whole body rigidly (used to dig out of solids).
    shiftAll(dx, dy) {
      this.carry(dx, dy);
    }
    onUnburrowed() {
      this.contactId = null;
      if ('vx' in this) this.vx = this.vy = 0;
      if (this.pather) {
        // keep the goal, but plan a fresh route from where we came out
        this.pather.nodes = null;
        this.pather.timer = 0;
      }
    }

    // --- unburrowing ---
    // A window dropped on a creature, or one dragged to pin it against the
    // taskbar or a screen edge, can leave it inside a solid, squeezed in a
    // crack thinner than its body, or pushed off the screen. Collision alone
    // can't fix that (it pushes points out to the nearest edge, which may be
    // more solid), so once trapped for a moment the creature wriggles its way
    // to the nearest open cell, ignoring collisions, then carries on.
    trapped() {
      const W = this.W;
      const m = this.mainPoint();
      if (!isFinite(m.x) || !isFinite(m.y)) return false;
      if (m.x < -2 || m.y < -2 || m.x > W.w + 2 || m.y > W.h + 2) return true;
      if (W.isSolidPt(m.x, m.y)) return true;
      const c = this.squeezeClear || 3;
      return (
        (W.isSolidPt(m.x, m.y - c) && W.isSolidPt(m.x, m.y + c)) ||
        (W.isSolidPt(m.x - c, m.y) && W.isSolidPt(m.x + c, m.y))
      );
    }
    // Nearest open nav cell (not solid, on screen, with open neighbours so it
    // isn't another crack) to (x, y).
    findExit(x, y) {
      const W = this.W;
      const cx0 = U.clamp(W.cellX(x), 0, W.cols - 1);
      const cy0 = U.clamp(W.cellY(y), 0, W.rows - 1);
      const open = (cx, cy) => W.inBounds(cx, cy) && !W.solid(cx, cy);
      const maxR = Math.max(W.cols, W.rows);
      for (let r = 0; r <= maxR; r++) {
        let best = null;
        let bd = Infinity;
        for (let cy = cy0 - r; cy <= cy0 + r; cy++) {
          for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
            if (Math.max(Math.abs(cx - cx0), Math.abs(cy - cy0)) !== r || !open(cx, cy)) continue;
            let n = 0;
            if (open(cx - 1, cy)) n++;
            if (open(cx + 1, cy)) n++;
            if (open(cx, cy - 1)) n++;
            if (open(cx, cy + 1)) n++;
            if (n < 2) continue;
            const px = W.centerX(cx);
            const py = W.centerY(cy);
            if (W.isSolidPt(px, py)) continue;
            const d = (px - x) * (px - x) + (py - y) * (py - y);
            if (d < bd) {
              bd = d;
              best = { x: px, y: py };
            }
          }
        }
        if (best) return best;
      }
      return null;
    }
    // Returns true while digging out (the creature's own logic is skipped).
    unburrowStep(dt) {
      const ub = this.unburrow;
      if (!ub) {
        if (this.grabbedBy || this.alpha < 0.5) {
          this.trappedT = 0;
          return false;
        }
        this.trapCheckT = (this.trapCheckT || 0) - dt;
        if (this.trapCheckT > 0) return false;
        this.trapCheckT = 0.1;
        if (!this.trapped()) {
          this.trappedT = 0;
          return false;
        }
        this.trappedT = (this.trappedT || 0) + 0.1;
        if (this.trappedT < 0.35) return false;
        this.trappedT = 0;
        const m = this.mainPoint();
        const exit = this.findExit(m.x, m.y);
        if (!exit) {
          this.burrowAway();
          return true;
        }
        if (this.holding) this.release();
        this.unburrow = { tx: exit.x, ty: exit.y, t: 0, phase: Math.random() * 6 };
        this.label = 'unburrow';
        return true;
      }
      ub.t += dt;
      const m = this.mainPoint();
      const dx = ub.tx - m.x;
      const dy = ub.ty - m.y;
      const d = Math.hypot(dx, dy);
      if (d < 1.5 || ub.t > 4) {
        this.unburrow = null;
        this.label = '';
        if (this.eco.burst) this.eco.burst(m.x, m.y, '#1a1612', 5);
        this.onUnburrowed();
        return false;
      }
      // digging: slow start, side-to-side wriggle across the direction of travel
      const speed = 60 + 220 * Math.min(1, ub.t * 2.5);
      const step = Math.min(d, speed * dt);
      const wig = Math.sin(ub.t * 28 + ub.phase) * 2.2 * Math.min(1, d / 20);
      const ux = dx / d;
      const uy = dy / d;
      this.shiftAll(ux * step - uy * wig * dt * 28, uy * step + ux * wig * dt * 28);
      return true;
    }

    // Screen area this creature may draw into, [x0, y0, x1, y1] in world
    // units (used to limit the per-frame pixel pass).
    bounds() {
      const m = this.mainPoint();
      return [m.x - 48, m.y - 48, m.x + 48, m.y + 48];
    }
    static ptsBounds(pts, pad) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
      return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    }

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
