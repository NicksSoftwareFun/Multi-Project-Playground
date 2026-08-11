// The player ship: procedural mesh + flight model.
//
// The flight model is a velocity chase rather than a position lerp. That extra
// bit of weight is what makes threading a gate feel like flying instead of
// dragging an icon.

import * as THREE from '../vendor/three.module.js';
import { TUBE_R, SHIP_R, LATERAL_MAX, LATERAL_CHASE, LATERAL_LAMBDA } from './config.js';
import { UNIT_BOX, hullGeo } from './geom.js';
import { glowTexture, sparkTexture } from './textures.js';
import { centreX, centreY, frameBasis } from './path.js';
import { clamp, damp, lerp } from './util.js';

const _m = new THREE.Matrix4();

export class Ship {
  constructor(scene) {
    this.root = new THREE.Object3D();
    this.inner = new THREE.Object3D();
    this.root.add(this.inner);
    scene.add(this.root);

    this.bodyMat = new THREE.MeshLambertMaterial({ color: 0x223344, emissive: 0x7fe9ff, emissiveIntensity: 0.35 });
    this.trimMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.glowMat = new THREE.SpriteMaterial({
      map: glowTexture(), color: 0x2ee6ff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.trailMat = new THREE.MeshBasicMaterial({
      map: sparkTexture(), color: 0x2ee6ff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });

    this.parts = new THREE.Group();
    this.inner.add(this.parts);

    this.engines = [];
    // Crossed billboards so the exhaust plume reads from any camera angle.
    const trailGeo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
    this.trail = new THREE.Group();
    this.trailA = new THREE.Mesh(trailGeo, this.trailMat);
    this.trailB = new THREE.Mesh(trailGeo, this.trailMat);
    this.trailB.rotation.z = Math.PI / 2;
    this.trail.add(this.trailA, this.trailB);
    this.inner.add(this.trail);

    this.def = null;
    this.reset();
  }

  build(def) {
    if (this.def && this.def.id === def.id) { this.applyColors(def); return; }
    this.def = def;
    const s = def.shape;
    for (const c of [...this.parts.children]) {
      this.parts.remove(c);
      if (c.geometry && c.geometry !== UNIT_BOX) c.geometry.dispose();
    }
    for (const e of this.engines) this.inner.remove(e);
    this.engines.length = 0;

    const hull = new THREE.Mesh(hullGeo(s.len, s.wide, s.wide * 0.62), this.bodyMat);
    hull.position.z = 0.1;
    this.parts.add(hull);

    // Wings sweep back from the nose.
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(UNIT_BOX, this.bodyMat);
      wing.scale.set(s.span, 0.09, s.len * 0.55);
      wing.position.set(side * s.span * 0.52, -0.02, -s.len * 0.12);
      wing.rotation.y = side * s.sweep * 0.5;
      wing.rotation.z = side * -0.16;
      this.parts.add(wing);

      const tip = new THREE.Mesh(UNIT_BOX, this.trimMat);
      tip.scale.set(0.09, 0.16, s.len * 0.34);
      tip.position.set(side * s.span * 0.95, 0.03, -s.len * 0.2);
      tip.rotation.y = side * s.sweep * 0.5;
      this.parts.add(tip);
    }

    for (let i = 0; i < s.fins; i++) {
      const fin = new THREE.Mesh(UNIT_BOX, this.bodyMat);
      const a = (i / s.fins) * Math.PI * 2 + Math.PI / 4;
      fin.scale.set(0.07, 0.5, s.len * 0.34);
      fin.position.set(Math.cos(a) * s.wide * 0.5, Math.sin(a) * s.wide * 0.5, -s.len * 0.34);
      fin.rotation.z = a - Math.PI / 2;
      this.parts.add(fin);
    }

    const canopy = new THREE.Mesh(UNIT_BOX, this.trimMat);
    canopy.scale.set(s.canopy, s.canopy * 0.5, s.canopy * 1.9);
    canopy.position.set(0, s.wide * 0.36, s.len * 0.16);
    this.parts.add(canopy);

    for (let i = 0; i < s.engines; i++) {
      const a = s.engines === 1 ? 0 : (i / s.engines) * Math.PI * 2;
      const r = s.engines === 1 ? 0 : s.wide * 0.55;
      const sp = new THREE.Sprite(this.glowMat.clone());
      sp.position.set(Math.cos(a) * r, Math.sin(a) * r * 0.6, -s.len * 0.52);
      sp.scale.setScalar(0.9);
      this.inner.add(sp);
      this.engines.push(sp);
    }

    this.applyColors(def);
  }

  applyColors(def) {
    this.bodyMat.color.setHex(def.color).multiplyScalar(0.22);
    this.bodyMat.emissive.setHex(def.color).multiplyScalar(0.5);
    this.trimMat.color.setHex(def.accent);
    this.trailMat.color.setHex(def.trail);
    for (const e of this.engines) e.material.color.setHex(def.trail);
  }

  reset() {
    this.z = 0; this.absZ = 0;
    this.ox = 0; this.oy = 0;
    this.vx = 0; this.vy = 0;
    this.tx = 0; this.ty = 0;
    this.roll = 0; this.pitch = 0; this.yaw = 0;
    this.invuln = 0;
    this.thrust = 0;
    this.visible = true;
  }

  get maxLateral() { return LATERAL_MAX * (this.def ? this.def.stats.handling : 1); }

  /** Move the ship inside the cross-section toward the input target. */
  fly(dt, boost) {
    const maxV = this.maxLateral * (boost ? 1.12 : 1);
    const dx = this.tx - this.ox, dy = this.ty - this.oy;
    const wantX = clamp(dx * LATERAL_CHASE, -maxV, maxV);
    const wantY = clamp(dy * LATERAL_CHASE, -maxV, maxV);
    const lam = LATERAL_LAMBDA * (this.def ? this.def.stats.handling : 1);
    this.vx = damp(this.vx, wantX, lam, dt);
    this.vy = damp(this.vy, wantY, lam, dt);
    this.ox += this.vx * dt;
    this.oy += this.vy * dt;

    // Stay inside the corridor; scrub velocity when we hit the wall.
    const lim = TUBE_R - SHIP_R - 0.12;
    const r = Math.hypot(this.ox, this.oy);
    if (r > lim) {
      const k = lim / r;
      this.ox *= k; this.oy *= k;
      const nx = this.ox / lim, ny = this.oy / lim;
      const vn = this.vx * nx + this.vy * ny;
      if (vn > 0) { this.vx -= nx * vn * 1.4; this.vy -= ny * vn * 1.4; }
      this.tx = clamp(this.tx, -lim, lim);
      this.ty = clamp(this.ty, -lim, lim);
      const tr = Math.hypot(this.tx, this.ty);
      if (tr > lim) { this.tx *= lim / tr; this.ty *= lim / tr; }
      return true;
    }
    return false;
  }

  updateVisual(dt, speed01, overdrive, hitFlash) {
    const maxV = this.maxLateral;
    this.roll = damp(this.roll, clamp(-this.vx / maxV, -1, 1) * 0.72, 11, dt);
    this.pitch = damp(this.pitch, clamp(-this.vy / maxV, -1, 1) * 0.24, 11, dt);
    this.yaw = damp(this.yaw, clamp(this.vx / maxV, -1, 1) * 0.22, 11, dt);
    this.inner.rotation.set(this.pitch, this.yaw, this.roll);
    this.inner.position.set(this.ox, this.oy, 0);

    const flick = 0.9 + Math.random() * 0.25;
    const eScale = (0.7 + speed01 * 0.7 + (overdrive ? 0.9 : 0)) * flick;
    for (const e of this.engines) e.scale.setScalar(eScale * 0.85);

    const tl = 3 + speed01 * 7 + (overdrive ? 9 : 0);
    const tw = 0.5 + speed01 * 0.55;
    this.trailA.scale.set(tw, 1, tl);
    this.trailB.scale.set(tw, 1, tl);
    this.trail.position.set(0, 0, -tl * 0.5 - this.def.shape.len * 0.5);
    this.trailMat.opacity = 0.32 + speed01 * 0.28 + (overdrive ? 0.34 : 0);

    // Pulse rather than blink while invulnerable: the mercy window has to be
    // legible, but losing sight of your own ship mid-dodge never is.
    const pulse = this.invuln > 0 ? 0.5 + 0.5 * Math.sin(this.invuln * 34) : 0;
    this.bodyMat.emissiveIntensity = lerp(0.5, 2.8, Math.max(hitFlash, pulse));
    const s = 1 - pulse * 0.06;
    this.parts.scale.setScalar(s);
  }

  /** Place the ship in world space from its tube coordinates. */
  place() {
    frameBasis(this.absZ, _m, centreX(this.absZ), centreY(this.absZ), this.z);
    _m.decompose(this.root.position, this.root.quaternion, this.root.scale);
  }
}
