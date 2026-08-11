// Zone definitions. A zone is a visual palette + a hazard diet + a tempo.
// After the last zone the list loops with an increasing difficulty tier, which
// is what keeps deep runs interesting instead of just faster.

import { ZONE_LENGTH, ZONE_FADE } from './config.js';
import { clamp } from './util.js';

export const ZONES = [
  {
    name: 'DRIFT', tag: 'OUTER APPROACH',
    fog: 0x050b1a, bg: 0x0a1836, ring: 0x2ee6ff, ringAlt: 0x7c5cff,
    hazard: 0x2ee6ff, hazEdge: 0xa8f6ff, accent: 0xffd166, struct: 0x101c33,
    speedMul: 1.0, densityMul: 1.15,
    music: { root: 45, scale: [0, 3, 5, 7, 10], tempo: 122, bright: 0.35 },
    hazards: [
      { k: 'gate', w: 30 }, { k: 'bars', w: 22 }, { k: 'ringgate', w: 16 },
      { k: 'spinner', w: 12 }, { k: 'block', w: 12 }, { k: 'mine', w: 8 },
    ],
  },
  {
    name: 'FOUNDRY', tag: 'SMELTWORKS',
    fog: 0x1a0803, bg: 0x3a1204, ring: 0xff8b25, ringAlt: 0xffd166,
    hazard: 0xff6a1f, hazEdge: 0xffd9a0, accent: 0x35f0d0, struct: 0x2a1207,
    speedMul: 1.04, densityMul: 1.0,
    music: { root: 43, scale: [0, 2, 3, 5, 7, 8, 10], tempo: 128, bright: 0.5 },
    hazards: [
      { k: 'spinner', w: 26 }, { k: 'block', w: 24 }, { k: 'bars', w: 20 },
      { k: 'gate', w: 16 }, { k: 'orb', w: 10 }, { k: 'mine', w: 8 },
    ],
  },
  {
    name: 'CRYO', tag: 'GLACIER VAULT',
    fog: 0x061620, bg: 0x0d2b3a, ring: 0xa8f0ff, ringAlt: 0xffffff,
    hazard: 0x8fe4ff, hazEdge: 0xffffff, accent: 0xff5c8a, struct: 0x0e2330,
    speedMul: 1.08, densityMul: 0.95,
    music: { root: 48, scale: [0, 2, 3, 5, 7, 9, 10], tempo: 118, bright: 0.7 },
    hazards: [
      { k: 'aperture', w: 26 }, { k: 'mine', w: 22 }, { k: 'gate', w: 18 },
      { k: 'ringgate', w: 16 }, { k: 'bars', w: 12 }, { k: 'spinner', w: 10 },
    ],
  },
  {
    name: 'REACTOR', tag: 'CORE BLEED',
    fog: 0x02160a, bg: 0x06331a, ring: 0x5cff9d, ringAlt: 0xd6ff3d,
    hazard: 0x4dff8f, hazEdge: 0xeaffb0, accent: 0xff4ddb, struct: 0x08241a,
    speedMul: 1.12, densityMul: 0.9,
    music: { root: 41, scale: [0, 1, 3, 5, 7, 8, 10], tempo: 134, bright: 0.45 },
    hazards: [
      { k: 'zapper', w: 28 }, { k: 'spinner', w: 22 }, { k: 'gate', w: 16 },
      { k: 'aperture', w: 14 }, { k: 'orb', w: 12 }, { k: 'bars', w: 12 },
    ],
  },
  {
    name: 'NEBULA', tag: 'VEILWORKS',
    fog: 0x14051f, bg: 0x2c0a44, ring: 0xd05cff, ringAlt: 0x35d6ff,
    hazard: 0xc44dff, hazEdge: 0xf5c8ff, accent: 0x9dff5c, struct: 0x1d0a2c,
    speedMul: 1.16, densityMul: 0.86,
    music: { root: 44, scale: [0, 2, 4, 6, 7, 9, 11], tempo: 126, bright: 0.8 },
    hazards: [
      { k: 'gate', w: 18 }, { k: 'spinner', w: 18 }, { k: 'bars', w: 16 },
      { k: 'ringgate', w: 14 }, { k: 'zapper', w: 14 }, { k: 'block', w: 12 },
      { k: 'mine', w: 10 }, { k: 'aperture', w: 10 },
    ],
  },
  {
    name: 'SINGULARITY', tag: 'EVENT HORIZON',
    fog: 0x000000, bg: 0x140f04, ring: 0xffd94d, ringAlt: 0xffffff,
    hazard: 0xffc53d, hazEdge: 0xffffff, accent: 0x4de1ff, struct: 0x0a0a0a,
    speedMul: 1.22, densityMul: 0.8,
    music: { root: 39, scale: [0, 2, 4, 6, 8, 10], tempo: 140, bright: 0.6 },
    hazards: [
      { k: 'spinner', w: 20 }, { k: 'zapper', w: 20 }, { k: 'aperture', w: 16 },
      { k: 'gate', w: 16 }, { k: 'orb', w: 14 }, { k: 'block', w: 14 },
      { k: 'bars', w: 14 }, { k: 'ringgate', w: 12 }, { k: 'mine', w: 10 },
    ],
  },
];

/**
 * Where are we? Returns the active zone, the one we are fading into, and the
 * 0..1 blend between them, plus the loop tier (0 on the first pass).
 */
export function zoneAt(distance) {
  const raw = Math.floor(distance / ZONE_LENGTH);
  const idx = ((raw % ZONES.length) + ZONES.length) % ZONES.length;
  const tier = Math.floor(raw / ZONES.length);
  const into = distance - raw * ZONE_LENGTH;
  const nextIdx = (idx + 1) % ZONES.length;
  const nextTier = nextIdx === 0 ? tier + 1 : tier;

  // Cross-fade over the last ZONE_FADE metres of the zone.
  const blend = clamp((into - (ZONE_LENGTH - ZONE_FADE)) / ZONE_FADE, 0, 1);

  return {
    index: idx, zone: ZONES[idx], tier,
    next: ZONES[nextIdx], nextTier,
    blend, into, raw,
    progress: into / ZONE_LENGTH,
  };
}

/** Difficulty multipliers for a given loop tier. */
export function tierSpeed(tier) { return 1 + Math.min(tier, 6) * 0.055; }
export function tierDensity(tier) { return Math.max(0.62, 1 - Math.min(tier, 6) * 0.06); }

export function zoneLabel(info) {
  const n = info.raw + 1;
  return `SECTOR ${String(n).padStart(2, '0')} · ${info.zone.name}`;
}
