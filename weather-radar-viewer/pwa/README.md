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
centers on your ZIP at a 200 km view. Auto Mode makes a great wall/desk
display: radar ×2 (regional then 175 km), satellite 10 s, conditions
board 20 s, looped.

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
NWS api.weather.gov fallback (conditions), Zippopotam.us (ZIP geocoding),
CARTO dark basemap. Weather data by [Open-Meteo.com](https://open-meteo.com/).
