# SKYWATCH Radar — installable PWA

Live NEXRAD radar + HRRR forecast timeline, GOES-East satellite, and
ZIP-code local conditions, packaged as a Progressive Web App that
installs on Windows and iPhone/iPad — free, keyless, no backend.

**Live:** https://nickssoftwarefun.github.io/Multi-Project-Playground/

## Hosting

Deployed automatically by `.github/workflows/pages.yml`: every push to the
default branch runs the smoke test suite and, if green, publishes this
folder as the GitHub Pages site root. No manual steps.

## Installing

- **Windows (Edge or Chrome):** open the URL → click the **install icon**
  in the address bar (or ⋯ menu → Apps → Install). It becomes a Start-menu
  app in its own window.
- **iPhone / iPad (Safari):** open the URL → **Share → Add to Home
  Screen**. Launches full-screen with the radar icon.

Saved locations persist per device. On open, the radar centers on your
active location at a 200 km view; picking a different location from the
locations sheet recenters it there.

## What's on screen

- **Radar** — animated NEXRAD past 50 min and HRRR forecast to +2:45 on one
  time-proportional timeline; forecast frames are framed in yellow.
- **Alert chip** (top bar) — the highest-severity NWS alert for your saved
  locations, color-coded; tap it for the full text. It hides itself if the
  feed goes stale rather than show a possibly-expired warning.
- **Alert polygons** — every watch, warning and advisory intersecting the
  current map view, from NOAA's watch/warn/advisory service, refetched as
  you pan. Tap one for the full NWS text in a scrollable sheet (the tap
  re-queries alerts for that exact point, so you get the real product text,
  not just the outline). Heat/cold products and plain advisories are off by
  default — a single heat wave issues them county by county and buries the
  radar; each drawer row shows how many are in view either way. The chip and
  the SEVERE board stay scoped to your saved locations: the map answers
  "what is happening out there", the chip answers "does this affect me".
- Place labels are drawn above the radar, so a wall of 60 dBZ can never
  hide which county you are looking at.
- **Satellite** — GOES-East, with a channel strip: **GEOCOLOR** (a fixed
  full-sector image that does not pan or zoom) plus **CH13 IR** and
  **CH02 VIS**, which are map tile layers that do pan and zoom. The channel
  choice persists. CH02 says so when it is likely dark at your location, and a
  channel whose tiles never arrive says which one failed rather than showing a
  blank map. Layer names are probed with one canary tile before the template is
  trusted, and a legacy alias name announces itself if it ever wins.
- **≡ Layers** — alert polygons, heat/cold alerts, advisories,
  SPC convective outlook, mesoscale discussions, tropical, NOHRSC modelled snow
  depth, and WPC Day-1 winter guidance. Each row carries a health dot and reads
  `N/A` when its source is unavailable. The three severe layers are three time
  horizons: outlook (days out) → mesoscale discussion (hours out, before
  anything is warned) → alert polygon (in effect now). Watch boxes are NWS
  active alerts, so they arrive on the alert-polygon layer. The snow-depth
  raster is re-exported for the exact viewport on every pan and says "out of
  coverage" outside CONUS rather than drawing nothing silently.
- **Boards** — tap the conditions panel to enter the swipeable full-screen data
  deck; ← / → , a horizontal swipe, or the dots move between boards, and a
  downward swipe from the top of a board — or Escape / Back — leaves. Six boards:
  **NOW** (conditions and forecast), **FCAST** (48 h meteogram, 15-minute
  precipitation, 7-day strip, ensemble confidence bands, model agreement, plus
  a winter-hazards strip and an atmospheric-profile section), **SEVERE** (every
  active alert with full text, the SPC categorical risk for the next three days
  labelled by date), **AIR** (US AQI, pollutants, 48 h
  trend, smoke note, plus an inversion/mixing section), **SKY** (day length and
  its day-over-day change, the three twilights, golden hour, solar noon, moon
  phase and rise/set — computed entirely on-device, the one board that works
  with no network at all) and **ALMANAC** (today ranked against this grid
  cell's ERA5 record since 1940 — percentile, 30-year normal, and the day's
  warmest/coldest years).
- **Winter hazards** (FCAST) — forecast snow and ice accumulation from the NWS
  gridpoint, totalled and broken out by period, with the source grid and any
  unit conversion stated on screen. A confirmed all-zero forecast renders
  nothing at all; a field that could not be *read* says so instead, so August
  and a broken feed never look alike.
- **Profile** (FCAST) and **Inversion / mixing** (AIR) — freezing level,
  precipitation-type reasoning, cloud layers and mixing depth, derived on-device
  from six Open-Meteo pressure levels. These are model output for the current
  hour, not an observed sounding, and every number carries what limits it: the
  interpolation gap, the sensitivity of the freezing level to a small lapse-rate
  change, and a refusal to print one at all across an inversion near 0 °C. The
  warm-nose case never asserts sleet versus freezing rain — six levels cannot
  resolve that, and it says so.
- **⌂ Locations** — unlimited saved ZIPs plus GPS. The button sits in the side
  rail on the radar view and on every board.

## Android APK

Android users can install straight from Chrome (the install prompt creates a
real launcher app), but a sideloadable APK is also built from
`../android/` — see that folder's README, or grab the latest at
https://github.com/NicksSoftwareFun/Multi-Project-Playground/releases/download/android-latest/skywatch.apk

## Architecture

Static, no build step — plain ES modules and CSS served as-is:

- `index.html` — HTML skeleton; view state lives in `data-view`/`data-board`
  attributes on `#screen`
- `css/` — `tokens.css` (design tokens: all colors + the data typeface),
  `base` / `chrome` / `views` / `boards` / `charts`
- `js/` — 23 modules:
  `config` (endpoints, frame model, palettes, tuned thresholds) ·
  `util` (helpers, safe-DOM `el()`/`esc()`, `isValidDate`) ·
  `state` (view enum, pub/sub, Escape/Back history sentinel) ·
  `net` (`fetchT` timeout fetch, source health) ·
  `store` (localStorage + IndexedDB) ·
  `map` (Leaflet + radar frame engine) ·
  `timeline` (scrubber, play loop, frame chrome) ·
  `sat` (GOES viewer + the channel strip: GeoColor image, CH13/CH02 tiles) ·
  `wx` (conditions: Open-Meteo → NWS fallback; the panel that enters the deck) ·
  `locations` · `layers` (drawer, per-layer health dots, persistence) ·
  `boards` (the six-board deck, dots, keyboard and swipe navigation) ·
  `alerts` · `spc` ·
  `charts` (hand-rolled SVG chart engine) ·
  `forecastx` (FCAST) · `airq` (AIR) · `astro` (SKY) · `almanac` (ALMANAC) ·
  `winter` (NWS-gridpoint snow/ice strip in FCAST, plus the NOHRSC snow-depth
  and WPC Day-1 winter-guidance map layers) ·
  `profile` (freezing level, precipitation-type reasoning, cloud layers,
  mixing depth — sections inside FCAST and AIR, no board of their own) ·
  `main` (boot)
- `vendor/` — Leaflet 1.9.4 and SunCalc, self-hosted (no CDN dependency)
- `sw.js` — service worker: caches the app shell for instant launch;
  weather data is always fetched live (stale radar is worse than no radar)
- Tests live in `../tests/` (Playwright smoke suite + live endpoint checks);
  the deploy workflow blocks on them.

## Data sources (all free, no keys)

**Radar and satellite** — IEM NEXRAD N0Q composite tiles (past) and IEM HRRR
REFD tiles (forecast); NOAA STAR GOES-19 GeoColor for the fixed satellite image,
and IEM's GOES-East CH13 and CH02 tile layers for the two pannable channels
(the exact layer names are probed at runtime, with the legacy 4 km IR / 1 km
visible composites as named fallbacks).

**Conditions and forecast** — Open-Meteo with automatic NWS `api.weather.gov`
fallback; Open-Meteo ensembles for the confidence bands and model agreement;
Open-Meteo air quality for the US AQI; the Open-Meteo ERA5 archive
(`archive-api.open-meteo.com`) for daily climate history, cached in IndexedDB
per 0.25° grid cell; and Open-Meteo pressure levels (1000/925/850/700/500/300
hPa) for the derived freezing level, precipitation-type reasoning, cloud layers
and mixing depth. Everything under "profile" is model output for the current
hour, not an observed sounding, and the board says so.

**Severe and hazards** — NWS active alerts plus zone geometry; NOAA ArcGIS map
services for SPC convective outlooks, mesoscale discussions, watch/warning/
advisory polygons and tropical products; the NWS gridpoint `snowfallAmount` and
`iceAccumulation` fields for the FCAST winter strip (a unit the app cannot
convert is reported as unreadable, never as zero); the NOHRSC National Snow
Analysis raster for modelled snow depth, resolved **by layer name** so Snow
Water Equivalent can never be drawn under a "snow depth" label; and WPC's
probabilistic winter guidance (Day-1 snow and ice accumulation), whose Day-1
layer is likewise resolved by name — the same catalog carries unrelated ice
charts and a Winter Storm Severity Index, and none of those may be drawn under
a winter-guidance label.

**Geocoding and basemap** — Zippopotam.us (ZIP → lat/lon), CARTO dark basemap
(geography and labels as separate layers, so labels draw above the radar).

Weather data by [Open-Meteo.com](https://open-meteo.com/).

Endpoint reachability and CORS are re-verified weekly by
`.github/workflows/endpoint-checks.yml`; layer ids are re-discovered at
runtime because NOAA renumbers them.
