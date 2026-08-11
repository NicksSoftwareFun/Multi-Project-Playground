// Local save. localStorage only - nothing leaves the device, ever.

import { makeRng } from './util.js';

const KEY = 'voidrunner.save.v1';

const DEFAULTS = () => ({
  v: 1,
  cells: 0,
  best: { score: 0, dist: 0, sector: 1 },
  runs: [],
  ship: 'scout',
  unlocked: ['scout'],
  settings: { music: true, sfx: true, roll: true, sens: 1, mode: 'relative', quality: 'auto', haptics: true },
  stats: { runs: 0, dist: 0, cells: 0, grazes: 0, overdrives: 0, sector: 1 },
  contracts: null,
  seen: false,
});

const CONTRACT_POOL = [
  { id: 'dist', text: (n) => `Reach ${n}m in a single run`, targets: [1200, 2000, 3000, 4200, 6000], reward: [90, 140, 210, 300, 420] },
  { id: 'cells', text: (n) => `Collect ${n} cells in one run`, targets: [40, 70, 110, 160, 220], reward: [80, 130, 200, 290, 400] },
  { id: 'graze', text: (n) => `Land ${n} near-misses in one run`, targets: [25, 45, 75, 110, 150], reward: [100, 160, 240, 340, 460] },
  { id: 'mult', text: (n) => `Hold a x${n} multiplier`, targets: [3, 4, 5, 6, 8], reward: [110, 170, 250, 350, 480] },
  { id: 'over', text: (n) => `Trigger overdrive ${n} times in one run`, targets: [1, 2, 3, 4, 5], reward: [90, 150, 220, 310, 420] },
  { id: 'sector', text: (n) => `Push into Sector ${n}`, targets: [2, 3, 4, 5, 7], reward: [120, 190, 280, 380, 520] },
  { id: 'clean', text: (n) => `Reach ${n}m without losing a shield`, targets: [900, 1500, 2200, 3200, 4500], reward: [140, 220, 320, 440, 600] },
  { id: 'score', text: (n) => `Score ${n} in one run`, targets: [20000, 45000, 90000, 160000, 260000], reward: [110, 180, 270, 380, 500] },
];

export class Save {
  constructor() {
    this.data = DEFAULTS();
    this.load();
    if (!this.data.contracts) this.rollContracts(true);
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const d = DEFAULTS();
        this.data = {
          ...d, ...parsed,
          best: { ...d.best, ...(parsed.best || {}) },
          settings: { ...d.settings, ...(parsed.settings || {}) },
          stats: { ...d.stats, ...(parsed.stats || {}) },
          unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked : d.unlocked,
          runs: Array.isArray(parsed.runs) ? parsed.runs.slice(0, 8) : [],
        };
      }
    } catch { /* corrupt or blocked storage - play with defaults */ }
  }

  flush() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  get settings() { return this.data.settings; }

  setSetting(k, v) { this.data.settings[k] = v; this.flush(); }

  isUnlocked(id) { return this.data.unlocked.includes(id); }

  unlock(id) {
    if (!this.isUnlocked(id)) { this.data.unlocked.push(id); this.flush(); }
  }

  spend(n) {
    if (this.data.cells < n) return false;
    this.data.cells -= n;
    this.flush();
    return true;
  }

  /** Three rolling contracts. Difficulty steps up as lifetime stats grow. */
  rollContracts(all = false) {
    const rng = makeRng((Date.now() ^ (this.data.stats.runs * 2654435761)) >>> 0);
    const tier = Math.min(4, Math.floor(this.data.stats.runs / 12));
    const make = () => {
      const p = CONTRACT_POOL[rng.int(0, CONTRACT_POOL.length - 1)];
      const lvl = Math.min(4, Math.max(0, tier + rng.int(-1, 1)));
      return { id: p.id, n: p.targets[lvl], reward: p.reward[lvl], text: p.text(p.targets[lvl]), done: false };
    };
    if (all || !this.data.contracts) {
      this.data.contracts = [make(), make(), make()];
    } else {
      this.data.contracts = this.data.contracts.map((c) => (c.done ? make() : c));
    }
    this.flush();
  }

  /**
   * Fold a finished run into the save. Returns the contracts that completed.
   */
  commitRun(run) {
    const d = this.data;
    d.cells += run.cells;
    d.stats.runs++;
    d.stats.dist += Math.floor(run.dist);
    d.stats.cells += run.cells;
    d.stats.grazes += run.grazes;
    d.stats.overdrives += run.overdrives;
    d.stats.sector = Math.max(d.stats.sector, run.sector);

    const newBest = run.score > d.best.score;
    if (newBest) d.best.score = Math.floor(run.score);
    d.best.dist = Math.max(d.best.dist, Math.floor(run.dist));
    d.best.sector = Math.max(d.best.sector, run.sector);

    d.runs.push({ score: Math.floor(run.score), dist: Math.floor(run.dist), sector: run.sector, ship: run.ship });
    d.runs.sort((a, b) => b.score - a.score);
    d.runs = d.runs.slice(0, 8);

    const completed = [];
    for (const c of d.contracts) {
      if (c.done) continue;
      let v = 0;
      switch (c.id) {
        case 'dist': v = run.dist; break;
        case 'cells': v = run.cells; break;
        case 'graze': v = run.grazes; break;
        case 'mult': v = run.bestMult; break;
        case 'over': v = run.overdrives; break;
        case 'sector': v = run.sector; break;
        case 'clean': v = run.cleanDist; break;
        case 'score': v = run.score; break;
      }
      if (v >= c.n) { c.done = true; d.cells += c.reward; completed.push(c); }
    }

    this.flush();
    return { newBest, completed };
  }

  wipe() {
    this.data = DEFAULTS();
    this.rollContracts(true);
    this.flush();
  }
}
