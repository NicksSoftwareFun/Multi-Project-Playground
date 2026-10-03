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
  const LIZARDS = ['lizard_*'];
  const REAR = [0, 0.9, 0.65, 0.35, 0.12]; // how much each front spine point lifts when rearing
  const TERR_R = 150; // territory radius around a lizard's hangout
  const RIVALRY = ['challenge', 'display', 'fight'];
  // Rain World wiki: biteDamage and toughness per species (fights only)
  const isLizard = (c) => c.species.startsWith('lizard_');

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
      for (let i = 0; i < this.bodyN; i++) segs.push((i === 0 ? 9 : 6.6) * L);
      for (let i = 0; i < nTail; i++) segs.push(6.4 * L * (1 - i / (nTail * 2.4)));
      const dir = U.sign();
      this.spine = new RW.Chain(x, y, this.bodyN + nTail, segs, -dir, 0);
      this.vx = 0;
      this.vy = 0;
      this.caps = {
        walls: !!p.climbWalls,
        ceil: !!p.climbCeilings,
        poles: !!p.poles,
        fall: true,
        // short leaps to and from poles, shorter for bigger lizards (slugcats
        // jump much further)
        jumpX: p.poles ? Math.max(2, Math.round(3.2 / L)) : 0,
        jumpUp: p.poles ? (L <= 1 ? 2 : 1) : 0,
        leapPoles: true,
        wallCost: 1.3,
        ceilCost: 1.8,
        poleCost: 1.4,
        fallCost: p.climbWalls ? 4 : 1, // climbers climb down rather than drop
      };
      this.mask = { floor: true, walls: !!p.climbWalls, ceil: !!p.climbCeilings, poles: !!p.poles };
      this.maskNoPole = Object.assign({}, this.mask, { poles: false });
      this.pather = new RW.Pather(this, this.caps);
      const l1 = 16 * L;
      const l2 = 16 * L;
      // heavy species take slower, flatter steps
      const o = { stepDur: 0.2 + 0.015 * (p.mass || 2), lift: 4.5 * L };
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
      // (lizards ignore batflies, per the Rain World wiki; greens and cyans
      // eat blue lizards)
      this.diet = ['slugcat', 'centipede', 'dropwig'];
      if (species === 'lizard_green' || species === 'lizard_cyan') this.diet.push('lizard_blue');
      this.diet.push('centipede_medium'); // the wiki: lizards eat adult centipedes too
      this.hp = 1; // fighting condition; recovers slowly
      this.home = null; // favourite hangout: { sid, ox } on top of a solid
      this.homeAwayT = 0;
      this.truces = new Map(); // lizard id -> eco time until which we leave it be
      this.threats = ['daddy'];
      // large centipedes hunt lizards: every lizard backs away from one
      // (how close it lets one come depends on its bravery)
      this.threats.push('centipede_large');
      this.camo = 1;
      this.mass = p.mass || 2 * L;
      // Rain World personality: energy, bravery, sympathy, dominance,
      // nervousness and aggression, each 0..1.
      this.pers = U.personality();
      this.walkPh = 0;
      // personality state
      this.look = 0; // head angle offset from the neck, radians
      this.lookAt = null; // point the head is turned toward
      this.idleLook = { x: x, y: y, t: 0 };
      this.raise = 0; // rearing up (display, stalking)
      this.raiseS = 0;
      this.lashS = 0;
      this.windT = 0;
      this.turn = null;
      this.turnCd = 0;
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
      if (!p.spines && (p.pattern === 'dapple' || p.pattern === 'spots')) {
        for (let t = 0.1; t < 0.5; t += U.rand(0.06, 0.1)) this.spineSet.push({ t, len: U.rand(2, 3.5), lean: 0.5 });
      }
      if (p.spines) {
        let t = 0.06;
        for (let k = 0; k < p.spines && t < (p.spines > 14 ? 0.8 : 0.62); k++) {
          const stubby = Math.random() < 0.25;
          const big = p.spines > 14; // red lizards: a crown of huge spines
          this.spineSet.push({ t, len: stubby ? U.rand(2.5, 4) : big ? U.rand(9, 16) : U.rand(6, 10), lean: U.rand(0.35, 0.8) });
          t += big ? U.rand(0.025, 0.045) : U.rand(0.035, 0.07);
        }
      }
      this.specks = [];
      const pat = p.pattern;
      const add = (t, side, size, kind) => this.specks.push({ t, side, size, kind: kind || 'fleck' });
      if (pat !== 'spots') for (let i = 0; i < 60; i++) add(0.08 + Math.pow(Math.random(), 1.6) * 0.34, U.rand(-0.95, 0.95), U.rand(1, 2.4));
      if (pat === 'dapple') {
        for (let i = 0; i < 14; i++) add(U.rand(0.15, 0.6), U.rand(-0.8, 0.8), 1);
        for (let i = 0; i < 18; i++) add(1 - Math.pow(Math.random(), 1.5) * 0.2, U.rand(-0.9, 0.9), 1);
      } else if (pat === 'dots') {
        for (let i = 0; i < 22; i++) add(0.1 + Math.pow(Math.random(), 1.6) * 0.6, U.rand(-0.8, 0.8), 2);
      } else if (pat === 'fins') {
        for (let i = 0; i < 14; i++) add(U.rand(0.05, 0.8), Math.random() < 0.7 ? 1 : -1, U.rand(7, 12), 'fin');
        for (let i = 0; i < 20; i++) add(1 - Math.pow(Math.random(), 1.4) * 0.25, U.rand(-0.9, 0.9), 1);
      } else if (pat === 'spots') {
        for (let i = 0; i < 26; i++) add(U.rand(0.08, 0.8), U.rand(-0.85, 0.85), U.randInt(1, 2), 'dark');
      }
    }

    mainPoint() {
      return this.spine.pts[0];
    }
    // How see-through to draw (white lizards' camouflage).
    ghostAlpha() {
      return this.p.camouflage ? this.alpha * this.camo : 1;
    }
    bounds() {
      return RW.Creature.ptsBounds(this.spine.pts, 56 * this.L);
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
      const pe = this.pers;
      // energetic lizards amble a little quicker
      this.speed = (this.p.speed || 50) * (0.88 + 0.24 * pe.energy);
      this.jawTarget = 0;
      this.pather.interval = 1.2;
      this.lookAt = null;
      this.raise = 0; // head stays in line with the body unless rearing
      this.lash = 0.08 + 0.2 * pe.nervous; // nervous ones twitch their tails

      if (this.holding && RIVALRY.includes(this.state) && this.rival) {
        if (this.rivalry(dt, perceive)) return; // someone wants our food
      }
      if (this.holding) {
        const prey = this.holding;
        this.jawTarget = 0.3;
        this.lash = 0.5;
        if (!prey.corpse) {
          // still kicking in our jaws: shake it until it dies
          this.setState('kill');
          this.pather.clear();
          if (this.killT === undefined) this.killT = U.rand(0.8, 2.2);
          this.killT -= dt;
          this.thrashT = Math.max(this.thrashT, 0.15);
          if (this.killT <= 0) {
            this.killT = undefined;
            prey.kill();
          }
          return;
        }
        // Dead: carry it back to our hangout before swallowing it there.
        const hp = this.homePos();
        const homeD = hp ? U.dist(head.x, head.y, hp.x, hp.y) : 0;
        if (hp && homeD > 45 && this.state !== 'eat' && !(this.state === 'carry' && this.stateT > 45)) {
          this.setState('carry');
          this.speed *= 0.85;
          this.pather.interval = 0.8;
          this.pather.setGoal(hp.x, hp.y);
          // no route, or no progress for a while: eat it here after all
          const cc = this.carryCheck || (this.carryCheck = { x: head.x, y: head.y, t: 0 });
          cc.t += dt;
          let stalled = false;
          if (cc.t > 5) {
            stalled = U.dist(head.x, head.y, cc.x, cc.y) < 10;
            this.carryCheck = { x: head.x, y: head.y, t: 0 };
          }
          const stuck = stalled || (this.pather.nodes && !this.pather.complete && this.pather.remaining() === 0 && this.stateT > 2);
          if (!stuck) return;
          this.carryCheck = null;
        }
        this.setState('eat');
        this.pather.clear();
        this.eatT += dt;
        if (this.eatT > 3) {
          eco.consume(prey, this);
          this.holding = null;
          this.fullT = U.rand(30, 60) * (1.3 - 0.5 * pe.aggression);
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
        const threat = this.threatNear(200 * (1.3 - 0.6 * pe.bravery)); // the brave let danger come closer
        if (threat) {
          this.setState('flee');
          const g = this.fleeGoal(this.caps, threat.x, threat.y, 350);
          if (g) this.pather.setGoal(g.x, g.y, true);
        }
      }
      if (this.state === 'flee') {
        this.speed = this.p.huntSpeed || 90;
        if (this.stateT < 3) return;
        this.setState('wander');
      }

      // Territory (Rain World's rivalry): an owner challenges lizards that
      // stray onto its hangout, and hungry lizards go after one that has
      // food. Both hiss and rear up trying to make the other back off; if
      // neither does, it becomes a fight until one submits (and maybe
      // leaves), dies, or is distracted by prey or a predator.
      this.rivalCd -= dt;
      this.hp = Math.min(1, this.hp + dt * 0.02);
      if (RIVALRY.includes(this.state)) {
        if (this.rivalry(dt, perceive)) return;
      }
      if (perceive) this.updateHome(0.3);
      if (perceive && this.rivalCd <= 0 && this.state !== 'hunt') {
        const f = this.findFoe();
        if (f) {
          this.rival = f.c;
          this.rivalWhy = f.why;
          this.setState('challenge');
          return;
        }
      }

      // Scavenging: a corpse of something we eat is an easy meal to carry home.
      if (this.state === 'scavenge') {
        const c = this.prey;
        if (!c || c.dead || !c.corpse || c.grabbedBy || this.stateT > 20) {
          this.prey = null;
          this.setState('wander');
        } else {
          this.pather.interval = 0.6;
          this.pather.setGoal(c.x, c.y);
          this.lookAt = c.mainPoint();
          const hp = c.hitParts()[0];
          if (U.dist(head.x, head.y, hp.x, hp.y) < 16 * this.L && this.grab(c)) {
            this.eatT = 0;
            this.prey = null;
          }
          return;
        }
      }
      if (perceive && this.fullT <= 0 && this.state !== 'hunt') {
        const c = this.nearestCorpse(this.diet, (this.p.vision || 300) * 0.8);
        if (c && this.canSee(c.x, c.y, (this.p.vision || 300) * 0.8)) {
          this.prey = c;
          this.setState('scavenge');
          return;
        }
      }

      // Hunting
      if (perceive && this.fullT <= 0) {
        const vision = this.p.vision || 300;
        if (this.giveUpT > 0) this.giveUpT -= 0.25;
        const prey = this.nearestOf(this.diet, vision, (c) => !c.grabbedBy && !(this.giveUpT > 0 && c === this.gaveUpOn) && this.canSee(c.x, c.y, vision));
        if (prey) {
          if (this.state !== 'hunt') this.noticeT = 0.45 * (1.4 - pe.aggression); // freeze and stare before the charge
          this.prey = prey;
          this.setState('hunt');
        } else if (this.state === 'hunt' && this.stateT > 4) {
          this.prey = null;
          this.setState('wander');
        }
      }
      if (this.state === 'hunt' && this.prey) {
        const prey = this.prey;
        const persist = 0.6 + pe.aggression;
        const hopeless = this.stateT > 25 * persist || (this.stateT > 8 * persist && !this.pather.complete);
        if (hopeless) {
          this.gaveUpOn = prey;
          this.giveUpT = 20;
        }
        if (prey.dead || prey.leaving || prey.grabbedBy || hopeless) {
          this.prey = null;
          this.setState('wander');
        } else {
          this.speed = (this.p.huntSpeed || 90) * (0.9 + 0.2 * pe.aggression);
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
          const canStrike = this.lungeCd <= 0 && this.grip && this.W.lineClear(head.x, head.y, prey.x, prey.y);
          if (canStrike && d < (this.p.biteRange || 60) * this.L) {
            this.lunge(prey.x, prey.y, prey, false);
          } else if (canStrike && perceive && d < 170 * this.L && Math.random() < (this.p.chargeRate || 0.05)) {
            // a long pounce from afar: green lizards always, most others rarely
            this.lunge(prey.x, prey.y, prey, true);
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
          this.speed = (this.p.speed || 50) * 0.75;
          this.jawTarget = 0.25;
          this.lookAt = cur;
          this.raise = 0.5;
          this.lash = 0.6;
          this.pather.interval = 0.6;
          this.pather.setGoal(cur.x, cur.y);
          if (d < (this.p.biteRange || 60) * this.L && this.lungeCd <= 0 && this.grip) {
            this.lunge(cur.x, cur.y, null, false);
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
          this.idleLook = { x: head.x + Math.cos(a) * 80, y: head.y + Math.sin(a) * 80, t: U.rand(0.8, 2.2) * (1.4 - 0.8 * pe.nervous) };
        }
        this.lookAt = this.idleLook;
        // every few seconds: rear up and gape
        this.gapeCd = (this.gapeCd === undefined ? U.rand(2, 5) : this.gapeCd) - dt;
        if (this.gapeCd <= 0) {
          this.gapeT = U.rand(0.8, 1.4);
          this.gapeCd = U.rand(4, 8);
        }
        if (this.gapeT > 0) {
          this.gapeT -= dt;
          this.jawTarget = 0.7;
          this.raise = 0.4;
        }
        if (this.idleT <= 0) this.setState('wander');
        return;
      }
      if (this.readyForGoal(dt, 35, !!this.grip)) { // slow walkers need time for a long climb
        // low-energy lizards stop to rest more often and for longer; a
        // low-energy white lizard lies still long enough to vanish (lurk)
        if (this.pather.goal && Math.random() < 0.2 + 0.35 * (1 - pe.energy) + (this.atHome() ? 0.2 : 0)) {
          this.setState('idle');
          this.idleT = U.rand(1.5, 4.5) * (1.5 - pe.energy) * (this.p.camouflage ? 2.5 - 1.5 * pe.energy : 1);
          return;
        }
        const g = this.homeGoal() || this.wanderGoal(this.caps, 500);
        if (g) this.pather.setGoal(g.x, g.y, true);
        this.stateT = 0;
      }
    }

    // -------------------------------------------------------------- weapons --
    hitParts() {
      const P = this.spine.pts;
      const L = this.L;
      const out = [{ x: P[0].x, y: P[0].y, r: 6 * L, part: 'head' }];
      for (let i = 2; i < this.bodyN + 3; i++) out.push({ x: P[i].x, y: P[i].y, r: 5.5 * L, part: 'body' });
      return out;
    }
    stun(t, flip) {
      if (!super.stun(t, flip)) return false;
      this.turn = null;
      this.lungeT = 0;
      this.windT = 0;
      if (RIVALRY.includes(this.state) && this.rival) {
        this.rival.endRivalry(8);
        this.endRivalry(8);
      }
      return true;
    }
    // Knocked about: fall under gravity, legs flailing (in the air if flipped).
    limp(dt) {
      const W = this.W;
      const P = this.spine.pts;
      const head = P[0];
      const L = this.L;
      this.vy += GRAV * dt;
      this.vx *= Math.pow(0.4, dt);
      head.x += this.vx * dt;
      head.y += this.vy * dt;
      const c = W.collideCircle(head, 5 * L);
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx * 1.2;
          this.vy -= vn * c.ny * 1.2;
        }
        this.vx *= 0.85;
      }
      head.px = head.x;
      head.py = head.y;
      this.spine.verlet(1, 0.9, 0, GRAV, dt);
      this.spine.follow(1);
      this.spine.collide(W, 3, 1);
      this.grip = null;
      // on its back: belly up, so the legs kick at the sky
      const tux = 0;
      const tuy = this.flipped ? 1 : -1;
      const k = U.approach(8, dt);
      this.ux += (tux - this.ux) * k;
      this.uy += (tuy - this.uy) * k;
      const ul = Math.hypot(this.ux, this.uy) || 1;
      this.ux /= ul;
      this.uy /= ul;
      this.headAng = U.lerpAngle(this.headAng, Math.atan2(head.y - P[1].y, head.x - P[1].x), U.approach(10, dt));
      this.jaw += ((this.corpse ? 0.25 : 0.5 + 0.3 * Math.sin(this.age * 20)) - this.jaw) * 0.2;
      this.lash = this.corpse ? 0 : 1;
      this.lashS *= this.corpse ? 0.9 : 1;
      for (const l of this.legs) l.leg.planted = false;
      this.updateLegs(dt, false);
    }
    onRecovered() {
      this.setState('wander');
    }
    // Rocks: a head hit flips it over; red lizards barely notice.
    onRockHit(w, part) {
      if (this.p.stunImmune) {
        this.thrashT = 0.3;
        this.noticeT = 0.3;
        return;
      }
      this.stun(part === 'head' ? 1.3 : 0.8, part === 'head');
      this.vx += w.vx * 0.15;
      this.vy -= 120;
      this.angerAt(w.thrower);
    }
    // Spears: glance off the armoured head; stick in and wound the body.
    onSpearHit(w, part) {
      if (part === 'head') {
        this.thrashT = 0.3;
        this.angerAt(w.thrower);
        return 'bounce';
      }
      this.hp -= 0.6 / (this.p.toughness || 1);
      if (this.holding) this.release();
      this.vx += w.vx * 0.25;
      this.vy += w.vy * 0.1 - 60;
      this.thrashT = 0.5;
      this.eco.burst(w.x, w.y, this.bloodColor || '#20141a', 4);
      if (this.hp <= 0) {
        this.die(16);
        return 'drop';
      }
      // badly hurt or timid: retreat (maybe to a den); otherwise turn on it
      if (this.hp < 0.45 || Math.random() > this.pers.bravery) {
        const t = w.thrower || w;
        const g = this.fleeGoal(this.caps, t.x, t.y, 350);
        if (g) this.pather.setGoal(g.x, g.y, true);
        this.setState('flee');
        if (this.hp < 0.45 && Math.random() < 0.5) this.migrating = true;
      } else {
        this.angerAt(w.thrower);
      }
      return 'embed';
    }
    angerAt(c) {
      if (!c || c.dead || !this.diet.includes(c.species)) return;
      this.prey = c;
      this.fullT = Math.min(this.fullT, 0);
      if (this.state !== 'flee') this.setState('hunt');
    }
    // A rock clattering nearby: go and have a look.
    hearNoise(x, y) {
      if ((this.state !== 'wander' && this.state !== 'idle') || this.stunT > 0 || Math.random() > 0.6) return;
      this.setState('wander');
      this.stateT = 0;
      this.pather.setGoal(x, y, true);
      this.noticeT = 0.3;
      this.idleLook = { x, y, t: 2 };
    }

    // ------------------------------------------------------------ territory --
    homePos() {
      const h = this.home;
      if (!h) return null;
      const sol = this.W.solidById(h.sid);
      if (!sol) return null;
      const x = sol.x + Math.min(h.ox, sol.w - 6);
      const y = sol.y - 12;
      if (y < 4 || this.W.isSolidPt(x, y)) return null; // covered over
      return { x, y };
    }
    // Hangouts: the tops of windows, the taskbar and wallpaper ledges.
    pickHome(exclude) {
      const W = this.W;
      const head = this.spine.pts[0];
      const cands = [];
      for (const sol of W.solids) {
        if (sol.kind === 'edge' || sol.kind === 'icon' || sol.w < 80 || sol.id === exclude) continue;
        const ox = sol.w * U.rand(0.2, 0.8);
        const x = sol.x + ox;
        const y = sol.y - 12;
        if (y < 4 || W.isSolidPt(x, y)) continue;
        // unclaimed spots appeal; a dominant lizard may covet a claimed one
        let owner = null;
        for (const c of this.eco.creatures) {
          if (c !== this && c.home && c.home.sid === sol.id && isLizard(c) && !c.dead && !c.corpse) owner = c;
        }
        const claim = owner ? (this.pers.dominance - owner.pers.dominance) * 0.8 - 0.25 : 0.3;
        // up high is a better lookout than the floor
        const sc = Math.random() * 0.6 + claim - U.dist(head.x, head.y, x, y) / 1400 + (1 - y / W.h) * 0.5;
        cands.push({ sc, sid: sol.id, ox, x, y });
      }
      // best-scoring spot we can actually walk to (checking only a few)
      cands.sort((a, b) => b.sc - a.sc);
      let best = null;
      for (const c of cands.slice(0, 4)) {
        const r = Nav.findPath(W, head.x, head.y, c.x, c.y, this.caps, 4000);
        if (r && r.complete) {
          best = { sid: c.sid, ox: c.ox };
          break;
        }
      }
      this.home = best || (cands[0] ? { sid: cands[0].sid, ox: cands[0].ox } : null);
      this.homeAwayT = 0;
    }
    updateHome(dt) {
      const hp = this.homePos();
      if (!hp) return this.pickHome();
      const head = this.spine.pts[0];
      // can't get there (or keeps getting chased off): settle somewhere else
      if (U.dist(head.x, head.y, hp.x, hp.y) > TERR_R) this.homeAwayT += dt;
      else this.homeAwayT = 0;
      if (this.homeAwayT > 70) this.pickHome(this.home.sid);
    }
    atHome() {
      const hp = this.homePos();
      const head = this.spine.pts[0];
      return !!hp && U.dist(head.x, head.y, hp.x, hp.y) < TERR_R;
    }
    homeGoal() {
      const hp = this.homePos();
      if (!hp || Math.random() > 0.55 + 0.3 * (1 - this.pers.energy)) return null;
      return Nav.randomValid(this.W, this.caps, hp.x, hp.y, TERR_R * 0.6);
    }
    truce(c, sec) {
      this.truces.set(c.id, this.eco.t + sec);
    }
    // Who, if anyone, is worth squaring up to right now?
    findFoe() {
      const head = this.spine.pts[0];
      const L = this.L;
      const pe = this.pers;
      const hp = this.homePos();
      const home = this.atHome();
      let best = null;
      let bd = Infinity;
      for (const c of this.eco.creatures) {
        if (c === this || !isLizard(c) || c.dead || c.corpse || c.leaving || c.grabbedBy || c.alpha < 0.8) continue;
        if (this.diet.includes(c.species) || c.diet.includes(this.species)) continue; // that's hunting, not rivalry
        if ((this.truces.get(c.id) || 0) > this.eco.t) continue;
        if (RIVALRY.includes(c.state) || c.state === 'flee' || c.state === 'leave') continue;
        const ch = c.spine.pts[0];
        const d = U.dist(head.x, head.y, ch.x, ch.y);
        if (d > 200 * L || !this.canSee(ch.x, ch.y, 220 * L)) continue;
        let why = null;
        if (home && hp && U.dist(ch.x, ch.y, hp.x, hp.y) < TERR_R * 0.9) {
          // trespasser on our hangout
          if (Math.random() < 0.3 + 0.7 * Math.max(pe.aggression, pe.dominance)) why = 'territory';
        } else if (c.holding && this.fullT <= 0 && !this.holding) {
          // it has food and we're hungry
          if (Math.random() < 0.25 + 0.6 * pe.aggression) why = 'food';
        } else if (d < 70 * L && Math.random() < 0.1 * pe.aggression) {
          why = 'meet'; // bumped into each other
        }
        if (why && d < bd) {
          bd = d;
          best = { c, why };
        }
      }
      return best;
    }
    // How determined we are to win against c.
    resolve(c) {
      const pe = this.pers;
      let r = pe.dominance * 0.5 + pe.aggression * 0.25 + pe.bravery * 0.15 + this.mass * 0.05 + this.hp * 0.3;
      if (this.rivalWhy === 'territory' && this.atHome()) r += 0.25; // defending our own patch
      if (this.holding) r += 0.15; // possession
      if (this.rivalWhy === 'food' && this.fullT <= 0) r += 0.1;
      return r;
    }
    endRivalry(cd) {
      this.cancelStrike();
      this.rival = null;
      this.rivalCd = cd;
      if (RIVALRY.includes(this.state)) this.setState('wander');
    }
    // Runs the challenge / display / fight states. Returns true while busy.
    rivalry(dt, perceive) {
      const r = this.rival;
      const head = this.spine.pts[0];
      const L = this.L;
      const gone = !r || r.dead || r.leaving || r.grabbedBy;
      if (gone || (this.state !== 'challenge' && (r.rival !== this || !RIVALRY.includes(r.state)))) {
        this.endRivalry(U.rand(4, 8));
        return false;
      }
      const rh = r.spine.pts[0];
      const d = U.dist(head.x, head.y, rh.x, rh.y);
      this.lookAt = rh;
      this.lash = 1;
      // a meal wandering past or a predator breaks it up
      if (perceive && this.state === 'fight' && this.fullT <= 0) {
        const prey = this.nearestOf(this.diet, 90 * L, (c) => !c.grabbedBy && c !== r);
        if (prey) {
          this.endRivalry(10);
          r.endRivalry(10);
          return false;
        }
      }

      if (this.state === 'challenge') {
        // stride over, head up, hissing
        this.speed = (this.p.speed || 50) * 1.15;
        this.raise = 0.35;
        this.jawTarget = 0.35;
        this.pather.interval = 0.5;
        this.pather.setGoal(rh.x, rh.y);
        const hp = this.homePos();
        const left = this.rivalWhy === 'territory' && hp && U.dist(rh.x, rh.y, hp.x, hp.y) > TERR_R * 1.3;
        if (left || this.stateT > 9 || (this.rivalWhy === 'food' && !r.holding)) {
          // it moved on (or the food's gone): good enough
          this.truce(r, 20);
          this.endRivalry(U.rand(3, 6));
          return false;
        }
        if (d < 90 * L && !RIVALRY.includes(r.state)) {
          const t = U.rand(1.6, 3.2) * (0.7 + 0.6 * Math.max(this.pers.dominance, r.pers.dominance));
          for (const [a, b] of [[this, r], [r, this]]) {
            a.rival = b;
            a.rivalWhy = this.rivalWhy;
            a.displayFor = t;
            a.setState('display');
            a.pather.clear();
          }
        }
        return true;
      }

      if (this.state === 'display') {
        // rear up, gape and hiss, face it, edge closer
        this.raise = 1;
        this.jawTarget = this.holding ? 0.3 : 0.55 + 0.45 * Math.max(0, Math.sin(this.stateT * 9));
        if (d > 95 * L) {
          this.speed = (this.p.speed || 50) * 0.6;
          this.pather.setGoal(rh.x, rh.y);
        } else {
          this.pather.clear();
        }
        this.faceToward(rh);
        if (this.stateT > this.displayFor && this.id < r.id) this.settleDisplay(r);
        return true;
      }

      // fight: close in and snap; each bite staggers and wears the other down
      this.raise = 0.3;
      this.jawTarget = 0.5;
      this.speed = (this.p.huntSpeed || 90) * 0.8;
      this.pather.interval = 0.35;
      this.pather.setGoal(rh.x, rh.y);
      this.faceToward(rh);
      if (d < (this.p.biteRange || 60) * L + 12 && this.lungeCd <= 0 && this.grip && this.windT <= 0 && this.lungeT <= 0) {
        this.lunge(rh.x, rh.y, r, false);
        this.lungeCd = U.rand(0.5, 1.1) * (1.3 - 0.5 * this.pers.aggression);
      }
      if (this.stateT > 14 && this.id < r.id) {
        // a long scrap: whoever is worse off gives up
        if (this.hp < r.hp) this.submitTo(r);
        else r.submitTo(this);
      }
      return true;
    }
    cancelStrike() {
      if (this.lungePrey && isLizard(this.lungePrey) && !this.diet.includes(this.lungePrey.species)) {
        this.lungePrey = null;
        this.windT = 0;
      }
    }
    faceToward(pt) {
      const P = this.spine.pts;
      const fx = P[0].x - P[2].x;
      const fy = P[0].y - P[2].y;
      if (!this.turn && this.turnCd <= 0 && this.grip && fx * (pt.x - P[0].x) + fy * (pt.y - P[0].y) < 0) this.startTurn();
    }
    // End of the hissing: one backs down, or it comes to blows.
    settleDisplay(r) {
      const diff = this.resolve(r) - r.resolve(this) + U.rand(-0.12, 0.12);
      if (Math.abs(diff) > 0.2) {
        if (diff > 0) r.submitTo(this);
        else this.submitTo(r);
        return;
      }
      for (const a of [this, r]) {
        if (a.holding) a.release(); // drop the food to fight for it
        a.setState('fight');
      }
    }
    // Back down: run from the winner, maybe give up the hangout or the food,
    // and maybe leave the screen altogether.
    submitTo(w) {
      const eco = this.eco;
      const why = this.rivalWhy;
      const food = this.holding;
      if (food) {
        this.release();
        if (eco.cfg.ecosystem.predation && w.diet.includes(food.species) && !w.holding) w.grab(food);
      }
      if (why === 'territory' && this.home && w.home && this.atHome()) {
        // the winner takes over this hangout; we look for another
        w.home = this.home;
        w.homeAwayT = 0;
        this.pickHome(this.home.sid);
      }
      this.cancelStrike();
      this.truce(w, 40);
      w.truce(this, 40);
      w.endRivalry(U.rand(8, 15));
      this.rival = null;
      this.rivalCd = U.rand(20, 40);
      const g = this.fleeGoal(this.caps, w.x, w.y, 300);
      if (g) this.pather.setGoal(g.x, g.y, true);
      this.setState('flee');
      if (Math.random() < 0.3 * (1 - this.pers.bravery) + (this.hp < 0.35 ? 0.35 : 0)) this.migrating = true;
    }
    // A fight bite landed on our rival.
    biteRival(r) {
      const L = this.L;
      const head = this.spine.pts[0];
      const rh = r.spine.pts[0];
      const dmg = ((this.p.biteDamage || 1) / (r.p.toughness || 1)) * 0.16 * U.rand(0.8, 1.2);
      r.hp -= dmg;
      const dx = rh.x - head.x;
      const dy = rh.y - head.y;
      const dl = Math.hypot(dx, dy) || 1;
      r.vx += (dx / dl) * 230;
      r.vy += (dy / dl) * 230 - 60;
      r.thrashT = 0.35;
      this.thrashT = 0.25;
      this.eco.burst(rh.x, rh.y, r.bloodColor || '#20141a', 3);
      if (r.hp <= 0) {
        // killed: it stays where it fell
        r.die(14);
        this.endRivalry(U.rand(15, 25));
        return;
      }
      const submitAt = 0.2 + 0.35 * (1 - r.pers.bravery);
      if (r.hp < submitAt || Math.random() < 0.08 * (1 - r.pers.bravery)) r.submitTo(this);
    }

    // Lunges have a short windup (stop, rear, gape) before the strike.
    // A bite is a short snap once in range; a pounce is a long leap from
    // further off. The windup follows the species' bite delay.
    lunge(tx, ty, prey, pounce) {
      this.windT = 0.08 + ((this.p.biteDelay === undefined ? 12 : this.p.biteDelay) / 40) * 0.5;
      this.lungeTarget = { x: tx, y: ty };
      this.lungeCd = U.rand(1.3, 2.4);
      this.lungePrey = prey;
      this.pounce = !!pounce;
    }

    launchLunge() {
      const head = this.spine.pts[0];
      const prey = this.lungePrey;
      const tx = prey && !prey.dead ? prey.x : this.lungeTarget.x;
      const ty = prey && !prey.dead ? prey.y : this.lungeTarget.y;
      const dx = tx - head.x;
      const dy = ty - head.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = this.pounce ? 380 + 120 * this.L : 240 + 80 * this.L;
      this.lungeV = { x: (dx / d) * sp, y: (dy / d) * sp };
      this.lungeT = this.pounce ? 0.32 : 0.22;
      // the whole body is thrown into the strike, not just the head
      this.jolt = { hx: head.x, hy: head.y };
      // feet leave the ground for the strike
      for (const l of this.legs) l.leg.planted = false;
    }

    // Leap for a nearby pole: a ballistic arc over to the next path node.
    launchLeap(node) {
      const head = this.spine.pts[0];
      const cell = this.W.cell;
      const apexY = Math.min(head.y, node.y) - cell * 1.1;
      const vy0 = -Math.sqrt(2 * GRAV * Math.max(4, head.y - apexY));
      const tUp = -vy0 / GRAV;
      const tDown = Math.sqrt((2 * Math.max(1, node.y - apexY)) / GRAV);
      this.vx = (node.x - head.x) / (tUp + tDown);
      this.vy = vy0;
      this.leap = { t: 0, tx: node.x, ty: node.y, dur: tUp + tDown };
      this.leapNode = null;
      for (const l of this.legs) l.leg.planted = false;
    }

    // Turning round: the body swings over through the vertical instead of
    // the head ploughing back through its own shoulders.
    startTurn() {
      const P = this.spine.pts;
      const C = { x: P[3].x, y: P[3].y };
      const tx = -this.uy;
      const ty = this.ux;
      const off = P.map((p) => [(p.x - C.x) * tx + (p.y - C.y) * ty, (p.x - C.x) * this.ux + (p.y - C.y) * this.uy]);
      this.turn = { t: 0, dur: 0.42, C, tx, ty, nx: this.ux, ny: this.uy, off };
      for (const l of this.legs) l.leg.planted = false;
      this.vx = this.vy = 0;
    }

    stepTurn(dt) {
      const T = this.turn;
      const P = this.spine.pts;
      T.t += dt;
      const k = Math.min(1, T.t / T.dur);
      const f = Math.cos(Math.PI * k); // 1 -> -1 mirrors the body about the pivot
      const lift = Math.sin(Math.PI * k);
      for (let i = 0; i < P.length; i++) {
        const a = T.off[i][0];
        const b = T.off[i][1] + lift * Math.min(9 * this.L, Math.abs(a) * 0.45);
        P[i].x = P[i].px = T.C.x + T.tx * a * f + T.nx * b;
        P[i].y = P[i].py = T.C.y + T.ty * a * f + T.ny * b;
        this.W.collideCircle(P[i], i < this.bodyN ? 3 * this.L : 2);
      }
      if (k >= 1) {
        this.turn = null;
        this.turnCd = 1.2;
        this.look = 0;
      }
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
        // dead or dangling from the player's hand: slack-jawed; caught by a
        // predator: snapping
        const limp = this.corpse || this.grabbedBy.isHand;
        this.jaw += limp ? (0.25 - this.jaw) * 0.2 : (Math.random() < 0.1 ? 1 : 0 - this.jaw) * 0.3;
        this.updateLegs(dt, false);
        this.struggle(dt);
        return;
      }

      this.think(dt);
      this.pather.update(dt, head.x, head.y);
      this.turnCd = (this.turnCd || 0) - dt;
      if (this.turn) {
        this.stepTurn(dt);
        this.headAng = U.lerpAngle(this.headAng, Math.atan2(P[0].y - P[1].y, P[0].x - P[1].x), U.approach(20, dt));
        this.updateLegs(dt, true);
        return;
      }
      if (this.windT > 0) {
        // windup: stop, rear, gape
        this.windT -= dt;
        this.raise = 0.8;
        this.jawTarget = 0.9;
        this.vx *= 0.7;
        this.vy *= 0.7;
        // coil: draw the head and shoulders back away from the target
        const lt = this.lungeTarget;
        if (lt) {
          const dx = lt.x - head.x;
          const dy = lt.y - head.y;
          const d = Math.hypot(dx, dy) || 1;
          const pull = 30 * L * dt;
          for (let i = 0; i < this.bodyN; i++) {
            const k = 1 - (i / this.bodyN) * 0.7; // the whole body rocks back
            P[i].x -= (dx / d) * pull * k;
            P[i].y -= (dy / d) * pull * k;
          }
        }
        if (this.windT <= 0) this.launchLunge();
      }
      if (this.lungeT > 0) this.jawTarget = 1; // hold the gape through the strike

      // Only cling to a pole when the path is actually using it; otherwise a
      // pole base pushes the lizard sideways and it can't walk past.
      const pn = this.pather.current();
      const mask = pn && W.pole(pn.cx, pn.cy) && !W.solid(pn.cx, pn.cy + 1) ? this.mask : this.maskNoPole;
      let g = W.nearestSurface(head.x, head.y, 22 * L, mask);
      if (!g) g = W.nearestSurface(P[3].x, P[3].y, 20 * L, mask);
      if (this.dropT > 0) {
        // letting go on purpose to drop down
        this.dropT -= dt;
        g = null;
      }
      if (this.leap) {
        // mid-leap: don't snag on the pole we left; grab hold near the far end
        const lp = this.leap;
        const near = U.dist(head.x, head.y, lp.tx, lp.ty) < W.cell * 1.6;
        if (!near && lp.t < lp.dur * 0.75) g = null;
      }
      if (this.scramble) g = null; // hauling over a ledge lip: no hugging
      this.grip = g;

      if (this.lungeT > 0) {
        this.lungeT -= dt;
        if (this.lungeT > 0.19) {
          // ease into the strike over a few frames
          this.vx += (this.lungeV.x - this.vx) * 0.5;
          this.vy += (this.lungeV.y - this.vy) * 0.5;
        }
        if (this.lungeT < 0.12) this.vy += GRAV * dt;
        const prey = this.lungePrey;
        if (prey && prey === this.rival && this.state === 'fight' && !prey.dead && U.dist(head.x, head.y, prey.x, prey.y) < 22 * L) {
          this.lungeT = 0;
          this.lungePrey = null;
          this.biteRival(prey);
        } else if (prey && !prey.dead && U.dist(head.x, head.y, prey.x, prey.y) < 18 * L) {
          if (isLizard(prey) && !this.diet.includes(prey.species)) {
            // a rival, not a meal (the scrap ended mid-lunge): just snap shut
            this.lungeT = 0;
          } else if (this.eco.cfg.ecosystem.predation && this.grab(prey)) {
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
        this.scrambleCd = (this.scrambleCd || 0) - dt;
        if (!this.scramble && !this.leap && !(this.leapWind > 0) && this.scrambleCd <= 0) {
          // off a pole onto the ledge beside it: scramble up over the lip
          // (smaller lizards make it more often)
          const corner = this.cornerAhead(head);
          if (corner) this.startScramble(corner, head, 6 * L, 15 * L, U.clamp(0.95 - L * 0.4, 0.35, 0.7));
        }
        if (this.scramble) {
          const sc = this.scramble;
          if (this.stepScramble(dt, head) === null) {
            // the body wriggles and the feet paw at the face
            for (let i = 1; i < this.bodyN; i++) P[i].x += Math.sin(sc.t * 30 - i * 1.1) * 0.6 * L;
            this.raise = 0.5;
          }
        } else if (this.leap) {
          // airborne: a ballistic arc until we catch hold of something
          const lp = this.leap;
          lp.t += dt;
          this.vy += GRAV * dt;
          if ((g && lp.t > 0.12) || lp.t > lp.dur + 0.8) {
            this.leap = null;
            this.pather.timer = Math.min(this.pather.timer, 0.1);
          }
        } else if (this.leapWind > 0) {
          // crouch, then spring
          this.leapWind -= dt;
          this.vx *= 0.7;
          this.vy *= 0.7;
          if (this.leapWind <= 0 && this.leapNode) this.launchLeap(this.leapNode);
        } else if (node && node.type === Nav.JUMP) {
          // a leap: get to the take-off point first
          const prev = this.pather.previous();
          if (g && (!prev || U.dist(head.x, head.y, prev.x, prev.y) < cell * 0.9)) {
            this.leapWind = 0.14;
            this.leapNode = node;
          } else if (prev) {
            const dx = prev.x - head.x;
            const dy = prev.y - head.y;
            const d = Math.hypot(dx, dy) || 1;
            dvx = (dx / d) * this.speed;
            dvy = (dy / d) * this.speed;
          }
        } else if (node) {
          let tx = node.x;
          let ty = node.y;
          if (node.type === Nav.FALL && g) {
            if (Math.abs(node.x - head.x) < cell * 0.6) this.dropT = 0.35; // right above it: let go
            else ty = head.y; // walk off the edge first
          }
          const dx = tx - head.x;
          const dy = ty - head.y;
          const d = Math.hypot(dx, dy) || 1;
          // speed surges as feet step and eases as they plant
          // lumbering: a heave forward as feet swing, a sag as they plant
          const surge = this.legs.some((l) => l.leg.stepping) ? 1.25 : 0.68;
          dvx = (dx / d) * this.speed * surge;
          dvy = (dy / d) * this.speed * surge;
          if (g && this.speed > 0 && this.turnCd <= 0 && this.windT <= 0) {
            let nx = P[0].x - P[2].x;
            let ny = P[0].y - P[2].y;
            const nl = Math.hypot(nx, ny) || 1;
            if ((nx / nl) * (dx / d) + (ny / nl) * (dy / d) < -0.3) {
              this.startTurn();
              return;
            }
          }
          // Deliberately stepping off a surface: don't let the hug pull us back.
          this.leavingSurface = node.type === Nav.FALL || (g && (dx / d) * g.nx + (dy / d) * g.ny > 0.6);
        }
        if (this.leap || this.scramble) {
          // (gravity already applied or scrambling; no steering)
        } else if (g) {
          // heavy lizards are slow to get going and slow to stop
          const k = U.approach(U.clamp(11 / Math.sqrt(this.mass), 3.5, 9), dt);
          this.vx += (dvx - this.vx) * k;
          this.vy += (dvy - this.vy) * k;
        } else {
          this.vy += GRAV * dt;
          this.vx += (dvx * 0.3 - this.vx) * U.approach(0.8, dt);
        }
      }

      // On a surface the head never walks backwards into its own shoulders
      // (that folds the body up behind it); it has to turn round instead.
      if (g && this.lungeT <= 0 && !this.leavingSurface) {
        let fx = head.x - P[2].x;
        let fy = head.y - P[2].y;
        const fl = Math.hypot(fx, fy) || 1;
        fx /= fl;
        fy /= fl;
        const back = this.vx * fx + this.vy * fy;
        if (back < 0) {
          this.vx -= back * fx;
          this.vy -= back * fy;
        }
      }
      head.x += this.vx * dt;
      head.y += this.vy * dt;
      if (g && this.lungeT <= 0 && !this.leavingSurface) {
        // hug the surface at a fixed body height
        this.raiseS = (this.raiseS || 0) + (this.raise - (this.raiseS || 0)) * U.approach(5, dt);
        // a slow rise and fall with the stride
        const moving = U.clamp(Math.hypot(this.vx, this.vy) / 40, 0, 1);
        this.walkPh += Math.hypot(this.vx, this.vy) * dt * 0.11 / L;
        const bob = Math.sin(this.walkPh * 2) * 1.3 * moving;
        const err = g.d - (15 + bob + this.raiseS * 12) * L;
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
          const s = W.nearestSurface(pt.x, pt.y, 22 * L, mask);
          if (s) {
            const e = s.d - (i < this.bodyN ? 14 - i * 0.5 + this.raiseS * 12 * (REAR[i] || 0) : 5.5 + (this.bodyN + 4 - i) * 1.4) * L;
            pt.x -= s.nx * e * 0.3;
            pt.y -= s.ny * e * 0.3;
          }
        }
        W.collideCircle(pt, i < this.bodyN ? 4 * L : 2.5);
      }
      // A little backbone stiffness: the body resists folding into a heap.
      if (g && !this.leavingSurface) {
        for (let i = 1; i < this.bodyN + 2; i++) {
          const a = P[i - 1];
          const b = P[i + 1];
          const pt = P[i];
          pt.x += ((a.x + b.x) / 2 - pt.x) * 0.12;
          pt.y += ((a.y + b.y) / 2 - pt.y) * 0.12;
        }
      }

      // Lunge follow-through: shoulders, hips and tail lurch after the head.
      // Each point is dragged along by a share of the head's own movement this
      // frame, most at the shoulders, least at the tail tip.
      if (this.jolt) {
        const j = this.jolt;
        const mx = head.x - j.hx;
        const my = head.y - j.hy;
        j.hx = head.x;
        j.hy = head.y;
        const n = P.length;
        for (let i = 1; i < n; i++) {
          const k = Math.pow(1 - i / n, 0.8) * 0.6;
          P[i].x += mx * k;
          P[i].y += my * k;
        }
        if (this.lungeT <= 0) this.jolt = null;
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
      // never let the head point more than ~35 degrees off the body line
      const bodyAng = Math.atan2(P[1].y - P[3].y, P[1].x - P[3].x);
      ang = bodyAng + U.clamp(U.angleDiff(bodyAng, ang), -0.6, 0.6);
      // ...and on a surface, keep the head near level with it: a little
      // up-tilt (more when rearing), never nosing down into the ground
      if (g && this.lungeT <= 0) {
        const hx = Math.cos(ang);
        const hy = Math.sin(ang);
        const up = hx * this.ux + hy * this.uy;
        const maxUp = Math.sin(0.4 + (this.raiseS || 0) * 0.7);
        const maxDown = -Math.sin(0.25);
        if (up > maxUp || up < maxDown) {
          let tx = hx - up * this.ux;
          let ty = hy - up * this.uy;
          const tl = Math.hypot(tx, ty) || 1;
          tx /= tl;
          ty /= tl;
          const u = U.clamp(up, maxDown, maxUp);
          const c = Math.sqrt(1 - u * u);
          ang = Math.atan2(ty * c + this.uy * u, tx * c + this.ux * u);
        }
      }
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
        // only while stalking or hunting: fades see-through when still (never
        // fully invisible); otherwise in plain sight
        const sneaking = this.state === 'hunt' || this.state === 'stalk';
        const visible = !sneaking || this.lungeT > 0 || this.holding ? 1 : U.clamp(speedNow / 140, 0.35, 1);
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
        let canStep = active && !stepping[1 - l.leg.group];
        if (l.at === 2 && (this.raiseS || 0) > 0.6 && active) {
          // reared up: front feet leave the ground and paw the air
          l.leg.planted = false;
          canStep = false;
        }
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
      // (a camouflaged lizard is drawn opaque here and blended in later; see
      // ghostAlpha and Ecosystem.drawLate)
      ctx.globalAlpha = this.alpha;

      // An open mouth is a gap: keep the lizard's own neck and legs out of it
      // (clip, rather than erase, so whatever is behind still shows).
      ctx.save();
      const wedge = this.mouthWedge();
      if (wedge) {
        const b = this.bounds();
        ctx.beginPath();
        ctx.rect(b[0] - 40, b[1] - 40, b[2] - b[0] + 80, b[3] - b[1] + 80);
        ctx.moveTo(wedge[0][0], wedge[0][1]);
        for (let i = 1; i < wedge.length; i++) ctx.lineTo(wedge[i][0], wedge[i][1]);
        ctx.closePath();
        ctx.clip('evenodd');
      }

      for (const l of this.legs) if (!l.near) this.drawLeg(ctx, l, px);

      // Flat silhouette; the pixel pass gives it hard edges.
      const breath = 1 + 0.05 * Math.sin(this.age * 2.3 + this.breathe) * (this.state === 'display' ? 2.5 : 1);
      const widths = new Array(n);
      const prof = [6.2, 8, 9.2, 9, 8.2, 7, 5.8];
      for (let i = 0; i < n; i++) {
        if (i < this.bodyN) widths[i] = prof[i] * L * (i >= 2 && i <= 5 ? breath : 1);
        else {
          const t = (i - this.bodyN + 1) / (n - this.bodyN);
          widths[i] = Math.max(px * 0.8, 5.5 * L * (t < 0.75 ? 1 - t * 0.6 : 0.55 * (1 - t) / 0.25));
        }
      }
      const N = this.backNormals(P);
      ctx.fillStyle = body;
      U.taperPath(ctx, P, widths);
      ctx.fill();
      // Neck takes the head colour solid for a short way...
      ctx.fillStyle = headCol;
      U.taperPath(ctx, P.slice(0, 3), widths.slice(0, 3).map((w) => w * 0.9));
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

      // Coloured tail tip (blue, pink, yellow, cyan...).
      if (this.p.tailTip) {
        ctx.fillStyle = headCol;
        const k0 = Math.floor(n * 0.78);
        U.taperPath(ctx, P.slice(k0), widths.slice(k0).map((w) => w * 0.95));
        ctx.fill();
      }
      // Ring markings (cyan lizards).
      if (this.p.pattern === 'rings') {
        ctx.strokeStyle = headCol;
        ctx.lineWidth = Math.max(px * 1.5, 1.4 * L);
        for (const t of [0.14, 0.24, 0.42]) {
          const q = at(t);
          ctx.beginPath();
          ctx.arc(q.x + q.nx * q.w * 0.15, q.y + q.ny * q.w * 0.15, q.w * 0.55, 0, U.TAU);
          ctx.stroke();
        }
        // stripe along the tail
        ctx.lineWidth = Math.max(px, 1 * L);
        ctx.beginPath();
        for (let i = this.bodyN; i < n; i++) {
          const x = P[i].x + N[i].nx * widths[i] * 0.4;
          const y = P[i].y + N[i].ny * widths[i] * 0.4;
          if (i === this.bodyN) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Dorsal spines (green lizards): wide-based jagged pixel spikes,
      // irregular in height, spacing and lean.
      if (this.spineSet.length) {
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
      ctx.restore(); // end of the mouth clip
      this.drawHead(ctx, px);
      ctx.restore();
      this.drawPath(ctx, this.pather);
      if (this.eco.cfg.debug.showPaths) {
        // territory: a ring round the hangout, in the lizard's colour
        const hp = this.homePos();
        if (hp) {
          ctx.strokeStyle = U.rgba(this.headColor, 0.9);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(hp.x, hp.y, TERR_R, 0, U.TAU);
          ctx.stroke();
          ctx.fillStyle = U.rgba(this.headColor, 0.8);
          ctx.fillRect(hp.x - 2, hp.y - 2, 4, 4);
        }
      }
      this.drawDebug(ctx);
    }

    // Sprawling limbs, seen from the side: front elbows point back and hind
    // knees forward, and a joint never rises above the body's centreline
    // (the leg splays out sideways instead, so it reads foreshortened).
    legJoint(l) {
      const P = this.spine.pts;
      const h = P[l.at];
      const leg = l.leg;
      const L = this.L;
      const a = P[l.at - 1];
      const b = P[l.at + 1];
      let fx = a.x - b.x;
      let fy = a.y - b.y;
      const fl = Math.hypot(fx, fy) || 1;
      fx /= fl;
      fy /= fl;
      const sgn = l.at <= 2 ? -1 : 1;
      const k = U.ikToward(h.x, h.y, leg.foot.x, leg.foot.y, leg.l1, leg.l2, fx * sgn, fy * sgn);
      // limit how far the joint sticks out from the hip-foot line
      const mx = (h.x + k.ex) / 2;
      const my = (h.y + k.ey) / 2;
      let ox = k.kx - mx;
      let oy = k.ky - my;
      const ol = Math.hypot(ox, oy);
      const maxOff = 7 * L;
      if (ol > maxOff) {
        ox *= maxOff / ol;
        oy *= maxOff / ol;
      }
      let kx = mx + ox;
      let ky = my + oy;
      // never above the centreline: push it down toward the surface
      const up = (kx - h.x) * this.ux + (ky - h.y) * this.uy;
      if (up > -1.5 * L) {
        kx -= this.ux * (up + 1.5 * L);
        ky -= this.uy * (up + 1.5 * L);
      }
      return { kx, ky, ex: k.ex, ey: k.ey };
    }

    drawLeg(ctx, l, px) {
      const P = this.spine.pts;
      const h = P[l.at];
      const leg = l.leg;
      const k = this.legJoint(l);
      const L = this.L;
      // near-black legs; only the feet carry the species colour
      const base = this.p.camouflage ? this.bodyColor : U.scale(this.bodyColor, l.near ? 1.6 : 1);
      const body = U.rgba(base);
      const foot = U.rgba(this.p.camouflage ? U.scale(this.bodyColor, 0.85) : this.headColor);
      ctx.fillStyle = body;
      U.taperPath(ctx, [{ x: h.x, y: h.y }, { x: k.kx, y: k.ky }], [4.6 * L, 3.2 * L]);
      ctx.fill();
      U.taperPath(ctx, [{ x: k.kx, y: k.ky }, { x: k.ex, y: k.ey }], [3.2 * L, 2.2 * L]);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(k.kx, k.ky, 3.2 * L, 0, U.TAU);
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
      // four splayed toes, each a pointed wedge
      ctx.fillStyle = foot;
      ctx.beginPath();
      ctx.arc(k.ex, k.ey, Math.max(px, 1.6 * L), 0, U.TAU);
      ctx.fill();
      const half = Math.max(px, 1.3 * L);
      for (const s of [-0.6, 0.1, 0.7, 1.3]) {
        const len = 5.8 * L * curl;
        const tx = k.ex + sx * s * len + nx * (s < 0 ? 1 : 0.3) * L;
        const ty = k.ey + sy * s * len + ny * (s < 0 ? 1 : 0.3) * L;
        const dx = tx - k.ex;
        const dy = ty - k.ey;
        const dl = Math.hypot(dx, dy) || 1;
        ctx.beginPath();
        ctx.moveTo(k.ex - (dy / dl) * half, k.ey + (dx / dl) * half);
        ctx.lineTo(k.ex + (dy / dl) * half, k.ey - (dx / dl) * half);
        ctx.lineTo(tx, ty);
        ctx.fill();
      }
    }

    // Head-local art coordinates -> world, mirroring drawHead's transform.
    headToWorld(x, y) {
      const hd = this.spine.pts[0];
      const L = this.L * 1.3;
      const a = this.headAng;
      const flip = Math.sin(a) * this.ux - Math.cos(a) * this.uy < 0 ? -1 : 1;
      const lx = (x - 3) * L;
      const ly = (y + 1.6) * L * flip;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return [hd.x + lx * c - ly * s, hd.y + lx * s + ly * c];
    }
    // The open gape between the jaws (world points), or null when shut.
    mouthWedge() {
      const jawA = this.jaw * 0.95;
      if (jawA <= 0.04) return null;
      const c = Math.cos(jawA);
      const s = Math.sin(jawA);
      const lx = -4 + 20.4 * c;
      const ly = 0.5 + 20.4 * s;
      return [this.headToWorld(-4, 0.5), this.headToWorld(16.4, 0.5), this.headToWorld(lx, ly)];
    }

    // Big boxy head, flat colour, black tooth marks along the mouth line and
    // a black eye: the Rain World lizard face.
    drawHead(ctx, px) {
      const hd = this.spine.pts[0];
      const L = this.L * 1.3;
      const a = this.headAng;
      const col = U.rgba(this.headColor);
      const jawCol = U.rgba(U.scale(this.headColor, 0.55));
      const ink = '#0a0608';
      ctx.save();
      ctx.translate(hd.x, hd.y);
      ctx.rotate(a);
      const topX = Math.sin(a);
      const topY = -Math.cos(a);
      if (topX * this.ux + topY * this.uy < 0) ctx.scale(1, -1);
      ctx.scale(L, L);
      // centre the skull+jaw on the spine so the head continues the neck
      // line (as in the game) instead of perching on top of it
      ctx.translate(-3, 1.6);
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
        ctx.moveTo(13, 1);
        ctx.lineTo(17 + ext, 1 + Math.sin(this.age * 40) * 0.6);
        ctx.lineTo(18.5 + ext, -0.3);
        ctx.moveTo(17 + ext, 1);
        ctx.lineTo(18.5 + ext, 2.3);
        ctx.stroke();
      }

      // lower jaw
      ctx.fillStyle = jawCol;
      ctx.beginPath();
      // flat-bottomed lower jaw with a rounded front corner
      [[-5, 0.5], [16.2, 0.5], [16.2, 2.6], [15.2, 4], [-4.5, 4.4]].forEach((pt, i) => {
        const r = rot(pt[0], pt[1]);
        if (i) ctx.lineTo(r[0], r[1]);
        else ctx.moveTo(r[0], r[1]);
      });
      ctx.closePath();
      ctx.fill();
      // upper skull: flat top, blunt snout, rounded back
      ctx.fillStyle = col;
      ctx.beginPath();
      // short boxy skull: flat top and a blunt, rounded snout
      ctx.moveTo(-5.5, 0.6);
      ctx.lineTo(-7, -2.2);
      ctx.lineTo(-5.8, -5.6);
      ctx.lineTo(-2, -6.6);
      ctx.lineTo(10, -6.4);
      ctx.quadraticCurveTo(16.6, -6.2, 16.6, -1.6);
      ctx.lineTo(16.6, 0.6);
      ctx.closePath();
      ctx.fill();

      // tooth marks: small irregular black ticks on the upper jaw along the
      // mouth line (gap at the snout tip); lower ones only show when it gapes
      const toothW = Math.max(u * 1.5, 1);
      const step = Math.max(2.6 * u, 2.4);
      ctx.fillStyle = ink;
      let k = 0;
      for (let x = 3.5; x <= 15.2; x += step, k++) {
        const th = Math.max(u * 2, 1.8) * [1, 0.65, 1.2, 0.8][k % 4];
        ctx.fillRect(x, 0.6 - th, toothW, th);
        if (jawA > 0.15) {
          const r0 = rot(x + 0.5, 0.6);
          const r1 = rot(x + 0.5, 0.6 + th * 0.8);
          ctx.fillRect(Math.min(r0[0], r1[0]), Math.min(r0[1], r1[1]), toothW, Math.abs(r1[1] - r0[1]) + 0.01);
        }
      }
      // dark line under the jaw
      ctx.fillStyle = ink;
      {
        const r0 = rot(-4, 4.3);
        const r1 = rot(15.2, 4);
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
      const es = Math.max(u * 2, 2.8);
      const eh = Math.max(u, es * open);
      if (this.corpse) {
        // dead: an X for an eye
        ctx.strokeStyle = ink;
        ctx.lineWidth = Math.max(u, 0.9);
        ctx.beginPath();
        ctx.moveTo(4, -6);
        ctx.lineTo(4 + es + 0.6, -6 + es + 0.6);
        ctx.moveTo(4 + es + 0.6, -6);
        ctx.lineTo(4, -6 + es + 0.6);
        ctx.stroke();
      } else ctx.fillRect(4, -5.4 + (es - eh) / 2, es, eh);
      if (open > 0.5 && !this.corpse) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(4, -5.4 + (es - eh) / 2, Math.max(u, 0.6), Math.max(u, 0.6));
        ctx.fillStyle = ink;
      }
      // nostril
      ctx.fillRect(14.6, -4.4, Math.max(u, 0.9), Math.max(u, 0.9));
      ctx.restore();
    }
  }

  RW.Creatures.Lizard = Lizard;
})();
