# Tests

Headless checks for the prototype and the wallpaper build. Node 18+.

```sh
cd rain-world-desktop/tests
npm install                      # Playwright (ESM won't find a global install)
export CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome   # cloud sessions; omit if Playwright has its own browser
npm test                         # smoke + quick behaviour checks (~4 min)
node smoke.mjs                   # page errors, population, window dragging, wallpaper vs fake helper (~1 min)
node behaviour.mjs               # all behaviour checks (~2-3 min)
node behaviour.mjs bodies rain   # just some
```

## What's covered

`smoke.mjs`: the prototype and the wallpaper build (served by
`fake-helper.mjs`, a stand-in for the Windows helper) run for a few minutes
without page errors, populate, and react to geometry changes.

`behaviour.mjs`, one check per thing that has gone wrong before:

| Check | Guards against |
| --- | --- |
| `soak` | errors, runaway population, active creatures getting stuck (burrowing away) |
| `bodies` | centipedes folding in half, lizards hairpinning or balling up on poles |
| `dropwigs` | dropwigs losing their grip on corners and falling in a loop |
| `scramble` | slugcats bouncing off ledge corners instead of scrambling up from poles |
| `jumps` | slugcats not jumping, centipedes able to jump (also reports lizard pole leaps and slugcat long leaps) |
| `fruit` | fruit dropping by itself or piling up |
| `transients` | slugcats / Daddy Long Legs leaving before two meals; batflies running out |
| `rain` | the rain curve, waterfalls in light rain, rain blocked by horizontal poles |
| `presets` | defaults, ledge rows growing with map size, nests, pixel scales, wildlife restart |

The simulation isn't seeded, so numbers vary between runs. Each check's
thresholds are set well clear of the values measured when it was written
(noted in comments). A single failure is worth a rerun; a repeat failure is a
regression. **WARN** means the random run gave the check nothing to measure.

## Adding a check

Add an entry to `checks` in `behaviour.mjs`: `run(page)` drives the
simulation inside the page (`RW_APP.engine.tick(1/60)`, hook prototype
methods to count events) and returns plain numbers; `judge(metrics)` returns
failure strings. Re-read `engine.eco` after anything that regenerates.
