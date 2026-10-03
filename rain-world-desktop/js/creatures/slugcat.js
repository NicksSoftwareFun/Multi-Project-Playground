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
      this.tail = new RW.Chain(x, y, 5, [4.5, 4.2, 3.8, 3.4, 3], -1, 0.3);
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
      this.hunger = U.rand(0.2, 0.7);
      this.item = null;
      this.eatT = 0;
      this.restT = 0;
      this.sleeping = false;
      this.perceiveT = 0;
      this.threat = null;
      this.stuckT = 0;
      this.lastX = x;
      this.lastY = y;
      this.diet = ['batfly'];
      this.threats = ['lizard_pink', 'lizard_green', 'lizard_blue', 'lizard_white', 'daddy', 'dropwig'];
      this.bloodColor = '#3a1f22';
    }

    mainPoint() {
      return this.hip;
    }
    itemPoint() {
      return { x: this.head.x + this.facing * 4, y: this.head.y + 4 };
    }
    carry(dx, dy) {
      this.hip.x += dx;
      this.hip.y += dy;
      this.head.x += dx;
      this.head.y += dy;
      this.tail.shift(dx, dy);
    }
    onGrabbed() {
      this.pole = null;
      this.jumping = false;
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
      this.speed = p.speed || 105;
      this.sleeping = false;

      if (this.item) {
        this.setState('eat');
        this.pather.clear();
        this.eatT += dt;
        if (this.eatT > 2.4) {
          this.item.dead = true;
          this.item = null;
          this.hunger = Math.max(0, this.hunger - 0.6);
          this.eatT = 0;
          this.setState('rest');
          this.restT = U.rand(1, 3);
        }
        return;
      }

      if (this.wantsToLeave(dt)) {
        this.setState('leave');
        const den = eco.nearestDen(hip.x, hip.y);
        if (den) {
          this.pather.setGoal(den.x, den.y);
          if (U.dist(hip.x, hip.y, den.x, den.y) < 22) this.leave();
        }
        this.speed = p.runSpeed || 170;
        return;
      }

      if (perceive) {
        const t = this.threatNear(p.vision || 260);
        if (t) {
          this.threat = t;
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
        if (!f || f.dead || f.heldBy || (f.claimedBy && f.claimedBy !== this) || this.stateT > 20) {
          this.food = null;
          this.setState('wander');
        } else {
          f.claimedBy = this;
          this.pather.interval = 0.7;
          this.pather.setGoal(f.x, f.y - 4);
          if (U.dist(hip.x, hip.y, f.x, f.y) < 14) {
            f.heldBy = this;
            this.item = f;
            this.eatT = 0;
          }
          return;
        }
      }
      if (this.hunger > 0.3) {
        const bf = this.nearestOf(['batfly'], 50, (c) => !c.grabbedBy);
        if (bf) {
          if (this.grounded && bf.y < hip.y) {
            this.vy = -Math.sqrt(2 * GRAV * Math.max(10, Math.min(90, hip.y - bf.y + 10)));
            this.vx = U.clamp((bf.x - hip.x) * 3, -200, 200);
            this.grounded = false;
          }
          if (U.dist(this.head.x, this.head.y, bf.x, bf.y) < 14) {
            eco.consume(bf, this);
            this.hunger = Math.max(0, this.hunger - 0.35);
          }
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
      if (this.pather.done() || !this.pather.goal || this.stateT > 16 || this.stuckT > 3) {
        if (this.pather.goal && Math.random() < 0.3 && this.grounded) {
          this.setState('rest');
          this.restT = U.rand(2, 8);
          return;
        }
        const g = this.wanderGoal(this.caps, 550);
        if (g) this.pather.setGoal(g.x, g.y, true);
        this.stateT = 0;
        this.stuckT = 0;
      }
    }

    findFruit(range) {
      let best = null;
      let bd = range * range;
      for (const it of this.eco.items) {
        if (it.dead || it.heldBy || (it.claimedBy && it.claimedBy !== this)) continue;
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
      this.jumping = true;
      this.grounded = false;
      this.pole = null;
      this.facing = Math.sign(this.vx) || this.facing;
    }

    update(dt) {
      if (!this.tick(dt)) return;
      const W = this.W;
      const hip = this.hip;

      if (this.grabbedBy) {
        const hp = this.grabbedBy.holdPoint();
        hip.x = hp.x;
        hip.y = hp.y;
        this.vx = this.vy = 0;
        this.updateHead(dt, true);
        this.updateTail(dt);
        if (this.struggle(dt)) this.onReleased();
        return;
      }

      this.think(dt);
      this.pather.update(dt, hip.x, hip.y);
      const cell = W.cell;
      this.pather.advance(hip.x, hip.y, cell * 0.65);
      const node = this.pather.current();
      const prev = this.pather.previous();
      const speed = this.speed || 105;

      if (this.pole) {
        const pole = this.pole;
        hip.x += (pole.x - hip.x) * 0.4;
        this.vx = 0;
        this.vy = 0;
        if (node) {
          const onSamePole = Math.abs(node.x - pole.x) < cell * 0.6 && W.pole(node.cx, node.cy);
          if (node.type === Nav.JUMP) {
            this.launch(node);
          } else if (onSamePole) {
            const dy = node.y - hip.y;
            this.vy = Math.abs(dy) > 2 ? Math.sign(dy) * (this.p.climbSpeed || 80) : 0;
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
          hip.y = U.clamp(hip.y + this.vy * dt, pole.y1 + 2, pole.y2);
          if (W.isSolidPt(hip.x, hip.y + R)) {
            this.pole = null;
            this.grounded = true;
          }
        }
      } else {
        this.vy += GRAV * dt;
        if (this.grounded) {
          let want = 0;
          if (node) {
            const launchHere = !prev || Math.abs(prev.x - hip.x) < 9;
            if (node.type === Nav.JUMP && launchHere) {
              this.launch(node);
            } else {
              const tx = node.type === Nav.JUMP && prev ? prev.x : node.x;
              const dx = tx - hip.x;
              want = Math.abs(dx) > 3 ? Math.sign(dx) * speed * Math.min(1, Math.abs(dx) / 20 + 0.3) : 0;
              // Climbing onto a pole or a one-cell step.
              if (node.type === Nav.WALK && node.y < hip.y - cell * 0.6 && Math.abs(node.x - hip.x) < cell * 1.1) {
                const pole = this.findPole(node.x, node.y);
                if (pole && Math.abs(pole.x - hip.x) < 12) this.pole = pole;
                else if (!this.jumping) {
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
          if (this.jumping) this.jumping = false;
          if (!wasGrounded) this.pather.timer = Math.min(this.pather.timer, 0.1);
        }
      }
      if (this.pole) this.grounded = false;

      // Stuck detection
      if (U.dist(hip.x, hip.y, this.lastX, this.lastY) < 0.4 && this.pather.current()) this.stuckT += dt;
      else this.stuckT = Math.max(0, this.stuckT - dt);
      this.lastX = hip.x;
      this.lastY = hip.y;

      this.updateHead(dt, false);
      this.updateTail(dt);
      this.blinkT -= dt;
      if (this.blinkT <= 0) {
        this.blink = 0.12;
        this.blinkT = U.rand(2, 6);
      }
      this.blink = Math.max(0, this.blink - dt);
      let lookTarget = this.vx / 120;
      if (this.lookAt) lookTarget = U.clamp((this.lookAt.x - this.head.x) / 60, -1, 1);
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
      } else if (this.state === 'eat' || this.state === 'rest') {
        tx = hip.x + this.facing * 5;
        ty = hip.y - 7;
      } else if (this.pole) {
        tx = hip.x;
        ty = hip.y - 11.5;
      } else if (!this.grounded) {
        const sp = Math.hypot(this.vx, this.vy) || 1;
        tx = hip.x + (this.vx / sp) * 6 + this.facing * 2;
        ty = hip.y - 10;
      } else {
        const lean = U.clamp(this.vx / 160, -1, 1);
        tx = hip.x + this.facing * 2 + lean * 5;
        ty = hip.y - 11 + Math.abs(lean) * 1.5 + Math.sin(this.walkPhase * 2) * Math.abs(lean) * 0.8;
      }
      if (this.state === 'eat') ty += Math.sin(this.age * 14) * 0.8;
      const k = U.approach(held ? 6 : 22, dt);
      h.x += (tx - h.x) * k;
      h.y += (ty - h.y) * k;
      const dx = h.x - hip.x;
      const dy = h.y - hip.y;
      const d = Math.hypot(dx, dy) || 1;
      const L = this.state === 'eat' || this.state === 'rest' ? 8.5 : 11;
      h.x = hip.x + (dx / d) * L;
      h.y = hip.y + (dy / d) * L;
      this.W.collideCircle(h, 5.5);
    }

    updateTail(dt) {
      const T = this.tail.pts;
      T[0].x = this.hip.x - this.facing * 1.5;
      T[0].y = this.hip.y + 2;
      T[0].px = T[0].x;
      T[0].py = T[0].y;
      this.tail.verlet(1, 0.86, -this.facing * 120, 700, dt);
      this.tail.follow(1);
      this.tail.collide(this.W, 1.5, 1);
    }

    // ------------------------------------------------------------ drawing ----
    draw(ctx) {
      const hip = this.hip;
      const h = this.head;
      const col = this.color;
      const dark = U.rgba(U.scale(col, 0.72));
      const main = U.rgba(col);
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const shoulder = { x: U.lerp(hip.x, h.x, 0.62), y: U.lerp(hip.y, h.y, 0.62) };
      const limbs = this.limbTargets(shoulder);

      // far limbs
      this.drawLimb(ctx, hip.x - this.facing, hip.y + 2, limbs.feet[1], 5.2, 5, dark, 2.4, this.facing);
      this.drawLimb(ctx, shoulder.x, shoulder.y, limbs.hands[1], 4.2, 4, dark, 1.9, -this.facing);

      // tail
      const T = this.tail.pts;
      ctx.fillStyle = main;
      U.taperPath(ctx, T, [4.2, 3.4, 2.6, 1.7, 0.6]);
      ctx.fill();

      // body
      const mid = { x: U.lerp(hip.x, h.x, 0.5) - this.facing * 0.5, y: U.lerp(hip.y, h.y, 0.5) };
      U.taperPath(ctx, [{ x: hip.x, y: hip.y + 1 }, mid, h], [6.6, 6, 5.2]);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hip.x, hip.y + 0.5, 6.4, 0, U.TAU);
      ctx.fill();

      // near limbs
      this.drawLimb(ctx, hip.x + this.facing, hip.y + 2, limbs.feet[0], 5.2, 5, main, 2.6, this.facing);

      // head
      ctx.fillStyle = main;
      ctx.beginPath();
      ctx.arc(h.x, h.y, 6.9, 0, U.TAU);
      ctx.fill();
      this.drawLimb(ctx, shoulder.x, shoulder.y, limbs.hands[0], 4.2, 4, main, 2.1, -this.facing);

      if (this.item) {
        const ip = this.itemPoint();
        RW.drawFruit(ctx, ip.x, ip.y, 0, 1);
        if (this.state === 'eat') {
          // shrink as it's eaten
          ctx.fillStyle = main;
          ctx.beginPath();
          ctx.arc(ip.x, ip.y + 4 - 6 * Math.min(1, this.eatT / 2.4), 4, 0, U.TAU);
          ctx.fill();
        }
      }

      // eyes
      const lx = this.look;
      const sep = 2.7 * (1 - 0.35 * Math.abs(lx));
      const ex = h.x + lx * 2.3;
      const ey = h.y + 0.6;
      ctx.fillStyle = '#0b0b10';
      const closed = this.blink > 0 || this.sleeping || (this.grabbedBy && Math.sin(this.age * 7) > 0);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        if (closed) ctx.ellipse(ex + s * sep, ey + 0.8, 1.6, 0.45, 0, 0, U.TAU);
        else ctx.ellipse(ex + s * sep, ey, 1.35, 2.4, 0, 0, U.TAU);
        ctx.fill();
      }
      ctx.restore();
      this.drawPath(ctx, this.pather);
      this.drawDebug(ctx);
    }

    limbTargets(shoulder) {
      const hip = this.hip;
      const f = this.facing;
      const feet = [];
      const hands = [];
      if (this.grabbedBy) {
        const w = Math.sin(this.age * 12) * 4;
        feet.push({ x: hip.x + 3 + w, y: hip.y + 10 }, { x: hip.x - 3 - w, y: hip.y + 10 });
        hands.push({ x: shoulder.x + 6, y: shoulder.y - 4 - w }, { x: shoulder.x - 6, y: shoulder.y - 4 + w });
      } else if (this.pole) {
        const px = this.pole.x;
        const c = this.climbPhase;
        feet.push({ x: px + 1, y: hip.y + 8 + Math.sin(c) * 2 }, { x: px - 1, y: hip.y + 8 - Math.sin(c) * 2 });
        hands.push({ x: px, y: this.head.y - 3 + Math.sin(c) * 3 }, { x: px, y: this.head.y - 3 - Math.sin(c) * 3 });
      } else if (!this.grounded) {
        feet.push({ x: hip.x - f * 3, y: hip.y + 7 }, { x: hip.x + f * 3, y: hip.y + 6 });
        hands.push({ x: shoulder.x + f * 6, y: shoulder.y - 3 }, { x: shoulder.x - f * 2, y: shoulder.y + 4 });
      } else {
        const moving = U.clamp(Math.abs(this.vx) / 60, 0, 1);
        const ph = this.walkPhase;
        const gy = hip.y + R + 0.5;
        for (const k of [0, Math.PI]) {
          feet.push({
            x: hip.x + Math.sin(ph + k) * 5 * moving + f * 1,
            y: gy - Math.max(0, Math.cos(ph + k)) * 3 * moving,
          });
        }
        if (this.state === 'eat' || this.item) {
          const ip = this.itemPoint();
          hands.push({ x: ip.x - 1, y: ip.y + 2 }, { x: ip.x + 1, y: ip.y + 2 });
        } else {
          for (const k of [Math.PI, 0]) {
            hands.push({ x: shoulder.x + Math.sin(ph + k) * 3 * moving + f * 1.5, y: shoulder.y + 6.5 });
          }
        }
      }
      return { feet, hands };
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
