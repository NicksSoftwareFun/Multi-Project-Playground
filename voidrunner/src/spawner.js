// The director.
//
// Content is generated around a "flow line" - a point in the corridor
// cross-section that wanders no faster than the ship can chase it. Every
// hazard is built so the flow line passes safely through, and collectables are
// strung along it. The result reads as hand-authored: there is always a line,
// and the line is always makeable, but you have to find it in time.

import * as THREE from '../vendor/three.module.js';
import { TUBE_R, GAP_START, GAP_MIN, GAP_RAMP, SPAWN_AHEAD, LATERAL_MAX } from './config.js';
import { KINDS, HazardPool } from './hazards.js';
import { centreX, centreY, frameBasis } from './path.js';
import { CELL, SHIELD, CHARGE } from './pickups.js';
import { TAU, clamp, lerp, makeRng } from './util.js';
import { tierDensity } from './zones.js';

const _m = new THREE.Matrix4();

export class Spawner {
  constructor(scene, materials, pickups) {
    this.pool = new HazardPool(scene, materials);
    this.M = materials;
    this.pickups = pickups;
    this.hazards = [];
  }

  reset(seed) {
    for (const h of this.hazards) this.pool.release(h);
    this.hazards.length = 0;
    this.rng = makeRng(seed);
    this.spawnZ = 165;          // relative z of the next hazard
    this.originZ = 0;
    this.flowX = 0; this.flowY = 0;
    this.prevFlowX = 0; this.prevFlowY = 0;
    this.prevZ = 0;
    this.seqLeft = 0;
    this.seqKind = null;
    this.seqStep = 0;
    this.sinceShield = 0;
    this.sinceCharge = 0;
    this.spawned = 0;
  }

  rebase(delta) {
    this.spawnZ -= delta;
    this.prevZ -= delta;
    for (const h of this.hazards) {
      h.z -= delta;
      h.root.position.z -= delta;
    }
  }

  gapFor(distance, zone, tier) {
    const ramp = 1 - Math.exp(-distance / GAP_RAMP);
    const base = lerp(GAP_START, GAP_MIN, ramp);
    return Math.max(21, base * zone.densityMul * tierDensity(tier));
  }

  /** Advance generation so content always exists SPAWN_AHEAD metres out. */
  generate(shipZ, originZ, distance, speed, time, info) {
    this.originZ = originZ;
    const zone = info.zone;
    const target = shipZ + SPAWN_AHEAD;
    let guard = 0;

    while (this.spawnZ < target && guard++ < 24) {
      const dist = distance + (this.spawnZ - shipZ);
      const gap = this.gapFor(dist, zone, info.tier);
      const intensity = clamp((1 - Math.exp(-dist / GAP_RAMP)) + info.tier * 0.12, 0, 1);
      const rng = this.rng;

      // --- move the flow line, bounded by what the ship can physically do ---
      const travelT = gap / Math.max(speed, 30);
      const maxMove = LATERAL_MAX * 0.55 * travelT;
      let tx, ty;
      if (this.seqLeft > 0) {
        const a = Math.atan2(this.flowY, this.flowX) + this.seqStep;
        const r = clamp(Math.hypot(this.flowX, this.flowY), 2.0, TUBE_R - 2.0);
        tx = Math.cos(a) * r; ty = Math.sin(a) * r;
      } else if (rng.chance(0.22)) {
        tx = this.flowX; ty = this.flowY;                 // hold - gives the run a rhythm
      } else {
        const a = rng() * TAU;
        const r = rng.range(1.4, TUBE_R - 2.0);
        tx = Math.cos(a) * r; ty = Math.sin(a) * r;
      }
      let dx = tx - this.flowX, dy = ty - this.flowY;
      const dl = Math.hypot(dx, dy);
      if (dl > maxMove) { dx = (dx / dl) * maxMove; dy = (dy / dl) * maxMove; }
      this.prevFlowX = this.flowX; this.prevFlowY = this.flowY;
      this.flowX = clamp(this.flowX + dx, -(TUBE_R - 1.3), TUBE_R - 1.3);
      this.flowY = clamp(this.flowY + dy, -(TUBE_R - 1.3), TUBE_R - 1.3);
      const fr = Math.hypot(this.flowX, this.flowY);
      if (fr > TUBE_R - 1.3) {
        this.flowX *= (TUBE_R - 1.3) / fr;
        this.flowY *= (TUBE_R - 1.3) / fr;
      }

      // --- choose a hazard kind the current line can actually survive ---
      const flowR = Math.hypot(this.flowX, this.flowY);
      const usable = zone.hazards.filter((e) => (KINDS[e.k].minR || 0) <= flowR);
      const table = usable.length ? usable : zone.hazards.filter((e) => !KINDS[e.k].minR);
      let kind;
      if (this.seqLeft > 0 && (KINDS[this.seqKind].minR || 0) <= flowR) {
        kind = this.seqKind;
        this.seqLeft--;
      } else {
        this.seqLeft = 0;
        kind = (table.length ? rng.weighted(table) : { k: 'gate' }).k;
        if (this.spawned > 2 && rng.chance(0.20)) {
          this.seqKind = kind;
          this.seqLeft = rng.int(1, 3);
          this.seqStep = rng.sign() * rng.range(0.45, 0.95);
        }
      }

      this.place(kind, this.spawnZ, dist, speed, time, shipZ, intensity, rng);
      this.spawned++;

      // --- collectables in the run-up to the next hazard ---
      this.dropPickups(this.prevZ, this.spawnZ, this.prevFlowX, this.prevFlowY, rng, dist);
      this.prevZ = this.spawnZ;

      this.spawnZ += this.seqLeft > 0 ? gap * 0.62 : gap;
    }
  }

  place(kind, z, dist, speed, time, shipZ, intensity, rng) {
    const h = this.pool.acquire(kind);
    h.z = z;
    h.absZ = z + this.originZ;
    h.depth = KINDS[kind].depth;
    h.flowX = this.flowX;
    h.flowY = this.flowY;
    h.minSd = Infinity;
    h.scored = false;

    // Arrival time matters: rotating gaps are phased to be open when we get
    // there. Speed climbs with distance, so integrate over the average of the
    // cruise speed now and at the hazard rather than assuming a constant.
    const lead = Math.max(0, z - shipZ);
    const s1 = this.speedAt ? this.speedAt(dist) : speed;
    const s0 = this.speedAt ? this.speedAt(Math.max(0, dist - lead)) : speed;
    const arriveT = time + lead / Math.max(30, (s0 + s1) * 0.5);
    KINDS[kind].reset(h, {
      rng, flowX: this.flowX, flowY: this.flowY, arriveT, intensity,
    });
    KINDS[kind].tick(h, time, 0, this.M);

    frameBasis(h.absZ, _m, centreX(h.absZ), centreY(h.absZ), h.z);
    _m.decompose(h.root.position, h.root.quaternion, h.root.scale);
    this.hazards.push(h);
  }

  dropPickups(z0, z1, fx0, fy0, rng, dist) {
    const span = z1 - z0;
    if (span < 12) return;
    const n = Math.max(2, Math.floor(span / 7.2) - 1);
    const risky = rng.chance(0.32);
    const bulge = risky ? rng.range(1.6, 3.2) * rng.sign() : 0;
    const bulgeA = rng() * TAU;

    if (rng.chance(0.14)) return;   // an empty stretch now and then

    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      const arc = Math.sin(t * Math.PI);
      let ox = lerp(fx0, this.flowX, t) + Math.cos(bulgeA) * bulge * arc;
      let oy = lerp(fy0, this.flowY, t) + Math.sin(bulgeA) * bulge * arc;
      const r = Math.hypot(ox, oy);
      if (r > TUBE_R - 1.0) { ox *= (TUBE_R - 1.0) / r; oy *= (TUBE_R - 1.0) / r; }
      const zz = z0 + span * t;
      this.pickups.add(CELL, zz + this.originZ, zz, ox, oy);
    }

    this.sinceShield += span;
    this.sinceCharge += span;
    if (this.sinceShield > 620 && rng.chance(0.5)) {
      this.sinceShield = 0;
      this.pickups.add(SHIELD, z0 + span * 0.5 + this.originZ, z0 + span * 0.5, this.flowX * 0.6, this.flowY * 0.6);
    } else if (this.sinceCharge > 420 && rng.chance(0.5)) {
      this.sinceCharge = 0;
      const a = rng() * TAU, r = rng.range(2, TUBE_R - 2.2);
      this.pickups.add(CHARGE, z0 + span * 0.5 + this.originZ, z0 + span * 0.5, Math.cos(a) * r, Math.sin(a) * r);
    }
    void dist;
  }

  /**
   * Re-aim every timed hazard ahead of us. Overdrive makes the ship arrive
   * early, which would leave rotating gaps pointing the wrong way; calling
   * this when overdrive starts and ends keeps the promise that the line works.
   */
  rephase(shipZ, time, distNow) {
    for (const h of this.hazards) {
      const lead = h.z - shipZ;
      if (lead <= 2) continue;
      const k = KINDS[h.kind];
      if (!k.rephase) continue;
      const s1 = this.speedAt ? this.speedAt(distNow + lead) : 90;
      const s0 = this.speedAt ? this.speedAt(distNow) : 90;
      k.rephase(h, time + lead / Math.max(30, (s0 + s1) * 0.5));
      k.tick(h, time, 0, this.M);
    }
  }

  /** Animate live hazards and recycle the ones behind us. */
  update(time, dt, shipZ) {
    const list = this.hazards;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      if (h.z < shipZ - 30) {
        this.pool.release(h);
        list.splice(i, 1);
        continue;
      }
      // Once a hazard is behind the nose it is between the ship and the
      // camera, where it would balloon across the screen for a frame or two.
      const dz = h.z - shipZ;
      h.root.visible = dz > -1.5;
      if (dz < 420) KINDS[h.kind].tick(h, time, dt, this.M);
    }
  }

  /** Blow up every hazard within `range` ahead - used by overdrive. */
  shatter(shipZ, range, onBurst) {
    const list = this.hazards;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      const dz = h.z - shipZ;
      if (dz > -4 && dz < range) {
        onBurst(h);
        this.pool.release(h);
        list.splice(i, 1);
      }
    }
  }
}
