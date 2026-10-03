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
  const LIZARDS = ['lizard_pink', 'lizard_green', 'lizard_blue', 'lizard_white'];

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
      const l1 = 13 * L;
      const l2 = 13.5 * L;
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
      // personality state
      this.look = 0; // head angle offset from the neck, radians
      this.lookAt = null; // point the head is turned toward
      this.idleLook = { x: x, y: y, t: 0 };
      this.raise = 0; // rearing up (display, stalking)
      this.raiseS = 0;
      this.lashS = 0;
      this.tongue = 0; // 0..1 flick progress
      this.tongueCd = U.rand(2, 8);
      this.noticeT = 0;
      this.thrashT = 0;
      this.lash = 0; // tail agitation
      this.rival = null;
      this.rivalCd = U.rand(5, 15);
      this.blink = 0;
      this.blinkT = U.rand(2, 6);
      this.breathe = U.rand(0, 10);
      // Fixed markings, Rain World style: colour flecks bleeding from the head
      // down the neck, plus a species pattern. t = position along the spine.
      this.spineSet = [];
      if (p.spines) {
        let t = 0.06;
        for (let k = 0; k < p.spines && t < 0.62; k++) {
          const stubby = Math.random() < 0.25;
          this.spineSet.push({ t, len: stubby ? U.rand(2.5, 4) : U.rand(6, 10), lean: U.rand(0.35, 0.8) });
          t += U.rand(0.035, 0.07);
        }
      }
      this.specks = [];
      const pat = p.pattern;
      const add = (t, side, size, kind) => this.specks.push({ t, side, size, kind: kind || 'fleck' });
      if (pat !== 'spots') for (let i = 0; i < 30; i++) add(0.04 + Math.pow(Math.random(), 2.2) * 0.2, U.rand(-0.9, 0.9), U.rand(1, 2));
      if (pat === 'dapple') {
        for (let i = 0; i < 14; i++) add(U.rand(0.15, 0.6), U.rand(-0.8, 0.8), 1);
        for (let i = 0; i < 18; i++) add(1 - Math.pow(Math.random(), 1.5) * 0.2, U.rand(-0.9, 0.9), 1);
      } else if (pat === 'dots') {
        for (let i = 0; i < 22; i++) add(0.1 + Math.pow(Math.random(), 1.6) * 0.6, U.rand(-0.8, 0.8), 2);
      } else if (pat === 'fins') {
        for (let i = 0; i < 10; i++) add(U.rand(0.04, 0.5), Math.random() < 0.75 ? 1 : -1, U.rand(5, 9), 'fin');
        for (let i = 0; i < 20; i++) add(1 - Math.pow(Math.random(), 1.4) * 0.25, U.rand(-0.9, 0.9), 1);
      } else if (pat === 'spots') {
        for (let i = 0; i < 26; i++) add(U.rand(0.08, 0.8), U.rand(-0.85, 0.85), U.randInt(1, 2), 'dark');
      }
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
      this.lookAt = null;
      this.raise = 0.35; // carry the head a little high, as in the game
      this.lash = 0.15;

      if (this.holding) {
        this.setState('eat');
        this.eatT += dt;
        this.jawTarget = 0.3;
        this.lash = 0.5;
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

      // Rival standoff: two lizards that meet rear up and hiss; the smaller backs off.
      this.rivalCd -= dt;
      if (this.state === 'display') {
        const r = this.rival;
        this.pather.clear();
        this.raise = 1;
        this.lash = 1;
        this.lookAt = r && !r.dead ? r.spine.pts[0] : null;
        this.jawTarget = 0.55 + 0.45 * Math.max(0, Math.sin(this.stateT * 9));
        if (!r || r.dead || r.leaving || this.stateT > this.displayFor) {
          const lost = r && !r.dead && r.L * (r.p.huntSpeed || 150) > this.L * (this.p.huntSpeed || 150);
          this.rival = null;
          this.rivalCd = U.rand(20, 40);
          if (lost) {
            const g = this.fleeGoal(this.caps, r.x, r.y, 300);
            if (g) this.pather.setGoal(g.x, g.y, true);
            this.setState('flee');
          } else {
            this.setState('wander');
          }
        }
        return;
      }
      if (perceive && this.rivalCd <= 0 && this.state !== 'hunt') {
        const r = this.nearestOf(LIZARDS, 95 * this.L, (c) => c.rivalCd <= 0 && !c.holding && !c.grabbedBy && c.state !== 'hunt' && c.state !== 'display');
        if (r) {
          const t = U.rand(1.6, 3.2);
          for (const [a, b] of [[this, r], [r, this]]) {
            a.rival = b;
            a.displayFor = t;
            a.setState('display');
          }
          return;
        }
      }

      // Hunting
      if (perceive && this.fullT <= 0) {
        const vision = this.p.vision || 300;
        if (this.giveUpT > 0) this.giveUpT -= 0.25;
        const prey = this.nearestOf(this.diet, vision, (c) => !c.grabbedBy && !(this.giveUpT > 0 && c === this.gaveUpOn) && this.canSee(c.x, c.y, vision));
        if (prey) {
          if (this.state !== 'hunt') this.noticeT = 0.45; // freeze and stare before the charge
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
          this.lookAt = prey.mainPoint();
          this.lash = 0.7;
          const d = U.dist(head.x, head.y, prey.x, prey.y);
          if (this.noticeT > 0) {
            this.noticeT -= dt;
            this.speed = 0;
            this.raise = 0.6;
            this.jawTarget = 0.15;
            return;
          }
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
          this.lookAt = cur;
          this.raise = 0.5;
          this.lash = 0.6;
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
        // look around at nothing in particular
        this.idleLook.t -= dt;
        if (this.idleLook.t <= 0) {
          const a = U.rand(0, U.TAU);
          this.idleLook = { x: head.x + Math.cos(a) * 80, y: head.y + Math.sin(a) * 80, t: U.rand(0.8, 2.2) };
        }
        this.lookAt = this.idleLook;
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
            this.thrashT = 1.1; // shake the catch
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
        this.raiseS = (this.raiseS || 0) + (this.raise - (this.raiseS || 0)) * U.approach(5, dt);
        const err = g.d - (14 + this.raiseS * 8) * L;
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
            const e = s.d - (i < this.bodyN ? 13 - i * 0.5 : 5 + (this.bodyN + 4 - i) * 1.4) * L;
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
      const neckAng = Math.atan2(head.y - P[1].y, head.x - P[1].x);
      let lookTarget = 0;
      if (this.lookAt) {
        const want = Math.atan2(this.lookAt.y - head.y, this.lookAt.x - head.x);
        lookTarget = U.clamp(U.angleDiff(neckAng, want), -0.85, 0.85);
      }
      this.look += (lookTarget - this.look) * U.approach(this.noticeT > 0 ? 30 : 7, dt);
      let ang = neckAng + this.look;
      if (this.thrashT > 0) {
        this.thrashT -= dt;
        ang += Math.sin(this.age * 38) * 0.45 * Math.min(1, this.thrashT);
      }
      this.headAng = U.lerpAngle(this.headAng, ang, U.approach(this.thrashT > 0 ? 40 : 12, dt));
      this.jaw += (this.jawTarget - this.jaw) * U.approach(this.jawTarget > this.jaw ? 25 : 8, dt);

      // Tongue flicks while idle, stalking or sizing up a rival.
      this.tongueCd -= dt;
      if (this.tongue > 0) this.tongue = Math.min(1.0001, this.tongue + dt * 3.2);
      if (this.tongue > 1) this.tongue = 0;
      if (this.tongueCd <= 0 && this.tongue === 0 && this.jaw < 0.3 && ['idle', 'stalk', 'wander', 'display'].includes(this.state)) {
        this.tongue = 0.001;
        this.tongueCd = U.rand(2.5, 9);
      }
      this.blinkT -= dt;
      if (this.blinkT <= 0) {
        this.blink = 0.14;
        this.blinkT = U.rand(2.5, 7);
      }
      this.blink = Math.max(0, this.blink - dt);

      // Tail: lazy swish at rest, lashing when agitated.
      this.lashS = (this.lashS || 0) + (this.lash - (this.lashS || 0)) * U.approach(3, dt);
      const nT = P.length - this.bodyN;
      const freq = 2 + this.lashS * 7;
      for (let i = this.bodyN + 2; i < P.length; i++) {
        const k = (i - this.bodyN) / nT;
        const a = P[i - 1];
        let tx = P[i].x - a.x;
        let ty = P[i].y - a.y;
        const tl = Math.hypot(tx, ty) || 1;
        const amp = (0.25 + this.lashS * 1.4) * k * k * L;
        const w = Math.sin(this.age * freq - i * 0.55) * amp;
        P[i].x += (-ty / tl) * w;
        P[i].y += (tx / tl) * w;
      }

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
    // Per-point normal pointing to the lizard's back (away from the surface).
    backNormals(P) {
      const n = P.length;
      const N = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = P[Math.max(0, i - 1)];
        const b = P[Math.min(n - 1, i + 1)];
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
        N[i] = { nx, ny, tx, ty };
      }
      return N;
    }

    draw(ctx) {
      const P = this.spine.pts;
      const L = this.L;
      const n = P.length;
      const px = this.eco.artPx || 1.25; // one art pixel, in world units
      const body = U.rgba(this.bodyColor);
      const headCol = U.rgba(this.headColor);
      ctx.save();
      ctx.globalAlpha = this.alpha * (this.p.camouflage ? this.camo : 1);

      for (const l of this.legs) if (!l.near) this.drawLeg(ctx, l, px);

      // Flat silhouette; the pixel pass gives it hard edges.
      const breath = 1 + 0.05 * Math.sin(this.age * 2.3 + this.breathe) * (this.state === 'display' ? 2.5 : 1);
      const widths = new Array(n);
      const prof = [4.6, 5.6, 6.6, 6.4, 6, 5.3, 4.6];
      for (let i = 0; i < n; i++) {
        if (i < this.bodyN) widths[i] = prof[i] * L * (i >= 2 && i <= 5 ? breath : 1);
        else {
          const t = (i - this.bodyN + 1) / (n - this.bodyN);
          widths[i] = Math.max(px * 0.8, 4.4 * L * (t < 0.75 ? 1 - t * 0.6 : 0.55 * (1 - t) / 0.25));
        }
      }
      const N = this.backNormals(P);
      ctx.fillStyle = body;
      U.taperPath(ctx, P, widths);
      ctx.fill();
      // Neck takes the head colour solid for a short way...
      ctx.fillStyle = headCol;
      U.taperPath(ctx, P.slice(0, 2), widths.slice(0, 2).map((w) => w * 0.98));
      ctx.fill();

      // ...then breaks up into flecks, plus the species pattern.
      const at = (t) => {
        const f = U.clamp(t, 0, 1) * (n - 1);
        const i = Math.min(n - 2, Math.floor(f));
        const k = f - i;
        return {
          x: U.lerp(P[i].x, P[i + 1].x, k),
          y: U.lerp(P[i].y, P[i + 1].y, k),
          w: U.lerp(widths[i], widths[i + 1], k),
          nx: N[i].nx,
          ny: N[i].ny,
          tx: N[i].tx,
          ty: N[i].ty,
        };
      };
      for (const sp of this.specks) {
        const q = at(sp.t);
        if (sp.kind === 'fin') {
          // spiky fin sticking out of the outline
          const sx = q.x + q.nx * q.w * sp.side * 0.7;
          const sy = q.y + q.ny * q.w * sp.side * 0.7;
          const len = sp.size * L * (1 + this.raiseS * 0.5);
          const ox = q.nx * sp.side;
          const oy = q.ny * sp.side;
          ctx.fillStyle = headCol;
          ctx.beginPath();
          ctx.moveTo(sx + q.tx * px * 1.2, sy + q.ty * px * 1.2);
          ctx.lineTo(sx - q.tx * px * 1.2, sy - q.ty * px * 1.2);
          ctx.lineTo(sx + ox * len - q.tx * len * 0.8, sy + oy * len - q.ty * len * 0.8);
          ctx.fill();
          continue;
        }
        const sz = Math.max(1, Math.round(sp.size)) * px;
        const x = q.x + q.nx * q.w * sp.side * 0.85;
        const y = q.y + q.ny * q.w * sp.side * 0.85;
        ctx.fillStyle = sp.kind === 'dark' ? 'rgb(78,80,90)' : headCol;
        ctx.fillRect(Math.round(x / px) * px - sz / 2, Math.round(y / px) * px - sz / 2, sz, sz);
      }

      // Dorsal spines (green lizards): wide-based jagged pixel spikes,
      // irregular in height, spacing and lean.
      if (this.p.spines) {
        ctx.fillStyle = headCol;
        for (const sp of this.spineSet) {
          const q = at(sp.t);
          const len = sp.len * L * (1 + this.raiseS * 0.4);
          const half = Math.max(px * 1.6, 1.8 * L);
          const bx = q.x + q.nx * (q.w - px);
          const by = q.y + q.ny * (q.w - px);
          ctx.beginPath();
          ctx.moveTo(bx + q.tx * half, by + q.ty * half);
          ctx.lineTo(bx - q.tx * half, by - q.ty * half);
          ctx.lineTo(bx + q.nx * len - q.tx * len * sp.lean, by + q.ny * len - q.ty * len * sp.lean);
          ctx.fill();
        }
      }

      for (const l of this.legs) if (l.near) this.drawLeg(ctx, l, px);
      this.drawHead(ctx, px);
      ctx.restore();
      this.drawPath(ctx, this.pather);
      this.drawDebug(ctx);
    }

    drawLeg(ctx, l, px) {
      const P = this.spine.pts;
      const h = P[l.at];
      const leg = l.leg;
      const k = leg.solve(h.x, h.y, this.ux, this.uy);
      const L = this.L;
      // near-black legs; only the feet carry the species colour
      const base = this.p.camouflage ? this.bodyColor : U.scale(this.bodyColor, l.near ? 1.6 : 1);
      const body = U.rgba(base);
      const foot = U.rgba(this.p.camouflage ? U.scale(this.bodyColor, 0.85) : this.headColor);
      ctx.fillStyle = body;
      U.taperPath(ctx, [{ x: h.x, y: h.y }, { x: k.kx, y: k.ky }], [3.2 * L, 2.2 * L]);
      ctx.fill();
      U.taperPath(ctx, [{ x: k.kx, y: k.ky }, { x: k.ex, y: k.ey }], [2.2 * L, 1.5 * L]);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(k.kx, k.ky, 2.2 * L, 0, U.TAU);
      ctx.fill();
      // three chunky toes, splayed forward along the surface; curled in the air
      const nx = leg.planted || leg.stepping ? leg.n.x : this.ux;
      const ny = leg.planted || leg.stepping ? leg.n.y : this.uy;
      // forward along the surface = body heading projected onto the surface
      const a = P[l.at - 1];
      const b = P[l.at + 1];
      const d = (a.x - b.x) * -ny + (a.y - b.y) * nx;
      const sx = -ny * Math.sign(d || 1);
      const sy = nx * Math.sign(d || 1);
      const curl = leg.stepping ? 0.55 : leg.planted ? 1 : 0.5;
      ctx.strokeStyle = foot;
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(px * 1.6, 1.6 * L);
      ctx.beginPath();
      for (const s of [-0.35, 0.25, 0.9]) {
        const len = 3.6 * L * curl;
        ctx.moveTo(k.ex - sx * L, k.ey - sy * L);
        ctx.lineTo(k.ex + sx * s * len + nx * (s < 0 ? 0.6 : -0.2) * L, k.ey + sy * s * len + ny * (s < 0 ? 0.6 : -0.2) * L);
      }
      ctx.stroke();
    }

    // Big boxy head, flat colour, black tooth marks along the mouth line and
    // a black eye: the Rain World lizard face.
    drawHead(ctx, px) {
      const hd = this.spine.pts[0];
      const L = this.L * 1.4;
      const a = this.headAng;
      const col = U.rgba(this.headColor);
      const jawCol = U.rgba(U.scale(this.headColor, 0.7));
      const ink = '#0a0608';
      ctx.save();
      ctx.translate(hd.x, hd.y);
      ctx.rotate(a);
      const topX = Math.sin(a);
      const topY = -Math.cos(a);
      if (topX * this.ux + topY * this.uy < 0) ctx.scale(1, -1);
      ctx.scale(L, L);
      ctx.translate(-3, 0);
      const u = px / L; // one art pixel in head-local units
      const jawA = this.jaw * 0.95;
      const c = Math.cos(jawA);
      const s = Math.sin(jawA);
      const rot = (x, y) => [-4 + (x + 4) * c - (y - 0.5) * s, 0.5 + (x + 4) * s + (y - 0.5) * c];

      if (this.tongue > 0) {
        const ext = Math.sin(Math.PI * this.tongue) * 12;
        ctx.strokeStyle = '#e0405f';
        ctx.lineWidth = Math.max(u, 0.9);
        ctx.beginPath();
        ctx.moveTo(15, 1);
        ctx.lineTo(19 + ext, 1 + Math.sin(this.age * 40) * 0.6);
        ctx.lineTo(20.5 + ext, -0.3);
        ctx.moveTo(19 + ext, 1);
        ctx.lineTo(20.5 + ext, 2.3);
        ctx.stroke();
      }

      // open mouth: black interior
      if (jawA > 0.04) {
        const lt = rot(19, 0.5);
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.moveTo(-4, 0.5);
        ctx.lineTo(20, 0.5);
        ctx.lineTo(lt[0], lt[1]);
        ctx.closePath();
        ctx.fill();
      }
      // lower jaw
      ctx.fillStyle = jawCol;
      ctx.beginPath();
      [[-5, 0.5], [19.2, 0.5], [18.8, 2.8], [8, 3.6], [-4.5, 4.4]].forEach((pt, i) => {
        const r = rot(pt[0], pt[1]);
        if (i) ctx.lineTo(r[0], r[1]);
        else ctx.moveTo(r[0], r[1]);
      });
      ctx.closePath();
      ctx.fill();
      // upper skull: flat top, blunt snout, rounded back
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(-5.5, 0.6);
      ctx.lineTo(-7, -2.6);
      ctx.lineTo(-5.6, -6.6);
      ctx.lineTo(-1, -7.4); // raised back of the skull
      ctx.lineTo(3, -7.2);
      ctx.lineTo(5, -5.8); // brow step down to the snout
      ctx.lineTo(15, -4.8);
      ctx.lineTo(19.4, -3);
      ctx.lineTo(20.2, -0.4);
      ctx.lineTo(19.6, 0.6);
      ctx.closePath();
      ctx.fill();

      // tooth marks: small irregular black ticks on the upper jaw along the
      // mouth line (gap at the snout tip); lower ones only show when it gapes
      const toothW = Math.max(u, 0.7);
      const step = Math.max(3 * u, 2.6);
      ctx.fillStyle = ink;
      let k = 0;
      for (let x = 4 + step; x <= 17.5 - step; x += step, k++) {
        const th = Math.max(u * 2, 1.7) * (k % 3 === 1 ? 0.7 : 1);
        ctx.fillRect(x, 0.6 - th, toothW, th);
        if (jawA > 0.15) {
          const r0 = rot(x + 0.5, 0.6);
          const r1 = rot(x + 0.5, 0.6 + th * 0.8);
          ctx.fillRect(Math.min(r0[0], r1[0]), Math.min(r0[1], r1[1]), toothW, Math.abs(r1[1] - r0[1]) + 0.01);
        }
      }
      // dark line under the jaw
      ctx.fillStyle = 'rgba(10,6,8,0.9)';
      {
        const r0 = rot(-4, 4.3);
        const r1 = rot(17, 2.9);
        ctx.beginPath();
        ctx.moveTo(r0[0], r0[1]);
        ctx.lineTo(r1[0], r1[1]);
        ctx.lineTo(r1[0], r1[1] + Math.max(u, 0.8));
        ctx.lineTo(r0[0], r0[1] + Math.max(u, 0.8));
        ctx.fill();
      }
      // eye: a black dot at the top-back of the skull; narrows when hissing
      ctx.fillStyle = ink;
      const open = this.blink > 0 ? 0.35 : this.noticeT > 0 ? 1.3 : 1 - Math.min(0.5, this.jaw * 0.6);
      const es = Math.max(u * 2, 2.2);
      const eh = Math.max(u, es * open);
      ctx.fillRect(-0.5, -5 + (es - eh) / 2, es, eh);
      // nostril
      ctx.fillRect(18, -3.2, Math.max(u, 0.9), Math.max(u, 0.9));
      ctx.restore();
    }
  }

  RW.Creatures.Lizard = Lizard;
})();
