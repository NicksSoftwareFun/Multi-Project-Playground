// Dropwigs: spindly dark ambushers. They crawl to a ceiling (the underside of
// a window or ledge), flatten against it and wait. When prey — or the cursor —
// passes directly below, they let go and drop on it, mandibles open.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;
  const Nav = RW.Nav;

  const GRAV = 1000;
  const COL = {
    body: U.hex('#15151b'),
    plate: U.hex('#25252f'),
    rim: U.hex('#6f7f99'),
    eye: U.hex('#a6ecff'),
    leg: U.hex('#121217'),
  };

  class Dropwig extends RW.Creature {
    constructor(eco, species, x, y) {
      super(eco, species, x, y);
      this.spine = new RW.Chain(x, y, 3, [8, 7], U.sign(), 0);
      this.vx = 0;
      this.vy = 0;
      this.caps = { walls: true, ceil: true, poles: false, fall: true, wallCost: 1.1, ceilCost: 1.0 };
      this.mask = { floor: true, walls: true, ceil: true, poles: false };
      this.pather = new RW.Pather(this, this.caps);
      this.legs = [];
      const at = [0, 0, 1, 1, 2, 2];
      const fw = [0.75, 0.55, 0.2, 0.05, -0.3, -0.45];
      for (let i = 0; i < 6; i++) {
        this.legs.push({ leg: new RW.Leg(13, 16, { group: i % 2, forward: fw[i], stepDur: 0.12, lift: 7 }), at: at[i], near: i % 2 === 0 });
      }
      for (const l of this.legs) l.leg.place(x, y + 10);
      this.ux = 0;
      this.uy = -1;
      this.grip = null;
      this.spot = null;
      this.mandible = 0;
      this.checkT = 0;
      this.speed = this.p.speed || 85;
      this.prey = ['slugcat', 'centipede', 'lizard_blue'];
      this.threats = ['daddy'];
      this.bloodColor = '#1b1b25';
      this.setState('seek');
    }

    mainPoint() {
      return this.spine.pts[0];
    }
    holdPoint() {
      const h = this.spine.pts[0];
      return { x: h.x - this.ux * 6, y: h.y - this.uy * 6 };
    }
    carry(dx, dy) {
      this.spine.shift(dx, dy);
      for (const l of this.legs) l.leg.shift(dx, dy);
      if (this.spot) {
        this.spot.x += dx;
        this.spot.y += dy;
      }
    }

    pickSpot() {
      const W = this.W;
      const h = this.spine.pts[0];
      return Nav.randomValid(W, this.caps, h.x, h.y, 600, (cx, cy) => {
        if (!W.solid(cx, cy - 1) || W.solid(cx - 1, cy) || W.solid(cx + 1, cy)) return false;
        for (let k = 1; k <= 7; k++) if (W.solid(cx, cy + k)) return false;
        return true;
      });
    }

    underCeiling() {
      const h = this.spine.pts[0];
      const W = this.W;
      return W.isSolidPt(h.x, h.y - 14);
    }

    think(dt) {
      const eco = this.eco;
      const h = this.spine.pts[0];
      if (this.state === 'drop' || this.state === 'recover') return;
      if (this.holding) {
        this.setState('feed');
        this.pather.clear();
        this.mandible = 0.6 + 0.3 * Math.sin(this.age * 12);
        if (this.stateT > 4) {
          eco.consume(this.holding, this);
          this.holding = null;
          this.setState('seek');
          this.spot = null;
        }
        return;
      }
      if (this.state === 'feed') {
        // prey wriggled free
        this.setState('recover');
        return;
      }
      if (this.wantsToLeave(dt)) {
        this.setState('leave');
        const den = eco.nearestDen(h.x, h.y);
        if (den) {
          this.pather.setGoal(den.x, den.y);
          if (U.dist(h.x, h.y, den.x, den.y) < 22) this.leave();
        }
        return;
      }
      if (this.state === 'seek') {
        this.mandible = 0;
        if (!this.spot || this.stateT > 30 || (this.pather.done() && this.pather.nodes && U.dist(h.x, h.y, this.spot.x, this.spot.y) < 16 && !this.underCeiling())) {
          this.spot = this.pickSpot();
          this.stateT = 0;
        }
        if (this.spot) {
          this.pather.setGoal(this.spot.x, this.spot.y);
          if (U.dist(h.x, h.y, this.spot.x, this.spot.y) < 16 && this.underCeiling()) {
            this.setState('wait');
            this.pather.clear();
          }
        }
        return;
      }
      if (this.state === 'wait') {
        if (!this.underCeiling() || this.stateT > (this.p.patience || 70)) {
          this.setState('seek');
          this.spot = null;
          return;
        }
        this.mandible = 0.1 + 0.1 * Math.sin(this.age * 2);
        this.checkT -= dt;
        if (this.checkT <= 0) {
          this.checkT = 0.12;
          const tw = this.p.triggerWidth || 26;
          const below = (x, y) => Math.abs(x - h.x) < tw && y > h.y + 10 && y < h.y + 480 && this.W.lineClear(h.x, h.y + 8, x, y);
          let target = null;
          for (const c of eco.creatures) {
            if (this.prey.indexOf(c.species) < 0 || !c.canBeGrabbed()) continue;
            if (below(c.x, c.y)) {
              target = c;
              break;
            }
          }
          const cur = eco.cursor;
          if (!target && eco.cfg.ecosystem.cursorInteraction && cur.inside && below(cur.x, cur.y)) target = cur;
          if (target) this.drop(target);
        }
      }
    }

    drop(target) {
      this.setState('drop');
      this.target = target;
      this.grip = null;
      this.vx = 0;
      this.vy = 80;
      this.pather.clear();
    }

    update(dt) {
      if (!this.tick(dt)) return;
      // Ambushers go unnoticed while creeping about or waiting on the ceiling.
      this.lurking = this.state === 'wait' || this.state === 'seek';
      const W = this.W;
      const P = this.spine.pts;
      const h = P[0];

      if (this.grabbedBy) {
        const hp = this.grabbedBy.holdPoint();
        h.x = hp.x;
        h.y = hp.y;
        this.spine.verlet(1, 0.9, 0, GRAV, dt);
        this.spine.follow(1);
        this.updateLegs(dt, false);
        this.struggle(dt);
        return;
      }

      this.think(dt);
      const falling = this.state === 'drop' || this.state === 'recover';
      let g = falling ? null : W.nearestSurface(h.x, h.y, 22, this.mask);
      if (this.dropT > 0) {
        this.dropT -= dt;
        g = null;
      }
      this.grip = g;
      let leaving = false;

      if (this.state === 'drop') {
        this.mandible = 1;
        this.vy += GRAV * dt;
        const t = this.target;
        if (t && t.canBeGrabbed && U.dist(h.x, h.y, t.x, t.y) < 18) {
          if (this.eco.cfg.ecosystem.predation && this.grab(t)) this.target = null;
          else if (t.onBitten) {
            t.onBitten(this);
            this.target = null;
          }
        }
      } else if (this.state === 'recover') {
        this.vy += GRAV * dt;
        this.vx *= 0.9;
        if (this.stateT > 1.2) this.setState('seek');
      } else {
        this.pather.update(dt, h.x, h.y);
        this.pather.advance(h.x, h.y, W.cell * 0.8);
        const node = this.pather.current();
        let dvx = 0;
        let dvy = 0;
        if (node && this.state !== 'wait' && this.state !== 'feed') {
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
          const k = U.approach(10, dt);
          this.vx += (dvx - this.vx) * k;
          this.vy += (dvy - this.vy) * k;
        } else {
          this.vy += GRAV * dt;
        }
      }

      h.x += this.vx * dt;
      h.y += this.vy * dt;
      if (g && !leaving) {
        const hug = this.state === 'wait' ? 5 : 9;
        const e = g.d - hug;
        h.x -= g.nx * e * 0.25;
        h.y -= g.ny * e * 0.25;
        this.contactId = g.id;
      }
      const c = W.collideCircle(h, 5);
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx;
          this.vy -= vn * c.ny;
        }
        if (this.state === 'drop' && c.ny < -0.5) {
          if (this.holding) this.setState('feed');
          else this.setState('recover');
          this.vx = 0;
          this.vy = 0;
        }
      }
      if (this.state === 'drop' && h.y > W.h + 50) this.remove();
      h.px = h.x;
      h.py = h.y;
      this.spine.follow(1);
      for (let i = 1; i < P.length; i++) {
        if (g) {
          const s = W.nearestSurface(P[i].x, P[i].y, 20, this.mask);
          if (s) {
            const e = s.d - (this.state === 'wait' ? 5 : 8);
            P[i].x -= s.nx * e * 0.3;
            P[i].y -= s.ny * e * 0.3;
          }
        }
        W.collideCircle(P[i], 4);
      }

      const ux = g ? g.nx : 0;
      const uy = g ? g.ny : -1;
      const ku = U.approach(8, dt);
      this.ux += (ux - this.ux) * ku;
      this.uy += (uy - this.uy) * ku;
      const ul = Math.hypot(this.ux, this.uy) || 1;
      this.ux /= ul;
      this.uy /= ul;
      this.updateLegs(dt, !falling);
    }

    updateLegs(dt, active) {
      const P = this.spine.pts;
      const stepping = [false, false];
      for (const l of this.legs) if (l.leg.stepping) stepping[l.leg.group] = true;
      let fx = P[0].x - P[2].x;
      let fy = P[0].y - P[2].y;
      const fl = Math.hypot(fx, fy) || 1;
      fx /= fl;
      fy /= fl;
      for (const l of this.legs) {
        const hp = P[l.at];
        const can = active && !stepping[1 - l.leg.group];
        if (!active) l.leg.planted = false;
        l.leg.update(dt, this.W, hp.x, hp.y, fx, fy, this.ux, this.uy, this.mask, can, 1.2);
        if (this.state === 'drop') {
          // splay wide, reaching down for the prey
          const side = l.near ? 1 : -1;
          const tx = hp.x + side * 16 + fx * 4;
          const ty = hp.y + 14;
          l.leg.foot.x += (tx - l.leg.foot.x) * 0.3;
          l.leg.foot.y += (ty - l.leg.foot.y) * 0.3;
        }
      }
    }

    draw(ctx) {
      const P = this.spine.pts;
      const h = P[0];
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const legCol = U.rgba(COL.leg);
      for (const l of this.legs) if (!l.near) this.drawLeg(ctx, l, U.rgba(U.scale(COL.leg, 0.8)));

      const a = Math.atan2(P[0].y - P[1].y, P[0].x - P[1].x);
      // which side is "up" (away from the surface) in local space
      const flip = Math.sin(a) * this.ux - Math.cos(a) * this.uy < 0 ? -1 : 1;
      // abdomen
      for (let i = 2; i >= 0; i--) {
        const p = P[i];
        const rx = [8.5, 8.5, 7][i];
        const ry = [6, 7, 5.5][i];
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(a);
        ctx.fillStyle = U.rgba(COL.body);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, U.TAU);
        ctx.fill();
        ctx.fillStyle = U.rgba(COL.plate);
        ctx.beginPath();
        ctx.ellipse(-1, -flip * 1.5, rx * 0.8, ry * 0.55, 0, 0, U.TAU);
        ctx.fill();
        ctx.strokeStyle = U.rgba(COL.rim, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx - 0.5, ry - 0.5, 0, flip > 0 ? Math.PI * 1.15 : Math.PI * 0.15, flip > 0 ? Math.PI * 1.85 : Math.PI * 0.85);
        ctx.stroke();
        // plate seams
        ctx.strokeStyle = U.rgba(COL.body);
        ctx.beginPath();
        ctx.moveTo(-2, -ry);
        ctx.lineTo(-2, ry);
        ctx.moveTo(2.5, -ry * 0.9);
        ctx.lineTo(2.5, ry * 0.9);
        ctx.stroke();
        ctx.restore();
      }
      // head: mandibles, eyes, feelers
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(a);
      ctx.scale(1, flip);
      const m = this.mandible;
      ctx.strokeStyle = legCol;
      ctx.lineWidth = 1.8;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(6, s * 2);
        ctx.quadraticCurveTo(12, s * (3 + m * 6), 14 + m * 2, s * (0.5 + m * 4));
        ctx.stroke();
      }
      const t = this.age;
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = U.rgba(COL.rim, 0.8);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(6, -3);
        ctx.bezierCurveTo(14, -8 + s * 2, 20, -14 + Math.sin(t * 3 + s) * 3, 26 + s * 3, -10 + Math.cos(t * 2.3 + s) * 4);
        ctx.stroke();
      }
      ctx.fillStyle = U.rgba(COL.eye, this.state === 'wait' ? 0.5 + 0.5 * Math.sin(t * 1.5) : 0.9);
      ctx.fillRect(5, -3, 1.4, 1.4);
      ctx.fillRect(3, -4, 1.2, 1.2);
      ctx.fillRect(5.5, -0.8, 1, 1);
      ctx.restore();

      for (const l of this.legs) if (l.near) this.drawLeg(ctx, l, legCol);
      ctx.restore();
      this.drawPath(ctx, this.pather);
      this.drawDebug(ctx);
    }

    drawLeg(ctx, l, col) {
      const hp = this.spine.pts[l.at];
      const k = l.leg.solve(hp.x, hp.y, this.ux, this.uy);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(hp.x, hp.y);
      ctx.lineTo(k.kx, k.ky);
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(k.kx, k.ky);
      ctx.lineTo(k.ex, k.ey);
      ctx.stroke();
      // knee spur and pale tip
      ctx.beginPath();
      ctx.moveTo(k.kx, k.ky);
      ctx.lineTo(k.kx + this.ux * 3.5, k.ky + this.uy * 3.5);
      ctx.stroke();
      ctx.fillStyle = U.rgba(COL.rim, 0.7);
      ctx.fillRect(k.ex - 0.8, k.ey - 0.8, 1.6, 1.6);
    }
  }

  RW.Creatures.Dropwig = Dropwig;
})();
