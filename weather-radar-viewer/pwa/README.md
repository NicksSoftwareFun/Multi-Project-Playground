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

Settings (ZIP code, Auto Mode) persist per device. On open, the radar
centers on your active location at a 200 km view. Auto Mode makes a great
wall/desk display: radar ×2 (regional then 175 km), satellite 10 s,
conditions board 20 s, plus the severe board for 15 s whenever an alert
is active, looped.

## What's on screen

- **Radar** — animated NEXRAD past 50 min and HRRR forecast to +2:45 on one
  time-proportional timeline; forecast frames are framed in yellow.
- **Alert chip** (top bar) — the highest-severity NWS alert for your location,
  color-coded; tap it for the full text. It hides itself if the feed goes
  stale rather than show a possibly-expired warning.
- **≡ Layers** — alert polygons, SPC convective outlook, watches/mesoscale
  discussions, tropical. Each row carries a health dot and reads `N/A` when
  its source is unavailable.
- **▤ Boards** — swipeable full-screen data boards: **NOW** (conditions and
  forecast) and **SEVERE** (every active alert with full text, plus the SPC
  Day 1–3 categorical risk for your location).
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
  `wx` (conditions: Open-Meteo → NWS fallback) · `auto` (kiosk playlist) ·
  `settings` · `main` (boot)
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
discussions and tropical, Zippopotam.us (ZIP geocoding), CARTO dark
basemap. Weather data by [Open-Meteo.com](https://open-meteo.com/).

Endpoint reachability and CORS are re-verified weekly by
`.github/workflows/endpoint-checks.yml`; layer ids are re-discovered at
runtime because NOAA renumbers them.
