// Collectables. All of them live in two instanced meshes, so a hundred
// floating cells cost two draw calls.

import * as THREE from '../vendor/three.module.js';
import { tubeToWorld } from './path.js';
import { TAU, clamp, damp } from './util.js';
import { UNIT_ICO2 } from './geom.js';
import { glowTexture } from './textures.js';

const MAX = 160;

// Three unmistakable silhouettes: a cut gem, a ring, a rough sphere. You should
// never have to read the colour to know what you are about to fly into.
const CELL_GEO = new THREE.OctahedronGeometry(1, 0);
const SHIELD_GEO = new THREE.TorusGeometry(0.78, 0.26, 6, 14);
const CHARGE_GEO = UNIT_ICO2;

export const CELL = 0, SHIELD = 1, CHARGE = 2;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);

export class Pickups {
  constructor(scene) {
    this.items = [];
    this.free = [];

    this.cellMat = new THREE.MeshLambertMaterial({ color: 0x6b5410, emissive: 0xffd166, emissiveIntensity: 0.62 });
    this.haloMat = new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xffd166, transparent: true, opacity: 0.65,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
    });
    this.shieldMat = new THREE.MeshLambertMaterial({ color: 0x145766, emissive: 0x4de1ff, emissiveIntensity: 0.62 });
    this.chargeMat = new THREE.MeshLambertMaterial({ color: 0x5c1450, emissive: 0xff4ddb, emissiveIntensity: 0.62 });

    this.cells = new THREE.InstancedMesh(CELL_GEO, this.cellMat, MAX);
    this.power = new THREE.InstancedMesh(SHIELD_GEO, this.shieldMat, 12);
    this.charge = new THREE.InstancedMesh(CHARGE_GEO, this.chargeMat, 12);
    for (const m of [this.cells, this.power, this.charge]) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }

    // A modest pool of sprite halos, assigned to whichever pickups are nearest.
    this.halos = [];
    for (let i = 0; i < 26; i++) {
      const s = new THREE.Sprite(this.haloMat);
      s.visible = false;
      scene.add(s);
      this.halos.push(s);
    }
  }

  tint(cellCol, accentCol) {
    this.cellMat.emissive.copy(cellCol);
    this.cellMat.color.copy(cellCol).multiplyScalar(0.34);
    this.haloMat.color.copy(cellCol);
    void accentCol;
  }

  clear() {
    this.items.length = 0;
    this.free.length = 0;
  }

  add(type, absZ, z, ox, oy) {
    const it = this.free.pop() || {};
    it.type = type; it.absZ = absZ; it.z = z; it.ox = ox; it.oy = oy;
    it.bx = ox; it.by = oy;
    it.phase = (absZ * 0.31) % TAU;
    it.dead = false;
    it.pull = 0;
    this.items.push(it);
    return it;
  }

  rebase(delta) {
    for (const it of this.items) it.z -= delta;
  }

  /**
   * @returns {{cells:number, shields:number, charges:number, events:Array}}
   */
  update(dt, t, ship, magnetR, behindZ) {
    const res = { cells: 0, shields: 0, charges: 0, events: [] };
    const items = this.items;
    let ci = 0, pi = 0, gi = 0, hi = 0;

    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.z < behindZ) {
        this.free.push(it);
        items.splice(i, 1);
        continue;
      }
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const dz = it.z - ship.z;

      // Magnet: pull nearby cells onto the ship.
      if (dz > -2 && dz < magnetR * 2.6) {
        const d = Math.hypot(it.ox - ship.ox, it.oy - ship.oy);
        if (d < magnetR) {
          const k = clamp(1 - d / magnetR, 0, 1);
          it.pull = Math.max(it.pull, k);
          it.ox = damp(it.ox, ship.ox, 6 * k * k, dt);
          it.oy = damp(it.oy, ship.oy, 6 * k * k, dt);
        }
      }

      // Collection.
      if (!it.dead && Math.abs(dz) < 2.0) {
        const d = Math.hypot(it.ox - ship.ox, it.oy - ship.oy);
        if (d < 1.5) {
          it.dead = true;
          if (it.type === CELL) res.cells++;
          else if (it.type === SHIELD) res.shields++;
          else res.charges++;
          res.events.push(it);
          continue;
        }
      }
      if (it.dead) continue;
      // Once a pickup is past the ship it is no longer collectable, and it is
      // about to fly through the camera - stop drawing it.
      if (dz < -0.8) continue;

      const bob = Math.sin(t * 2.2 + it.phase) * 0.22 * (1 - it.pull);
      tubeToWorld(it.absZ, it.z, it.ox, it.oy + bob, _v);
      const spin = t * 1.9 + it.phase;
      _e.set(spin * 0.7, spin, spin * 0.3);
      _q.setFromEuler(_e);

      if (it.type === CELL) {
        if (ci < MAX) {
          _s.setScalar(0.42);
          _m.compose(_v, _q, _s);
          this.cells.setMatrixAt(ci++, _m);
        }
      } else if (it.type === SHIELD) {
        if (pi < 12) {
          _s.setScalar(0.66);
          _m.compose(_v, _q, _s);
          this.power.setMatrixAt(pi++, _m);
        }
      } else if (gi < 12) {
        _s.setScalar(0.62);
        _m.compose(_v, _q, _s);
        this.charge.setMatrixAt(gi++, _m);
      }

      if (hi < this.halos.length && dz < 130) {
        const s = this.halos[hi++];
        s.visible = true;
        s.position.copy(_v);
        s.scale.setScalar(it.type === CELL ? 1.5 : 2.6);
      }
    }

    // Remove collected items.
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].dead) { this.free.push(items[i]); items.splice(i, 1); }
    }

    for (let i = ci; i < this.cells.count; i++) this.cells.setMatrixAt(i, _hidden);
    for (let i = pi; i < this.power.count; i++) this.power.setMatrixAt(i, _hidden);
    for (let i = gi; i < this.charge.count; i++) this.charge.setMatrixAt(i, _hidden);
    for (let i = hi; i < this.halos.length; i++) this.halos[i].visible = false;

    this.cells.instanceMatrix.needsUpdate = true;
    this.power.instanceMatrix.needsUpdate = true;
    this.charge.instanceMatrix.needsUpdate = true;
    this.cells.count = MAX;
    this.power.count = 12;
    this.charge.count = 12;

    return res;
  }
}
