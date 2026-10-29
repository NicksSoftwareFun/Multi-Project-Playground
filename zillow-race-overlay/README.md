# Zillow Race Dot-Density Overlay (Brave / Chrome extension)

Draws the Esri Living Atlas map **"Race in the US by Dot Density"**
([ArcGIS Hub link](https://hub.arcgis.com/maps/arcgis-content::race-in-the-us-by-dot-density/explore))
directly on top of Zillow's search map, so you can look at listings and
neighborhood demographics in one view.

- Same data, colors, and groups as the ArcGIS map: U.S. Census ACS 5-year
  estimates, table B03002 (Hispanic or Latino origin by race), from Esri's
  [ACS Race and Hispanic Origin Variables – Boundaries](https://www.arcgis.com/home/item.html?id=23ab8028f1784de4b0810104cd5d1c8f)
  layer.
- Switches geography by zoom: **state** (zoomed way out) → **county** →
  **census tract** (city / neighborhood zoom, where you'll usually be on Zillow).
- Shows only the dots by default. A legend (with a hover readout of each
  tract's population mix), area outlines and basemap darkening can be turned
  on in the toolbar popup, along with opacity, dot size and people-per-dot.
- No account or API key needed. Data is fetched from Esri's public service.

> Dots are placed **randomly** inside each tract/county to show the mix and
> density. They are not individual homes or people.

## Install in Brave

1. Download this folder (`zillow-race-overlay`) to your computer. If you
   download the repo as a ZIP from GitHub, unzip it first.
2. In Brave, go to `brave://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the `zillow-race-overlay` folder (the
   one that contains `manifest.json`).
5. Optional: click the puzzle-piece icon in the toolbar and pin
   "Zillow Race Dot-Density Overlay".
6. Open (or reload) a Zillow search page, e.g. `https://www.zillow.com/homes/`.
   The dots and the legend appear on the map.

The same steps work in Chrome and Edge (`chrome://extensions`,
`edge://extensions`).

### Brave Shields

The overlay works with Shields up. If the map ever loads without dots, try
setting Shields to "Down" for zillow.com once to rule it out, then reload.

## Using it

| Control | Where | What it does |
| --- | --- | --- |
| Checkbox next to "Race & ethnicity" | Map legend | Overlay on/off |
| Group checkboxes | Legend or popup | Show/hide a group's dots |
| `–` / `+` | Legend | Collapse/expand the legend |
| Geography | Popup | Force state / county / tract instead of auto |
| People per dot | Popup | Fix the dot value (blank = auto by zoom) |
| Dot size, opacity | Popup | Appearance |
| Darken basemap | Popup | Dims Zillow's light map so pale dots (White, non-Hispanic) stay visible |

The legend always shows the current level and **1 dot = N people**. In auto
mode the value matches the ArcGIS map at zoom 10 and halves for each zoom
level in (down to 1). If a view would need more than ~350,000 dots, the value
is doubled until it fits, so the page stays responsive.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3; runs on `www.zillow.com`, fetches only from `services.arcgis.com` |
| `page-hook.js` | Runs in Zillow's page, finds Zillow's Google Map, draws the dots on a canvas overlay, and builds the legend |
| `content.js` | Bridge between the page and the extension (settings + data requests) |
| `background.js` | Queries the ArcGIS FeatureServer by map tile, pages through results, caches them |
| `config.js` | Shared fields, colors, and per-level settings |
| `popup.*` | Toolbar settings panel |

Zillow's map is a Google Map created inside Zillow's own code. The extension
recognizes it the first time Zillow or Google Maps calls any method on it,
then attaches a standard `google.maps.OverlayView`, so the dots pan and zoom
with the map and normally sit under Zillow's price markers.

## Troubleshooting

- **No legend, no dots:** reload the Zillow tab after installing or updating
  the extension. Check `brave://extensions` for an error badge on the
  extension.
- **Legend says "Couldn't load some data":** Esri's service was slow or down;
  pan or zoom slightly to retry.
- **Stopped working after a Zillow update:** the extension depends on Zillow
  using Google Maps. If Zillow changes map providers, `page-hook.js` needs a
  new adapter.

## Testing notes

Tested in Chromium (the engine Brave uses) with the extension loaded unpacked,
against a page served at a `zillow.com` URL that builds a real Google Map the
way Zillow does (map instance kept private). Verified: the map is detected,
tract / county / state data loads and renders at zoom 14 / 8 / 4, hover
readout, legend and popup settings stay in sync, and on/off works. Zillow's
live site blocks automated browsers, so the first real-Zillow check is yours.
