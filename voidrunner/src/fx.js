// Particles, shockwaves and screen shake.
// One Points draw call for every spark in the game, plus a small ring pool.

import * as THREE from '../vendor/three.module.js';
import { glowTexture } from './textures.js';
import { clamp } from './util.js';

const MAXP = 560;
const RINGS = 10;

const VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (320.0 / max(-mv.z, 0.001));
  gl_Position = projectionMatrix * mv;
  vAlpha = aAlpha;
  vColor = aColor;
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * a, a);
  #include <colorspace_fragment>
}`;

export class FX {
  constructor(scene) {
    this.scene = scene;

    const pos = new Float32Array(MAXP * 3);
    const size = new Float32Array(MAXP);
    const alpha = new Float32Array(MAXP);
    const col = new Float32Array(MAXP * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setDrawRange(0, MAXP);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: glowTexture() } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    this.geo = g;
    this.pos = pos; this.size = size; this.alpha = alpha; this.col = col;
    this.vel = new Float32Array(MAXP * 3);
    this.life = new Float32Array(MAXP);
    this.maxLife = new Float32Array(MAXP);
    this.size0 = new Float32Array(MAXP);
    this.drag = new Float32Array(MAXP);
    this.cursor = 0;
    this.live = 0;

    // Expanding shockwave rings.
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.rings = [];
    const rgeo = new THREE.TorusGeometry(1, 0.045, 4, 40);
    for (let i = 0; i < RINGS; i++) {
      const m = new THREE.Mesh(rgeo, this.ringMat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.rings.push({ m, t: 0, dur: 0, r0: 1, r1: 8 });
    }
    this.ringCursor = 0;

    this.shake = 0;
    this.shakeDecay = 3.2;
    this.quality = 1;
  }

  setQuality(q) { this.quality = clamp(q, 0.25, 1); }

  clear() {
    this.alpha.fill(0);
    this.life.fill(0);
    this.geo.attributes.aAlpha.needsUpdate = true;
    for (const r of this.rings) { r.m.visible = false; r.t = 0; r.dur = 0; }
    this.shake = 0;
  }

  emit(x, y, z, vx, vy, vz, size, life, r, g, b, drag = 2.2) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAXP;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.size0[i] = size;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alpha[i] = 1;
    this.drag[i] = drag;
  }

  /** Radial spray. `col` is a THREE.Color. */
  burst(p, count, col, speed, size, life, forward = 0) {
    const n = Math.max(2, Math.round(count * this.quality));
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      const v = speed * (0.35 + Math.random() * 0.65);
      this.emit(
        p.x, p.y, p.z,
        Math.cos(a) * s * v, u * v, Math.sin(a) * s * v + forward,
        size * (0.6 + Math.random() * 0.8),
        life * (0.6 + Math.random() * 0.6),
        col.r, col.g, col.b,
      );
    }
  }

  /** Small directional spark, used for grazes. */
  spark(p, col, dirZ) {
    const n = Math.max(1, Math.round(4 * this.quality));
    for (let i = 0; i < n; i++) {
      this.emit(
        p.x, p.y, p.z,
        (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, dirZ * (0.2 + Math.random()),
        0.7 + Math.random() * 0.5, 0.28 + Math.random() * 0.2,
        col.r, col.g, col.b, 4.5,
      );
    }
  }

  ring(pos, quat, col, r0, r1, dur, width = 0.045) {
    const r = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % RINGS;
    r.m.visible = true;
    r.m.position.copy(pos);
    if (quat) r.m.quaternion.copy(quat);
    r.m.material.color.copy(col);
    r.m.material.opacity = 0.85;
    r.t = 0; r.dur = dur; r.r0 = r0; r.r1 = r1;
    void width;
    r.m.scale.setScalar(r0);
    return r;
  }

  addShake(amount) { this.shake = Math.min(1.6, this.shake + amount); }

  update(dt) {
    const { pos, vel, size, size0, alpha, life, maxLife, drag } = this;
    let any = false;
    for (let i = 0; i < MAXP; i++) {
      if (life[i] <= 0) { if (alpha[i] !== 0) { alpha[i] = 0; any = true; } continue; }
      any = true;
      life[i] -= dt;
      const i3 = i * 3;
      const d = Math.exp(-drag[i] * dt);
      vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      const k = Math.max(0, life[i] / maxLife[i]);
      alpha[i] = k * k;
      size[i] = size0[i] * (0.35 + 0.65 * k);
    }
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aColor.needsUpdate = true;
    }

    for (const r of this.rings) {
      if (r.dur <= 0) continue;
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) { r.dur = 0; r.m.visible = false; continue; }
      const e = 1 - Math.pow(1 - k, 3);
      r.m.scale.setScalar(r.r0 + (r.r1 - r.r0) * e);
      r.m.material.opacity = 0.85 * (1 - k) * (1 - k);
    }

    this.shake = Math.max(0, this.shake - this.shakeDecay * dt * (0.4 + this.shake));
  }
}
