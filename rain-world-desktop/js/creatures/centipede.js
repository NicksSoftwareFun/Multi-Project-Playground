// Small centipedes: segmented armoured crawlers that ripple along any
// surface, legs moving in a travelling wave. Shy prey for lizards.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;
  const Nav = RW.Nav;

  const GRAV = 900;

  class Centipede extends RW.Creature {
    constructor(eco, species, x, y) {
      super(eco, species, x, y);
      const r = this.p.segments || [6, 9];
      this.n = U.randInt(r[0], r[1]);
      this.chain = new RW.Chain(x, y, this.n, 6.5, U.sign(), 0);
      this.vx = 0;
      this.vy = 0;
      this.caps = { walls: true, ceil: true, poles: true, fall: true, wallCost: 1.1, ceilCost: 1.3 };
      this.mask = { floor: true, walls: true, ceil: true, poles: true };
      this.pather = new RW.Pather(this, this.caps);
      this.ux = 0;
      this.uy = -1;
      this.phase = 0;
      this.hue = U.rand(0, 1);
      this.threats = ['lizard_pink', 'lizard_green', 'lizard_blue', 'lizard_white', 'daddy', 'dropwig'];
      this.bloodColor = '#5a2a12';
      this.perceiveT = 0;
      this.idleT = 0;
    }
    mainPoint() {
      return this.chain.pts[0];
    }
    carry(dx, dy) {
      this.chain.shift(dx, dy);
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
      if (this.pather.done() || !this.pather.goal || this.stateT > 20) {
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
      const g = W.nearestSurface(h.x, h.y, 14, this.mask);
      const node = this.pather.current();
      let dvx = 0;
      let dvy = 0;
      let leaving = false;
      if (node) {
        let ty = node.y;
        if (node.type === Nav.FALL && g) ty = h.y;
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
        const e = g.d - 5;
        h.x -= g.nx * e * 0.3;
        h.y -= g.ny * e * 0.3;
        this.contactId = g.id;
      }
      const c = W.collideCircle(h, 3.5);
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
        const s = W.nearestSurface(P[i].x, P[i].y, 14, this.mask);
        if (s) {
          const e = s.d - 5;
          P[i].x -= s.nx * e * 0.35;
          P[i].y -= s.ny * e * 0.35;
        }
        W.collideCircle(P[i], 3);
      }
      const ux = g ? g.nx : 0;
      const uy = g ? g.ny : -1;
      const ku = U.approach(8, dt);
      this.ux += (ux - this.ux) * ku;
      this.uy += (uy - this.uy) * ku;
      const ul = Math.hypot(this.ux, this.uy) || 1;
      this.ux /= ul;
      this.uy /= ul;
      this.phase += Math.hypot(this.vx, this.vy) * dt * 0.45;
    }

    draw(ctx) {
      const P = this.chain.pts;
      const n = P.length;
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.lineCap = 'round';
      const head = U.mix('#ffb03a', '#ffd84a', this.hue);
      const tail = U.mix('#d2421c', '#b8321a', this.hue);
      // legs: a travelling wave, one pair per segment
      ctx.strokeStyle = '#2a1a12';
      ctx.lineWidth = 1.1;
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
          ctx.lineTo(P[i].x - this.ux * 5.5 + tx * (w * 2.5 + s * 1.5), P[i].y - this.uy * 5.5 + ty * (w * 2.5 + s * 1.5));
        }
      }
      ctx.stroke();
      // shell segments, tail first
      for (let i = n - 1; i >= 0; i--) {
        const a = P[Math.max(0, i - 1)];
        const b = P[Math.min(n - 1, i + 1)];
        const ang = Math.atan2(a.y - b.y, a.x - b.x);
        const t = i / (n - 1);
        const col = U.mix(head, tail, t);
        const sz = i === 0 ? 4.6 : 4.2 - t * 1.2;
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
        ctx.fillStyle = U.rgba(U.mix(col, '#fff3c0', 0.35), 0.8);
        ctx.fillRect(-0.5, -sz * 0.45, sz * 0.8, 1);
        ctx.restore();
      }
      // antennae and tail prongs
      const h = P[0];
      const ha = Math.atan2(P[0].y - P[1].y, P[0].x - P[1].x);
      ctx.strokeStyle = U.rgba(U.scale(head, 0.7));
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (const s of [-1, 1]) {
        const a = ha + s * 0.5 + Math.sin(this.age * 6 + s) * 0.15;
        ctx.moveTo(h.x, h.y);
        ctx.quadraticCurveTo(h.x + Math.cos(ha) * 6, h.y + Math.sin(ha) * 6, h.x + Math.cos(a) * 10, h.y + Math.sin(a) * 10);
      }
      const tl = P[n - 1];
      const ta = Math.atan2(P[n - 1].y - P[n - 2].y, P[n - 1].x - P[n - 2].x);
      for (const s of [-1, 1]) {
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tl.x + Math.cos(ta + s * 0.4) * 6, tl.y + Math.sin(ta + s * 0.4) * 6);
      }
      ctx.stroke();
      ctx.restore();
      this.drawPath(ctx, this.pather);
      this.drawDebug(ctx);
    }
  }

  RW.Creatures.Centipede = Centipede;
})();
