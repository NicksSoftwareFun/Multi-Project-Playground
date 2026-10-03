# Rain World Desktop

A living, Rain World-inspired ecosystem for your desktop background.
Procedurally animated creatures climb your windows, desktop icons and taskbar,
hunt each other, forage, react to your cursor, and shelter from the rain at
the end of every cycle.

Everything is plain JavaScript + `<canvas>`, with no build step and no dependencies.

## Try it

- **Browser prototype**: open `index.html`. It shows a mock Windows desktop
  with draggable, resizable windows and icons over the wallpaper. They are real
  geometry: drag a window and creatures standing on it ride along.
  - Press **`** (backtick) or the ≡ button for the **ecosystem panel**.
  - **Drag** a creature (living or dead) to pick it up: it hangs limp from
    the cursor and drops where you let go. (Clicking bare wallpaper to drop
    a dangle fruit is still available as a panel toggle, off by default.)
  - **Rest the cursor** near creatures: lizards stalk and snap at it, slugcats
    come and look at it, Daddy Long Legs reaches for it, Dropwigs drop on it.
- **Creature gallery**: `gallery.html?spawn=lizard_pink@200,300;slugcat@400,300`
  puts chosen creatures in a small test room (see the comment at the top of the file).
- **As your real Windows wallpaper**: see [`windows/README.md`](windows/README.md).

## The creatures

| Creature | Behaviour |
| --- | --- |
| **Lizards** (pink, green, blue, white) | Verlet spine, 4 IK legs stepping in a diagonal gait, hinged jaws. Hunt slugcats, centipedes and batflies; lunge and carry prey off. Pink climbs walls and poles; blue also ceilings; green is big and floor-only; white climbs everything and camouflages when still. |
| **Slugcats** (Survivor, Monk, Hunter) | Platformer physics: walk, climb poles, and make planned jumps between ledges. Eat dangle fruit and catch batflies, flee predators, rest, and get curious about a resting cursor. |
| **Daddy / Brother Long Legs** | Pulsing knot of rot bulbs with glowing spots. Its tentacles grope for anchors and haul the body along; anything in reach is seized and reeled in. |
| **Dropwigs** | Spiny ambushers that wait flattened against ceilings (window undersides!) and drop onto prey passing below. Prey can't see them while they lurk. |
| **Batflies** | Flocking prey that roost on grass and pole tops and scatter from danger. |
| **Small centipedes** | Armoured segments rippling over any surface on a wave of legs. |

## Configuring

All defaults live in [`js/config.js`](js/config.js). The panel edits them live
and saves to `localStorage`:

- **Spawn weights**: when the spawner adds a creature it picks a species at
  random in proportion to `weight`, among enabled species below their `max`.
- **`ecosystem.maxPopulation`**: the total the spawner keeps the screen near.
  Each species has a `popCost` (a batfly counts 0, a Daddy Long Legs 4).
- **`world.mapSize`**: how much of the world fits on screen. 1 is the default;
  bigger shows more map with everything (creatures, ledges, poles) smaller,
  smaller zooms in so everything is bigger.
- **Rain**: cycle length, drizzle level, and whether creatures take shelter
  in dens during the downpour.
- Every creature's parameters (speeds, colours, climbing abilities, vision…)
  are under `species.<name>.params`. Edit them in the panel's *Config JSON* box.

## How it works

```
js/
  util.js          math, colour, IK, taper-path drawing
  config.js        defaults + localStorage
  world.js         solid rects (windows/icons/taskbar/ledges), poles, collision,
                   raycasts, 20px nav grid
  nav.js           A* with per-species movement: walls, ceilings, poles,
                   deliberate drops, solved jumps, flight
  background.js    procedural fogged wallpaper (5 palettes), rain cycle
  creatures/       base (paths, verlet chains, legs, grabbing) + one file per creature
  ecosystem.js     weighted spawner, dens, predation, cursor, food
  engine.js        fixed-timestep loop, rendering, geometry providers
  geometry/
    mock-desktop.js  fake Windows desktop for the browser prototype
    remote.js        real geometry from the Windows helper
windows/           Lively Wallpaper port + PowerShell geometry helper
tests/             fake-helper.mjs (helper stand-in for non-Windows dev)
```

The engine only sees rectangles from a **geometry provider**, so the prototype
and the real desktop run identical simulation code.
