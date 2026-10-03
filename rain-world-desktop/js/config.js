// Default configuration. Everything here can be overridden from the debug
// panel (` key), which saves to localStorage, or by editing this file.
//
// Spawning: the spawner keeps the ecosystem near `ecosystem.maxPopulation`.
// Each time it spawns it picks a species at random, in proportion to `weight`,
// from the species that are enabled and below their own `max`.
// `popCost` is how much one individual counts toward maxPopulation (a batfly
// is a fraction of a slugcat; a Daddy Long Legs is several).
(function () {
  'use strict';
  const RW = (window.RW = window.RW || {});

  RW.DEFAULT_CONFIG = {
    world: {
      palette: 'industrial', // industrial | shoreline | outskirts | chimney | subterranean
      mapSize: 1, // how much world fits on screen: bigger = more map, everything smaller
      pixelScale: 2, // 1 = full res, 2-3 = chunkier Rain World pixels
      cellSize: 20, // navigation grid cell (px). Rain World tiles are 20px.
      seed: 0, // 0 = new background every load
      decorLedges: 6, // wallpaper ledges creatures can use
      decorPoles: 7, // climbable poles in the wallpaper
      ledgePoles: 0.6, // chance a ledge gets a pole standing on it (linking up to a higher ledge if there is one)
      fruitPlants: 5,
      timeScale: 1,
      maxFps: 60, // 30 halves drawing cost; the simulation is unaffected
    },
    rain: {
      enabled: true,
      cycleMinutes: 4, // length of one rain cycle
      downpourFraction: 0.12, // final part of the cycle that is a downpour
      shelterDuringDownpour: true, // creatures retreat into dens when the rain hits
      drizzle: 0.24, // light rain outside the downpour (0-1)
      drips: 0.7, // water dripping from window/icon/ledge undersides (0 = none)
      curtains: true, // faint drifting sheets of rain
      showCycleHud: true,
    },
    ecosystem: {
      maxPopulation: 12,
      spawnPerMinute: 2.5, // new arrivals per minute while below the population cap
      startPopulated: true, // fill the screen immediately on load
      predation: true, // predators actually eat prey (off = chase, bite, release)
      migrationPerMinute: 0.3,
      rocks: 6, // rocks kept lying about for slugcats to throw
      spears: 2, // spears likewise (the wiki: about one weapon in five is a spear) // chance per creature per minute to wander off into a den
      cursorInteraction: true,
      clickDropsFood: true,
    },
    debug: {
      showGrid: false,
      showPaths: false,
      showLabels: false,
      showFps: false,
    },
    species: {
      slugcat: {
        label: 'Slugcat',
        enabled: true,
        weight: 4,
        max: 4,
        popCost: 1,
        params: {
          speed: 105,
          runSpeed: 175,
          climbSpeed: 80,
          jumpX: 7, // cells
          jumpUp: 5, // cells
          vision: 260,
          escapeChance: 0.25, // per second while held by a predator
          variants: { survivor: 6, monk: 2, hunter: 1 },
          colors: { survivor: '#f1f1f4', monk: '#f4ee82', hunter: '#ff7070' },
        },
      },
      lizard_pink: {
        label: 'Pink Lizard',
        enabled: true,
        weight: 3,
        max: 2,
        popCost: 1.5,
        params: {
          headColor: '#ff36c4',
          bodyColor: '#120b11',
          length: 1.0,
          speed: 49, // wiki baseSpeed 4.1 x 12
          huntSpeed: 83,
          climbWalls: false,
          climbCeilings: false,
          poles: true,
          vision: 297,
          mass: 2.1, // wiki bodyMass
          chargeRate: 0.05, // wiki loungeTendency: chance to pounce from afar
          biteDelay: 12, // wiki biteDelay (frames at 40fps): windup before a bite
          biteRange: 60, // wiki attemptBiteRadius x 0.75
          biteDamage: 1, // wiki biteDamage (lizard fights)
          toughness: 1, // wiki toughness
          spines: 0,
          pattern: 'dapple',
          tailTip: true,
        },
      },
      lizard_green: {
        label: 'Green Lizard',
        enabled: true,
        weight: 2,
        max: 2,
        popCost: 1.5,
        params: {
          headColor: '#41f53c',
          bodyColor: '#0c0d10',
          length: 1.25,
          speed: 80, // wiki baseSpeed 6.7 x 12
          huntSpeed: 136,
          climbWalls: false,
          climbCeilings: false,
          poles: false,
          vision: 280,
          mass: 7.5, // wiki bodyMass
          chargeRate: 1.0, // wiki loungeTendency: chance to pounce from afar
          biteDelay: 20, // wiki biteDelay (frames at 40fps): windup before a bite
          biteRange: 75, // wiki attemptBiteRadius x 0.75
          biteDamage: 2, // wiki biteDamage (lizard fights)
          toughness: 2.5, // wiki toughness
          spines: 9,
          pattern: 'dots',
        },
      },
      lizard_blue: {
        label: 'Blue Lizard',
        enabled: true,
        weight: 3,
        max: 2,
        popCost: 1.2,
        params: {
          headColor: '#2d8cff',
          bodyColor: '#0c0d10',
          length: 0.8,
          speed: 38, // wiki baseSpeed 3.2 x 12
          huntSpeed: 65,
          climbWalls: true,
          climbCeilings: true,
          poles: true,
          vision: 314,
          mass: 1.4, // wiki bodyMass
          chargeRate: 0.01, // wiki loungeTendency: chance to pounce from afar
          biteDelay: 14, // wiki biteDelay (frames at 40fps): windup before a bite
          biteRange: 68, // wiki attemptBiteRadius x 0.75
          biteDamage: 0.7, // wiki biteDamage (lizard fights)
          toughness: 0.5, // wiki toughness
          spines: 0,
          pattern: 'fins',
          tailTip: true,
        },
      },
      lizard_white: {
        label: 'White Lizard',
        enabled: true,
        weight: 1,
        max: 1,
        popCost: 1.5,
        params: {
          headColor: '#b6bac3',
          bodyColor: '#e9e9ec',
          length: 1.05,
          speed: 46, // wiki baseSpeed 3.8 x 12
          huntSpeed: 78,
          climbWalls: true,
          climbCeilings: false,
          poles: true,
          vision: 396,
          mass: 2.1, // wiki bodyMass
          chargeRate: 0.05, // wiki loungeTendency: chance to pounce from afar
          biteDelay: 15, // wiki biteDelay (frames at 40fps): windup before a bite
          biteRange: 64, // wiki attemptBiteRadius x 0.75
          biteDamage: 1, // wiki biteDamage (lizard fights)
          toughness: 0.9, // wiki toughness
          spines: 0,
          pattern: 'spots',
          camouflage: true,
        },
      },
      lizard_red: {
        label: 'Red Lizard',
        enabled: true,
        weight: 0.5,
        max: 1,
        popCost: 2,
        params: {
          headColor: '#ff1e2a',
          bodyColor: '#0c0608',
          length: 1.35,
          speed: 60, // wiki baseSpeed 5.0 x 12
          huntSpeed: 102,
          climbWalls: false,
          climbCeilings: false,
          poles: true,
          vision: 520,
          mass: 3.1, // wiki bodyMass
          chargeRate: 0.05, // wiki loungeTendency: chance to pounce from afar
          biteDelay: 2, // wiki biteDelay (frames at 40fps): windup before a bite
          biteRange: 90, // wiki attemptBiteRadius x 0.75
          biteDamage: 4, // wiki biteDamage (lizard fights)
          toughness: 3, // wiki toughness
          stunImmune: true, // wiki: red lizards can't be stunned or flipped by rocks
          spines: 18,
          pattern: 'dots',
        },
      },
      lizard_yellow: {
        label: 'Yellow Lizard',
        enabled: true,
        weight: 1.5,
        max: 2,
        popCost: 1.2,
        params: {
          headColor: '#ffbf1c',
          bodyColor: '#120d06',
          length: 0.95,
          speed: 49, // wiki baseSpeed 4.1 x 12
          huntSpeed: 83,
          climbWalls: false,
          climbCeilings: false,
          poles: true,
          vision: 297,
          mass: 1.7, // wiki bodyMass
          chargeRate: 0.05, // wiki loungeTendency: chance to pounce from afar
          biteDelay: 21, // wiki biteDelay (frames at 40fps): windup before a bite
          biteRange: 30, // wiki attemptBiteRadius x 0.75
          biteDamage: 0.8, // wiki biteDamage (lizard fights)
          toughness: 0.8, // wiki toughness
          spines: 0,
          pattern: 'dapple',
          tailTip: true,
        },
      },
      lizard_cyan: {
        label: 'Cyan Lizard',
        enabled: true,
        weight: 1,
        max: 1,
        popCost: 1.2,
        params: {
          headColor: '#18d8e8',
          bodyColor: '#0a0d10',
          length: 0.95,
          speed: 58, // wiki baseSpeed 4.85 x 12
          huntSpeed: 99,
          climbWalls: true,
          climbCeilings: true,
          poles: true,
          vision: 327,
          mass: 2.0, // wiki bodyMass
          chargeRate: 0.033, // wiki loungeTendency: chance to pounce from afar
          biteDelay: 12, // wiki biteDelay (frames at 40fps): windup before a bite
          biteRange: 68, // wiki attemptBiteRadius x 0.75
          biteDamage: 1, // wiki biteDamage (lizard fights)
          toughness: 0.9, // wiki toughness
          spines: 0,
          pattern: 'rings',
        },
      },
      daddy: {
        label: 'Daddy Long Legs',
        enabled: true,
        weight: 0.3,
        max: 1,
        popCost: 4,
        params: {
          variants: { daddy: 2, brother: 1 },
          tentacles: 8,
          reach: 250,
          speed: 42,
          bodyRadius: 24,
        },
      },
      dropwig: {
        label: 'Dropwig',
        enabled: true,
        weight: 2,
        max: 2,
        popCost: 1,
        params: {
          speed: 85,
          triggerWidth: 26, // how close (horizontally) prey must pass beneath
          patience: 70, // seconds before giving up on an ambush spot
        },
      },
      batfly: {
        label: 'Batflies',
        enabled: true,
        weight: 3,
        max: 14,
        popCost: 0, // batflies don't count toward max population (their own max still applies)
        params: {
          flockSize: [3, 6],
          speed: 110,
        },
      },
      centipede: {
        label: 'Small Centipede',
        enabled: true,
        weight: 5, // common: something for everyone to hunt
        max: 6,
        popCost: 0.5,
        params: {
          segments: [6, 9],
          speed: 55,
          huntSpeed: 80,
          diet: ['batfly'], // small ones snatch batflies
        },
      },
      centipede_medium: {
        label: 'Medium Centipede',
        enabled: true,
        weight: 1,
        max: 2,
        popCost: 1.5,
        params: {
          size: 1.5,
          segments: [8, 11],
          speed: 45,
          huntSpeed: 85,
          toughness: 1.5,
          diet: ['slugcat', 'centipede', 'dropwig'], // bigger prey than batflies
          threats: ['daddy', 'centipede_large', 'lizard_*'],
          colors: ['#d0662a', '#dc8a2e', '#6a2412', '#5a1e10'],
        },
      },
      centipede_large: {
        label: 'Large Centipede',
        enabled: true,
        weight: 0.5,
        max: 1,
        popCost: 3,
        params: {
          size: 2,
          segments: [10, 13],
          speed: 38,
          huntSpeed: 95, // a burst of speed that can run down the slower lizards
          toughness: 3,
          diet: ['lizard_*', 'slugcat', 'centipede_medium', 'dropwig'], // hunts lizards
          threats: ['daddy'],
          colors: ['#b8401e', '#c45a24', '#4a160c', '#3c120a'],
        },
      },
    },
  };

  const STORAGE_KEY = 'rw-desktop-config-v9'; // bumped when defaults change shape

  RW.loadConfig = function () {
    const cfg = RW.U.clone(RW.DEFAULT_CONFIG);
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) RW.U.deepMerge(cfg, JSON.parse(saved));
    } catch (e) {
      /* storage blocked or corrupt — run on defaults */
    }
    return cfg;
  };

  RW.saveConfig = function (cfg) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {
      /* ignore */
    }
  };

  RW.clearSavedConfig = function () {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
  };
})();
