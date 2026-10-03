// Behaviour checks: each one runs the simulation headlessly, measures one
// thing that has gone wrong before (bodies folding, dropwigs falling off
// corners, fruit dropping by itself...) and passes or fails on a threshold.
//
//   cd rain-world-desktop/tests && npm install
//   node behaviour.mjs                 all checks (~10-15 min)
//   node behaviour.mjs --quick         shorter runs (~5 min), looser numbers
//   node behaviour.mjs bodies fruit    just the named checks
//   (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
//
// The simulation isn't seeded (only the map is, via ?seed=), so the numbers
// vary run to run. Thresholds sit well clear of the measured values; a check
// that fails once is worth a rerun before digging in, one that fails twice
// is a real regression. A check can also WARN when the random run gave it
// nothing to measure (e.g. no slugcat happened to need a ledge scramble).
import { launch, openPrototype } from './lib.mjs';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const only = args.filter((a) => !a.startsWith('--'));
const T = (min) => (quick ? min / 2 : min); // simulated minutes per check

// Every check: run(page) -> metrics (computed in the page), then
// judge(metrics) -> list of failures (empty = pass) and optional warnings.
const checks = [
  {
    name: 'soak',
    about: 'default settings through two downpours: no errors, no runaway population, active creatures not getting stuck',
    run: (page) =>
      page.evaluate((mins) => {
        const e = RW_APP.engine;
        e.cfg.rain.cycleMinutes = Math.max(1.5, mins / 2);
        // Burrowing away is the safety net for a creature that hasn't moved in
        // a while. One that's sheltering/leaving with no route to a den is
        // meant to slip away like that; an active one stuck is a bug.
        const C = RW.Creature.prototype;
        const bw = C.burrowAway;
        let stuckBurrows = 0;
        let leaveSlips = 0;
        C.burrowAway = function () {
          if (!this.burrow && !this.dead) {
            if (this.state === 'leave') leaveSlips++;
            else stuckBurrows++;
          }
          return bw.apply(this, arguments);
        };
        let bad = 0;
        let peakN = 0;
        let peakPop = 0;
        for (let i = 0; i < mins * 3600; i++) {
          e.tick(1 / 60);
          if (i % 300) continue;
          const eco = e.eco; // always re-read: regenerate() replaces the ecosystem
          peakN = Math.max(peakN, eco.creatures.length);
          peakPop = Math.max(peakPop, eco.population());
          for (const c of eco.creatures) if (!isFinite(c.x) || !isFinite(c.y)) bad++;
        }
        return { bad, peakN, peakPop: +peakPop.toFixed(1), cap: e.cfg.ecosystem.maxPopulation, stuckBurrows, leaveSlips, born: e.eco.stats.born };
      }, T(8)),
    judge: (m) => [
      m.bad && `${m.bad} non-finite creature positions`,
      m.peakN < 5 && 'ecosystem never populated',
      m.peakPop > m.cap * 1.4 && `population ran away (${m.peakPop} vs cap ${m.cap})`,
      // measured: ~0-1 per run (was ~4 before corner clambering)
      m.stuckBurrows > Math.max(3, m.born * 0.04) && `${m.stuckBurrows} active creatures got stuck and burrowed away (of ${m.born})`,
    ],
  },
  {
    name: 'bodies',
    about: 'centipedes never fold in half; lizards never hairpin or ball up on poles',
    run: (page) =>
      page.evaluate((mins) => {
        const e = RW_APP.engine;
        e.cfg.rain.enabled = false;
        e.cfg.ecosystem.predation = false;
        const S = e.cfg.species;
        for (const k in S) S[k].weight = 0;
        Object.assign(S.centipede, { weight: 3 });
        Object.assign(S.centipede_medium, { weight: 2 });
        for (const k of ['lizard_pink', 'lizard_blue', 'lizard_yellow']) S[k].weight = 2;
        S.slugcat.weight = 1;
        e.restartWildlife();
        const st = { centi: [0, 0, 0], lizPole: [0, 0, 0], liz: [0, 0, 0] }; // frames, hairpin joint, balled up
        for (let i = 0; i < mins * 3600; i++) {
          e.tick(1 / 60);
          if (i % 4) continue;
          const W = e.world;
          for (const c of e.eco.creatures) {
            if (c.dead || c.corpse || c.grabbedBy || c.burrow || c.turn) continue;
            let P;
            let n;
            let k;
            if (c.chain && c.species.startsWith('centipede')) {
              P = c.chain.pts;
              n = P.length;
              k = 'centi';
            } else if (c.spine && c.species.startsWith('lizard')) {
              P = c.spine.pts;
              n = c.bodyN + 3;
              const h = P[Math.floor(c.bodyN / 2)];
              const cx = W.cellX(h.x);
              const cy = W.cellY(h.y);
              k = W.pole(cx, cy) && !W.solid(cx, cy + 1) ? 'lizPole' : 'liz';
            } else continue;
            let len = 0;
            let hair = false;
            for (let j = 1; j < n; j++) {
              len += Math.hypot(P[j].x - P[j - 1].x, P[j].y - P[j - 1].y);
              if (j < 2) continue;
              const ax = P[j - 1].x - P[j - 2].x;
              const ay = P[j - 1].y - P[j - 2].y;
              const bx = P[j].x - P[j - 1].x;
              const by = P[j].y - P[j - 1].y;
              if ((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1) < -0.5) hair = true;
            }
            const ratio = Math.hypot(P[n - 1].x - P[0].x, P[n - 1].y - P[0].y) / (len || 1);
            st[k][0]++;
            if (hair) st[k][1]++;
            if (ratio < 0.35) st[k][2]++;
          }
        }
        const pct = (a, i) => +((100 * a[i]) / (a[0] || 1)).toFixed(1);
        return {
          centiFrames: st.centi[0],
          centiHairpinPct: pct(st.centi, 1),
          centiBalledPct: pct(st.centi, 2),
          lizHairpinPct: pct(st.liz, 1),
          lizPoleFrames: st.lizPole[0],
          lizPoleBalledPct: pct(st.lizPole, 2),
        };
      }, T(5)),
    // measured: centipede hairpin 2-7% (was 82%), lizard pole balled 3-5% (was 21%)
    judge: (m) => [
      m.centiFrames < 500 && 'too few centipede frames to judge',
      m.centiHairpinPct > 10 && `centipedes folding (${m.centiHairpinPct}% of frames)`,
      m.centiBalledPct > 6 && `centipedes balled up (${m.centiBalledPct}%)`,
      m.lizHairpinPct > 8 && `lizard bodies hairpinning (${m.lizHairpinPct}%)`,
      m.lizPoleFrames > 300 && m.lizPoleBalledPct > 12 && `lizards balling up on poles (${m.lizPoleBalledPct}%)`,
    ],
  },
  {
    name: 'dropwigs',
    about: 'dropwigs keep their grip round corners and reach ceilings to ambush from',
    run: (page) =>
      page.evaluate((mins) => {
        const e = RW_APP.engine;
        e.cfg.rain.enabled = false;
        e.cfg.ecosystem.predation = false;
        const S = e.cfg.species;
        for (const k in S) S[k].weight = 0;
        S.dropwig.weight = 3;
        S.dropwig.max = 4;
        S.slugcat.weight = 0.5;
        e.restartWildlife();
        let frames = 0;
        let losses = 0;
        let waits = 0;
        const grip = new Map();
        const state = new Map();
        for (let i = 0; i < mins * 3600; i++) {
          e.tick(1 / 60);
          for (const c of e.eco.creatures) {
            if (c.species !== 'dropwig' || c.dead) continue;
            frames++;
            const had = grip.get(c.id);
            grip.set(c.id, !!c.grip);
            if (c.state === 'wait' && state.get(c.id) !== 'wait') waits++;
            state.set(c.id, c.state);
            if (had && !c.grip && (c.state === 'seek' || c.state === 'leave') && !(c.dropT > 0)) losses++;
          }
        }
        const dwMin = frames / 3600;
        return { dropwigMinutes: +dwMin.toFixed(1), gripLossesPerMin: +(losses / (dwMin || 1)).toFixed(2), ambushesSetUp: waits };
      }, T(5)),
    // measured: ~0.25 grip losses per dropwig-minute (was ~50)
    judge: (m) => [
      m.dropwigMinutes < 3 && 'too few dropwigs to judge',
      m.gripLossesPerMin > 3 && `dropwigs losing their grip (${m.gripLossesPerMin}/min)`,
      m.ambushesSetUp < 1 && 'no dropwig ever settled on a ceiling',
    ],
  },
  {
    name: 'scramble',
    about: 'from a pole beside a ledge, creatures scramble up over the lip more often than they slip',
    seed: 21,
    run: (page) =>
      page.evaluate((mins) => {
        const e = RW_APP.engine;
        e.cfg.rain.enabled = false;
        e.cfg.ecosystem.predation = false;
        const S = e.cfg.species;
        for (const k in S) S[k].weight = 0;
        S.slugcat.weight = 3;
        S.lizard_pink.weight = 2;
        S.lizard_yellow.weight = 2;
        e.restartWildlife();
        const out = { slugDone: 0, slugSlip: 0, lizDone: 0, lizSlip: 0 };
        const B = RW.Creature.prototype;
        const ss = B.stepScramble;
        B.stepScramble = function (dt, pt) {
          const r = ss.call(this, dt, pt);
          const who = this.species === 'slugcat' ? 'slug' : 'liz';
          if (r === 'done') out[who + 'Done']++;
          if (r === 'slip') out[who + 'Slip']++;
          return r;
        };
        for (let i = 0; i < mins * 3600; i++) e.tick(1 / 60);
        return out;
      }, T(5)),
    // measured: slugcats ~85% success, lizards ~50% (size-dependent by design)
    judge: (m) => [
      m.slugDone + m.slugSlip >= 4 && m.slugDone < m.slugSlip && `slugcats slip more than they scramble up (${m.slugDone}/${m.slugSlip})`,
    ],
    warn: (m) => m.slugDone + m.slugSlip + m.lizDone + m.lizSlip === 0 && 'no scrambles happened this run',
  },
  {
    name: 'jumps',
    about: 'slugcats jump (pole to pole too), lizards leap between poles, centipedes never jump',
    run: (page) =>
      page.evaluate((mins) => {
        const e = RW_APP.engine;
        e.cfg.rain.enabled = false;
        e.cfg.ecosystem.predation = false;
        const S = e.cfg.species;
        for (const k in S) S[k].weight = 0;
        S.slugcat.weight = 3;
        for (const k of ['lizard_pink', 'lizard_blue', 'lizard_yellow']) S[k].weight = 2;
        S.centipede.weight = 2;
        S.centipede_large.weight = 1;
        e.restartWildlife();
        const out = { slugJumps: 0, slugLongLeaps: 0, lizardLeaps: 0, centipedeJumpCaps: 0 };
        const L = RW.Creatures.Lizard.prototype;
        const ll = L.launchLeap;
        L.launchLeap = function (node) {
          out.lizardLeaps++;
          return ll.call(this, node);
        };
        const Sl = RW.Creatures.Slugcat.prototype;
        const la = Sl.launch;
        Sl.launch = function (node) {
          out.slugJumps++;
          if (this.longJump) out.slugLongLeaps++;
          return la.call(this, node);
        };
        for (const sp of ['centipede', 'centipede_medium', 'centipede_large']) {
          const c = new (e.eco.classFor(sp))(e.eco, sp, 100, 100).caps;
          if (c.jumpX || c.jumpUp) out.centipedeJumpCaps++;
        }
        for (let i = 0; i < mins * 3600; i++) e.tick(1 / 60);
        return out;
      }, T(6)),
    judge: (m) => [m.centipedeJumpCaps && 'centipedes can jump', m.slugJumps < 3 && `slugcats hardly jump (${m.slugJumps})`],
    warn: (m) => (!m.lizardLeaps && 'no lizard pole leaps this run') || (!m.slugLongLeaps && 'no slugcat long leaps this run'),
  },
  {
    name: 'fruit',
    about: 'ripe fruit only drops when hit, and dropped fruit rots instead of piling up',
    run: (page) =>
      page.evaluate((mins) => {
        const e = RW_APP.engine;
        e.cfg.rain.enabled = false;
        let knocks = 0;
        const P = RW.FruitPlant.prototype;
        const ko = P.knockOff;
        P.knockOff = function () {
          if (this.ripe()) knocks++;
          return ko.apply(this, arguments);
        };
        const seen = new Set();
        let maxLoose = 0;
        let oldest = 0;
        for (let i = 0; i < mins * 3600; i++) {
          e.tick(1 / 60);
          if (i % 30) continue;
          let loose = 0;
          for (const it of e.eco.items) {
            if (!(it instanceof RW.Fruit) || it.dead) continue;
            seen.add(it);
            if (!it.heldBy) loose++;
            if (!it.claimedBy && !it.heldBy) oldest = Math.max(oldest, it.age);
          }
          maxLoose = Math.max(maxLoose, loose);
        }
        return { fruitDropped: seen.size, knocks, maxLoose, oldestUnclaimedS: Math.round(oldest) };
      }, T(6)),
    judge: (m) => [
      m.fruitDropped > m.knocks && `fruit appeared without being knocked off (${m.fruitDropped} fruit, ${m.knocks} knocks)`,
      m.maxLoose > 6 && `loose fruit piling up (${m.maxLoose})`,
      m.oldestUnclaimedS > 62 && `fruit not rotting away (${m.oldestUnclaimedS}s old)`,
    ],
  },
  {
    name: 'transients',
    about: 'slugcats and Daddy Long Legs leave after two meals (or a long fruitless while); batflies never run out',
    run: (page) =>
      page.evaluate((mins) => {
        const e = RW_APP.engine;
        e.cfg.rain.enabled = false;
        RW.applyWildlifePreset(e.cfg, 'daddy');
        e.restartWildlife();
        const out = { slugLeft: 0, slugEarly: 0, daddyLeft: 0, daddyEarly: 0, minBatflies: 99, nests: e.eco.nests.length };
        const C = RW.Creature.prototype;
        const lv = C.leave;
        C.leave = function () {
          if (this.species === 'slugcat') {
            out.slugLeft++;
            if (this.meals < 2 && this.age <= 210) out.slugEarly++;
          }
          if (this.species === 'daddy') {
            out.daddyLeft++;
            if (this.meals < 2 && this.age <= 300) out.daddyEarly++;
          }
          return lv.apply(this, arguments);
        };
        for (let i = 0; i < mins * 3600; i++) {
          e.tick(1 / 60);
          if (i > 3600 && i % 1800 === 0) out.minBatflies = Math.min(out.minBatflies, e.eco.count('batfly'));
        }
        return out;
      }, T(8)),
    judge: (m) => [
      m.slugEarly && `${m.slugEarly} slugcats left before eating twice`,
      m.daddyEarly && `${m.daddyEarly} Daddy Long Legs left before eating twice`,
      m.nests < 1 && 'no batfly nest',
      m.minBatflies < 1 && 'batflies ran out',
    ],
    warn: (m) => !m.slugLeft && 'no slugcat finished its visit this run',
  },
  {
    name: 'rain',
    about: 'rain eases into and out of the downpour exponentially; waterfalls only in real rain; rain falls past horizontal poles',
    run: (page) =>
      page.evaluate(() => {
        const e = RW_APP.engine;
        const R = e.cfg.rain;
        R.cycleMinutes = 1;
        const w = e.weather;
        const cyc = 60;
        const out = { flatEarly: true, rampMonotonic: true, peak: 0, decaysBack: false, waterfallsInDrizzle: 0, beamBlocked: 0, beamExposed: 0 };
        let last = 0;
        e.tick(1 / 60);
        while (w.t < cyc * 2.3) {
          e.tick(1 / 60);
          const ph = w.phase;
          const second = w.t >= cyc;
          if (!second && ph < 0.5 && Math.abs(w.intensity - R.drizzle) > 1e-6) out.flatEarly = false;
          if (!second && ph > 0.5 && !w.downpour && w.intensity < last - 1e-6) out.rampMonotonic = false;
          if (w.downpour) out.peak = Math.max(out.peak, w.intensity);
          if (second && ph > 0.25 && ph < 0.5 && Math.abs(w.intensity - R.drizzle) < 0.01) out.decaysBack = true;
          if (w.intensity < (R.waterfallsFrom ?? 0.35) && w.waterfalls > 0) out.waterfallsInDrizzle++;
          last = w.intensity;
        }
        // rain shadow: points right under a horizontal pole that the rain
        // reaches must still get rain
        for (const s of e.world.solids.filter((q) => q.kind === 'beam')) {
          for (let fx = 0.1; fx < 0.95; fx += 0.1) {
            const x = s.x + s.w * fx;
            if (w.shelterAt(x, s.y - 1) < s.y - 1) continue; // in a ledge's shadow anyway
            out.beamExposed++;
            const hit = w.shelterAt(x, s.y + s.h + 2);
            if (hit >= s.y && hit <= s.y + s.h + 1) out.beamBlocked++;
          }
        }
        return out;
      }),
    judge: (m) => [
      !m.flatEarly && 'light rain not steady early in the cycle',
      !m.rampMonotonic && 'build-up to the downpour not smooth',
      m.peak < 0.99 && 'downpour never reached full strength',
      !m.decaysBack && 'rain never eased back to light rain after the downpour',
      m.waterfallsInDrizzle && 'ledge waterfalls running in light rain',
      m.beamBlocked && `horizontal poles block the rain (${m.beamBlocked} points)`,
    ],
    warn: (m) => !m.beamExposed && 'no horizontal pole caught any rain on this map',
  },
  {
    name: 'presets',
    about: 'size presets scale the map (more ledge rows, nests, finer pixels); wildlife presets restart with only their creatures',
    run: (page) =>
      page.evaluate(() => {
        const e = RW_APP.engine;
        const out = { defaults: e.cfg.presets.size + '/' + e.cfg.presets.wildlife, sizes: {} };
        for (const sz of ['compact', 'normal', 'large', 'xl']) {
          RW.applySizePreset(e.cfg, sz);
          const rows = [];
          for (const seed of [3, 21]) {
            e.seed = seed;
            const t0 = performance.now();
            e.regenerate(false);
            const d = e.decor;
            rows.push({
              tiers: new Set(d.ledges.map((l) => l.tier)).size,
              ledges: d.ledges.length,
              nests: d.nests.length,
              ms: Math.round(performance.now() - t0),
              ps: e.ps,
            });
          }
          out.sizes[sz] = {
            tiers: Math.min(...rows.map((r) => r.tiers)),
            ledges: Math.min(...rows.map((r) => r.ledges)),
            nests: Math.min(...rows.map((r) => r.nests)),
            msMax: Math.max(...rows.map((r) => r.ms)),
            pixelScale: rows[0].ps,
          };
        }
        RW.applySizePreset(e.cfg, 'normal');
        e.regenerate(false);
        for (let i = 0; i < 600; i++) e.tick(1 / 60);
        RW.applyWildlifePreset(e.cfg, 'peaceful');
        e.restartWildlife();
        out.rainTimerAfterRestart = e.weather.t;
        out.peacefulSpecies = [...new Set(e.eco.creatures.filter((c) => !c.dead).map((c) => c.species))].sort().join(',');
        return out;
      }),
    judge: (m) => {
      const s = m.sizes;
      const peaceful = new Set(['batfly', 'centipede', 'slugcat']);
      return [
        m.defaults !== 'normal/balanced' && `defaults are ${m.defaults}, expected normal/balanced`,
        s.compact.tiers !== 3 && `compact should have 3 ledge rows (${s.compact.tiers})`,
        !(s.normal.tiers > s.compact.tiers && s.xl.tiers >= 6) && `ledge rows don't grow with the map (${s.compact.tiers}/${s.normal.tiers}/${s.large.tiers}/${s.xl.tiers})`,
        s.xl.nests < 2 && 'XL should have two batfly nests',
        Object.values(s).some((r) => r.nests < 1) && 'a map without a batfly nest',
        `${s.compact.pixelScale}/${s.normal.pixelScale}/${s.large.pixelScale}/${s.xl.pixelScale}` !== '2/2/1.5/1' && 'pixel scales should be 2/2/1.5/1',
        s.xl.msMax > 3000 && `XL map takes ${s.xl.msMax}ms to build`,
        m.rainTimerAfterRestart > 0.1 && 'wildlife change did not restart the rain cycle',
        m.peacefulSpecies.split(',').some((k) => k && !peaceful.has(k)) && `Peaceful still has ${m.peacefulSpecies}`,
      ];
    },
  },
];

const browser = await launch();
let failures = 0;
const t0 = Date.now();
try {
  for (const c of checks) {
    if (only.length && !only.includes(c.name)) continue;
    const started = Date.now();
    const { page, errors } = await openPrototype(browser, { seed: c.seed });
    let metrics;
    let problems;
    try {
      metrics = await c.run(page);
      problems = c.judge(metrics).filter(Boolean);
    } catch (err) {
      metrics = {};
      problems = ['crashed: ' + err.message.split('\n')[0]];
    }
    if (errors.length) problems.push('page errors: ' + errors.slice(0, 3).join(' | '));
    const warning = !problems.length && c.warn && c.warn(metrics);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`${problems.length ? 'FAIL' : warning ? 'WARN' : 'ok  '}  ${c.name.padEnd(10)} ${secs.padStart(4)}s  ${c.about}`);
    console.log(`      ${JSON.stringify(metrics)}`);
    for (const p of problems) console.log(`      -> ${p}`);
    if (warning) console.log(`      -> ${warning} (nothing to measure; rerun if it matters)`);
    if (problems.length) failures++;
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${failures ? failures + ' check(s) failed' : 'all checks passed'} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
process.exit(failures ? 1 : 0);
