// Food: dangle fruit grows on vines under ledges and ripens. It only drops
// when something hits it (a thrown rock or spear, or a creature barging
// through), then gets carried off and eaten by slugcats, or rots away.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  const FRUIT_LIFE = 60; // seconds a dropped fruit lasts unclaimed
  const SHRIVEL = 4; // ...the last few of them spent shrinking away

  class Fruit {
    constructor(eco, x, y) {
      this.eco = eco;
      this.x = x;
      this.y = y;
      this.vx = 0;
      this.vy = 0;
      this.r = 4.5;
      this.dead = false;
      this.heldBy = null;
      this.contactId = null;
      this.grounded = false;
      this.rot = U.rand(-0.4, 0.4);
      this.age = 0;
      this.claimedBy = null;
    }
    carry(dx, dy) {
      this.x += dx;
      this.y += dy;
    }
    update(dt) {
      this.age += dt;
      if (this.heldBy) {
        if (this.heldBy.dead) this.heldBy = null;
        else {
          const h = this.heldBy.itemPoint();
          this.x = h.x;
          this.y = h.y;
          return;
        }
      }
      this.vy += 900 * dt;
      this.vx *= this.grounded ? 0.8 : 0.995;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      const c = this.eco.world.collideCircle(this, this.r);
      this.grounded = false;
      if (c) {
        const vn = this.vx * c.nx + this.vy * c.ny;
        if (vn < 0) {
          this.vx -= vn * c.nx * 1.35;
          this.vy -= vn * c.ny * 1.35;
        }
        if (c.ny < -0.6) {
          this.grounded = true;
          this.contactId = c.id;
          this.rot += this.vx * dt * 0.2;
        }
      }
      // Drop a claim whose slugcat gave up, fled, left or was eaten.
      const cl = this.claimedBy;
      if (cl && (cl.dead || cl.leaving || (cl.item !== this && (cl.food !== this || cl.state !== 'forage')))) this.claimedBy = null;
      // rots away if nobody comes for it (a claim holds it a while longer)
      if (this.age > FRUIT_LIFE * (this.claimedBy ? 2 : 1)) this.dead = true;
    }
    draw(ctx) {
      const left = FRUIT_LIFE * (this.claimedBy ? 2 : 1) - this.age;
      if (left < SHRIVEL && !this.heldBy) {
        const k = Math.max(0.2, left / SHRIVEL);
        ctx.save();
        ctx.translate(this.x, this.y + 5 * (1 - k)); // shrivels down onto the floor
        ctx.scale(k, k);
        drawFruit(ctx, 0, 0, this.rot, 1);
        ctx.restore();
      } else {
        drawFruit(ctx, this.x, this.y, this.rot, 1);
      }
    }
  }

  function drawFruit(ctx, x, y, rot, a) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.globalAlpha *= a;
    ctx.fillStyle = '#1f3fd1';
    ctx.beginPath();
    ctx.ellipse(0, 0.5, 4.2, 5.2, 0, 0, U.TAU);
    ctx.fill();
    ctx.fillStyle = '#5b86ff';
    ctx.beginPath();
    ctx.ellipse(-1.2, -1, 1.8, 2.4, -0.3, 0, U.TAU);
    ctx.fill();
    ctx.fillStyle = '#0d1a4d';
    ctx.fillRect(-0.6, -5.5, 1.2, 2);
    ctx.restore();
  }

  // A vine hanging from a ceiling that grows a fruit and holds it once ripe
  // until something knocks it off, then regrows.
  class FruitPlant {
    constructor(eco, x, y, len) {
      this.eco = eco;
      this.x = x;
      this.y = y;
      this.len = len;
      this.grow = U.rand(0.3, 1);
      this.phase = U.rand(0, 10);
      this.regrowRate = 1 / U.rand(35, 80);
    }
    tip() {
      const sway = Math.sin(this.eco.t * 0.9 + this.phase) * 4;
      return { x: this.x + sway, y: this.y + this.len };
    }
    ripe() {
      return this.grow >= 1;
    }
    // Hit by a thrown rock or spear, or a creature: a ripe fruit drops.
    knockOff(vx, vy) {
      if (!this.ripe()) return;
      const t = this.tip();
      const f = new Fruit(this.eco, t.x, t.y + 5);
      f.vx = (vx || 0) * 0.3;
      f.vy = 40 + Math.max(0, (vy || 0) * 0.3);
      this.eco.items.push(f);
      this.grow = 0;
    }
    update(dt) {
      if (this.eco.world.isSolidPt(this.x, this.y + 4)) return; // covered by a window
      this.grow = Math.min(1, this.grow + dt * this.regrowRate);
      if (!this.ripe()) return;
      // a creature barging into the ripe fruit knocks it loose
      const t = this.tip();
      const fy = t.y + 5;
      for (const c of this.eco.creatures) {
        if (c.dead || c.burrow || !c.hitParts) continue;
        const sp = Math.hypot(c.vx || 0, c.vy || 0);
        if (sp < 120 || Math.abs(c.x - t.x) > 80 || Math.abs(c.y - fy) > 80) continue;
        for (const pt of c.hitParts()) {
          if (U.dist(pt.x, pt.y, t.x, fy) < pt.r + 5) {
            this.knockOff(c.vx, c.vy);
            return;
          }
        }
      }
    }
    draw(ctx) {
      const pal = this.eco.palette;
      if (!pal) return;
      const t = this.tip();
      ctx.strokeStyle = U.rgba(U.mix(pal.near, '#55703f', 0.3));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.quadraticCurveTo(this.x, this.y + this.len * 0.6, t.x, t.y);
      ctx.stroke();
      // small leaves
      ctx.fillStyle = U.rgba(U.mix(pal.near, '#55703f', 0.35));
      for (let k = 1; k <= 3; k++) {
        const ly = this.y + (this.len * k) / 4;
        ctx.beginPath();
        ctx.ellipse(this.x + (k % 2 ? 3 : -3), ly, 3, 1.3, k % 2 ? 0.5 : -0.5, 0, U.TAU);
        ctx.fill();
      }
      const g = Math.min(1, this.grow);
      if (g > 0.15) {
        ctx.save();
        ctx.translate(t.x, t.y + 5 * g);
        ctx.scale(g, g);
        drawFruit(ctx, 0, 0, 0, 1);
        ctx.restore();
      }
    }
  }

  RW.Fruit = Fruit;
  RW.FruitPlant = FruitPlant;
  RW.drawFruit = drawFruit;
})();
