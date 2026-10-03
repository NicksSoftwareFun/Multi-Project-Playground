// Lizards: the iconic Rain World predator. A verlet spine (neck, body, tail)
// steered from the head, four IK legs that step onto real surfaces in a
// diagonal gait, and a hinged jaw. Species differ by colour, size and which
// surfaces they may climb.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;
  const Nav = RW.Nav;

  const GRAV = 900;

  class Lizard extends RW.Creature {
    constructor(eco, species, x, y) {
      super(eco, species, x, y);
      const p = this.p;
      const L = (this.L = p.length || 1);
      this.headColor = U.hex(p.headColor || '#ff2fc0');
      this.bodyColor = U.hex(p.bodyColor || '#1d151d');
      this.bodyTint = p.bodyTint === undefined ? 0.25 : p.bodyTint;
      this.bodyN = 7;
      const nTail = 16;
      const segs = [];
      for (let i = 0; i < this.bodyN; i++) segs.push((i === 0 ? 9 : 6.2) * L);
      for (let i = 0; i < nTail; i++) segs.push(5.6 * L * (1 - i / (nTail * 2.4)));
      const dir = U.sign();
      this.spine = new RW.Chain(x, y, this.bodyN + nTail, segs, -dir, 0);
      this.vx = 0;
      this.vy = 0;
      this.caps = {
        walls: !!p.climbWalls,
        ceil: !!p.climbCeilings,
        poles: !!p.poles,
        fall: true,
        jumpX: 0,
        jumpUp: 0,
        wallCost: 1.3,
        ceilCost: 1.8,
        poleCost: 1.4,
      };
      this.mask = { floor: true, walls: !!p.climbWalls, ceil: !!p.climbCeilings, poles: !!p.poles };
      this.pather = new RW.Pather(this, this.caps);
      const l1 = 10 * L;
      const l2 = 10.5 * L;
      const o = { stepDur: 0.17, lift: 6 * L };
      this.legs = [
        { leg: new RW.Leg(l1, l2, Object.assign({ group: 0, forward: 0.65 }, o)), at: 2, near: true },
        { leg: new RW.Leg(l1, l2, Object.assign({ group: 1, forward: 0.35 }, o)), at: 2, near: false },
        { leg: new RW.Leg(l1, l2, Object.assign({ group: 1, forward: 0.55 }, o)), at: 5, near: true },
        { leg: new RW.Leg(l1, l2, Object.assign({ group: 0, forward: 0.25 }, o)), at: 5, near: false },
      ];
      for (const l of this.legs) {
        const h = this.spine.pts[l.at];
        l.leg.place(h.x, h.y + 10);
      }
      this.ux = 0;
      this.uy = -1;
      this.jaw = 0;
      this.jawTarget = 0;
      this.headAng = dir > 0 ? 0 : Math.PI;
      this.speed = p.speed || 90;
      this.grip = null;
      this.lungeT = 0;
      this.lungeCd = 0;
      this.perceiveT = 0;
      this.prey = null;
      this.fullT = U.rand(0, 15);
      this.eatT = 0;
      this.idleT = 0;
      this.cursorBites = 0;
      this.cursorBored = 0;
      this.diet = ['slugcat', 'centipede', 'batfly'];
      if (L >= 1.1) this.diet.push('lizard_blue');
      this.threats = ['daddy'];
      this.camo = 1;
      this.mass = 2 * L;
    }

    mainPoint() {
      return this.spine.pts[0];
    }
    holdPoint() {
      const h = this.spine.pts[0];
      return { x: h.x + Math.cos(this.headAng) * 12 * this.L, y: h.y + Math.sin(this.headAng) * 12 * this.L };
    }
    carry(dx, dy) {
      this.spine.shift(dx, dy);
      for (const l of this.legs) l.leg.shift(dx, dy);
    }

    // ---------------------------------------------------------------- AI ----
    think(dt) {
      const eco = this.eco;
      const head = this.spine.pts[0];
      const cfgE = eco.cfg.ecosystem;
      this.perceiveT -= dt;
      this.fullT -= dt;
      this.lungeCd -= dt;
      this.cursorBored -= dt;
      const perceive = this.perceiveT <= 0;
      if (perceive) this.perceiveT = 0.25 + Math.random() * 0.1;
      this.speed = this.p.speed || 90;
      this.jawTarget = 0;
      this.pather.interval = 1.2;

      if (this.holding) {
        this.setState('eat');
        this.eatT += dt;
        this.jawTarget = 0.3;
        this.speed *= 0.6;
        if (this.pather.done() || this.stateT > 6) {
          const g = this.wanderGoal(this.caps, 250);
          if (g) this.pather.setGoal(g.x, g.y);
        }
        if (this.eatT > 4.5) {
          eco.consume(this.holding, this);
          this.holding = null;
          this.fullT = U.rand(30, 60);
          this.eatT = 0;
        }
        return;
      }

      if (this.wantsToLeave(dt)) {
        this.setState('leave');
        const den = eco.nearestDen(head.x, head.y, this.caps);
        if (den) {
          this.pather.setGoal(den.x, den.y);
          if (U.dist(head.x, head.y, den.x, den.y) < 26) this.leave();
        }
        this.speed *= 1.3;
        return;
      }

      if (perceive) {
        const threat = this.threatNear(200);
        if (threat) {
          this.setState('flee');
          const g = this.fleeGoal(this.caps, threat.x, threat.y, 350);
          if (g) this.pather.setGoal(g.x, g.y, true);
        }
      }
      if (this.state === 'flee') {
        this.speed = this.p.huntSpeed || 160;
        if (this.stateT < 3) return;
        this.setState('wander');
      }

      // Hunting
      if (perceive && this.fullT <= 0) {
        const vision = this.p.vision || 300;
        if (this.giveUpT > 0) this.giveUpT -= 0.25;
        const prey = this.nearestOf(this.diet, vision, (c) => !c.grabbedBy && !(this.giveUpT > 0 && c === this.gaveUpOn) && this.canSee(c.x, c.y, vision));
        if (prey) {
          this.prey = prey;
          this.setState('hunt');
        } else if (this.state === 'hunt' && this.stateT > 4) {
          this.prey = null;
          this.setState('wander');
        }
      }
      if (this.state === 'hunt' && this.prey) {
        const prey = this.prey;
        const hopeless = this.stateT > 25 || (this.stateT > 8 && !this.pather.complete);
        if (hopeless) {
          this.gaveUpOn = prey;
          this.giveUpT = 20;
        }
        if (prey.dead || prey.leaving || prey.grabbedBy || hopeless) {
          this.prey = null;
          this.setState('wander');
        } else {
          this.speed = this.p.huntSpeed || 160;
          this.pather.interval = 0.45;
          this.pather.setGoal(prey.x, prey.y);
          const d = U.dist(head.x, head.y, prey.x, prey.y);
          if (d < 140) this.jawTarget = 0.35;
          if (d < 75 * this.L && this.lungeCd <= 0 && this.grip && this.W.lineClear(head.x, head.y, prey.x, prey.y)) {
            this.lunge(prey.x, prey.y, prey);
          }
          return;
        }
      }

      // Stalk the cursor when it's resting nearby.
      const cur = eco.cursor;
      if (cfgE.cursorInteraction && cur.inside && this.cursorBored <= 0) {
        const d = U.dist(head.x, head.y, cur.x, cur.y);
        const vision = this.p.vision || 300;
        if (d < vision && cur.still > 0.5 && (this.state === 'stalk' || (perceive && Math.random() < 0.08))) {
          this.setState('stalk');
          this.speed = (this.p.speed || 90) * 0.75;
          this.jawTarget = 0.25;
          this.pather.interval = 0.6;
          this.pather.setGoal(cur.x, cur.y);
          if (d < 70 * this.L && this.lungeCd <= 0 && this.grip) {
            this.lunge(cur.x, cur.y, null);
            if (++this.cursorBites >= 3) {
              this.cursorBites = 0;
              this.cursorBored = U.rand(12, 25);
              this.setState('wander');
            }
          }
          return;
        }
        if (this.state === 'stalk') this.setState('wander');
      } else if (this.state === 'stalk') {
        this.setState('wander');
      }

      // Wander with pauses.
      if (this.state !== 'wander' && this.state !== 'idle') this.setState('wander');
      if (this.state === 'idle') {
        this.pather.clear();
        this.idleT -= dt;
        if (Math.random() < dt * 0.15) this.jawTarget = 0.7; // yawn / hiss
        if (this.idleT <= 0) this.setState('wander');
        return;
      }
      if (this.pather.done() || !this.pather.goal || this.stateT > 14) {
        if (this.pather.goal && Math.random() < 0.35) {
          this.setState('idle');
          this.idleT = U.rand(1.5, 4.5);
          return;
        }
        const g = this.wanderGoal(this.caps, 500);
        if (g) this.pather.setGoal(g.x, g.y, true);
        this.stateT = 0;
      }
    }

    lunge(tx, ty, prey) {
      const head = this.spine.pts[0];
      const dx = tx - head.x;
      const dy = ty - head.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = 380 + 120 * this.L;
      this.vx = (dx / d) * sp;
      this.vy = (dy / d) * sp;
      this.lungeT = 0.24;
      this.lungeCd = U.rand(1.1, 2.2);
      this.lungePrey = prey;
      this.jawTarget = 1;
    }

    // --------------------------------------------------------- physics ----
    update(dt) {
      if (!this.tick(dt)) return;
      const W = this.W;
      const P = this.spine.pts;
      const head = P[0];
      const L = this.L;

      if (this.grabbedBy) {
        const hp = this.grabbedBy.holdPoint();
        head.x = hp.x;
        head.y = hp.y;
        this.spine.verlet(1, 0.9, 0, GRAV, dt);
        this.spine.follow(1);
        this.spine.collide(W, 3, 1);
        this.jaw += (Math.random() < 0.1 ? 1 : 0 - this.jaw) * 0.3;
        this.updateLegs(dt, false);
        this.struggle(dt);
        return;
      }

      this.think(dt);
      this.pather.update(dt, head.x, head.y);

      let g = W.nearestSurface(head.x, head.y, 22 * L, this.mask);
      if (!g) g = W.nearestSurface(P[3].x, P[3].y, 20 * L, this.mask);
      if (this.dropT > 0) {
        // letting go on purpose to drop down
        this.dropT -= dt;
        g = null;
      }
      this.grip = g;

      if (this.lungeT > 0) {
        this.lungeT -= dt;
        if (this.lungeT < 0.12) this.vy += GRAV * dt;
        const prey = this.lungePrey;
        if (prey && !prey.dead && U.dist(head.x, head.y, prey.x, prey.y) < 18 * L) {
          if (this.eco.cfg.ecosystem.predation && this.grab(prey)) {
            this.eatT = 0;
            this.lungeT = 0;
          } else if (prey.onBitten) {
            prey.onBitten(this);
            this.lungeT = 0;
          }
          this.lungePrey = null;
        }
      } else {
        // Steering toward the next path node.
        const cell = W.cell;
        this.pather.advance(head.x, head.y, cell * 0.8);
        const node = this.pather.current();
        let dvx = 0;
        let dvy = 0;
        this.leavingSurface = false;
        if (node) {
          let tx = node.x;
          let ty = node.y;
          if (node.type === Nav.FALL && g) {
            if (Math.abs(node.x - head.x) < cell * 0.6) this.dropT = 0.35; // right above it: let go
            else ty = head.y; // walk off the edge first
          }
          const dx = tx - head.x;
          const dy = ty - head.y;
          const d = Math.hypot(dx, dy) || 1;
          dvx = (dx / d) * this.speed;
          dvy = (dy / d) * this.speed;
          // Deliberately stepping off a surface: don't let the hug pull us back.
          this.leavingSurface = node.type === Nav.FALL || (g && (dx / d) * g.nx + (dy / d) * g.ny > 0.6);
        }
        if (g) {
          const k = U.approach(9, dt);
          this.vx += (dvx - this.vx) * k;
          this.vy += (dvy - this.vy) * k;
        } else {
          this.vy += GRAV * dt;
          this.vx += (dvx * 0.3 - this.vx) * U.approach(0.8, dt);
        }
      }

      head.x += this.vx * dt;
      head.y += this.vy * dt;
      if (g && this.lungeT <= 0 && !this.leavingSurface) {
        // hug the surface at a fixed body height
        const err = g.d - 11 * L;
        head.x -= g.nx * err * 0.25;
        head.y -= g.ny * err * 0.25;
        this.contactId = g.id;
      }
      const c = W.collideCircle(head, 5 * L);
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx;
          this.vy -= vn * c.ny;
        }
      }
      head.px = head.x;
      head.py = head.y;

      // Body and tail
      this.spine.verlet(this.bodyN, 0.88, 0, g ? 150 : 700, dt);
      this.spine.follow(1);
      for (let i = 1; i < P.length; i++) {
        const pt = P[i];
        if (g && !this.leavingSurface && i < this.bodyN + 4) {
          const s = W.nearestSurface(pt.x, pt.y, 22 * L, this.mask);
          if (s) {
            const e = s.d - (i < this.bodyN ? 10 : 4.5 + (this.bodyN + 4 - i) * 1.2) * L;
            pt.x -= s.nx * e * 0.3;
            pt.y -= s.ny * e * 0.3;
          }
        }
        W.collideCircle(pt, i < this.bodyN ? 4 * L : 2.5);
      }

      // Smoothed "up" (away from surface) and head angle.
      const ux = g ? g.nx : 0;
      const uy = g ? g.ny : -1;
      const ku = U.approach(6, dt);
      this.ux += (ux - this.ux) * ku;
      this.uy += (uy - this.uy) * ku;
      const ul = Math.hypot(this.ux, this.uy) || 1;
      this.ux /= ul;
      this.uy /= ul;
      let ang = Math.atan2(head.y - P[1].y, head.x - P[1].x);
      if (this.state === 'idle') ang += Math.sin(this.age * 1.7) * 0.35;
      this.headAng = U.lerpAngle(this.headAng, ang, U.approach(12, dt));
      this.jaw += (this.jawTarget - this.jaw) * U.approach(this.jawTarget > this.jaw ? 25 : 8, dt);

      this.updateLegs(dt, true);
      const speedNow = Math.hypot(this.vx, this.vy);
      if (this.p.camouflage) {
        const visible = this.lungeT > 0 || this.holding ? 1 : U.clamp(speedNow / 140, 0.12, 1);
        this.camo += (visible - this.camo) * U.approach(visible > this.camo ? 6 : 0.7, dt);
        this.lurking = this.camo < 0.4;
      }
    }

    updateLegs(dt, active) {
      const P = this.spine.pts;
      const stepping = [false, false];
      for (const l of this.legs) if (l.leg.stepping) stepping[l.leg.group] = true;
      const spd = Math.hypot(this.vx, this.vy) / (this.p.speed || 90);
      for (const l of this.legs) {
        const a = P[l.at - 1];
        const b = P[l.at + 1];
        let fx = a.x - b.x;
        let fy = a.y - b.y;
        const fl = Math.hypot(fx, fy) || 1;
        fx /= fl;
        fy /= fl;
        const h = P[l.at];
        const canStep = active && !stepping[1 - l.leg.group];
        l.leg.update(dt, this.W, h.x, h.y, fx, fy, this.ux, this.uy, this.mask, canStep, spd);
      }
    }

    // ------------------------------------------------------------ drawing ----
    draw(ctx) {
      const P = this.spine.pts;
      const L = this.L;
      ctx.save();
      ctx.globalAlpha = this.alpha * (this.p.camouflage ? this.camo : 1);
      const body = this.bodyColor;
      const head = this.headColor;
      const farCol = U.rgba(U.scale(U.mix(body, head, this.bodyTint * 0.5), 0.7));
      const nearCol = U.rgba(U.mix(body, head, this.bodyTint * 0.6));

      for (const l of this.legs) if (!l.near) this.drawLeg(ctx, l, farCol, 0.85);

      // Body silhouette with head colour bleeding down the neck.
      const n = P.length;
      const widths = new Array(n);
      const prof = [4.2, 4.4, 5.6, 6.2, 6.3, 5.9, 5.1];
      for (let i = 0; i < n; i++) {
        if (i < this.bodyN) widths[i] = prof[i] * L;
        else {
          const t = (i - this.bodyN + 1) / (n - this.bodyN);
          widths[i] = Math.max(0.5, 4.6 * L * Math.pow(1 - t, 1.25));
        }
      }
      const grad = ctx.createLinearGradient(P[0].x, P[0].y, P[5].x, P[5].y);
      grad.addColorStop(0, U.rgba(U.mix(body, head, 0.85)));
      grad.addColorStop(0.45, U.rgba(U.mix(body, head, Math.max(this.bodyTint, 0.35))));
      grad.addColorStop(1, U.rgba(U.mix(body, head, this.bodyTint)));
      ctx.fillStyle = grad;
      U.taperPath(ctx, P, widths);
      ctx.fill();
      // Belly shading: a darker band along the side facing the surface.
      {
        const bp = [];
        const bw = [];
        for (let i = 1; i < this.bodyN + 6 && i < n; i++) {
          bp.push({ x: P[i].x - this.ux * widths[i] * 0.45, y: P[i].y - this.uy * widths[i] * 0.45 });
          bw.push(widths[i] * 0.55);
        }
        ctx.fillStyle = U.rgba(this.bodyColor, 0.45);
        U.taperPath(ctx, bp, bw);
        ctx.fill();
      }
      // Tail fades back to the plain body colour.
      if (this.bodyTint > 0.05) {
        ctx.fillStyle = U.rgba(U.scale(U.mix(body, head, this.bodyTint), 0.85));
        U.taperPath(ctx, P.slice(this.bodyN - 1), widths.slice(this.bodyN - 1));
        ctx.fill();
      }
      // Dorsal spines / scales along the top edge.
      if (this.p.spines) {
        ctx.strokeStyle = U.rgba(U.mix(head, body, 0.25));
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        const count = this.p.spines;
        for (let k = 0; k < count; k++) {
          const i = 2 + Math.floor((k / count) * (this.bodyN + 3));
          const a = P[i - 1];
          const b = P[i + 1];
          let tx = a.x - b.x;
          let ty = a.y - b.y;
          const tl = Math.hypot(tx, ty) || 1;
          tx /= tl;
          ty /= tl;
          let nx = -ty;
          let ny = tx;
          if (nx * this.ux + ny * this.uy < 0) {
            nx = -nx;
            ny = -ny;
          }
          const w = widths[i];
          const bx = P[i].x + nx * (w - 0.5);
          const by = P[i].y + ny * (w - 0.5);
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + nx * 4 * L - tx * 3 * L, by + ny * 4 * L - ty * 3 * L);
        }
        ctx.stroke();
      }

      for (const l of this.legs) if (l.near) this.drawLeg(ctx, l, nearCol, 1);
      this.drawHead(ctx);
      ctx.restore();
      this.drawPath(ctx, this.pather);
      this.drawDebug(ctx);
    }

    drawLeg(ctx, l, col, wk) {
      const P = this.spine.pts;
      const h = P[l.at];
      const leg = l.leg;
      const k = leg.solve(h.x, h.y, this.ux, this.uy);
      const L = this.L;
      ctx.strokeStyle = col;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.9 * L * wk;
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(k.kx, k.ky);
      ctx.stroke();
      ctx.lineWidth = 2.1 * L * wk;
      ctx.beginPath();
      ctx.moveTo(k.kx, k.ky);
      ctx.lineTo(k.ex, k.ey);
      ctx.stroke();
      // splayed toes along the surface
      const nx = leg.planted || leg.stepping ? leg.n.x : this.ux;
      const ny = leg.planted || leg.stepping ? leg.n.y : this.uy;
      ctx.lineWidth = 1.3 * L;
      ctx.beginPath();
      for (const s of [-1, 0, 1]) {
        const tx = -ny * s * 3.2 * L + nx * (s === 0 ? -1.6 : 0.6);
        const ty = nx * s * 3.2 * L + ny * (s === 0 ? -1.6 : 0.6);
        ctx.moveTo(k.ex, k.ey);
        ctx.lineTo(k.ex + tx, k.ey + ty);
      }
      ctx.stroke();
    }

    drawHead(ctx) {
      const hd = this.spine.pts[0];
      const L = this.L;
      const a = this.headAng;
      const col = this.headColor;
      ctx.save();
      ctx.translate(hd.x, hd.y);
      ctx.rotate(a);
      // keep the skull's top facing away from whatever we're clinging to
      const topX = Math.sin(a);
      const topY = -Math.cos(a);
      if (topX * this.ux + topY * this.uy < 0) ctx.scale(1, -1);
      ctx.scale(L, L);
      ctx.translate(-2, 0);
      const jawA = this.jaw * 0.85;

      // mouth interior
      const c = Math.cos(jawA);
      const s = Math.sin(jawA);
      const rot = (x, y) => [-4 + (x + 4) * c - (y - 0.5) * s, 0.5 + (x + 4) * s + (y - 0.5) * c];
      if (jawA > 0.03) {
        ctx.fillStyle = '#2e070e';
        const lt = rot(12.5, 0.5);
        ctx.beginPath();
        ctx.moveTo(-4, 0.5);
        ctx.lineTo(14, 0.5);
        ctx.lineTo(lt[0], lt[1]);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#f1ece0';
        ctx.beginPath();
        for (let x = 1; x <= 12; x += 2.7) {
          ctx.moveTo(x, 0.4);
          ctx.lineTo(x + 0.8, 2.4);
          ctx.lineTo(x + 1.6, 0.4);
        }
        ctx.fill();
      }
      // lower jaw
      ctx.fillStyle = U.rgba(U.scale(col, 0.72));
      ctx.beginPath();
      const lj = [[-5, 0.5], [12.5, 0.5], [12, 2.6], [6, 4.2], [-3, 4.6]];
      lj.forEach((pt, i) => {
        const r = rot(pt[0], pt[1]);
        if (i) ctx.lineTo(r[0], r[1]);
        else ctx.moveTo(r[0], r[1]);
      });
      ctx.closePath();
      ctx.fill();
      if (jawA > 0.03) {
        ctx.fillStyle = '#f1ece0';
        ctx.beginPath();
        for (let x = 2; x <= 11; x += 2.7) {
          const p0 = rot(x, 0.6);
          const p1 = rot(x + 0.7, -1.2);
          const p2 = rot(x + 1.4, 0.6);
          ctx.moveTo(p0[0], p0[1]);
          ctx.lineTo(p1[0], p1[1]);
          ctx.lineTo(p2[0], p2[1]);
        }
        ctx.fill();
      }
      // skull
      ctx.fillStyle = U.rgba(col);
      ctx.beginPath();
      ctx.moveTo(-5, 1);
      ctx.lineTo(-7, -2.5);
      ctx.lineTo(-5, -6.5);
      ctx.lineTo(1, -7.2);
      ctx.lineTo(8, -6.2);
      ctx.lineTo(13, -3.6);
      ctx.lineTo(15, -0.8);
      ctx.lineTo(14.4, 0.8);
      ctx.closePath();
      ctx.fill();
      // mouth line, visible even when shut
      ctx.strokeStyle = U.rgba(U.scale(col, 0.35));
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(-3.5, 0.6);
      ctx.lineTo(14, 0.6);
      ctx.stroke();
      // brow highlight + nostril
      ctx.fillStyle = U.rgba(U.mix(col, '#ffffff', 0.35), 0.8);
      ctx.beginPath();
      ctx.moveTo(-3, -6.2);
      ctx.quadraticCurveTo(3, -7.4, 9, -5.4);
      ctx.lineTo(8.6, -4.6);
      ctx.quadraticCurveTo(3, -6.2, -3, -5.2);
      ctx.fill();
      ctx.fillStyle = U.rgba(U.scale(col, 0.45));
      ctx.fillRect(11.4, -3.6, 1.4, 1);
      ctx.restore();
    }
  }

  RW.Creatures.Lizard = Lizard;
})();
