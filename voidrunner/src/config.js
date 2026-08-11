// VOIDRUNNER - tunable constants.
// Everything that defines "feel" lives here so it can be tuned in one place.

export const TUBE_R = 9.0;          // playable radius of the corridor
export const SHIP_R = 0.62;         // ship collision radius (cross-section)
export const GRAZE_R = 1.55;        // extra radius that counts as a near-miss

export const SPEED_BASE = 46;       // units/sec at the start of a run
export const SPEED_MAX = 132;       // asymptotic top speed
export const SPEED_RAMP = 5200;     // metres over which speed approaches max
export const OVERDRIVE_SPEED = 1.45;
export const OVERDRIVE_TIME = 5.0;
export const OVERDRIVE_SCORE = 3;

export const LATERAL_MAX = 27;      // max lateral speed of the ship (units/sec)
export const LATERAL_CHASE = 12.5;  // how hard the ship chases the input target
export const LATERAL_LAMBDA = 17;   // how quickly it reaches that chase speed

export const CAM_BACK = 7.0;
export const CAM_UP = 1.35;
export const CAM_LOOK = 26;
export const CAM_LAG = 7.5;         // higher = snappier camera
export const CAM_OFFSET_FOLLOW = 0.62;

export const FOG_NEAR = 55;
export const FOG_FAR = 330;
export const DRAW_DIST = 350;

export const RING_SPACING = 7.0;
export const RING_COUNT = 62;
export const RAIL_SEG = 12;
export const RAIL_COUNT = 30;
export const RAIL_LINES = 6;
export const STRUCT_COUNT = 90;

export const SHIELD_INVULN = 1.35;  // seconds of mercy after a hit
export const ZONE_LENGTH = 1500;    // metres per zone
export const ZONE_FADE = 220;       // metres of colour cross-fade at a boundary

// Scoring
export const SCORE_PER_METRE = 0.9;
export const SCORE_CELL = 50;
export const SCORE_GRAZE = 25;
export const MULT_MAX = 10;
export const HEAT_DRAIN = 0.42;     // multiplier heat lost per second
export const GRAZE_TICK = 0.05;     // seconds between graze spark bursts

// Overdrive is charged mostly by skill (near-misses), only trickled by cells,
// so it lands roughly every 20-30 seconds of committed flying.
export const CHARGE_PER_CELL = 0.0022;
export const CHARGE_PER_GRAZE = 0.035;

export const CELL_MAGNET = 4.2;     // base pickup magnet radius

// Spawner
export const SPAWN_AHEAD = 340;
export const GAP_START = 66;        // metres between hazards at distance 0
export const GAP_MIN = 27;
export const GAP_RAMP = 4200;

export const REBASE_AT = 10000;     // rebase world z to keep float precision tight
