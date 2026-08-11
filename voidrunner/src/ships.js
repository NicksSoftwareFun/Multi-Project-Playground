// The hangar. Everything is unlocked with cells you collect by playing -
// there is no other currency, and nothing here is for sale.

export const SHIPS = [
  {
    id: 'scout', name: 'SCOUT MK-I', cost: 0,
    blurb: 'Standard issue. Nothing special, good at everything.',
    color: 0x7fe9ff, accent: 0xffffff, trail: 0x2ee6ff,
    stats: { handling: 1.0, shields: 3, magnet: 1.0, graze: 1.0, charge: 1.0, score: 1.0 },
    shape: { len: 2.6, wide: 0.62, span: 1.55, sweep: 0.55, fins: 2, engines: 2, canopy: 0.34 },
  },
  {
    id: 'vector', name: 'VECTOR', cost: 400,
    blurb: 'Twitchy interceptor. Turns on a coin, folds like paper.',
    color: 0xff7a4d, accent: 0xffe0a0, trail: 0xff8b25,
    stats: { handling: 1.32, shields: 2, magnet: 1.0, graze: 1.05, charge: 1.0, score: 1.08 },
    shape: { len: 3.1, wide: 0.5, span: 1.15, sweep: 0.85, fins: 2, engines: 1, canopy: 0.28 },
  },
  {
    id: 'aegis', name: 'AEGIS', cost: 900,
    blurb: 'Hauler plating. Slow to answer the stick, hard to kill.',
    color: 0x9dff8f, accent: 0xe8ffd0, trail: 0x5cff9d,
    stats: { handling: 0.86, shields: 5, magnet: 1.2, graze: 1.0, charge: 0.9, score: 1.0 },
    shape: { len: 2.4, wide: 0.95, span: 1.9, sweep: 0.3, fins: 4, engines: 4, canopy: 0.42 },
  },
  {
    id: 'phantom', name: 'PHANTOM', cost: 1800,
    blurb: 'Runs cold and close. Near-misses register from further out.',
    color: 0xd88bff, accent: 0xffd6ff, trail: 0xc44dff,
    stats: { handling: 1.16, shields: 2, magnet: 1.1, graze: 1.55, charge: 1.15, score: 1.18 },
    shape: { len: 3.0, wide: 0.55, span: 2.1, sweep: 0.72, fins: 3, engines: 2, canopy: 0.3 },
  },
  {
    id: 'singularity', name: 'SINGULARITY', cost: 3500,
    blurb: 'Prototype drive. Bends cells toward you and charges fast.',
    color: 0xffd94d, accent: 0xffffff, trail: 0xffc53d,
    stats: { handling: 1.24, shields: 3, magnet: 1.85, graze: 1.25, charge: 1.45, score: 1.25 },
    shape: { len: 2.8, wide: 0.7, span: 1.7, sweep: 0.62, fins: 4, engines: 3, canopy: 0.36 },
  },
];

export const shipById = (id) => SHIPS.find((s) => s.id === id) || SHIPS[0];
