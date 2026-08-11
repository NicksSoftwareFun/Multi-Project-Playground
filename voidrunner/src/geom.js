// Shared geometry. Built once, reused by every pooled object.
//
// Hazard collision is analytic (see hazards.js), so geometry here only has to
// *look* like the collider - but it is built to match exactly, because
// "I clearly went through the gap" is the fastest way to lose a player.

import * as THREE from '../vendor/three.module.js';
import { TAU } from './util.js';

export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_ICO = new THREE.IcosahedronGeometry(1, 0);
export const UNIT_ICO2 = new THREE.IcosahedronGeometry(1, 1);
export const UNIT_SPHERE = new THREE.SphereGeometry(1, 16, 12);

// Cylinder aligned along +X (scale.x = length, scale.y/z = radius).
export const UNIT_CYL_X = (() => {
  const g = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  g.rotateZ(-Math.PI / 2);
  return g;
})();

export const UNIT_TORUS = new THREE.TorusGeometry(1, 0.055, 6, 40);

const _cache = new Map();

/**
 * A solid annulus sector extruded along Z.
 * The GAP is centred on angle 0 with half-width `half`; the solid part spans
 * the rest of the circle. Rotate the mesh about Z to aim the gap.
 * rIn === 0 produces a filled fan (no inner rim).
 */
export function annulusSector(rIn, rOut, half, depth) {
  const key = `a${rIn.toFixed(2)}_${rOut.toFixed(2)}_${half.toFixed(3)}_${depth.toFixed(2)}`;
  const hit = _cache.get(key);
  if (hit) return hit;

  const a0 = half, a1 = TAU - half;
  const arc = a1 - a0;
  const seg = Math.max(6, Math.round(arc / 0.13));
  const step = arc / seg;
  const zf = -depth / 2, zb = depth / 2;
  const pos = [];
  const col = [];

  // Face shade is baked into vertex colours: the face you approach is lit, the
  // one you leave behind is nearly black. Flying through a bulkhead then reads
  // as a blink rather than a full-screen flash of flat colour.
  let shade = 1;
  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) col.push(shade, shade, shade);
  };
  const quad = (p0, p1, p2, p3) => {
    tri(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    tri(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
  };
  const FRONT = 1.0, BACK = 0.05, RIM = 0.55;

  for (let i = 0; i < seg; i++) {
    const a = a0 + i * step, b = a + step;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const oA = [rOut * ca, rOut * sa], oB = [rOut * cb, rOut * sb];
    const iA = [rIn * ca, rIn * sa], iB = [rIn * cb, rIn * sb];

    if (rIn <= 1e-4) {
      shade = FRONT;
      tri(0, 0, zf, oA[0], oA[1], zf, oB[0], oB[1], zf);
      shade = BACK;
      tri(0, 0, zb, oB[0], oB[1], zb, oA[0], oA[1], zb);
    } else {
      shade = FRONT;
      quad([iA[0], iA[1], zf], [oA[0], oA[1], zf], [oB[0], oB[1], zf], [iB[0], iB[1], zf]);
      shade = BACK;
      quad([iA[0], iA[1], zb], [iB[0], iB[1], zb], [oB[0], oB[1], zb], [oA[0], oA[1], zb]);
      shade = RIM;
      quad([iA[0], iA[1], zf], [iB[0], iB[1], zf], [iB[0], iB[1], zb], [iA[0], iA[1], zb]);
    }
    shade = RIM;
    quad([oA[0], oA[1], zf], [oA[0], oA[1], zb], [oB[0], oB[1], zb], [oB[0], oB[1], zf]);
  }

  // Flat caps on the two cut faces beside the gap.
  shade = RIM;
  for (const a of [a0, a1]) {
    const c = Math.cos(a), s = Math.sin(a);
    const i0 = [rIn * c, rIn * s], o0 = [rOut * c, rOut * s];
    quad([i0[0], i0[1], zf], [o0[0], o0[1], zf], [o0[0], o0[1], zb], [i0[0], i0[1], zb]);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  _cache.set(key, g);
  return g;
}

/** Partial torus whose gap is centred on angle 0. */
export function torusArc(radius, tube, half) {
  const key = `t${radius.toFixed(2)}_${tube.toFixed(2)}_${half.toFixed(3)}`;
  const hit = _cache.get(key);
  if (hit) return hit;
  const arc = TAU - 2 * half;
  const g = new THREE.TorusGeometry(radius, tube, 7, Math.max(10, Math.round(arc / 0.14)), arc);
  g.rotateZ(half);   // TorusGeometry starts at angle 0; shift so the gap straddles 0
  _cache.set(key, g);
  return g;
}

/** A tapered hull piece: cone-ish prism used for ship bodies. */
export function hullGeo(len, w, h, taper = 0.25) {
  const g = new THREE.CylinderGeometry(w * taper, w, len, 4, 1);
  g.rotateX(Math.PI / 2);
  g.rotateZ(Math.PI / 4);
  g.scale(1, h / w, 1);
  return g;
}
