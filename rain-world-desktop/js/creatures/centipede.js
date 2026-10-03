// Centipedes: segmented armoured crawlers that ripple along any surface,
// legs moving in a travelling wave. Small ones are shy prey; medium and large
// adults hunt, shocking what they catch before carrying it off to eat.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;
  const Nav = RW.Nav;

  const GRAV = 900;

  class Centipede extends RW.Creature {
    constructor(eco, species, x, y) {
      super(eco, species, x, y);
      const p = this.p;
      const S = (this.size = p.size || 1);
      const r = p.segments || [6, 9];
      this.n = U.randInt(r[0], r[1]);
      this.chain = new RW.Chain(x, y, this.n, 6.5 * S, U.sign(), 0);
      this.diet = p.diet || [];
      this.hp = 1;
      this.fullT = U.rand(0, 20);
      this.eatT = 0;
      this.cols = p.colors || ['#e3892c', '#e9b23a', '#8f2f17', '#7a2614'];
      this.vx = 0;
      this.vy = 0;
      this.caps = { walls: true, ceil: true, poles: true, fall: true, wallCost: 1.1, ceilCost: 1.3 };
      this.mask = { floor: true, walls: true, ceil: true, poles: true };
      this.maskNoPole = { floor: true, walls: true, ceil: true, poles: false };
      this.pather = new RW.Pather(this, this.caps);
      this.ux = 0;
      this.uy = -1;
      this.phase = 0;
      this.hue = U.rand(0, 1);
      this.threats = p.threats || ['lizard_*', 'daddy', 'dropwig', 'centipede_medium', 'centipede_large'];
      this.bloodColor = '#5a2a12';
      this.perceiveT = 0;
      this.idleT = 0;
    }
    mainPoint() {
      return this.chain.pts[0];
    }
    bounds() {
      return RW.Creature.ptsBounds(this.chain.pts, 16 * this.size);
    }
    holdPoint() {
      const P = this.chain.pts;
      const a = Math.atan2(P[0].y - P[1].y, P[0].x - P[1].x);
      return { x: P[0].x + Math.cos(a) * 6 * this.size, y: P[0].y + Math.sin(a) * 6 * this.size };
    }
    carry(dx, dy) {
      this.chain.shift(dx, dy);
    }
    // --- weapons
    hitParts() {
      const P = this.chain.pts;
      const r = 4 * (this.size || 1);
      const out = [];
      for (let i = 0; i < P.length; i += 2) out.push({ x: P[i].x, y: P[i].y, r, part: i ? 'body' : 'head' });
      return out;
    }
    limp(dt) {
      const W = this.W;
      const P = this.chain.pts;
      const h = P[0];
      this.vy += GRAV * dt;
      this.vx *= Math.pow(0.3, dt);
      h.x += this.vx * dt;
      h.y += this.vy * dt;
      const c = W.collideCircle(h, 3 * this.size);
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx;
          this.vy -= vn * c.ny;
        }
        this.vx *= 0.8;
      }
      this.chain.verlet(1, 0.9, 0, GRAV, dt);
      this.chain.follow(1);
      this.chain.collide(W, 2.5 * this.size, 1);
      this.phase += dt * 6;
    }
    // Rocks stun the small ones well, adults barely; a spear skewers a small
    // one outright but takes a few to kill an adult.
    onRockHit() {
      this.stun(1.5 / (this.size * this.size));
    }
    onSpearHit(w) {
      if (this.size <= 1) {
        this.remove();
        return 'skewer';
      }
      this.hp -= 0.6 / (this.p.toughness || this.size);
      if (this.holding) this.release();
      if (this.hp <= 0) {
        this.die(14);
        return 'drop';
      }
      const t = w.thrower || w;
      const g = this.fleeGoal(this.caps, t.x, t.y, 300);
      if (g) this.pather.setGoal(g.x, g.y, true);
      this.setState('flee');
      return 'embed';
    }
    onBitten(by) {
      this.setState('flee');
      const g = this.fleeGoal(this.caps, by.x, by.y, 300);
      if (g) this.pather.setGoal(g.x, g.y, true);
    }

    think(dt) {
      const h = this.chain.pts[0];
      this.speed = this.p.speed || 55;
      this.perceiveT -= dt;
      if (this.wantsToLeave(dt)) {
        this.setState('leave');
        const den = this.eco.nearestDen(h.x, h.y);
        if (den) {
          this.pather.setGoal(den.x, den.y);
          if (U.dist(h.x, h.y, den.x, den.y) < 20) this.leave();
        }
        return;
      }
      // Adults: shock what we catch, then eat it.
      if (this.holding) {
        const prey = this.holding;
        this.setState('eat');
        this.pather.clear();
        this.eatT += dt;
        if (!prey.corpse && this.eatT > 0.7) prey.kill();
        if (this.eatT > 4) {
          this.eco.consume(prey, this);
          this.holding = null;
          this.eatT = 0;
          this.fullT = U.rand(40, 80);
        }
        return;
      }
      this.fullT -= dt;
      const perceive = this.perceiveT <= 0;
      if (perceive && this.diet.length && this.fullT <= 0 && this.state !== 'hunt' && this.state !== 'flee') {
        const v = 200 * this.size;
        const prey = this.nearestOf(this.diet, v, (c) => c.canBeGrabbed() && this.canSee(c.x, c.y, v)) || this.nearestCorpse(this.diet, v * 0.7);
        if (prey) {
          this.prey = prey;
          this.setState('hunt');
        }
      }
      // danger first: drop the hunt and let the threat check below run
      if (this.state === 'hunt' && perceive && this.threatNear(170)) this.setState('wander');
      if (this.state === 'hunt') {
        const prey = this.prey;
        if (!prey || prey.dead || prey.leaving || prey.grabbedBy || this.stateT > 18) {
          this.prey = null;
          this.setState('wander');
        } else {
          this.speed = this.p.huntSpeed || this.speed * 1.8;
          this.pather.interval = 0.5;
          this.pather.setGoal(prey.x, prey.y);
          const hp = prey.hitParts()[0];
          if (U.dist(h.x, h.y, hp.x, hp.y) < 9 * this.size + hp.r * 0.5) {
            // the shock: a crackle of sparks and the prey goes stiff
            this.eco.burst(hp.x, hp.y, '#fff2a0', 8);
            if (!prey.corpse) prey.stun(1.5);
            if (this.eco.cfg.ecosystem.predation && this.grab(prey)) {
              this.eatT = 0;
              this.prey = null;
            } else {
              this.setState('wander');
            }
          }
          return;
        }
      }
      if (this.perceiveT <= 0) {
        this.perceiveT = 0.4;
        const t = this.threatNear(170);
        if (t && this.state !== 'flee') {
          this.setState('flee');
          const g = this.fleeGoal(this.caps, t.x, t.y, 300);
          if (g) this.pather.setGoal(g.x, g.y, true);
        }
      }
      if (this.state === 'flee') {
        this.speed *= 2.2;
        if (this.stateT > 3) this.setState('wander');
        return;
      }
      if (this.state === 'idle') {
        this.idleT -= dt;
        this.pather.clear();
        if (this.idleT <= 0) this.setState('wander');
        return;
      }
      this.setState('wander');
      if (this.readyForGoal(dt, 20)) {
        if (this.pather.goal && Math.random() < 0.4) {
          this.setState('idle');
          this.idleT = U.rand(2, 6);
          return;
        }
        const g = this.wanderGoal(this.caps, 400);
        if (g) this.pather.setGoal(g.x, g.y, true);
        this.stateT = 0;
      }
    }

    update(dt) {
      if (!this.tick(dt)) return;
      const W = this.W;
      const P = this.chain.pts;
      const h = P[0];
      if (this.grabbedBy) {
        const hp = this.grabbedBy.holdPoint();
        h.x = hp.x;
        h.y = hp.y;
        this.chain.verlet(1, 0.9, 0, GRAV, dt);
        this.chain.follow(1);
        this.phase += dt * 30;
        this.struggle(dt);
        return;
      }
      this.think(dt);
      this.pather.update(dt, h.x, h.y);
      this.pather.advance(h.x, h.y, W.cell * 0.8);
      // Poles only count when the path uses one (see lizard.js). Grip range
      // covers path nodes that sit up to a cell from a partly covered wall.
      const pn = this.pather.current();
      const mask = pn && W.pole(pn.cx, pn.cy) && !W.solid(pn.cx, pn.cy + 1) ? this.mask : this.maskNoPole;
      const S = this.size;
      let g = W.nearestSurface(h.x, h.y, 24 * S, mask);
      if (this.dropT > 0) {
        this.dropT -= dt;
        g = null;
      }
      const node = this.pather.current();
      let dvx = 0;
      let dvy = 0;
      let leaving = false;
      if (node) {
        let ty = node.y;
        if (node.type === Nav.FALL && g) {
          if (Math.abs(node.x - h.x) < W.cell * 0.6) this.dropT = 0.35;
          else ty = h.y;
        }
        const dx = node.x - h.x;
        const dy = ty - h.y;
        const d = Math.hypot(dx, dy) || 1;
        dvx = (dx / d) * this.speed;
        dvy = (dy / d) * this.speed;
        leaving = node.type === Nav.FALL || (g && (dx / d) * g.nx + (dy / d) * g.ny > 0.6);
      }
      if (g) {
        const k = U.approach(8, dt);
        this.vx += (dvx - this.vx) * k;
        this.vy += (dvy - this.vy) * k;
      } else {
        this.vy += GRAV * dt;
      }
      h.x += this.vx * dt;
      h.y += this.vy * dt;
      if (g && !leaving) {
        const e = g.d - 5 * S;
        h.x -= g.nx * e * 0.3;
        h.y -= g.ny * e * 0.3;
        this.contactId = g.id;
      }
      const c = W.collideCircle(h, 3.5 * S);
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx;
          this.vy -= vn * c.ny;
        }
      }
      this.chain.verlet(1, 0.8, 0, g ? 0 : GRAV, dt);
      this.chain.follow(1);
      for (let i = 1; i < P.length; i++) {
        const s = W.nearestSurface(P[i].x, P[i].y, 18 * S, mask);
        if (s) {
          const e = s.d - 5 * S;
          P[i].x -= s.nx * e * 0.35;
          P[i].y -= s.ny * e * 0.35;
        }
        W.collideCircle(P[i], 3 * S);
      }
      const ux = g ? g.nx : 0;
      const uy = g ? g.ny : -1;
      const ku = U.approach(8, dt);
      this.ux += (ux - this.ux) * ku;
      this.uy += (uy - this.uy) * ku;
      const ul = Math.hypot(this.ux, this.uy) || 1;
      this.ux /= ul;
      this.uy /= ul;
      this.phase += (Math.hypot(this.vx, this.vy) * dt * 0.45) / S;
    }

    draw(ctx) {
      const P = this.chain.pts;
      const n = P.length;
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.lineCap = 'round';
      const S = this.size;
      const head = U.mix(this.cols[0], this.cols[1], this.hue);
      const tail = U.mix(this.cols[2], this.cols[3], this.hue);
      // legs: a travelling wave, one pair per segment
      ctx.strokeStyle = '#2a1a12';
      ctx.lineWidth = 1.1 * Math.sqrt(S);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = P[Math.max(0, i - 1)];
        const b = P[Math.min(n - 1, i + 1)];
        let tx = a.x - b.x;
        let ty = a.y - b.y;
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        for (const s of [-1, 1]) {
          const w = Math.sin(this.phase + i * 0.9 + (s > 0 ? Math.PI : 0));
          ctx.moveTo(P[i].x, P[i].y);
          const st = this.corpse ? 0 : w * 2.5;
          ctx.lineTo(P[i].x - this.ux * 5.5 * S + tx * (st + s * 1.5) * S, P[i].y - this.uy * 5.5 * S + ty * (st + s * 1.5) * S);
        }
      }
      ctx.stroke();
      // shell segments, tail first
      for (let i = n - 1; i >= 0; i--) {
        const a = P[Math.max(0, i - 1)];
        const b = P[Math.min(n - 1, i + 1)];
        const ang = Math.atan2(a.y - b.y, a.x - b.x);
        const t = i / (n - 1);
        const col = i === 0 ? U.scale(tail, 0.85) : U.mix(head, tail, t);
        const sz = (i === 0 ? 4.6 : 4.2 - t * 1.2) * S;
        ctx.save();
        ctx.translate(P[i].x, P[i].y);
        ctx.rotate(ang);
        ctx.fillStyle = U.rgba(U.scale(col, 0.55));
        ctx.beginPath();
        ctx.ellipse(0, 0, sz * 1.05, sz * 0.85, 0, 0, U.TAU);
        ctx.fill();
        ctx.fillStyle = U.rgba(col);
        ctx.beginPath();
        ctx.ellipse(0.5, 0, sz * 0.85, sz * 0.7, 0, 0, U.TAU);
        ctx.fill();
        ctx.fillStyle = U.rgba(U.mix(col, '#fff3c0', 0.35));
        ctx.fillRect(-0.5, -sz * 0.45, sz * 0.8, 1);
        // dark seam between plates
        ctx.fillStyle = 'rgb(30,14,10)';
        ctx.fillRect(-sz * 0.95, -sz * 0.7, Math.max(1, S * 0.7), sz * 1.4);
        if (i === 0) {
          if (this.corpse) {
            // dead: little X'd eyes
            ctx.strokeStyle = '#f2d36b';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            for (const ey of [-1.6 * S, 1 * S]) {
              ctx.moveTo(sz * 0.3, ey - 0.8);
              ctx.lineTo(sz * 0.3 + 1.6, ey + 0.8);
              ctx.moveTo(sz * 0.3 + 1.6, ey - 0.8);
              ctx.lineTo(sz * 0.3, ey + 0.8);
            }
            ctx.stroke();
          } else {
            ctx.fillStyle = '#f2d36b';
            ctx.fillRect(sz * 0.4, -1.8 * S, Math.max(1, S * 0.8), Math.max(1, S * 0.8));
            ctx.fillRect(sz * 0.4, 0.8 * S, Math.max(1, S * 0.8), Math.max(1, S * 0.8));
          }
        }
        ctx.restore();
      }
      // antennae and tail prongs
      const h = P[0];
      const ha = Math.atan2(P[0].y - P[1].y, P[0].x - P[1].x);
      ctx.strokeStyle = U.rgba(U.scale(head, 0.7));
      ctx.lineWidth = 0.9 * Math.sqrt(S);
      ctx.beginPath();
      for (const s of [-1, 1]) {
        const a = ha + s * 0.5 + (this.corpse ? 0.6 * s : Math.sin(this.age * 6 + s) * 0.15);
        ctx.moveTo(h.x, h.y);
        ctx.quadraticCurveTo(h.x + Math.cos(ha) * 6 * S, h.y + Math.sin(ha) * 6 * S, h.x + Math.cos(a) * 10 * S, h.y + Math.sin(a) * 10 * S);
      }
      const tl = P[n - 1];
      const ta = Math.atan2(P[n - 1].y - P[n - 2].y, P[n - 1].x - P[n - 2].x);
      for (const s of [-1, 1]) {
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tl.x + Math.cos(ta + s * 0.4) * 6 * S, tl.y + Math.sin(ta + s * 0.4) * 6 * S);
      }
      ctx.stroke();
      ctx.restore();
      this.drawPath(ctx, this.pather);
      this.drawDebug(ctx);
    }
  }

  RW.Creatures.Centipede = Centipede;
})();
