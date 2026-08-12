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
- **≡ Layers** — alert polygons, SPC convective outlook, mesoscale
  discussions, tropical. Each row carries a health dot and reads `N/A` when
  its source is unavailable. The three severe layers are three time horizons:
  outlook (days out) → mesoscale discussion (hours out, before anything is
  warned) → alert polygon (in effect now). Watch boxes are NWS active alerts,
  so they arrive on the alert-polygon layer.
- **▤ Boards** — swipeable full-screen data boards: **NOW** (conditions and
  forecast), **CAST** (48 h meteogram, 15-minute precipitation, 7-day strip,
  ensemble confidence bands, model agreement), **SEVERE** (every active alert
  with full text, plus the SPC categorical risk for the next three days,
  labelled by date) and **AIR** (US AQI, pollutants, 48 h trend, smoke note).
- **Locations** — tap the conditions panel for unlimited saved ZIPs plus GPS.

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
- `js/` — `config` (endpoints + frame model) · `util` (helpers, safe-DOM
  `el()`/`esc()`) · `state` (view enum, pub/sub, Escape/Back history
  sentinel) · `net` (`fetchT` timeout fetch, source health) · `store`
  (localStorage + IndexedDB) · `map` (Leaflet + radar frame engine) ·
  `timeline` (scrubber, play loop, frame chrome) · `sat` (GOES viewer) ·
  `wx` (conditions: Open-Meteo → NWS fallback) · `locations` · `layers` ·
  `boards` · `alerts` · `spc` · `charts` (hand-rolled SVG chart engine) ·
  `forecastx` (CAST) · `airq` (AIR) · `main` (boot)
- `vendor/` — Leaflet 1.9.4 and SunCalc, self-hosted (no CDN dependency)
- `sw.js` — service worker: caches the app shell for instant launch;
  weather data is always fetched live (stale radar is worse than no radar)
- Tests live in `../tests/` (Playwright smoke suite + live endpoint checks);
  the deploy workflow blocks on them.

## Data sources (all free, no keys)

IEM NEXRAD N0Q composite tiles (past), IEM HRRR REFD tiles (forecast),
NOAA STAR GOES-East GeoColor (satellite), Open-Meteo with automatic
NWS api.weather.gov fallback (conditions), NWS active alerts + zone
geometry (severe), NOAA ArcGIS map services for SPC outlooks, mesoscale
mesoscale discussions, watch/warning/advisory polygons and tropical, Open-Meteo
air quality (US AQI) and ensembles, Zippopotam.us (ZIP geocoding), CARTO
dark basemap (geography and labels as separate layers). Weather data by [Open-Meteo.com](https://open-meteo.com/).

Endpoint reachability and CORS are re-verified weekly by
`.github/workflows/endpoint-checks.yml`; layer ids are re-discovered at
runtime because NOAA renumbers them.
