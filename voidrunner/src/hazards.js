// Hazards.
//
// Two rules drive the whole file:
//  1. Collision is analytic 2-D signed distance in the corridor cross-section.
//     No raycasts, no physics engine, no per-triangle tests - a few dozen
//     hazards cost microseconds and the result is exact, which matters because
//     an endless runner lives or dies on whether near-misses feel honest.
//  2. Every hazard is *generated around a safe point*. The spawner hands each
//     hazard the point the player is expected to fly through and the hazard
//     shapes itself around it, so a run is always survivable.

import * as THREE from '../vendor/three.module.js';
import { TUBE_R, SHIP_R } from './config.js';
import { UNIT_BOX, UNIT_ICO, UNIT_ICO2, UNIT_CYL_X, UNIT_TORUS, annulusSector, torusArc } from './geom.js';
import { glowTexture } from './textures.js';
import { TAU, clamp, distToSeg, angDist } from './util.js';

/* ------------------------------------------------------------------ */
/* Shared materials - re-tinted every frame by the zone palette.       */
/* ------------------------------------------------------------------ */

export function makeHazardMaterials() {
  // Massive hazards are dark hull lit by the scene; skeletal ones glow. The
  // split is what lets you read a wall from a blade at 120 units per second.
  const core = new THREE.MeshLambertMaterial({ color: 0x0d2230, emissive: 0x081420, emissiveIntensity: 1, side: THREE.DoubleSide });
  const hot = new THREE.MeshLambertMaterial({ color: 0x11414f, emissive: 0x2ee6ff, emissiveIntensity: 0.9 });
  const wall = new THREE.MeshLambertMaterial({
    color: 0x0d2230, emissive: 0x081420, side: THREE.DoubleSide, vertexColors: true,
  });
  const edge = new THREE.MeshBasicMaterial({ color: 0xa8f6ff, fog: true });
  const halo = new THREE.MeshBasicMaterial({
    color: 0x2ee6ff, transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide, fog: true,
  });
  const beamOn = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  });
  const beamOff = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.20,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  });
  const line = new THREE.LineBasicMaterial({ color: 0xa8f6ff, transparent: true, opacity: 0.9, fog: true });
  const beacon = new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xffffff, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  });
  return { core, hot, wall, edge, line, halo, beamOn, beamOff, beacon };
}

/** Push the active palette into the shared hazard materials. */
export function tintHazardMaterials(M, hazCol, edgeCol, dangerCol) {
  M.core.color.copy(hazCol).multiplyScalar(0.30);
  M.core.emissive.copy(hazCol).multiplyScalar(0.10);
  M.wall.color.copy(hazCol).multiplyScalar(0.42);
  M.wall.emissive.copy(hazCol).multiplyScalar(0.07);
  M.hot.color.copy(hazCol).multiplyScalar(0.35);
  M.hot.emissive.copy(hazCol);
  M.edge.color.copy(edgeCol);
  M.line.color.copy(edgeCol);
  M.halo.color.copy(hazCol);
  M.beamOn.color.copy(dangerCol);
  M.beamOff.color.copy(dangerCol);
  M.beacon.color.copy(edgeCol);
}

/* ------------------------------------------------------------------ */
/* Geometry variant tables (kept small so nothing is built mid-run)    */
/* ------------------------------------------------------------------ */

const GATE_HALF = [0.30, 0.40, 0.52, 0.68, 0.90];
const GATE_DEPTH = 1.5;
const RING_MID = [3.0, 4.6, 6.2];
const RING_HALF = [0.46, 0.70, 1.00];
const RING_TUBE = 0.85;

const GATE_OUT = TUBE_R + 2.0;   // seals against the corridor ring
const BOX_EDGES = new THREE.EdgesGeometry(UNIT_BOX);

export function warmGeometry() {
  for (const h of GATE_HALF) { annulusSector(0, GATE_OUT, h, GATE_DEPTH); annulusSector(3.5, GATE_OUT, h, GATE_DEPTH); }
  for (const r of RING_MID) for (const h of RING_HALF) torusArc(r, RING_TUBE, h);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sdBox = (px, py, hx, hy) => {
  const qx = Math.abs(px) - hx, qy = Math.abs(py) - hy;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0);
};

/** Signed distance to the solid part of a gapped annulus. */
function sdGapped(x, y, rIn, rOut, gapAng, gapHalf) {
  const r = Math.hypot(x, y);
  const dRad = rIn <= 1e-4 ? r - rOut : Math.max(rIn - r, r - rOut);
  const dAng = (angDist(Math.atan2(y, x), gapAng) - gapHalf) * Math.max(r, 0.05);
  return Math.max(dRad, -dAng);
}

/**
 * Cap rotation so a mistimed arrival still fits through the opening.
 * `slack` is the spare angle (radians) either side of the gap centre once the
 * ship and the hazard's own thickness are accounted for; `tol` is how many
 * seconds of arrival error we promise to survive.
 */
function spinLimit(slack, tol = 0.55) {
  return Math.max(0.05, slack) / tol;
}

function newInstanced(geo, mat, n) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return m;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);

function setInst(mesh, i, x, y, z, rot, sx, sy, sz) {
  _q.setFromAxisAngle(_zAxis, rot);
  _v.set(x, y, z);
  _s.set(sx, sy, sz);
  _m.compose(_v, _q, _s);
  mesh.setMatrixAt(i, _m);
}

/* ------------------------------------------------------------------ */
/* Kind implementations                                                */
/* ------------------------------------------------------------------ */
// Each kind: create(M) -> parts, reset(h, p) -> configure, tick(h, t),
// sdf(h, x, y) -> signed distance in the cross-section.
// p = { rng, flowX, flowY, arriveT, intensity (0..1) }

const KINDS = {};

/* ---- GATE: a bulkhead with one open sector (or an open core). ---- */
KINDS.gate = {
  depth: GATE_DEPTH,
  create(M) {
    const g = new THREE.Group();
    const spin = new THREE.Group();
    const wall = new THREE.Mesh(annulusSector(0, TUBE_R + 2.0, GATE_HALF[2], GATE_DEPTH), M.wall);
    const lips = newInstanced(UNIT_BOX, M.edge, 2);   // glowing edges of the opening
    const rim = new THREE.Mesh(UNIT_TORUS, M.edge);
    spin.add(wall, lips, rim);
    const beacon = new THREE.Sprite(M.beacon);
    g.add(spin, beacon);
    return { g, spin, wall, lips, rim, beacon };
  },
  reset(h, p) {
    const { rng } = p;
    const fr = Math.hypot(p.flowX, p.flowY);
    const fa = Math.atan2(p.flowY, p.flowX);
    let rIn = 0, half, ang;

    if (fr >= 2.6) {
      // Gap centred on the flow point, wide enough to be comfortable.
      const need = 2.35 / fr;
      half = GATE_HALF.find((v) => v >= need) ?? GATE_HALF[GATE_HALF.length - 1];
      ang = fa + rng.range(-0.10, 0.10) * (half - need > 0.12 ? 1 : 0);
      h.beaconX = Math.cos(ang) * fr; h.beaconY = Math.sin(ang) * fr;
    } else {
      // Flow is near the axis: open the core instead and put the gap anywhere.
      rIn = 3.5;
      half = rng.pick(GATE_HALF);
      ang = rng() * TAU;
      h.beaconX = 0; h.beaconY = 0;
    }

    h.rIn = rIn; h.half = half; h.ang = ang;
    const slack = rIn > 0 ? 6 : Math.max(0, half - (SHIP_R + 0.85) / Math.max(fr, 2.6));
    const cap = spinLimit(slack);
    h.spin = rng.chance(0.26 + p.intensity * 0.28)
      ? rng.sign() * Math.min(rng.range(0.10, 0.42) * (0.6 + p.intensity), cap) : 0;
    h.aimAng = ang;
    h.ang0 = ang - h.spin * p.arriveT;

    h.parts.wall.geometry = annulusSector(rIn, GATE_OUT, half, GATE_DEPTH);
    h.parts.beacon.position.set(h.beaconX, h.beaconY, 0.2);
    h.parts.beacon.scale.setScalar(rIn > 0 ? 4.4 : clamp(half * Math.max(fr, 2.6) * 2.4, 2.2, 6));

    // Light up the two cut faces so the opening reads from a long way out.
    const len = GATE_OUT - rIn, mid = (GATE_OUT + rIn) / 2;
    for (let i = 0; i < 2; i++) {
      const a = i === 0 ? half : -half;
      setInst(h.parts.lips, i, Math.cos(a) * mid, Math.sin(a) * mid, 0, a, len, 0.20, GATE_DEPTH * 1.3);
    }
    h.parts.lips.instanceMatrix.needsUpdate = true;
    h.parts.rim.visible = rIn > 0;
    h.parts.rim.scale.set(rIn || 1, rIn || 1, 1.6);
  },
  tick(h, t) {
    h.ang = h.ang0 + h.spin * t;
    h.parts.spin.rotation.z = h.ang;
    if (h.spin !== 0 && h.rIn <= 0) {
      const fr = Math.hypot(h.beaconX, h.beaconY) || 4;
      h.parts.beacon.position.set(Math.cos(h.ang) * fr, Math.sin(h.ang) * fr, 0.2);
    }
  },
  rephase(h, arriveT) { h.ang0 = h.aimAng - h.spin * arriveT; },
  sdf(h, x, y) { return sdGapped(x, y, h.rIn, TUBE_R + 4, h.ang, h.half); },
};

/* ---- RINGGATE: a thick ring with a gap. Inside, outside and gap are safe. ---- */
KINDS.ringgate = {
  depth: RING_TUBE * 2,
  create(M) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(torusArc(RING_MID[1], RING_TUBE, RING_HALF[1]), M.hot);
    g.add(ring);
    return { g, ring };
  },
  reset(h, p) {
    const { rng } = p;
    const fr = Math.hypot(p.flowX, p.flowY);
    const fa = Math.atan2(p.flowY, p.flowX);

    // Prefer a ring radius that leaves the flow point clear without a gap;
    // otherwise aim the gap at it.
    const options = RING_MID.filter((r) => Math.abs(fr - r) > RING_TUBE + 1.9);
    let mid, half, ang;
    if (options.length && rng.chance(0.55)) {
      mid = rng.pick(options);
      half = rng.pick(RING_HALF);
      ang = rng() * TAU;
    } else {
      mid = rng.pick(RING_MID);
      half = RING_HALF.find((v) => v * mid >= 2.4) ?? RING_HALF[2];
      ang = fa;
    }
    h.mid = mid; h.half = half; h.ang = ang;
    const aimed = ang === fa;
    const slack = aimed ? Math.max(0, half - (SHIP_R + 0.85) / Math.max(fr, 1.5)) : 6;
    h.spin = rng.sign() * Math.min(rng.range(0.12, 0.55) * (0.55 + p.intensity), spinLimit(slack));
    h.aimAng = ang;
    h.ang0 = ang - h.spin * p.arriveT;
    h.parts.ring.geometry = torusArc(mid, RING_TUBE, half);
  },
  tick(h, t) {
    h.ang = h.ang0 + h.spin * t;
    h.parts.ring.rotation.z = h.ang;
  },
  rephase(h, arriveT) { h.ang0 = h.aimAng - h.spin * arriveT; },
  sdf(h, x, y) {
    const r = Math.hypot(x, y);
    const dBand = Math.abs(r - h.mid) - RING_TUBE;
    const dAng = (angDist(Math.atan2(y, x), h.ang) - h.half) * Math.max(r, 0.05);
    return Math.max(dBand, -dAng);
  },
};

/* ---- APERTURE: an iris that breathes. Only the core is safe. ---- */
KINDS.aperture = {
  depth: 1.3,
  create(M) {
    const g = new THREE.Group();
    const blades = newInstanced(UNIT_BOX, M.core, 9);
    const rim = new THREE.Mesh(UNIT_TORUS, M.edge);
    g.add(blades, rim);
    return { g, blades, rim };
  },
  reset(h, p) {
    const { rng } = p;
    const fr = Math.hypot(p.flowX, p.flowY);
    // An iris centred on the axis cannot clear a line hugging the wall, so
    // shift its centre toward the line until the opening fits.
    const maxOpen = TUBE_R - 1.2;
    const t = fr > 1e-3 ? Math.max(0, 1 - (maxOpen - 1.85) / fr) : 0;
    h.cx = p.flowX * t; h.cy = p.flowY * t;
    const d = Math.hypot(p.flowX - h.cx, p.flowY - h.cy);
    h.base = clamp(d + 1.85, 2.5, maxOpen);
    h.amp = rng.range(0.5, 1.4);
    h.w = rng.range(1.1, 2.3) * (0.7 + p.intensity * 0.6);
    // Phase so the iris is at its widest as the player arrives.
    h.ph = Math.PI / 2 - h.w * p.arriveT;
    h.aim = Math.PI / 2;
    h.blades = rng.int(7, 9);
    h.parts.blades.count = h.blades;
    h.r = h.base;
  },
  tick(h, t) {
    h.r = h.base + h.amp * 0.5 * (1 + Math.sin(h.w * t + h.ph));
    const n = h.blades, mesh = h.parts.blades;
    const len = (TUBE_R + 6) - h.r;
    const width = (TAU * h.r) / n + 1.5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + t * 0.12;
      const rm = h.r + len / 2;
      setInst(mesh, i, h.cx + Math.cos(a) * rm, h.cy + Math.sin(a) * rm, 0, a, len, width, 1.3);
    }
    mesh.instanceMatrix.needsUpdate = true;
    h.parts.rim.position.set(h.cx, h.cy, 0);
    h.parts.rim.scale.set(h.r, h.r, 1);
  },
  rephase(h, arriveT) { h.ph = h.aim - h.w * arriveT; },
  sdf(h, x, y) { return h.r - Math.hypot(x - h.cx, y - h.cy); },
};

/* ---- SPINNER: rotating blades around a hub. ---- */
KINDS.spinner = {
  depth: 1.2,
  // Blades converge on the axis, so a spinner is only fair if the intended
  // line is far enough out for the gap between blades to be flyable.
  minR: 2.6,
  create(M) {
    const g = new THREE.Group();
    const blades = newInstanced(UNIT_BOX, M.hot, 6);
    const hub = new THREE.Mesh(UNIT_ICO2, M.core);
    g.add(blades, hub);
    return { g, blades, hub };
  },
  reset(h, p) {
    const { rng } = p;
    const fr = Math.max(Math.hypot(p.flowX, p.flowY), 2.4);
    const fa = Math.atan2(p.flowY, p.flowX);
    h.bt = 0.36;
    h.hub = clamp(fr - SHIP_R - 1.0, 0.25, 0.9);
    // Blade count limited so the gap at the flow radius stays flyable.
    const maxN = Math.floor((Math.PI * fr) / (2.30 + h.bt));
    h.n = clamp(rng.int(2, 5), 2, Math.max(2, Math.min(5, maxN)));
    h.rIn = h.hub;
    h.rOut = TUBE_R + 3;
    const slack = Math.PI / h.n - (h.bt + SHIP_R + 0.85) / fr;
    h.spin = rng.sign() * Math.min(rng.range(0.42, 1.15) * (0.6 + p.intensity * 0.7), spinLimit(slack));
    // Aim the midpoint between two blades at the flow angle on arrival.
    h.aimAng = fa + Math.PI / h.n;
    h.ang0 = h.aimAng - h.spin * p.arriveT;
    h.ang = h.ang0;
    h.parts.blades.count = h.n;
    h.parts.hub.scale.setScalar(h.hub);
  },
  tick(h, t) {
    h.ang = h.ang0 + h.spin * t;
    const mesh = h.parts.blades, len = h.rOut - h.rIn, rm = (h.rIn + h.rOut) / 2;
    for (let i = 0; i < h.n; i++) {
      const a = h.ang + (i / h.n) * TAU;
      setInst(mesh, i, Math.cos(a) * rm, Math.sin(a) * rm, 0, a, len, h.bt * 2, 1.2);
    }
    mesh.instanceMatrix.needsUpdate = true;
    h.parts.hub.rotation.z = h.ang;
  },
  rephase(h, arriveT) { h.ang0 = h.aimAng - h.spin * arriveT; },
  sdf(h, x, y) {
    let best = Math.hypot(x, y) - h.hub;   // hub
    for (let i = 0; i < h.n; i++) {
      const a = h.ang + (i / h.n) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const d = distToSeg(x, y, c * h.rIn, s * h.rIn, c * h.rOut, s * h.rOut) - h.bt;
      if (d < best) best = d;
    }
    return best;
  },
};

/* ---- BARS: parallel girders with one clear lane. ---- */
KINDS.bars = {
  depth: 1.1,
  create(M) {
    const g = new THREE.Group();
    const bars = newInstanced(UNIT_BOX, M.hot, 7);
    g.add(bars);
    return { g, bars };
  },
  reset(h, p) {
    const { rng } = p;
    const th = rng() * TAU;
    const nx = -Math.sin(th), ny = Math.cos(th);
    const fn = p.flowX * nx + p.flowY * ny;
    h.th = th; h.nx = nx; h.ny = ny;
    h.bt = rng.range(0.34, 0.55);
    const lane = 2.25 + h.bt;
    const spacing = rng.range(2.9, 4.1) - p.intensity * 0.5;
    h.off = [];
    for (let k = 0; k < 4; k++) {
      const a = fn + lane + k * spacing;
      const b = fn - lane - k * spacing;
      if (Math.abs(a) < TUBE_R - 0.15) h.off.push(a);
      if (Math.abs(b) < TUBE_R - 0.15) h.off.push(b);
    }
    h.off.length = Math.min(h.off.length, 7);
    h.drift = rng.chance(0.35 + p.intensity * 0.25) ? rng.sign() * rng.range(0.4, 1.3) : 0;
    h.driftPh = -p.arriveT * 0.9;
    h.cur = h.off.slice();
    h.parts.bars.count = h.off.length;
  },
  tick(h, t) {
    const mesh = h.parts.bars;
    const shift = h.drift ? Math.sin(t * 0.9 + h.driftPh) * h.drift : 0;
    for (let i = 0; i < h.off.length; i++) {
      const o = h.off[i] + shift;
      h.cur[i] = o;
      const half = Math.sqrt(Math.max(0.4, (TUBE_R + 3) * (TUBE_R + 3) - o * o));
      setInst(mesh, i, h.nx * o, h.ny * o, 0, h.th, half * 2, h.bt * 2, 1.1);
    }
    mesh.instanceMatrix.needsUpdate = true;
  },
  rephase(h, arriveT) { h.driftPh = -arriveT * 0.9; },
  sdf(h, x, y) {
    const pn = x * h.nx + y * h.ny;
    let best = Infinity;
    for (let i = 0; i < h.cur.length; i++) {
      const d = Math.abs(pn - h.cur[i]) - h.bt;
      if (d < best) best = d;
    }
    return best;
  },
};

/* ---- BLOCK: a slab of hull you fly around. ---- */
KINDS.block = {
  depth: 3.2,
  create(M) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(UNIT_BOX, M.core);
    const cage = new THREE.LineSegments(BOX_EDGES, M.line);
    g.add(box, cage);
    return { g, box, cage };
  },
  reset(h, p) {
    const { rng } = p;
    const fa = Math.atan2(p.flowY, p.flowX);
    h.hx = rng.range(2.2, 4.2);
    h.hy = rng.range(1.7, 3.6);
    h.rot = rng() * TAU;
    // Sit on the far side of the corridor from the flow point.
    let ok = false;
    for (let tries = 0; tries < 12 && !ok; tries++) {
      const a = fa + Math.PI + rng.range(-1.5, 1.5);
      const rr = rng.range(2.0, TUBE_R - 1.2);
      h.cx = Math.cos(a) * rr; h.cy = Math.sin(a) * rr;
      ok = this.sdf(h, p.flowX, p.flowY) > 2.3;
    }
    if (!ok) {
      // Last resort: sit opposite the line and shrink until it is clear.
      const fr2 = Math.max(Math.hypot(p.flowX, p.flowY), 0.6);
      h.cx = (-p.flowX / fr2) * (TUBE_R * 0.55);
      h.cy = (-p.flowY / fr2) * (TUBE_R * 0.55);
      for (let k = 0; k < 8 && this.sdf(h, p.flowX, p.flowY) < 2.2; k++) { h.hx *= 0.72; h.hy *= 0.72; }
    }
    h.spin = rng.chance(0.35) ? rng.sign() * rng.range(0.1, 0.5) : 0;
    h.aimRot = h.rot;
    h.rot0 = h.rot - h.spin * p.arriveT;
    h.parts.box.scale.set(h.hx * 2, h.hy * 2, KINDS.block.depth);
    h.parts.box.position.set(h.cx, h.cy, 0);
    h.parts.cage.scale.copy(h.parts.box.scale).multiplyScalar(1.004);
    h.parts.cage.position.copy(h.parts.box.position);
  },
  tick(h, t) {
    if (h.spin) { h.rot = h.rot0 + h.spin * t; h.parts.box.rotation.z = h.rot; h.parts.cage.rotation.z = h.rot; }
  },
  rephase(h, arriveT) { if (h.spin) h.rot0 = h.aimRot - h.spin * arriveT; },
  sdf(h, x, y) {
    const dx = x - h.cx, dy = y - h.cy;
    const c = Math.cos(-h.rot), s = Math.sin(-h.rot);
    return sdBox(dx * c - dy * s, dx * s + dy * c, h.hx, h.hy);
  },
};

/* ---- MINE: a drifting swarm. ---- */
KINDS.mine = {
  depth: 2.6,
  create(M) {
    const g = new THREE.Group();
    const body = newInstanced(UNIT_ICO, M.hot, 10);
    const halo = newInstanced(UNIT_ICO, M.halo, 10);
    g.add(body, halo);
    return { g, body, halo };
  },
  reset(h, p) {
    const { rng } = p;
    h.n = rng.int(4, 9);
    h.mx = h.mx || new Float32Array(10);
    h.my = h.my || new Float32Array(10);
    h.mr = h.mr || new Float32Array(10);
    h.ma = h.ma || new Float32Array(10);
    h.mo = h.mo || new Float32Array(10);
    h.mw = h.mw || new Float32Array(10);
    h.cx = h.cx || new Float32Array(10);
    h.cy = h.cy || new Float32Array(10);
    let placed = 0;
    for (let tries = 0; tries < 60 && placed < h.n; tries++) {
      const a = rng() * TAU, r = rng.range(0.6, TUBE_R - 0.9);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      const rad = rng.range(0.55, 1.0);
      const orb = rng.range(0.3, 1.1);
      if (Math.hypot(x - p.flowX, y - p.flowY) < rad + orb + 2.4) continue;
      h.mx[placed] = x; h.my[placed] = y; h.mr[placed] = rad;
      h.ma[placed] = rng() * TAU; h.mo[placed] = orb;
      h.mw[placed] = rng.sign() * rng.range(0.6, 1.8);
      placed++;
    }
    if (placed === 0) {
      // Degenerate fallback: one mine directly opposite the flow point.
      const a = Math.atan2(p.flowY, p.flowX) + Math.PI;
      h.mx[0] = Math.cos(a) * 5; h.my[0] = Math.sin(a) * 5; h.mr[0] = 0.7;
      h.ma[0] = 0; h.mo[0] = 0.4; h.mw[0] = 1;
      placed = 1;
    }
    h.n = placed;
    h.parts.body.count = placed;
    h.parts.halo.count = placed;
  },
  tick(h, t) {
    const b = h.parts.body, hl = h.parts.halo;
    for (let i = 0; i < h.n; i++) {
      const a = h.ma[i] + h.mw[i] * t;
      const x = h.mx[i] + Math.cos(a) * h.mo[i];
      const y = h.my[i] + Math.sin(a) * h.mo[i];
      h.cx[i] = x; h.cy[i] = y;
      const r = h.mr[i];
      setInst(b, i, x, y, Math.sin(a * 1.7) * 0.6, a * 2, r, r, r);
      setInst(hl, i, x, y, Math.sin(a * 1.7) * 0.6, a * 2, r * 2.2, r * 2.2, r * 2.2);
    }
    b.instanceMatrix.needsUpdate = true;
    hl.instanceMatrix.needsUpdate = true;
  },
  sdf(h, x, y) {
    let best = Infinity;
    for (let i = 0; i < h.n; i++) {
      const d = Math.hypot(x - h.cx[i], y - h.cy[i]) - h.mr[i];
      if (d < best) best = d;
    }
    return best;
  },
};

/* ---- ORB: one big mass you sweep around. ---- */
KINDS.orb = {
  depth: 6.0,
  create(M) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(UNIT_ICO2, M.core);
    const halo = new THREE.Mesh(UNIT_ICO2, M.halo);
    g.add(body, halo);
    return { g, body, halo };
  },
  reset(h, p) {
    const { rng } = p;
    const fr = Math.hypot(p.flowX, p.flowY);
    h.rr = rng.range(2.4, 4.0);
    if (fr > h.rr + 2.4) { h.cx = 0; h.cy = 0; }
    else {
      const a = fr > 1e-3 ? Math.atan2(p.flowY, p.flowX) + Math.PI : rng() * TAU;
      const rr2 = clamp(fr + h.rr + 2.4, 0, TUBE_R - 0.4);
      h.cx = Math.cos(a) * rr2 * 0.6; h.cy = Math.sin(a) * rr2 * 0.6;
      h.rr = Math.max(0.8, Math.hypot(h.cx - p.flowX, h.cy - p.flowY) - 2.3);
    }
    h.spin = rng.range(0.2, 0.8) * rng.sign();
    h.parts.body.position.set(h.cx, h.cy, 0);
    h.parts.body.scale.setScalar(h.rr);
    h.parts.halo.position.set(h.cx, h.cy, 0);
    h.parts.halo.scale.setScalar(h.rr * 1.45);
  },
  tick(h, t) { h.parts.body.rotation.set(t * h.spin * 0.5, t * h.spin, 0); },
  sdf(h, x, y) { return Math.hypot(x - h.cx, y - h.cy) - h.rr; },
};

/* ---- ZAPPER: energy beams on a duty cycle, telegraphed while idle. ---- */
KINDS.zapper = {
  depth: 1.6,
  create(M) {
    const g = new THREE.Group();
    const nodes = newInstanced(UNIT_BOX, M.hot, 4);
    const b0 = new THREE.Mesh(UNIT_CYL_X, M.beamOff);
    const b1 = new THREE.Mesh(UNIT_CYL_X, M.beamOff);
    g.add(nodes, b0, b1);
    return { g, nodes, beams: [b0, b1] };
  },
  reset(h, p) {
    const { rng } = p;
    h.nb = rng.chance(0.45 + p.intensity * 0.3) ? 2 : 1;
    h.beams = h.beams || [];
    const R = TUBE_R + 2.5;
    for (let i = 0; i < h.nb; i++) {
      const th = rng() * TAU;
      const nx = -Math.sin(th), ny = Math.cos(th);
      const fn = p.flowX * nx + p.flowY * ny;
      // Keep the beam clear of the flow lane.
      const side = rng.sign();
      let off = fn + side * rng.range(2.7, 4.6);
      if (Math.abs(off) > TUBE_R - 0.6) off = fn - side * rng.range(2.7, 4.6);
      off = clamp(off, -(TUBE_R - 0.6), TUBE_R - 0.6);
      const half = Math.sqrt(Math.max(1, R * R - off * off));
      const period = rng.range(1.5, 2.8);
      h.beams[i] = {
        th, nx, ny, off, half, bt: 0.42, period,
        onFrac: rng.range(0.34, 0.5),
        // Phase so the beam is OFF when the player is expected to arrive.
        aim: 0.5 + rng.range(0.06, 0.22),
        phase: 0,
        on: false,
      };
    }
    h.parts.nodes.count = h.nb * 2;
    for (let i = 0; i < 2; i++) h.parts.beams[i].visible = i < h.nb;
    KINDS.zapper.rephase(h, p.arriveT);
  },
  tick(h, t, dt, M) {
    for (let i = 0; i < h.nb; i++) {
      const b = h.beams[i];
      const ph = (((t + b.phase) % b.period) + b.period) % b.period;
      const frac = ph / b.period;
      b.on = frac < b.onFrac;
      const warn = !b.on && frac > b.onFrac && (1 - frac) / (1 - b.onFrac) < 0.22;
      const mesh = h.parts.beams[i];
      const cx = b.nx * b.off, cy = b.ny * b.off;
      const thick = b.on ? b.bt * 2 : warn ? 0.30 : 0.13;
      mesh.position.set(cx, cy, 0);
      mesh.rotation.z = b.th;
      mesh.scale.set(b.half * 2, thick, thick);
      mesh.material = b.on ? M.beamOn : M.beamOff;
      // Nodes at each end.
      const dx = Math.cos(b.th), dy = Math.sin(b.th);
      setInst(h.parts.nodes, i * 2, cx + dx * b.half, cy + dy * b.half, 0, b.th, 1.0, 1.0, 1.5);
      setInst(h.parts.nodes, i * 2 + 1, cx - dx * b.half, cy - dy * b.half, 0, b.th, 1.0, 1.0, 1.5);
    }
    h.parts.nodes.instanceMatrix.needsUpdate = true;
  },
  rephase(h, arriveT) {
    for (let i = 0; i < h.nb; i++) {
      const b = h.beams[i];
      b.phase = -(arriveT % b.period) + b.period * b.aim;
    }
  },
  sdf(h, x, y) {
    let best = Infinity;
    for (let i = 0; i < h.nb; i++) {
      const b = h.beams[i];
      if (!b.on) continue;
      const d = Math.abs(x * b.nx + y * b.ny - b.off) - b.bt;
      const along = Math.abs(x * Math.cos(b.th) + y * Math.sin(b.th));
      const dd = along > b.half ? Math.hypot(d, along - b.half) : d;
      if (dd < best) best = dd;
    }
    return best;
  },
};

export const HAZARD_KINDS = Object.keys(KINDS);
export { KINDS };

/* ------------------------------------------------------------------ */
/* Pool                                                                */
/* ------------------------------------------------------------------ */

export class HazardPool {
  constructor(scene, materials) {
    this.scene = scene;
    this.M = materials;
    this.free = new Map();
    for (const k of HAZARD_KINDS) this.free.set(k, []);
  }

  acquire(kind) {
    const list = this.free.get(kind);
    let h = list.pop();
    if (!h) {
      const parts = KINDS[kind].create(this.M);
      h = { kind, parts, root: parts.g, depth: KINDS[kind].depth };
      h.root.matrixAutoUpdate = true;
      this.scene.add(h.root);
    }
    h.root.visible = true;
    return h;
  }

  release(h) {
    h.root.visible = false;
    this.free.get(h.kind).push(h);
  }
}
