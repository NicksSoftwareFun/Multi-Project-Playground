# Zillow Map Overlays: Race, DC Metro, Road Distance (Brave / Chrome extension)

Adds three things to Zillow's search map:

1. **Race dot density**: the Esri Living Atlas map **"Race in the US by Dot Density"**
   ([ArcGIS Hub link](https://hub.arcgis.com/maps/arcgis-content::race-in-the-us-by-dot-density/explore)).
2. **DC Metrorail**: Red, Orange, Silver, Blue, Yellow and Green lines in
   WMATA colors, drawn side by side where they share track, with all stations
   (names from zoom 13; hover a station to see its lines).
3. **Road distance**: click **Measure distance** on the map panel, click
   point A, then point B. You get driving miles along roads, an approximate
   drive time (no traffic), and the straight-line distance. Click again to
   start over; press Esc or **Done measuring** to finish.

### Race dot density

- Same data, colors, and groups as the ArcGIS map: U.S. Census ACS 5-year
  estimates, table B03002 (Hispanic or Latino origin by race), from Esri's
  [ACS Race and Hispanic Origin Variables – Boundaries](https://www.arcgis.com/home/item.html?id=23ab8028f1784de4b0810104cd5d1c8f)
  layer.
- Switches geography by zoom: **state** (zoomed way out) → **county** →
  **census tract** (city / neighborhood zoom, where you'll usually be on Zillow).
- Hover over any spot to see that tract's name, population, and percent by group.
- Legend on the map with per-group checkboxes; toolbar popup for opacity,
  dot size, people-per-dot, basemap darkening, and outlines.
- No account or API key needed for any feature.

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
| Metro lines | Map panel or popup | Metro lines and stations on/off |
| Measure distance | Map panel | Two-click road distance (Esc to stop) |
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
| `manifest.json` | Manifest V3; runs on `www.zillow.com`; fetches only from `services.arcgis.com` (race), `maps2.dcgis.dc.gov` (Metro) and `router.project-osrm.org` (routing) |
| `page-hook.js` | Runs in Zillow's page, finds Zillow's Google Map, draws the dots, Metro lines and measured route on canvas overlays, and builds the map panel |
| `content.js` | Bridge between the page and the extension (settings + data requests) |
| `background.js` | Queries the ArcGIS FeatureServer by map tile (paged, cached); fetches Metro lines/stations (cached a week); asks OSRM for driving routes |
| `config.js` | Shared fields, colors, and per-level settings |
| `popup.*` | Toolbar settings panel |

Zillow's map is a Google Map created inside Zillow's own code. The extension
recognizes it the first time Zillow or Google Maps calls any method on it,
then attaches a standard `google.maps.OverlayView`, so the dots pan and zoom
with the map and normally sit under Zillow's price markers.

## Data sources and limits

- **Race:** U.S. Census ACS 5-year, table B03002, via Esri Living Atlas.
- **Metro:** DC GIS open data, *Metro Lines (Regional)* and *Metro Stations
  (Regional)*. Lines are offset a few pixels so shared track shows each
  color; stations sit at their true location.
- **Road distance:** OpenStreetMap roads via the public OSRM demo router.
  Drive times are free-flow estimates with no traffic. Clicks snap to the
  nearest road. The public router is meant for light use, which a person
  measuring by hand is.

## Troubleshooting

- **No legend, no dots:** reload the Zillow tab after installing or updating
  the extension. Check `brave://extensions` for an error badge on the
  extension.
- **Legend says "Couldn't load some data":** Esri's service was slow or down;
  pan or zoom slightly to retry.
- **"Couldn't get a road route":** the routing server was busy or a point
  was far from any road; click again to retry.
- **Stopped working after a Zillow update:** the extension depends on Zillow
  using Google Maps. If Zillow changes map providers, `page-hook.js` needs a
  new adapter.

## Testing notes

Tested in Chromium (the engine Brave uses) with the extension loaded unpacked,
against a page served at a `zillow.com` URL that builds a real Google Map the
way Zillow does (map instance kept private). Verified: the map is detected,
tract / county / state data loads and renders at zoom 14 / 8 / 4, hover
readout, legend and popup settings stay in sync, and on/off works. For 1.2:
all 6 Metro lines and 98 stations load and draw (shared track side by side,
station hover), and a two-click measurement in DC returned a 5.82 mi road
route vs. 4.62 mi straight line; Esc clears it. Zillow's
live site blocks automated browsers, so the first real-Zillow check is yours.
