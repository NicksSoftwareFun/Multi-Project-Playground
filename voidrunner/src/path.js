// The corridor centreline.
//
// The world is infinite, so the path is an analytic function of the ABSOLUTE
// distance Z rather than a baked spline. That means:
//   * no memory growth, no regeneration seams
//   * we can rebase rendered z coordinates (float32 precision) without the
//     shape of the corridor changing, because the shape only depends on Z.
//
// Everything in the game is expressed in "tube space": a point is
//   world = centre(Z) + right(Z) * ox + up(Z) * oy
// where (ox, oy) is the cross-section offset the player actually controls.

import { clamp } from './util.js';

const F1 = 0.0038, F2 = 0.0101, G1 = 0.0029, G2 = 0.0083;
const AX1 = 30, AX2 = 12, AY1 = 22, AY2 = 9;
const ROLL_AMP = 0.26, ROLL_F = 0.0021;

let curveScale = 1;   // grows slowly with distance, set by the game each frame
let rollEnabled = true;

export function setCurveScale(s) { curveScale = clamp(s, 0.35, 1.6); }
export function setRollEnabled(v) { rollEnabled = !!v; }

/** Cross-section centre of the corridor at absolute distance Z. */
export function centreX(Z) {
  return curveScale * (AX1 * Math.sin(Z * F1) + AX2 * Math.sin(Z * F2 + 1.7));
}
export function centreY(Z) {
  return curveScale * (AY1 * Math.cos(Z * G1) + AY2 * Math.sin(Z * G2 + 0.6));
}

function dCentreX(Z) {
  return curveScale * (AX1 * F1 * Math.cos(Z * F1) + AX2 * F2 * Math.cos(Z * F2 + 1.7));
}
function dCentreY(Z) {
  return curveScale * (-AY1 * G1 * Math.sin(Z * G1) + AY2 * G2 * Math.cos(Z * G2 + 0.6));
}

export function rollAt(Z) {
  return rollEnabled ? ROLL_AMP * Math.sin(Z * ROLL_F) + ROLL_AMP * 0.5 * Math.sin(Z * ROLL_F * 2.7 + 2.1) : 0;
}

/**
 * Orthonormal frame at Z. Writes into the three provided plain {x,y,z} objects.
 * The frame is built from a fixed world-up reference so it never flips or
 * accumulates drift, then rolled by rollAt(Z) for a bit of drama.
 */
export function frameAt(Z, right, up, tangent) {
  const tx = dCentreX(Z), ty = dCentreY(Z);
  const tl = Math.hypot(tx, ty, 1);
  const Tx = tx / tl, Ty = ty / tl, Tz = 1 / tl;

  // right = normalize(worldUp x T) with worldUp = (0,1,0)
  let rx = 1 * Tz - 0 * Ty;   //  up.y*T.z - up.z*T.y
  let ry = 0 * Tx - 0 * Tz;   //  up.z*T.x - up.x*T.z
  let rz = 0 * Ty - 1 * Tx;   //  up.x*T.y - up.y*T.x
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;

  // up = T x right
  let ux = Ty * rz - Tz * ry;
  let uy = Tz * rx - Tx * rz;
  let uz = Tx * ry - Ty * rx;

  const a = rollAt(Z);
  if (a !== 0) {
    const c = Math.cos(a), s = Math.sin(a);
    const nrx = rx * c + ux * s, nry = ry * c + uy * s, nrz = rz * c + uz * s;
    ux = ux * c - rx * s; uy = uy * c - ry * s; uz = uz * c - rz * s;
    rx = nrx; ry = nry; rz = nrz;
  }

  right.x = rx; right.y = ry; right.z = rz;
  up.x = ux; up.y = uy; up.z = uz;
  tangent.x = Tx; tangent.y = Ty; tangent.z = Tz;
}

const _r = { x: 0, y: 0, z: 0 }, _u = { x: 0, y: 0, z: 0 }, _t = { x: 0, y: 0, z: 0 };

/**
 * Convert tube space (offset ox/oy at absolute Z) to a world position.
 * `relZ` is the rebased z that actually goes into the scene graph.
 */
export function tubeToWorld(Z, relZ, ox, oy, out) {
  frameAt(Z, _r, _u, _t);
  out.set(
    centreX(Z) + _r.x * ox + _u.x * oy,
    centreY(Z) + _r.y * ox + _u.y * oy,
    relZ + _r.z * ox + _u.z * oy
  );
  return out;
}

/** Fill a THREE.Matrix4-compatible basis from the frame at Z (column-major). */
export function frameBasis(Z, m4, px, py, pz) {
  frameAt(Z, _r, _u, _t);
  const e = m4.elements;
  e[0] = _r.x; e[1] = _r.y; e[2] = _r.z; e[3] = 0;
  e[4] = _u.x; e[5] = _u.y; e[6] = _u.z; e[7] = 0;
  e[8] = _t.x; e[9] = _t.y; e[10] = _t.z; e[11] = 0;
  e[12] = px; e[13] = py; e[14] = pz; e[15] = 1;
  return m4;
}

export { _r as scratchRight, _u as scratchUp, _t as scratchTangent };
