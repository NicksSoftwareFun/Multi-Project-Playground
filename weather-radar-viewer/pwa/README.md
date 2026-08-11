# SKYWATCH Radar — installable PWA

Live NEXRAD radar + HRRR forecast timeline, GOES-East satellite, and
ZIP-code local conditions, packaged as a Progressive Web App that
installs on Windows and iPhone/iPad.

## Hosting (required once)

PWAs must be served over HTTPS — they cannot be installed from a local
file. The zero-cost way with this repo:

1. GitHub → repo **Settings → Pages**
2. Source: **Deploy from a branch**; pick the branch and `/ (root)`
3. Wait ~1 minute, then the app is at:
   `https://<user>.github.io/<repo>/weather-radar-viewer/pwa/`

(The repo must be public for free GitHub Pages.) Any other static host
— Netlify, Cloudflare Pages, a home server with HTTPS — works the same:
just serve this folder.

## Installing

- **Windows (Edge or Chrome):** open the URL → click the **install icon**
  in the address bar (or ⋯ menu → Apps → Install). It becomes a Start-menu
  app in its own window.
- **iPhone / iPad (Safari):** open the URL → **Share → Add to Home
  Screen**. Launches full-screen with the radar icon.

Settings (ZIP code, Auto Mode) persist per device. Auto Mode makes a
great wall/desk display: radar ×2 (regional then 175 km), satellite 10 s,
conditions board 20 s, looped.

## Files

- `index.html` — the app (responsive; fills any screen, safe-area aware)
- `manifest.webmanifest` — install metadata (name, icons, standalone display)
- `sw.js` — service worker: caches the app shell + Leaflet for instant
  launch; all weather data is always fetched live
- `icon-*.png`, `apple-touch-icon.png` — generated radar icons

## Data sources (all free, no keys)

IEM NEXRAD N0Q composite tiles (past), IEM HRRR REFD tiles (forecast),
NOAA STAR GOES-East GeoColor (satellite), Open-Meteo with automatic
NWS api.weather.gov fallback (conditions), Zippopotam.us (ZIP geocoding),
CARTO dark basemap.
