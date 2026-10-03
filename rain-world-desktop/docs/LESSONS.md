# Lessons learned

Things that cost time in earlier sessions, and the owner's feedback, so the
next session doesn't relearn them.

## Pitfalls

- **`engine.regenerate()` and `restartWildlife()` replace things.**
  Regenerate builds a new `engine.eco` and `engine.world`: a test that keeps
  `const eco = e.eco` from before watches a dead ecosystem (it once made a
  whole batch of results read "0 creatures"). Always re-read `e.eco`. Setting
  `e.seed = N` then `regenerate(false)` is how to switch maps in a test.
- **Path nodes are recreated on every replan.** Compare `cx, cy`, never node
  objects, when tracking "the same next step" over time.
- **The sprite layer is alpha-thresholded** (`U.crispRects`, alpha < 110 ->
  gone). Semi-transparent drawing in the normal pass just vanishes or turns
  solid; draw translucent things in `Ecosystem.drawLate` (white lizard camo).
- **The nav grid is coarser than the geometry.** A cell is solid at >30%
  coverage, so a creature can stand in a cell nav thinks it can't, or be
  told to cut a corner diagonally that its body can't get round. Most
  "creature stuck / looping / bouncing" reports trace back to this. The
  generic answers now in `base.js`: scramble (pole -> ledge lip), clamber
  (any jammed adjacent step), nudge out of a dead cell, burrow away after
  25 s. Before adding a new special case, check whether these cover it.
- **Poles beside ledges** must sit in the grid column right next to the
  ledge (`beside()` in `generateDecor`) or the pole gets broken by the
  ledge's cells and nothing can step across.
- **Corner grip.** Surface-hugging creatures turn off hugging while leaving a
  surface; crossing a corner they could drift out of grip range and fall
  (dropwigs did this ~50 times a minute). Long-legged ones now keep a 44 px
  reach while crossing.
- **Chains need a bend limit.** Verlet chains with only length constraints
  fold flat when the head doubles back (centipedes folded in 82% of frames).
  `Chain.limitBend` fixed it; anything new with a body should use it.
- **Saved settings mask new defaults.** Bump `STORAGE_KEY` in `config.js`
  whenever defaults change, or everyone keeps the old values.
- **Presets govern their settings.** In Lively, the Customise panel replays
  every property on start; the preset dropdowns are reapplied after each
  property so their order doesn't matter, and the individual sliders only
  count when that preset is *Custom*.
- **GitHub Pages:** this repo's single Pages site belongs to the weather
  radar app (deployed from the repo's default branch). Don't add another
  Pages workflow here; the Rain World site is published from its own repo
  (see `CLAUDE.md`).
- **Shell editing.** Use exact-match replacements that assert the match is
  unique (a Python `assert s.count(a) == 1` pattern worked well). A sed range
  typo once wrote a stray copy of `base.js` into the repo under a garbage
  file name; check `git status` before committing.
- **The sim isn't seeded** (only maps are, via `?seed=`): measure over
  several minutes and runs, compare rates not single events, and expect
  run-to-run spread of a few percent.

## How to investigate a "looks wrong" report

1. Turn the complaint into a number (frames with a folded body, grip losses
   per minute, burrows per run...), measured headlessly over a few minutes.
2. Sample the bad moments: log state, the path's next node and a small ASCII
   map of the surrounding grid (`#` solid, `|` pole, `@` creature, `N` next
   node). The pattern usually jumps out.
3. If it's visual, screenshot or film the moment (hook the method that starts
   it, then record) and look at it before deciding.
4. Fix, re-measure, report before/after to the owner, add a check to
   `tests/behaviour.mjs` if it could come back.

## The owner's feedback so far (what "right" looks like)

Creatures should read as Rain World creatures. Specific asks, roughly in order:

- **Lizards**: open mouths are see-through (you see what's behind them,
  including other lizards); knees never above the body centreline; slow,
  lumbering, with personalities and territories per the wiki (fight over food
  and hangouts, carry kills home, shake them while carrying); lunges throw the
  whole body; white lizards only go partly transparent and only while
  stalking/hunting; no folding or balling up (especially on poles); non-green
  lizards hold territory on middle/top tiers, greens on the ground. Wary of
  large centipedes.
- **Slugcats**: head not a circle, body as wide as the head (no neck), a bit
  elongated, arms and hands, can lie flat, no dark edge on the arms.
  Transients: arrive by a pipe, eat two things (one fruit + one meat if both
  exist), leave by the farthest pipe. Pick up and throw rocks and spears (two
  different items at most); knock fruit down and batflies out of the air.
  Long lateral leaps start lying down with a windup (owner verified).
- **Others**: centipedes small/medium/large, never jump, small ones eat
  batflies, large ones hunt lizards; Daddy Long Legs rarer, transient (two
  meat meals); dropwigs lethal ambushers (owner verified); batflies don't
  count toward population and always have a nest on the map.
- **World**: tiered ledges like the owner's favourite generated map, no
  unreachable ledges, passages with poles through them, horizontal poles,
  ledges with poles on them; more rows on bigger maps. Rain doesn't fall under
  ledges or stop at horizontal poles; it builds and eases exponentially;
  ledge waterfalls only in real rain, light rain just drips. Fruit only drops
  when hit and rots after a minute.
- **Interaction**: no click-to-drop-food; dragging a creature picks it up
  limp, releasing drops it. Corpses stay as limp ragdolls with X eyes until
  eaten.
- **Settings**: Size presets Compact..XL (Normal is default; Compact was the
  original default), Wildlife presets to show off behaviours, collapsible
  panel sections, changing wildlife restarts creatures and the rain.
  Rocks plentiful, spears a little less so.
