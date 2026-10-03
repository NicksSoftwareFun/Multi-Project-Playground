// Slugcats: small scavengers with platformer physics. They walk, climb poles,
// make solved jumps between ledges, forage for dangle fruit and batflies,
// flee predators, and get curious about a resting cursor.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;
  const Nav = RW.Nav;

  const GRAV = 1100;
  const R = 6.5;
  const ARM = 4.8; // upper arm and forearm length
  const LEG = 5.6;

  class Slugcat extends RW.Creature {
    constructor(eco, species, x, y) {
      super(eco, species, x, y);
      const p = this.p;
      const variants = Object.entries(p.variants || { survivor: 1 });
      this.variant = U.weighted(variants) || 'survivor';
      this.color = U.hex((p.colors || {})[this.variant] || '#f1f1f4');
      this.hip = { x, y, px: x, py: y };
      this.head = { x, y: y - 11 };
      this.vx = 0;
      this.vy = 0;
      this.tail = new RW.Chain(x, y, 5, [5.2, 4.9, 4.4, 3.9, 3.4], -1, 0.3);
      this.caps = {
        walls: false,
        ceil: false,
        poles: true,
        fall: true,
        jumpX: p.jumpX || 7,
        jumpUp: p.jumpUp || 5,
        poleCost: 1.1,
      };
      this.pather = new RW.Pather(this, this.caps);
      this.facing = U.sign();
      this.look = 0;
      this.grounded = false;
      this.pole = null;
      this.jumping = false;
      this.walkPhase = 0;
      this.climbPhase = 0;
      this.blinkT = U.rand(1, 4);
      this.blink = 0;
      // Transitory: in through one pipe hungry, eat twice, then cross the map
      // and out through the pipe farthest from where we came in.
      this.hunger = U.rand(0.6, 0.85);
      this.meals = 0;
      this.origin = null;
      this.exitDen = null;
      this.item = null;
      this.eatT = 0;
      this.restT = 0;
      this.sleeping = false;
      this.perceiveT = 0;
      this.threat = null;
      this.stuckT = 0;
      this.jumpFails = 0;
      this.crouchT = 0;
      this.lastX = x;
      this.lastY = y;
      this.pers = U.personality(); // bravery decides fight (throw) or flight
      this.weapon = null; // a rock or spear in the far hand
      this.throwT = 0; // windup before a throw
      this.throwCd = 0;
      this.throwAt = null;
      this.fetch = null; // weapon we're walking over to pick up
      this.snackT = 0; // eating something skewered on a spear
      this.handPt2 = null;
      this.grabbedT = 0;
      this.lie = 0; // 0 standing .. 1 lying flat
      this.reachTo = null; // something the near hand is reaching for
      this.handPt = null;
      this.diet = ['batfly', 'centipede'];
      this.threats = ['lizard_*', 'daddy', 'dropwig', 'centipede_medium', 'centipede_large'];
      this.bloodColor = '#3a1f22';
    }

    mainPoint() {
      return this.hip;
    }
    bounds() {
      const b = RW.Creature.ptsBounds([this.hip, this.head].concat(this.tail.pts), 16);
      if (this.item) b[1] -= 8;
      return b;
    }
    // Held things sit in the near hand.
    itemPoint() {
      return this.handPt || { x: this.head.x + this.facing * 4, y: this.head.y + 4 };
    }
    holdPoint() {
      return this.itemPoint();
    }
    // A predator is a threat when it's after us, or simply too close for
    // comfort (closer for the brave); a daddy's long reach counts.
    threatNear(range) {
      const hip = this.hip;
      const calm = 110 + 70 * (1 - this.pers.bravery);
      return this.nearestOf(this.threats, range, (c) => {
        if (c.holding || c.lurking || !this.canSee(c.x, c.y, range)) return false;
        const d = U.dist(c.x, c.y, hip.x, hip.y);
        return c.prey === this || c.target === this || c.lungePrey === this || d < calm || (c.species === 'daddy' && d < 230);
      });
    }
    // Running away: head for high ground if there's a route, ideally one the
    // pursuer can't follow (up a pole, onto a ledge); else just get clear.
    fleeGoal(caps, fx, fy, dist) {
      return this.escapeUp(fx, fy) || super.fleeGoal(caps, fx, fy, dist);
    }
    escapeUp(fx, fy) {
      const W = this.W;
      const m = this.hip;
      const list = Nav.validCells(W, this.caps).stand;
      const n = list.length / 2;
      if (!n) return null;
      const cands = [];
      for (let k = 0; k < 12; k++) {
        const i = Math.floor(Math.random() * n) * 2;
        const x = W.centerX(list[i]);
        const y = W.centerY(list[i + 1]);
        const dThreat = U.dist(x, y, fx, fy);
        const dMe = U.dist(x, y, m.x, m.y);
        if (y > m.y - 30 || dThreat < 120 || dMe > 450) continue;
        cands.push({ x, y, sc: (m.y - y) / 100 + dThreat / 300 - dMe / 400 + Math.random() * 0.3 });
      }
      cands.sort((a, b) => b.sc - a.sc);
      const t = this.threat;
      let fallback = null;
      for (const c of cands.slice(0, 3)) {
        const r = Nav.findPath(W, m.x, m.y, c.x, c.y, this.caps, 4000);
        if (!r || !r.complete) continue;
        if (!t || !t.caps) return c;
        const rt = Nav.findPath(W, t.x, t.y, c.x, c.y, t.caps, 3000);
        if (!rt || !rt.complete) return c; // somewhere it can't follow
        if (!fallback) fallback = c;
      }
      return fallback;
    }
    weaponPoint() {
      return this.handPt2 || { x: this.head.x - this.facing * 3, y: this.head.y + 6 };
    }
    weaponAngle() {
      if (this.throwT > 0 && this.aimAng !== undefined) return this.aimAng;
      return this.facing > 0 ? -0.45 : Math.PI + 0.45;
    }
    remove() {
      if (this.weapon) this.weapon.drop();
      this.weapon = null;
      super.remove();
    }
    kill() {
      if (this.weapon) this.weapon.drop();
      this.weapon = null;
      if (this.item) {
        this.item.heldBy = null;
        this.item = null;
      }
      this.lie = 1;
      super.kill();
    }
    // Dead (or knocked out): a ragdoll lying on its side.
    limp(dt) {
      const hip = this.hip;
      this.vy += GRAV * dt;
      this.vx *= Math.pow(0.2, dt);
      hip.x += this.vx * dt;
      hip.y += this.vy * dt;
      const c = this.W.collideCircle(hip, R);
      this.grounded = false;
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx;
          this.vy -= vn * c.ny;
        }
        if (c.ny < -0.6) this.grounded = true;
      }
      this.pole = null;
      this.jumping = false;
      this.lie += (1 - this.lie) * U.approach(6, dt);
      this.look += (this.facing - this.look) * U.approach(6, dt);
      this.updateHead(dt, false);
      this.updateTail(dt);
      this.updateHand();
    }
    leave() {
      if (this.weapon) this.weapon.dead = true; // taken into the den
      this.weapon = null;
      super.leave();
    }
    carry(dx, dy) {
      this.hip.x += dx;
      this.hip.y += dy;
      this.head.x += dx;
      this.head.y += dy;
      this.tail.shift(dx, dy);
    }
    onUnburrowed() {
      super.onUnburrowed();
      this.pole = null;
      this.jumping = false;
    }
    onGrabbed() {
      this.pole = null;
      this.jumping = false;
      if (this.holding) this.release();
      if (this.item) {
        this.item.heldBy = null;
        this.item.claimedBy = null;
        this.item = null;
      }
    }
    onReleased() {
      this.vy = -250;
      this.vx = U.rand(-120, 120);
      this.setState('flee');
    }
    onBitten(by) {
      this.vy = -320;
      this.vx = Math.sign(this.hip.x - by.x) * 220;
      this.grounded = false;
      this.pole = null;
      this.threat = by;
      this.setState('flee');
    }

    // ---------------------------------------------------------------- AI ----
    think(dt) {
      const eco = this.eco;
      const hip = this.hip;
      const p = this.p;
      this.perceiveT -= dt;
      const perceive = this.perceiveT <= 0;
      if (perceive) this.perceiveT = 0.3;
      this.hunger = Math.min(1, this.hunger + dt / 100);
      this.ignoreFoodT = (this.ignoreFoodT || 0) - dt;
      this.speed = p.speed || 105;
      this.sleeping = false;
      this.reachTo = null;

      if (this.snackT > 0) {
        // nibbling whatever came skewered on the spear we picked up
        this.setState('eat');
        this.pather.clear();
        this.snackT -= dt;
        if (this.snackT <= 0) {
          this.hunger = Math.max(0, this.hunger - this.snackVal);
          this.ate();
          this.setState('rest');
          this.restT = U.rand(1, 3);
        }
        return;
      }

      if (this.item) {
        this.setState('eat');
        this.pather.clear();
        this.eatT += dt;
        if (this.eatT > 2.4) {
          this.item.dead = true;
          this.item = null;
          this.hunger = Math.max(0, this.hunger - 0.6);
          this.ate();
          this.eatT = 0;
          this.setState('rest');
          this.restT = U.rand(1, 3);
        }
        return;
      }
      if (this.holding) {
        if (!this.holding.corpse) this.holding.kill();
        // a batfly in hand: nibble it, then rest
        this.setState('eat');
        this.pather.clear();
        this.eatT += dt;
        if (this.eatT > 1.8) {
          eco.consume(this.holding, this);
          this.hunger = Math.max(0, this.hunger - 0.35);
          this.ate();
          this.eatT = 0;
          this.setState('rest');
          this.restT = U.rand(1, 3);
        }
        return;
      }

      // A transit slugcat still runs from danger on its way out.
      const passing = this.exitDen && !eco.shouldShelter();
      if (this.wantsToLeave(dt) && !(passing && this.state === 'flee' && this.stateT < 3.5)) {
        if (passing && perceive) {
          const t = this.threatNear(p.vision || 260);
          if (t) {
            this.threat = t;
            if (this.weapon && Math.random() < 0.35 + 0.6 * this.pers.bravery) this.startThrow(t);
            const g = this.fleeGoal(this.caps, t.x, t.y, 380);
            if (g) this.pather.setGoal(g.x, g.y, true);
            this.setState('flee');
            return;
          }
        }
        this.setState('leave');
        const den = passing ? this.exitDen : eco.nearestDen(hip.x, hip.y);
        if (den) {
          this.pather.setGoal(den.x, den.y);
          if (U.dist(hip.x, hip.y, den.x, den.y) < 22) this.leave();
        }
        this.speed = passing ? p.speed || 105 : p.runSpeed || 170;
        return;
      }

      if (perceive) {
        const t = this.threatNear(p.vision || 260);
        if (t) {
          this.threat = t;
          // armed and brave enough: throw at it first, then run
          const td = U.dist(t.x, t.y, hip.x, hip.y);
          if (this.weapon && td < 230 && Math.random() < 0.35 + 0.6 * this.pers.bravery && this.W.lineClear(hip.x, hip.y - 6, t.x, t.y)) {
            this.startThrow(t);
          }
          if (this.state !== 'flee' || this.stateT > 1.5) {
            const g = this.fleeGoal(this.caps, t.x, t.y, 380);
            if (g) this.pather.setGoal(g.x, g.y, true);
            this.setState('flee');
          }
        }
      }
      if (this.state === 'flee') {
        this.speed = p.runSpeed || 170;
        if (this.stateT < 3.5) return;
        this.setState('wander');
      }

      // Startle at a fast cursor swipe.
      const cur = eco.cursor;
      const cfgE = eco.cfg.ecosystem;
      if (cfgE.cursorInteraction && cur.inside && cur.speed > 1300 && U.dist(cur.x, cur.y, hip.x, hip.y) < 120) {
        if (this.grounded) {
          this.vy = -300;
          this.vx = Math.sign(hip.x - cur.x) * 150;
        }
        const g = this.fleeGoal(this.caps, cur.x, cur.y, 250);
        if (g) this.pather.setGoal(g.x, g.y, true);
        this.setState('flee');
        this.stateT = 2;
        return;
      }

      // Prey knocked down by a rock: go and pick it up.
      if (perceive && this.hunger > 0.3 && this.state !== 'forage') {
        let downed = this.nearestOf(['batfly', 'centipede'], 320, (c) => c.stunT > 0.4 && c.canBeGrabbed() && (c.size || 1) <= 1);
        if (!downed) {
          const c = this.nearestCorpse(['batfly', 'centipede'], 320);
          if (c && (c.size || 1) <= 1) downed = c;
        }
        if (downed) {
          this.food = downed;
          this.setState('forage');
        }
      }
      if (this.state === 'forage' && this.food instanceof RW.Creature) {
        const f = this.food;
        if (f.dead || f.leaving || f.grabbedBy || !(f.stunT > 0 || f.corpse) || this.stateT > 12) {
          this.food = null;
          this.setState('wander');
        } else {
          this.pather.interval = 0.5;
          this.pather.setGoal(f.x, f.y - 4);
          const fd = U.dist(hip.x, hip.y, f.x, f.y);
          if (fd < 30) this.reachTo = f.mainPoint();
          if (fd < 15 && this.grab(f)) {
            this.eatT = 0;
            this.food = null;
          }
          return;
        }
      }
      // Food: fruit on the ground, or a batfly flying past.
      if (perceive && (this.hunger > 0.35 || this.state === 'forage')) {
        const fruit = this.findFruit(this.hunger > 0.6 ? 700 : 300);
        if (fruit) {
          this.food = fruit;
          this.setState('forage');
        }
      }
      if (this.state === 'forage') {
        const f = this.food;
        // No route to it (fruit on a window top, across a gap we can't jump):
        // give up and ignore that fruit for a while instead of standing still.
        const unreachable = f && this.pather.nodes && !this.pather.complete && this.pather.remaining() === 0 && this.stateT > 1.5;
        if (unreachable || (f && this.stateT > 20)) {
          this.ignoreFood = f;
          this.ignoreFoodT = 30;
        }
        if (!f || f.dead || f.heldBy || (f.claimedBy && f.claimedBy !== this) || this.stateT > 20 || unreachable) {
          this.food = null;
          this.setState('wander');
        } else {
          f.claimedBy = this;
          this.pather.interval = 0.7;
          this.pather.setGoal(f.x, f.y - 4);
          const fd = U.dist(hip.x, hip.y, f.x, f.y);
          if (fd < 30) this.reachTo = f;
          if (fd < 14) {
            f.heldBy = this;
            this.item = f;
            this.eatT = 0;
          }
          return;
        }
      }
      if (this.hunger > 0.3) {
        const bf = this.nearestOf(['batfly'], 50, (c) => c.canBeGrabbed());
        if (bf) {
          this.reachTo = bf.mainPoint();
          if (this.grounded && bf.y < hip.y) {
            this.vy = -Math.sqrt(2 * GRAV * Math.max(10, Math.min(90, hip.y - bf.y + 10)));
            this.vx = U.clamp((bf.x - hip.x) * 3, -200, 200);
            this.grounded = false;
          }
          // snatch it out of the air with a hand
          const hp = this.handPt || this.head;
          if (U.dist(hp.x, hp.y, bf.x, bf.y) < 9 || U.dist(this.head.x, this.head.y, bf.x, bf.y) < 14) {
            if (this.grab(bf)) {
              this.eatT = 0;
              this.reachTo = null;
            }
          }
        }
      }

      // Armed and hungry: knock prey out of the air, or fruit off its vine.
      if (perceive && this.weapon && this.hunger > 0.35 && this.throwCd <= 0 && !this.item && Math.random() < 0.35) {
        const bf = this.nearestOf(['batfly', 'centipede'], 240, (c) => !c.grabbedBy && !(c.stunT > 0) && (c.size || 1) <= 1 && U.dist(c.x, c.y, hip.x, hip.y) > 40 && this.canSee(c.x, c.y, 240));
        if (bf) this.startThrow(bf);
        else if (this.weapon.kind === 'rock' && !this.findFruit(500)) {
          const pl = this.eco.plants.find((pp) => {
            if (pp.grow < 0.8) return false;
            const tp = pp.tip();
            return U.dist(tp.x, tp.y, hip.x, hip.y) < 260 && this.W.lineClear(hip.x, hip.y - 8, tp.x, tp.y + 5);
          });
          if (pl) this.startThrow(pl);
        }
      }

      // Pick up a rock or spear (spears preferred) when empty-handed.
      if (this.state === 'fetch') {
        const w = this.fetch;
        const unreachable = this.pather.nodes && !this.pather.complete && this.pather.remaining() === 0 && this.stateT > 1.5;
        if (!w || !w.pickable || this.weapon || this.stateT > 12 || unreachable || (w.claimedBy && w.claimedBy !== this)) {
          if (w && unreachable) {
            this.ignoreWeapon = w;
            this.ignoreWeaponT = 30;
          }
          this.fetch = null;
          this.setState('wander');
        } else {
          w.claimedBy = this;
          this.pather.interval = 0.7;
          this.pather.setGoal(w.x, w.y - 4);
          const wd = U.dist(hip.x, hip.y, w.x, w.y);
          if (wd < 30) this.reachTo = w;
          if (wd < 15) this.pickUpWeapon(w);
          return;
        }
      }
      this.ignoreWeaponT = (this.ignoreWeaponT || 0) - dt;
      if (!this.weapon && perceive && this.state === 'wander' && Math.random() < 0.4) {
        const w = this.findWeapon(300);
        if (w) {
          this.fetch = w;
          this.setState('fetch');
          return;
        }
      }

      // Curious about a resting cursor.
      if (cfgE.cursorInteraction && cur.inside && cur.still > 0.8 && U.dist(cur.x, cur.y, hip.x, hip.y) < 320) {
        this.setState('curious');
        const below = Nav.nearestValid(this.W, cur.x, cur.y + 20, this.caps, 6);
        if (below) {
          const gx = this.W.centerX(below.cx);
          const gy = this.W.centerY(below.cy);
          if (U.dist(gx, gy, hip.x, hip.y) > 40) this.pather.setGoal(gx, gy);
          else this.pather.clear();
        }
        this.lookAt = cur;
        return;
      }
      this.lookAt = null;
      if (this.state === 'curious') this.setState('wander');

      if (this.state === 'rest') {
        this.pather.clear();
        this.restT -= dt;
        this.sleeping = this.stateT > 3;
        if (this.restT <= 0) this.setState('wander');
        return;
      }
      if (this.state !== 'wander') this.setState('wander');
      const footing = this.grounded || !!this.pole;
      if (this.stuckT > 3 && footing) {
        // wedged: replan right away
        this.goalCd = 0;
        this.stateT = 99;
      }
      if (this.readyForGoal(dt, 16, footing)) {
        if (this.pather.goal && Math.random() < 0.3 && this.grounded) {
          this.setState('rest');
          this.restT = U.rand(3, 12);
          return;
        }
        const g = this.wanderGoal(this.caps, 550);
        if (g) this.pather.setGoal(g.x, g.y, true);
        this.stateT = 0;
        this.stuckT = 0;
      }
    }

    // Transit: the downpour sends everyone to the nearest den; otherwise a
    // slugcat leaves once it has eaten twice (or given up after a while),
    // heading for the den farthest from the one it arrived by.
    wantsToLeave(dt) {
      if (this.eco.shouldShelter()) return true;
      if (!this.origin) this.origin = this.eco.nearestDen(this.spawnX, this.spawnY) || { x: this.spawnX, y: this.spawnY };
      if (!this.exitDen && (this.meals >= 2 || this.age > 210) && !this.holding && !this.item && this.snackT <= 0) {
        const hip = this.hip;
        this.exitDen = this.eco.farthestDen(this.origin.x, this.origin.y, hip.x, hip.y, this.caps);
      }
      return !!this.exitDen;
    }
    ate() {
      this.meals++;
      if (this.meals < 2) this.hunger = Math.max(this.hunger, 0.6); // still peckish
    }
    findWeapon(range) {
      const hip = this.hip;
      let best = null;
      let bs = range;
      for (const it of this.eco.items) {
        if (!(it instanceof RW.Weapon) || !it.pickable) continue;
        if (it.claimedBy && it.claimedBy !== this) continue;
        if (it === this.ignoreWeapon && this.ignoreWeaponT > 0) continue;
        const d = U.dist(it.x, it.y, hip.x, hip.y) - (it.kind === 'spear' ? 120 : 0) - (it.skewer && this.hunger > 0.3 ? 150 : 0);
        if (d < bs) {
          bs = d;
          best = it;
        }
      }
      return best;
    }
    pickUpWeapon(w) {
      if (w.skewer) {
        this.snackT = 1.4;
        this.snackVal = w.skewer === 'centipede' ? 0.5 : 0.35;
        w.skewer = null;
      }
      w.pickUp(this);
      this.weapon = w;
      this.fetch = null;
      if (this.state === 'fetch') this.setState('wander');
    }
    // Where to aim: a lizard's head for a rock (it flips them), its body
    // for a spear (the head is armoured); a fruit's stalk; else the middle.
    aimPoint(t) {
      if (t.tip && !t.spine && !t.chain) {
        const tp = t.tip();
        return { x: tp.x, y: tp.y + 5 };
      }
      if (t.spine && t.species.startsWith('lizard_')) {
        const P = t.spine.pts;
        return this.weapon && this.weapon.kind === 'spear' ? P[3] : P[0];
      }
      return t.mainPoint();
    }
    startThrow(t) {
      if (!this.weapon || this.throwT > 0 || this.throwCd > 0 || !t) return false;
      const tp = this.aimPoint(t);
      this.throwAt = t;
      this.throwT = 0.16;
      this.facing = Math.sign(tp.x - this.hip.x) || this.facing;
      this.aimAng = Math.atan2(tp.y - this.hip.y, tp.x - this.hip.x);
      return true;
    }
    releaseThrow() {
      const w = this.weapon;
      const t = this.throwAt;
      this.throwAt = null;
      if (!w || !t || t.dead || t.leaving) return;
      const from = this.handPt2 || this.shoulder();
      w.x = from.x;
      w.y = from.y;
      w.thrower = this;
      this.weapon = null;
      this.throwCd = 1;
      if (t === this.grabbedBy) {
        // point blank into whatever has hold of us
        const parts = t.hitParts();
        let k = parts.findIndex((pp) => pp.part === (w.kind === 'spear' ? 'body' : 'head'));
        if (k < 0) k = 0;
        w.state = 'flying';
        w.vx = (parts[k].x - from.x) * 4;
        w.vy = (parts[k].y - from.y) * 4;
        w.strike(t, k, parts[k].part);
        return;
      }
      let tp = this.aimPoint(t);
      const speed = w.kind === 'spear' ? 560 : 470;
      let tt = U.dist(from.x, from.y, tp.x, tp.y) / speed;
      if (typeof t.vx === 'number' && typeof t.vy === 'number') {
        tp = { x: tp.x + t.vx * tt * 0.7, y: tp.y + t.vy * tt * 0.7 }; // lead a moving target
        tt = U.dist(from.x, from.y, tp.x, tp.y) / speed;
      }
      tt = Math.max(0.05, tt);
      const g = w.kind === 'spear' ? (tt < 0.45 ? 260 : 600) : 900;
      w.throwAt((tp.x - from.x) / tt, (tp.y - from.y) / tt - 0.5 * g * tt, this);
    }

    findFruit(range) {
      let best = null;
      let bd = range * range;
      for (const it of this.eco.items) {
        if (!(it instanceof RW.Fruit)) continue;
        if (it.dead || it.heldBy || (it.claimedBy && it.claimedBy !== this)) continue;
        if (it === this.ignoreFood && this.ignoreFoodT > 0) continue;
        const d = U.dist2(it.x, it.y, this.hip.x, this.hip.y);
        if (d < bd) {
          bd = d;
          best = it;
        }
      }
      return best;
    }

    // --------------------------------------------------------- physics ----
    findPole(x, y) {
      for (const p of this.W.poles) {
        if (Math.abs(p.x - x) < 11 && y > p.y1 - 4 && y < p.y2 && !this.W.isSolidPt(p.x, y)) return p;
      }
      return null;
    }

    launch(node) {
      const W = this.W;
      const hip = this.hip;
      const onPoleTarget = W.pole(node.cx, node.cy) && !W.solid(node.cx, node.cy + 1);
      const tx = node.x;
      const ty = onPoleTarget ? node.y : node.y + W.cell / 2 - R - 1;
      const apexY = Math.min(hip.y, ty) - W.cell * 1.3;
      const vy0 = -Math.sqrt(2 * GRAV * Math.max(4, hip.y - apexY));
      const tUp = -vy0 / GRAV;
      const tDown = Math.sqrt((2 * Math.max(1, ty - apexY)) / GRAV);
      this.vx = (tx - hip.x) / (tUp + tDown);
      this.vy = vy0;
      this.jumpTarget = { x: tx, y: ty };
      this.jumping = true;
      this.grounded = false;
      this.pole = null;
      this.facing = Math.sign(this.vx) || this.facing;
    }

    update(dt) {
      if (!this.tick(dt)) return;
      const W = this.W;
      const hip = this.hip;

      this.throwCd -= dt;
      if (this.throwT > 0) {
        this.throwT -= dt;
        if (this.throwT <= 0) this.releaseThrow();
      }
      if (this.grabbedBy) {
        // caught: a held rock or spear goes straight into the captor
        this.grabbedT += dt;
        if (this.weapon && this.grabbedT > 0.35 && this.throwT <= 0) this.startThrow(this.grabbedBy);
        const hp = this.grabbedBy.holdPoint();
        hip.x = hp.x;
        hip.y = hp.y;
        this.vx = this.vy = 0;
        this.updateHead(dt, true);
        this.updateTail(dt);
        this.lie = 0;
        this.updateHand();
        this.struggle(dt); // escaping triggers onReleased via the holder
        return;
      }

      this.grabbedT = 0;
      this.think(dt);
      // snatch up a weapon lying right underfoot
      if (!this.weapon && !this.item && !this.holding && this.state !== 'eat') {
        for (const it of this.eco.items) {
          const reach = this.state === 'flee' ? 20 : 12; // grab one on the run
          if (it instanceof RW.Weapon && it.pickable && (!it.claimedBy || it.claimedBy === this) && U.dist(it.x, it.y, hip.x, hip.y) < reach) {
            this.pickUpWeapon(it);
            break;
          }
        }
      }
      this.pather.update(dt, hip.x, hip.y);
      const cell = W.cell;
      this.pather.advance(hip.x, hip.y, cell * 0.65);
      const node = this.pather.current();
      const prev = this.pather.previous();
      const speed = this.speed || 105;

      if (this.pole) {
        const pole = this.pole;
        hip.x += (pole.x - hip.x) * 0.25;
        this.vx = 0;
        let tvy = 0;
        if (node) {
          const onSamePole = Math.abs(node.x - pole.x) < cell * 0.6 && W.pole(node.cx, node.cy);
          if (node.type === Nav.JUMP) {
            this.launch(node);
          } else if (onSamePole) {
            const dy = node.y - hip.y;
            tvy = Math.abs(dy) > 2 ? Math.sign(dy) * (this.p.climbSpeed || 80) : 0;
            this.climbPhase += Math.abs(this.vy) * dt * 0.25;
          } else {
            // Step or drop off the pole toward the next node.
            this.pole = null;
            this.vx = Math.sign(node.x - hip.x) * speed;
            this.vy = node.y < hip.y - 4 ? -260 : -60;
            this.facing = Math.sign(this.vx) || this.facing;
          }
        }
        if (this.pole) {
          this.vy += (tvy - this.vy) * U.approach(10, dt); // ease into and out of climbing
          hip.y = U.clamp(hip.y + this.vy * dt, pole.y1 + 2, pole.y2);
          // reached the ground at the foot of the pole (but not while
          // setting off upward from it: the climb eases in from a standstill)
          if (tvy >= 0 && W.isSolidPt(hip.x, hip.y + R)) {
            this.pole = null;
            this.grounded = true;
          }
        }
      } else {
        this.vy += GRAV * dt;
        if (this.grounded && this.crouchT > 0) {
          this.crouchT -= dt;
          this.vx *= 0.6;
          if (this.crouchT <= 0 && this.pendingJump) {
            this.launch(this.pendingJump);
            this.pendingJump = null;
          }
        }
        if (this.grounded) {
          let want = 0;
          if (node) {
            const launchHere = !prev || Math.abs(prev.x - hip.x) < 9;
            if (node.type === Nav.JUMP && launchHere) {
              // crouch for a moment, then spring
              if (!(this.crouchT > 0) && !this.jumping) {
                this.crouchT = 0.1;
                this.pendingJump = node;
              }
            } else {
              const tx = node.type === Nav.JUMP && prev ? prev.x : node.x;
              const dx = tx - hip.x;
              want = Math.abs(dx) > 3 ? Math.sign(dx) * speed * Math.min(1, Math.abs(dx) / 20 + 0.3) : 0;
              // Climbing onto a pole or a one-cell step.
              if (node.type === Nav.WALK && node.y < hip.y - cell * 0.6 && Math.abs(node.x - hip.x) < cell * 1.1) {
                const pole = this.findPole(node.x, node.y);
                if (pole && Math.abs(pole.x - hip.x) < 12) this.pole = pole;
                else if (!pole && !this.jumping) {
                  this.vy = -330;
                  this.grounded = false;
                }
              }
            }
          }
          if (!this.jumping && this.grounded) this.vx += (want - this.vx) * U.approach(12, dt);
          if (Math.abs(this.vx) > 5) this.facing = Math.sign(this.vx);
          this.walkPhase += Math.abs(this.vx) * dt * 0.22;
        } else if (!this.jumping && node) {
          const dx = node.x - hip.x;
          this.vx += (U.clamp(dx * 3, -speed, speed) - this.vx) * U.approach(2, dt);
        }
        // Catch a pole on the way past if the path wants one.
        if (!this.grounded && node && W.pole(node.cx, node.cy) && this.vy > -150) {
          const pole = this.findPole(hip.x, hip.y);
          if (pole && Math.abs(node.x - pole.x) < cell) {
            this.pole = pole;
            this.jumping = false;
          }
        }
        if (!this.pole) {
          hip.x += this.vx * dt;
          hip.y += this.vy * dt;
        }
      }

      const c = W.collideCircle(hip, R);
      const wasGrounded = this.grounded;
      this.grounded = false;
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx;
          this.vy -= vn * c.ny;
        }
        if (c.ny < -0.6) {
          this.grounded = true;
          this.contactId = c.id;
          if (this.jumping) {
            this.jumping = false;
            // landed well short of where we aimed: after two misses, give up
            const jt = this.jumpTarget;
            if (jt && U.dist(hip.x, hip.y, jt.x, jt.y) > W.cell * 1.5) {
              if (++this.jumpFails >= 2) {
                this.jumpFails = 0;
                this.pather.clear();
                this.stateT = 99;
              }
            } else {
              this.jumpFails = 0;
            }
          }
          if (!wasGrounded) this.pather.timer = Math.min(this.pather.timer, 0.1);
        }
      }
      if (this.pole) this.grounded = false;

      // Stuck detection
      if (U.dist(hip.x, hip.y, this.lastX, this.lastY) < 0.4 && this.pather.current()) this.stuckT += dt;
      else this.stuckT = Math.max(0, this.stuckT - dt);
      this.lastX = hip.x;
      this.lastY = hip.y;

      const lieT = this.state === 'rest' && this.grounded && this.stateT > 1 ? 1 : 0;
      this.lie += (lieT - this.lie) * U.approach(lieT > this.lie ? 2.5 : 9, dt);
      this.updateHead(dt, false);
      this.updateTail(dt);
      this.updateHand();
      this.blinkT -= dt;
      if (this.blinkT <= 0) {
        this.blink = 0.12;
        this.blinkT = U.rand(2, 6);
      }
      this.blink = Math.max(0, this.blink - dt);
      let lookTarget = this.vx / 120;
      if (this.lie > 0.4) lookTarget = this.facing; // lying in profile
      else if (this.reachTo) lookTarget = U.clamp((this.reachTo.x - this.head.x) / 30, -1, 1);
      else if (this.lookAt) lookTarget = U.clamp((this.lookAt.x - this.head.x) / 60, -1, 1);
      else if (this.state === 'flee' && this.threat) lookTarget = U.clamp((this.threat.x - this.head.x) / 60, -1, 1);
      this.look += (U.clamp(lookTarget, -1, 1) - this.look) * U.approach(6, dt);
    }

    updateHead(dt, held) {
      const hip = this.hip;
      const h = this.head;
      let tx;
      let ty;
      if (held) {
        tx = hip.x + Math.sin(this.age * 9) * 4;
        ty = hip.y + 9;
      } else if (this.crouchT > 0) {
        tx = hip.x + this.facing * 6;
        ty = hip.y - 10;
      } else if (this.state === 'eat' || this.state === 'rest') {
        tx = hip.x + this.facing * 7;
        ty = hip.y - 11;
      } else if (this.pole) {
        tx = hip.x;
        ty = hip.y - 18.5;
      } else if (!this.grounded) {
        const sp = Math.hypot(this.vx, this.vy) || 1;
        tx = hip.x + (this.vx / sp) * 10 + this.facing * 2;
        ty = hip.y - 16;
      } else {
        const lean = U.clamp(this.vx / 160, -1, 1);
        tx = hip.x + this.facing * 2 + lean * 6;
        ty = hip.y - 18 + Math.abs(lean) * 2.5 + Math.sin(this.walkPhase * 2) * Math.abs(lean) * 0.8;
      }
      if (this.state === 'eat') ty += Math.sin(this.age * 14) * 0.8;
      if (this.lie > 0) {
        // chin down on the floor in front of the body
        tx = U.lerp(tx, hip.x + this.facing * 16, this.lie);
        ty = U.lerp(ty, hip.y + 1.5, this.lie);
      }
      const k = U.approach(held ? 6 : 22, dt);
      h.x += (tx - h.x) * k;
      h.y += (ty - h.y) * k;
      const dx = h.x - hip.x;
      const dy = h.y - hip.y;
      const d = Math.hypot(dx, dy) || 1;
      // a long body: the head sits well clear of the hips
      const L = U.lerp(this.state === 'eat' || this.state === 'rest' ? 13 : 18, 16, this.lie);
      h.x = hip.x + (dx / d) * L;
      h.y = hip.y + (dy / d) * L;
      this.W.collideCircle(h, 5.5);
    }

    shoulder() {
      const hip = this.hip;
      const h = this.head;
      return { x: U.lerp(hip.x, h.x, 0.42), y: U.lerp(hip.y, h.y, 0.42) + this.lie * 1.5 };
    }
    // Where the near hand actually is (after IK), so held things sit in it.
    updateHand() {
      const sh = this.shoulder();
      const hands = this.limbTargets(sh).hands;
      const k = U.ik2(sh.x, sh.y, hands[0].x, hands[0].y, ARM, ARM, -this.facing);
      this.handPt = { x: k.ex, y: k.ey };
      const k2 = U.ik2(sh.x, sh.y, hands[1].x, hands[1].y, ARM, ARM, -this.facing);
      this.handPt2 = { x: k2.ex, y: k2.ey };
    }

    updateTail(dt) {
      const T = this.tail.pts;
      T[0].x = this.hip.x - this.facing * 1.5;
      T[0].y = this.hip.y + 2;
      T[0].px = T[0].x;
      T[0].py = T[0].y;
      this.tail.verlet(1, 0.86, -this.facing * 520, 420, dt); // tail streams out behind
      this.tail.follow(1);
      this.tail.collide(this.W, 1.5, 1);
    }

    // ------------------------------------------------------------ drawing ----
    draw(ctx) {
      const hip = this.hip;
      const h = this.head;
      const col = this.color;
      const f = this.facing;
      const dark = U.rgba(U.scale(col, 0.45)); // far limbs: clearly shaded so they separate
      const main = U.rgba(col);
      const lie = this.lie;
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const shoulder = this.shoulder();
      const limbs = this.limbTargets(shoulder);

      // Lying down squashes body, tail and limbs toward the floor (the head
      // keeps its shape and rests on the floor by itself).
      const floorY = hip.y + R;
      ctx.save();
      if (lie > 0.01) {
        ctx.translate(0, floorY);
        ctx.scale(1, 1 - 0.32 * lie);
        ctx.translate(0, -floorY);
      }

      // far limbs
      this.drawLimb(ctx, hip.x - f, hip.y + 2, limbs.feet[1], LEG, LEG, dark, 3, f);
      this.drawArm(ctx, shoulder, limbs.hands[1], dark, 2);

      // tail
      const T = this.tail.pts;
      ctx.fillStyle = main;
      U.taperPath(ctx, T, [5.4, 4.6, 3.6, 2.6, 1.2]);
      ctx.fill();

      // body: one soft sack as wide as the head where they meet (no neck),
      // easing a little toward the hips and on into the tail
      const mid = { x: U.lerp(hip.x, h.x, 0.5) - f * 0.5, y: U.lerp(hip.y, h.y, 0.5) };
      U.taperPath(ctx, [{ x: hip.x, y: hip.y - 1 }, mid, h], [5.8, 6.6, 7]);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hip.x, hip.y - 1.2, 5.6 + lie * 0.4, 0, U.TAU);
      ctx.fill();

      // near leg
      this.drawLimb(ctx, hip.x + f, hip.y + 2, limbs.feet[0], LEG, LEG, main, 3.2, f);
      ctx.restore();

      // near arm, drawn before the head so a hand never paints across the face
      // (reaching, climbing or flailing, the arm comes out in front instead)
      const armFront = !!this.reachTo || !!this.grabbedBy || !!this.pole || (!this.grounded && this.lie < 0.5);
      let hand = armFront ? null : this.drawArm(ctx, shoulder, limbs.hands[0], main, 2.2);

      // head
      this.drawHeadShape(ctx, h.x, h.y, this.look, main);
      if (armFront) hand = this.drawArm(ctx, shoulder, limbs.hands[0], main, 2.2);

      // held fruit sits in the near hand, just under the chin while eating
      if (this.item) {
        const ip = this.itemPoint();
        const left = this.state === 'eat' ? 1 - Math.min(1, this.eatT / 2.4) : 1;
        const sc = 0.4 + 0.6 * left; // shrinks as it's eaten
        ctx.save();
        ctx.translate(ip.x, ip.y - 1);
        ctx.scale(sc, sc);
        RW.drawFruit(ctx, 0, 0, 0, 1);
        ctx.restore();
        // fingers over the fruit
        ctx.fillStyle = main;
        ctx.fillRect(hand.x - 1, hand.y - 0.5, 2, 2);
      }

      // eyes: big black ovals, low and wide; in profile only the near one
      const lx = this.look;
      const ax = Math.abs(lx);
      const sep = 3.1 * (1 - 0.45 * ax);
      const ex = h.x + lx * 2.6;
      const ey = h.y + 0.9;
      ctx.fillStyle = '#0b0b10';
      const closed = this.blink > 0 || this.sleeping || (this.grabbedBy && Math.sin(this.age * 7) > 0);
      for (const s of [-1, 1]) {
        if (ax > 0.8 && s === -Math.sign(lx)) continue;
        if (this.corpse) {
          // dead: X'd-out eyes
          ctx.strokeStyle = '#0b0b10';
          ctx.lineWidth = 1;
          const cx = ex + s * sep;
          ctx.beginPath();
          ctx.moveTo(cx - 1.6, ey - 1.6);
          ctx.lineTo(cx + 1.6, ey + 1.6);
          ctx.moveTo(cx + 1.6, ey - 1.6);
          ctx.lineTo(cx - 1.6, ey + 1.6);
          ctx.stroke();
          continue;
        }
        ctx.beginPath();
        if (closed) ctx.ellipse(ex + s * sep, ey + 0.9, 1.7, 0.5, 0, 0, U.TAU);
        else ctx.ellipse(ex + s * sep, ey, 1.45, 2.6, 0, 0, U.TAU);
        ctx.fill();
      }
      ctx.restore();
      this.drawPath(ctx, this.pather);
      this.drawDebug(ctx);
    }

    // The slugcat head: wider than tall, flat-topped with two pointed ears at
    // the corners and full cheeks tapering to a soft chin. Turning (look) slides
    // the ears back and the face forward until it reads as a profile.
    drawHeadShape(ctx, x, y, l, fill) {
      const a = Math.abs(l);
      const w = 7.4 * (1 - 0.12 * a); // half width across the cheeks
      const sx = -l * 0.8; // skull shifts back as the face turns
      const eb = l * 2.2; // ears sweep back
      const front = l * 1.4; // and the muzzle side bulges forward
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x + sx - l * 0.4, y - 5.6);
      ctx.lineTo(x + sx + w * 0.5, y - 5.4);
      ctx.lineTo(x + sx + w * 0.88 - eb + 0.6 * (1 - a), y - 8.4); // right ear tip
      ctx.lineTo(x + sx + w + Math.max(0, front) * 0.4, y - 3.6);
      ctx.quadraticCurveTo(x + sx + w + 0.8 + Math.max(0, front), y + 3.8, x + sx + w * 0.42 + Math.max(0, front) * 0.6, y + 5.7);
      ctx.lineTo(x + sx - w * 0.42 + Math.min(0, front) * 0.6, y + 5.7);
      ctx.quadraticCurveTo(x + sx - w - 0.8 + Math.min(0, front), y + 3.8, x + sx - w + Math.min(0, front) * 0.4, y - 3.6);
      ctx.lineTo(x + sx - w * 0.88 - eb - 0.6 * (1 - a), y - 8.4); // left ear tip
      ctx.lineTo(x + sx - w * 0.5, y - 5.4);
      ctx.closePath();
      ctx.fill();
    }

    limbTargets(shoulder) {
      const hip = this.hip;
      const f = this.facing;
      const feet = [];
      const hands = [];
      const gy = hip.y + R + 0.5;
      if (this.grabbedBy) {
        const w = Math.sin(this.age * 12) * 4;
        feet.push({ x: hip.x + 3 + w, y: hip.y + 10 }, { x: hip.x - 3 - w, y: hip.y + 10 });
        hands.push({ x: shoulder.x + 7, y: shoulder.y - 4 - w }, { x: shoulder.x - 7, y: shoulder.y - 4 + w });
      } else if (this.pole) {
        // hugging the pole, hand over hand
        const px = this.pole.x;
        const c = this.climbPhase;
        feet.push({ x: px + 1, y: hip.y + 8 + Math.sin(c) * 2 }, { x: px - 1, y: hip.y + 8 - Math.sin(c) * 2 });
        hands.push({ x: px + f, y: this.head.y - 3 + Math.sin(c) * 3 }, { x: px - f, y: this.head.y - 3 - Math.sin(c) * 3 });
      } else if (this.lie > 0.5) {
        // lying flat: hind legs out behind, forepaws tucked under the chin
        feet.push({ x: hip.x - f * 4, y: gy }, { x: hip.x - f * 7, y: gy });
        hands.push({ x: this.head.x - f * 0.5, y: gy - 0.5 }, { x: this.head.x - f * 3, y: gy - 0.5 });
      } else if (!this.grounded) {
        feet.push({ x: hip.x - f * 3, y: hip.y + 7 }, { x: hip.x + f * 3, y: hip.y + 6 });
        // arms flung up and out mid-jump
        hands.push({ x: shoulder.x + f * 8, y: shoulder.y - 4 }, { x: shoulder.x - f * 5, y: shoulder.y - 2 });
      } else {
        const moving = U.clamp(Math.abs(this.vx) / 60, 0, 1);
        const ph = this.walkPhase;
        for (const k of [0, Math.PI]) {
          feet.push({
            x: hip.x + Math.sin(ph + k) * 5 * moving + f * 1 + (k ? -2 : 2) * (1 - moving),
            y: gy - Math.max(0, Math.cos(ph + k)) * 3 * moving,
          });
        }
        if (this.state === 'eat') {
          // both hands bring the food up to the mouth
          const mx = this.head.x + f * 5;
          const my = this.head.y + 7 + Math.sin(this.age * 14) * 0.6;
          hands.push({ x: mx, y: my }, { x: mx - f * 2, y: my + 1 });
        } else {
          // arms swing opposite the legs, held a little out from the body
          for (const k of [Math.PI, 0]) {
            hands.push({
              x: shoulder.x + Math.sin(ph + k) * 4.5 * moving + f * (k ? 8.5 : -6),
              y: shoulder.y + 7.5 - Math.max(0, -Math.cos(ph + k)) * 2 * moving,
            });
          }
        }
      }
      // the far hand carries the weapon: held ready, drawn back over the
      // shoulder in the windup, flung forward in the follow-through
      if (!this.grabbedBy && !this.pole && this.lie < 0.5 && this.state !== 'eat') {
        if (this.throwT > 0) hands[1] = { x: shoulder.x - f * 5, y: shoulder.y - 8 };
        else if (this.throwCd > 0.8) hands[1] = { x: shoulder.x + f * 9, y: shoulder.y - 1 };
        else if (this.weapon) hands[1] = { x: shoulder.x + f * 4, y: shoulder.y + 5 };
      } else if (this.grabbedBy && this.throwT > 0) {
        hands[1] = { x: shoulder.x - f * 5, y: shoulder.y - 8 };
      }
      // reaching for fruit or a batfly overrides the near hand
      if (this.reachTo && !this.grabbedBy && !this.pole) {
        hands[0] = { x: this.reachTo.x, y: this.reachTo.y };
        hands[1] = { x: U.lerp(hands[1].x, this.reachTo.x, 0.4), y: U.lerp(hands[1].y, this.reachTo.y, 0.4) };
      }
      return { feet, hands };
    }

    // Thin two-bone arm ending in a small round hand.
    drawArm(ctx, sh, t, col, w) {
      const k = U.ik2(sh.x, sh.y, t.x, t.y, ARM, ARM, -this.facing);
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(k.kx, k.ky);
      ctx.lineTo(k.ex, k.ey);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(k.ex, k.ey, 1.7, 0, U.TAU);
      ctx.fill();
      return { x: k.ex, y: k.ey };
    }

    drawLimb(ctx, ax, ay, t, l1, l2, col, w, bend) {
      const k = U.ik2(ax, ay, t.x, t.y, l1, l2, bend);
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(k.kx, k.ky);
      ctx.lineTo(k.ex, k.ey);
      ctx.stroke();
    }
  }

  RW.Creatures.Slugcat = Slugcat;
})();
