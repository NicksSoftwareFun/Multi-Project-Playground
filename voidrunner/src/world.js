// The corridor itself: rings, rails, outer structures, stars and backdrop.
// All of it is instanced and recycled, so the scene stays at roughly a dozen
// draw calls no matter how far you get.

import * as THREE from '../vendor/three.module.js';
import {
  TUBE_R, RING_SPACING, RING_COUNT, RAIL_SEG, RAIL_COUNT, RAIL_LINES,
  STRUCT_COUNT, FOG_NEAR, FOG_FAR,
} from './config.js';
import { centreX, centreY, frameBasis } from './path.js';
import { nebulaTexture, starTexture } from './textures.js';
import { TAU, makeRng, lerp } from './util.js';

const _frame = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _axisZ = new THREE.Vector3(0, 0, 1);

function placeInFrame(mesh, i, absZ, relZ, ox, oy, oz, rotZ, sx, sy, sz) {
  frameBasis(absZ, _frame, centreX(absZ), centreY(absZ), relZ);
  _pos.set(ox, oy, oz);
  _quat.setFromAxisAngle(_axisZ, rotZ);
  _scl.set(sx, sy, sz);
  _local.compose(_pos, _quat, _scl);
  _frame.multiply(_local);
  mesh.setMatrixAt(i, _frame);
}

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.originZ = 0;

    scene.fog = new THREE.Fog(0x050b1a, FOG_NEAR, FOG_FAR);

    // --- lights -----------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0x9fd8ff, 0x1b1030, 1.25);
    scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.15);
    this.key.position.set(6, 10, -4);
    scene.add(this.key, this.key.target);

    // --- backdrop ---------------------------------------------------
    this.bgMat = new THREE.MeshBasicMaterial({
      map: nebulaTexture(), color: 0x0a1836, side: THREE.BackSide,
      fog: false, depthWrite: false,
    });
    this.bg = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), this.bgMat);
    this.bg.scale.setScalar(900);
    this.bg.renderOrder = -10;
    this.bg.frustumCulled = false;
    scene.add(this.bg);

    // --- stars ------------------------------------------------------
    const starN = 620;
    const sp = new Float32Array(starN * 3);
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < starN; i++) {
      const u = rng() * 2 - 1, a = rng() * TAU, s = Math.sqrt(1 - u * u);
      const r = rng.range(320, 560);
      sp[i * 3] = Math.cos(a) * s * r;
      sp[i * 3 + 1] = u * r;
      sp[i * 3 + 2] = Math.sin(a) * s * r;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.starMat = new THREE.PointsMaterial({
      map: starTexture(), size: 3.4, sizeAttenuation: false,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      fog: false, opacity: 0.9, color: 0xffffff,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    scene.add(this.stars);

    // --- corridor rings ---------------------------------------------
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x2ee6ff, fog: true });
    this.ringGeo = new THREE.TorusGeometry(TUBE_R + 0.55, 0.075, 4, 30);
    this.rings = new THREE.InstancedMesh(this.ringGeo, this.ringMat, RING_COUNT);
    this.rings.frustumCulled = false;
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.rings);

    this.markMat = new THREE.MeshBasicMaterial({
      color: 0x7c5cff, transparent: true, opacity: 0.9, fog: true,
    });
    this.markGeo = new THREE.TorusGeometry(TUBE_R + 0.75, 0.20, 4, 30);
    const markN = Math.ceil(RING_COUNT / 5);
    this.marks = new THREE.InstancedMesh(this.markGeo, this.markMat, markN);
    this.marks.frustumCulled = false;
    this.marks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.marks);

    // --- longitudinal rails -----------------------------------------
    this.railMat = new THREE.MeshBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.55, fog: true });
    this.rails = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.railMat, RAIL_COUNT * RAIL_LINES);
    this.rails.frustumCulled = false;
    this.rails.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.rails);

    // --- outer megastructure ----------------------------------------
    this.structMat = new THREE.MeshLambertMaterial({ color: 0x101c33, emissive: 0x060a14 });
    this.structs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.structMat, STRUCT_COUNT);
    this.structs.frustumCulled = false;
    this.structs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.structs);

    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xffd166, fog: true });
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.lampMat, STRUCT_COUNT);
    this.lamps.frustumCulled = false;
    this.lamps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.lamps);

    this.ringZ = new Float32Array(RING_COUNT);
    this.railZ = new Float32Array(RAIL_COUNT);
    this.structZ = new Float32Array(STRUCT_COUNT);
    this.structData = [];
    const srng = makeRng(0x51ab1e);
    for (let i = 0; i < STRUCT_COUNT; i++) {
      this.structData.push({
        a: srng() * TAU,
        r: srng.range(14, 46),
        w: srng.range(3, 16), h: srng.range(3, 22), d: srng.range(6, 40),
        rot: srng() * TAU,
        lamp: srng.range(0.3, 1.4),
        lampOn: srng.chance(0.55),
      });
    }
    this.srng = makeRng(0x51ab1e);

    this.palette = {
      fog: new THREE.Color(0x050b1a), bg: new THREE.Color(0x0a1836),
      ring: new THREE.Color(0x2ee6ff), ringAlt: new THREE.Color(0x7c5cff),
      hazard: new THREE.Color(0x2ee6ff), hazEdge: new THREE.Color(0xa8f6ff),
      accent: new THREE.Color(0xffd166), struct: new THREE.Color(0x101c33),
    };
    this._a = new THREE.Color();
    this._b = new THREE.Color();
  }

  reset(shipZ) {
    this.originZ = 0;
    for (let i = 0; i < RING_COUNT; i++) {
      this.ringZ[i] = shipZ - 30 + i * RING_SPACING;
      this.writeRing(i);
    }
    for (let i = 0; i < RAIL_COUNT; i++) {
      this.railZ[i] = shipZ - 30 + i * RAIL_SEG;
      this.writeRail(i);
    }
    this.srng = makeRng(0x51ab1e);
    for (let i = 0; i < STRUCT_COUNT; i++) {
      this.structZ[i] = shipZ - 40 + (i / STRUCT_COUNT) * (RING_COUNT * RING_SPACING);
      this.writeStruct(i);
    }
    this.flushAll();
  }

  flushAll() {
    this.rings.instanceMatrix.needsUpdate = true;
    this.marks.instanceMatrix.needsUpdate = true;
    this.rails.instanceMatrix.needsUpdate = true;
    this.structs.instanceMatrix.needsUpdate = true;
    this.lamps.instanceMatrix.needsUpdate = true;
  }

  writeRing(i) {
    const z = this.ringZ[i], absZ = z + this.originZ;
    const pulse = 1 + 0.02 * Math.sin(absZ * 0.09);
    placeInFrame(this.rings, i, absZ, z, 0, 0, 0, absZ * 0.02, pulse, pulse, 1);
    if (i % 5 === 0) {
      const mi = i / 5;
      if (mi < this.marks.count) placeInFrame(this.marks, mi, absZ, z, 0, 0, 0, absZ * 0.02, 1, 1, 1);
    }
  }

  writeRail(i) {
    const z = this.railZ[i], absZ = z + this.originZ;
    const len = RAIL_SEG * 0.68;
    for (let k = 0; k < RAIL_LINES; k++) {
      const a = (k / RAIL_LINES) * TAU + 0.26;
      const ox = Math.cos(a) * (TUBE_R + 0.35);
      const oy = Math.sin(a) * (TUBE_R + 0.35);
      const idx = i * RAIL_LINES + k;
      placeInFrame(this.rails, idx, absZ, z, ox, oy, len * 0.5, a, 0.12, 0.12, len);
    }
  }

  writeStruct(i) {
    const z = this.structZ[i], absZ = z + this.originZ;
    const d = this.structData[i];
    placeInFrame(this.structs, i, absZ, z, Math.cos(d.a) * d.r, Math.sin(d.a) * d.r, 0, d.rot, d.w, d.h, d.d);
    if (d.lampOn) {
      const lr = d.r - d.w * 0.5;
      placeInFrame(this.lamps, i, absZ, z, Math.cos(d.a) * lr, Math.sin(d.a) * lr, d.d * 0.3, d.rot, d.lamp, d.lamp * 3.5, d.lamp);
    } else {
      _local.makeScale(0, 0, 0);
      this.lamps.setMatrixAt(i, _local);
    }
  }

  rebase(delta) {
    this.originZ += delta;
    for (let i = 0; i < RING_COUNT; i++) { this.ringZ[i] -= delta; this.writeRing(i); }
    for (let i = 0; i < RAIL_COUNT; i++) { this.railZ[i] -= delta; this.writeRail(i); }
    for (let i = 0; i < STRUCT_COUNT; i++) { this.structZ[i] -= delta; this.writeStruct(i); }
    this.flushAll();
  }

  update(shipZ, camera) {
    const behind = shipZ - 32;
    let dirtyRing = false, dirtyRail = false, dirtyStruct = false;

    for (let i = 0; i < RING_COUNT; i++) {
      if (this.ringZ[i] < behind) {
        this.ringZ[i] += RING_COUNT * RING_SPACING;
        this.writeRing(i);
        dirtyRing = true;
      }
    }
    for (let i = 0; i < RAIL_COUNT; i++) {
      if (this.railZ[i] < behind) {
        this.railZ[i] += RAIL_COUNT * RAIL_SEG;
        this.writeRail(i);
        dirtyRail = true;
      }
    }
    const structSpan = RING_COUNT * RING_SPACING;
    for (let i = 0; i < STRUCT_COUNT; i++) {
      if (this.structZ[i] < behind - 20) {
        this.structZ[i] += structSpan;
        const d = this.structData[i];
        d.a = this.srng() * TAU;
        d.r = this.srng.range(14, 46);
        d.w = this.srng.range(3, 16); d.h = this.srng.range(3, 22); d.d = this.srng.range(6, 40);
        d.rot = this.srng() * TAU;
        d.lampOn = this.srng.chance(0.55);
        d.lamp = this.srng.range(0.3, 1.4);
        this.writeStruct(i);
        dirtyStruct = true;
      }
    }

    if (dirtyRing) { this.rings.instanceMatrix.needsUpdate = true; this.marks.instanceMatrix.needsUpdate = true; }
    if (dirtyRail) this.rails.instanceMatrix.needsUpdate = true;
    if (dirtyStruct) { this.structs.instanceMatrix.needsUpdate = true; this.lamps.instanceMatrix.needsUpdate = true; }

    this.bg.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.key.position.copy(camera.position).add(_pos.set(8, 14, -6));
    this.key.target.position.copy(camera.position);
    this.key.target.updateMatrixWorld();
  }

  /** Blend the two zone palettes and push the result everywhere. */
  applyPalette(info, flash = 0) {
    const p = this.palette, a = info.zone, b = info.next, t = info.blend;
    const mix = (key) => {
      this._a.setHex(a[key]);
      this._b.setHex(b[key]);
      return this._a.lerp(this._b, t);
    };
    p.fog.copy(mix('fog'));
    p.bg.copy(mix('bg'));
    p.ring.copy(mix('ring'));
    p.ringAlt.copy(mix('ringAlt'));
    p.hazard.copy(mix('hazard'));
    p.hazEdge.copy(mix('hazEdge'));
    p.accent.copy(mix('accent'));
    p.struct.copy(mix('struct'));

    this.scene.fog.color.copy(p.fog);
    this.renderer.setClearColor(p.fog, 1);
    this.bgMat.color.copy(p.bg);
    this.ringMat.color.copy(p.ring).multiplyScalar(lerp(1, 2.2, flash));
    this.markMat.color.copy(p.ringAlt);
    this.railMat.color.copy(p.ring);
    this.structMat.color.copy(p.struct);
    this.structMat.emissive.copy(p.struct).multiplyScalar(0.35);
    this.lampMat.color.copy(p.accent);
    this.hemi.color.copy(p.ring).lerp(this._b.setHex(0xffffff), 0.58);
    this.hemi.groundColor.copy(p.bg);
  }

  setFogRange(near, far) {
    this.scene.fog.near = near;
    this.scene.fog.far = far;
  }
}
