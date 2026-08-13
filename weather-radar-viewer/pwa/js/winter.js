// Winter hazards (M6): three independent things behind one module.
//
//   1. NWS gridpoint snowfallAmount / iceAccumulation for the active location,
//      rendered as a strip on the FCAST board.
//   2. The NOHRSC snow-depth raster, as a map overlay.
//   3. WPC's probabilistic winter guidance (Day 1 accumulation), as a map layer.
//
// Nothing here is date-gated. There is no "winter mode" and no month check:
// the layers are always registered and always default off, and the board strip
// appears when the forecast actually carries snow or ice — so a July upslope
// event in the Rockies renders exactly like a January one, and an August
// forecast of nothing renders as nothing rather than a row of zeroes.
//
// Two facts drive the parsing, both measured rather than assumed:
//   - gridpoint winter fields arrive in MILLIMETRES ("wmoUnit:mm"), so every
//     number on screen is converted and the conversion is disclosed;
//   - NOAA moved NOHRSC from the obs/ folder to snow/ without notice, and the
//     old path still answers 200 with an error body. Discovery therefore walks
//     the service directory; the config hint is a last resort, never step one.
//
// And the rule the whole module is arranged around: an all-zero forecast and an
// UNREADABLE one are different answers and never render the same. A confirmed
// zero shows nothing; anything the app could not parse — a unit it cannot
// convert, an absent field, a group layer with no pixels, an export that failed
// — says so on screen and turns its health dot red.

import { ARCGIS_RASTER_ROOT, ARCGIS_VECTOR, NWS_POINTS, NOHRSC_SERVICE_HINT,
         UOM_TO_IN, WINTER_REFRESH_MS, NOHRSC_REFRESH_MS,
         WPC_WINTER_REFRESH_MS } from "./config.js";
import { fetchT, okJson } from "./net.js";
import * as net from "./net.js";
import { el, pad, expandGridSeries, sumGridWindow, inches } from "./util.js";
import * as layers from "./layers.js";
import * as mapMod from "./map.js";
import * as state from "./state.js";
import * as locations from "./locations.js";

// ---------------------------------------------------------------------------
// module state

const gridCache = new Map();      // locId -> { t, snow, ice, src, err }
const pending = new Set();        // locIds with a request in flight — the board
                                  // repaints several times per fetch cycle and
                                  // must not start a second identical request
let winterSeq = 0;                // stale-response guard, same role as spc.js's stripSeq

let nohrscSvc = null;             // Promise<svc|null>, memoized for the session
let wpcSvc = null;                // Promise<string|null>, memoized
let nohrscLyr = null, wpcLyr = null;
// The raster being replaced stays painted until its replacement loads, so a pan
// does not blank the map for a whole export round-trip. It gets its OWN slot:
// an overlay that is attached to the map but held in no variable can never be
// removed again — not by the error path, not by toggling the layer off.
let nohrscStale = null;
const geo = new Map();            // WPC geojson cache: url -> { t, p }
const timers = { nohrsc: null, wpcwinter: null };
let moveTimer = null;

const NOHRSC_CATALOG_KEY = "skywatch_nohrsc_svc";
const WPC_CATALOG_KEY = "skywatch_wpcwinter_svc";
const CATALOG_TTL = 24 * 60 * 60 * 1000;
const META_MS = 15000, GEO_MS = 15000;
const MOVE_DEBOUNCE_MS = 800;
const WPC_PANE = ["swWpcWinter", 433];       // between spc outlooks(430) and tropical(435)
// The NOHRSC raster gets NO pane of its own. Leaflet's tilePane is itself
// positioned at z 200 and therefore opens its own stacking context, so the
// radar frames' zIndex 400 (map.js) never escapes it: a sibling pane at ANY
// z above 200 paints over the radar, however low the number looks next to
// "400". The raster rides inside tilePane instead and is ordered there —
// above the basemap (no explicit z) and under the radar frames (400).
const NOHRSC_Z = 300;
// Used only when the discovered service's own fullExtent can't be read in
// WGS84. Deliberately generous — a too-small guess would hide real coverage.
const FALLBACK_EXTENT = { xmin: -125, ymin: 22, xmax: -66, ymax: 50 };

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
             "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Anything below this rounds to 0.0 in and is reported as TRACE rather than a
// number that reads as "none" — and rows below it are not listed at all.
const TRACE_IN = 0.05;

function cssVar(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || "#8FA5B7";
}

function why(e) {
  const m = e && e.message ? String(e.message) : "error";
  return m === "TIMEOUT" ? "timeout" : m.toLowerCase().slice(0, 28);
}

// ---------------------------------------------------------------------------
// shared ArcGIS plumbing (duplicated locally rather than imported from spc.js —
// spc.js owns its own cache lifetimes and must not gain winter's clients)

function fetchGeo(url, ttl) {
  const hit = geo.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = fetchT(url, GEO_MS).then(okJson).then((j) => {
    // ArcGIS answers 200 with an {error:{...}} body when a layer id has moved
    if (!j || j.error) throw new Error("layer error");
    if (!Array.isArray(j.features)) throw new Error("not geojson");
    return j;
  });
  p.catch(() => { const cur = geo.get(url); if (cur && cur.p === p) geo.delete(url); });
  geo.set(url, { t: Date.now(), p });
  return p;
}

function queryUrl(service, id) {
  return service + "/" + id + "/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson";
}

function count(gj) { return ((gj && gj.features) || []).length; }

function readPersistedSvc(key) {
  try {
    const j = JSON.parse(localStorage.getItem(key) || "null");
    if (j && typeof j.t === "number" && typeof j.url === "string") return j;
  } catch { /* corrupt entry — rediscover */ }
  return null;
}

function persistSvc(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

// Walk an ArcGIS service directory root plus its folders, collecting the
// services whose name matches `re`. This is the whole point of the module's
// discovery discipline: the root listing does NOT contain the folder services,
// so a service that moves between folders is only findable by walking. Folders
// whose own name looks relevant are visited first so the common case costs one
// or two extra requests, not nine.
async function walkServices(rootUrl, re, folderHintRe) {
  const hits = [];
  const take = (list) => {
    for (const s of list || []) {
      if (!s || !/MapServer|ImageServer/i.test(String(s.type || ""))) continue;
      if (re.test(String(s.name || ""))) hits.push({ name: String(s.name), type: String(s.type) });
    }
  };
  const root = await fetchT(rootUrl + "?f=json", META_MS).then(okJson);
  if (!root || root.error) throw new Error("no service directory");
  take(root.services);
  const folders = ((root.folders) || []).map(String);
  const ordered = folders.filter((f) => folderHintRe.test(f))
    .concat(folders.filter((f) => !folderHintRe.test(f)));
  for (const f of ordered) {
    try {
      const sub = await fetchT(rootUrl + "/" + encodeURIComponent(f) + "?f=json", META_MS).then(okJson);
      take(sub && sub.services);
    } catch { /* one unreadable folder must not end the walk */ }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// NOHRSC snow depth

const RASTER_SERVICES = ARCGIS_RASTER_ROOT + "/rest/services";

function rasterSvcUrl(name, type) {
  return RASTER_SERVICES + "/" + String(name).replace(/^\/+/, "") + "/" + (type || "MapServer");
}

// Depth and Snow Water Equivalent are bundled in the SAME MapServer (today:
// ids 0 and 4). They are physically different measurements, so the id is
// resolved BY NAME and SWE is never allowed to win — rendering SWE under a
// "SNOW DEPTH" label would be a quietly wrong map, the worst kind.
//
// Both are mosaic datasets, and ArcGIS publishes a mosaic as a GROUP layer
// wrapping Boundary/Footprint/Image children (0 -> 1,2,3 and 4 -> 5,6,7 in
// today's catalog). A group carries no pixels of its own and export does not
// expand a group id in layers=show, so asking for the group alone comes back
// fully transparent — a healthy-looking layer with nothing on it. Listing the
// children wholesale is no better: it draws the mosaic's boundary and footprint
// rectangles over the map. So resolve the group by name, then draw its RASTER
// child. spc.js reads subLayerIds for the same reason.
//
// Returns { id, show } — id is the named layer (what the user is being shown,
// and what the health note discloses), show is the id list actually exported.
function pickDepthLayer(catalog) {
  const list = (catalog && catalog.layers) || [];
  const nameOf = (id) => {
    const l = list.find((x) => x && x.id === id);
    return String((l && l.name) || "");
  };
  const hit = list.find((l) => /snow\s*depth/i.test(String((l && l.name) || "")));
  if (!hit) return null;
  const kids = Array.isArray(hit.subLayerIds) ? hit.subLayerIds.filter((k) => k != null) : [];
  if (!kids.length) return { id: hit.id, show: [hit.id] };
  const raster = kids.filter((k) => /image|raster/i.test(nameOf(k)));
  const drawable = raster.length
    ? raster
    : kids.filter((k) => !/boundary|footprint/i.test(nameOf(k)));
  return { id: hit.id, show: drawable.length ? drawable : kids };
}

// Ids the export actually asks for. Older persisted catalogs predate `showIds`,
// so fall back to the single named id rather than dropping the parameter —
// without it the service default would draw Snow Water Equivalent on top.
function showIds(svc) {
  if (svc && Array.isArray(svc.showIds) && svc.showIds.length) return svc.showIds;
  return svc && svc.layerId != null ? [svc.layerId] : [];
}

// Says which ids are being drawn AND whether they were resolved or guessed —
// a name-resolved id and a config hint must never look the same on screen.
function depthNote(svc) {
  const shown = showIds(svc).join(",");
  const lead = svc.hinted ? "snow depth · hinted layer " : "snow depth · layer ";
  return lead + svc.layerId + (shown === String(svc.layerId) ? "" : " · raster " + shown);
}

// Last-resort ids, used only when the catalog itself could not be read.
function hintShow() {
  const r = NOHRSC_SERVICE_HINT.rasterIdHint;
  return [r != null ? r : NOHRSC_SERVICE_HINT.layerIdHint];
}

function readExtent(desc) {
  const e = desc && desc.fullExtent;
  if (!e) return null;
  const wkid = e.spatialReference && (e.spatialReference.latestWkid || e.spatialReference.wkid);
  if (wkid !== 4326) return null;      // projected extents are not comparable to a lat/lon viewport
  const nums = [e.xmin, e.ymin, e.xmax, e.ymax];
  if (!nums.every((n) => typeof n === "number" && isFinite(n))) return null;
  return { xmin: e.xmin, ymin: e.ymin, xmax: e.xmax, ymax: e.ymax };
}

function discoverNohrsc() {
  if (nohrscSvc) return nohrscSvc;
  nohrscSvc = (async () => {
    const stored = readPersistedSvc(NOHRSC_CATALOG_KEY);
    if (stored && Date.now() - stored.t < CATALOG_TTL) return stored;
    const hits = await walkServices(RASTER_SERVICES, /snow|nohrsc|sno_|swe/i, /snow|obs|hydro|nohrsc/i);
    if (!hits.length) throw new Error("no service");
    // /nohrsc/i first so snow/NOHRSC_Snow_Analysis beats the other live
    // candidate in this catalog (obs/usnic_ims_snow_ice_1km, a different product)
    const best = hits.find((s) => /nohrsc/i.test(s.name)) ||
                 hits.find((s) => /snow_analysis/i.test(s.name)) || hits[0];
    const url = rasterSvcUrl(best.name, best.type);
    let pick = null, extent = null;
    try {
      const cat = await fetchT(url + "/layers?f=json", META_MS).then(okJson);
      pick = pickDepthLayer(cat);
    } catch { /* fall through to the hint ids */ }
    try {
      extent = readExtent(await fetchT(url + "?f=json", META_MS).then(okJson));
    } catch { /* fall through to FALLBACK_EXTENT */ }
    const svc = {
      t: Date.now(), url, type: best.type,
      layerId: pick ? pick.id : NOHRSC_SERVICE_HINT.layerIdHint,
      showIds: pick ? pick.show : hintShow(),
      hinted: !pick, extent
    };
    persistSvc(NOHRSC_CATALOG_KEY, svc);
    return svc;
  })().catch(() => {
    nohrscSvc = null;                 // transient outage: a later toggle rediscovers
    const stored = readPersistedSvc(NOHRSC_CATALOG_KEY);
    if (stored) return stored;        // an expired resolution still beats guessing
    // Last resort only. These are the confirmed live values, so the layer keeps
    // working through a discovery outage — but discovery is always tried first,
    // because this exact path is the one that went stale last time.
    return {
      t: 0, url: rasterSvcUrl(NOHRSC_SERVICE_HINT.name, NOHRSC_SERVICE_HINT.type),
      type: NOHRSC_SERVICE_HINT.type, layerId: NOHRSC_SERVICE_HINT.layerIdHint,
      showIds: hintShow(), hinted: true, extent: null
    };
  });
  return nohrscSvc;
}

function viewportBBox(m) {
  const b = m.getBounds();
  const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    w: cl(b.getWest(), -180, 180), s: cl(b.getSouth(), -85, 85),
    e: cl(b.getEast(), -180, 180), n: cl(b.getNorth(), -85, 85)
  };
}

function intersectsCoverage(bbox, extent) {
  if (!extent) return true;          // unknown coverage: draw and let the service answer
  return bbox.w < extent.xmax && bbox.e > extent.xmin &&
         bbox.s < extent.ymax && bbox.n > extent.ymin;
}

// imageSR is the map's projection, NOT the bbox's. The map is EPSG:3857 (map.js
// takes Leaflet's default CRS) and L.imageOverlay only pins the four corners of
// the image to their pixel positions — it does not reproject. A 4326 export is
// equirectangular, where the row fraction is linear in LATITUDE, so stretching
// one across a Mercator viewport lands every interior row at the wrong latitude:
// at zoom 5 over 32N-48N the middle row carries 40.0N but is drawn at 40.48N,
// ~53 km of misregistration, growing with the latitude span. Asking for a
// Mercator image makes the corner pinning exact. The bbox stays in lat/lon
// (bboxSR=4326) — the viewport's projected envelope has the same aspect ratio
// as m.getSize(), so no stretch is introduced by the size parameter.
function nohrscExportUrl(svc, bbox, size) {
  const w = Math.max(64, Math.round(size.x)), h = Math.max(64, Math.round(size.y));
  const ids = showIds(svc);
  return svc.url + "/export?f=image" +
    "&bbox=" + [bbox.w, bbox.s, bbox.e, bbox.n].join(",") +
    "&bboxSR=4326&imageSR=3857" +
    "&size=" + w + "," + h +
    "&format=png&transparent=true" +
    (ids.length ? "&layers=show:" + ids.join(",") : "");
}

// WPC's pane only. The NOHRSC raster rides in tilePane (see NOHRSC_Z) and needs
// no pane of its own to stay out of the way: Leaflet's own stylesheet gives
// .leaflet-image-layer pointer-events:none unless the overlay is interactive.
function pane(m) {
  const [name, z] = WPC_PANE;
  if (!m.getPane(name)) {
    const p = m.createPane(name);
    p.style.zIndex = String(z);
    p.style.pointerEvents = "none";   // a viewport-wide fill must not eat map drags
  }
  return name;
}

function drop(lyr) {
  const m = mapMod.getMap();
  if (lyr && m && m.hasLayer(lyr)) m.removeLayer(lyr);
  return null;
}

async function drawNohrsc() {
  const m0 = mapMod.getMap();
  if (!m0 || !window.L) { layers.setHealth("nohrsc", false, "map unavailable"); return; }
  try {
    const svc = await discoverNohrsc();
    if (!svc) { layers.setHealth("nohrsc", false, "service unavailable"); return; }
    if (!layers.isOn("nohrsc")) return;               // toggled off mid-flight
    const m = mapMod.getMap();
    if (!m) return;
    const bbox = viewportBBox(m);
    if (!intersectsCoverage(bbox, svc.extent || FALLBACK_EXTENT)) {
      clearLayer("nohrsc");
      layers.setHealth("nohrsc", true, "out of coverage — CONUS only");
      return;
    }
    const url = nohrscExportUrl(svc, bbox, m.getSize());
    const bounds = [[bbox.s, bbox.w], [bbox.n, bbox.e]];
    const next = window.L.imageOverlay(url, bounds, {
      pane: "tilePane", zIndex: NOHRSC_Z, opacity: 0.62, interactive: false,
      alt: "NOHRSC modelled snow depth"
    });
    // Swap on load, not before: replacing the old raster up front leaves a
    // blank map for the length of the export round-trip on every pan. Both
    // overlays are tracked while that overlap lasts, so every path below —
    // load, error, and a toggle-off in between — can take BOTH off the map.
    if (nohrscStale && nohrscStale !== nohrscLyr) nohrscStale = drop(nohrscStale);
    nohrscStale = nohrscLyr;
    nohrscLyr = next;
    next.on("load", () => {
      if (nohrscLyr !== next) return;           // superseded, or toggled off mid-load
      nohrscStale = drop(nohrscStale);
      layers.setHealth("nohrsc", true, depthNote(svc));
    });
    next.on("error", () => {
      // The old raster belongs to the old viewport, so a failed export leaves
      // nothing trustworthy to keep showing: drop both, and say so.
      if (nohrscLyr === next) nohrscLyr = drop(next); else drop(next);
      nohrscStale = drop(nohrscStale);
      layers.setHealth("nohrsc", false, "image unavailable");
    });
    next.addTo(m);
  } catch (e) {
    layers.setHealth("nohrsc", false, why(e));
  }
}

// ---------------------------------------------------------------------------
// WPC probabilistic winter guidance (Day 1 accumulation)

function vectorSvcUrl(name, type) {
  return ARCGIS_VECTOR + String(name).replace(/^\/+/, "") + "/" + (type || "MapServer");
}

function discoverWpcWinter() {
  if (wpcSvc) return wpcSvc;
  wpcSvc = (async () => {
    const stored = readPersistedSvc(WPC_CATALOG_KEY);
    if (stored && Date.now() - stored.t < CATALOG_TTL) return stored.url;
    const hits = await walkServices(
      ARCGIS_VECTOR.replace(/\/+$/, ""),
      /wpc.*winter|winter.*wpc|wssi|prob_winter/i,
      /precip|outlook|hazard|winter/i);
    // Deliberately NO "else first match" here. This catalog also carries
    // unrelated ice services (obs/asip_ice_chart, obs/usnic_greatlakes_ice_chart);
    // drawing one of those under a "WPC WINTER GUIDANCE" label would be worse
    // than showing the layer as unavailable.
    const best = hits.find((s) => /prob.*winter|winter.*prob/i.test(s.name)) ||
                 hits.find((s) => /wssi/i.test(s.name));
    if (!best) throw new Error("no service");
    const url = vectorSvcUrl(best.name, best.type);
    persistSvc(WPC_CATALOG_KEY, { t: Date.now(), url });
    return url;
  })().catch(() => {
    wpcSvc = null;                    // transient outage: a later toggle rediscovers
    const stored = readPersistedSvc(WPC_CATALOG_KEY);
    return stored ? stored.url : null;
  });
  return wpcSvc;
}

// The live catalog carries 15 layers (Days 1-3 x {accumulation, >=4in, >=8in,
// >=12in snow, icing}). Only the Day 1 combined accumulation layer ships this
// milestone; the rest are discovered and deliberately unused.
//
// null, never a hardcoded id: config.js keeps no hint for this service on
// purpose, and there is nothing sensible to guess. Id 0 in particular is NOT a
// safe default — through the wssi tie-break it is a Winter Storm Severity Index
// impact layer, an entirely different product, and drawing that under a
// "DAY 1 ACCUMULATION" label is worse than showing the layer as unavailable.
async function wpcDay1LayerId(svcUrl) {
  try {
    const cat = await fetchT(svcUrl + "/layers?f=json", META_MS).then(okJson);
    for (const l of (cat && cat.layers) || []) {
      if (/^day\s*0*1\b.*accumulation/i.test(String(l.name || ""))) return l.id;
    }
  } catch { /* an unreadable catalog is not an id */ }
  return null;
}

async function drawWpcWinter() {
  const m0 = mapMod.getMap();
  if (!m0 || !window.L) { layers.setHealth("wpcwinter", false, "map unavailable"); return; }
  try {
    const svc = await discoverWpcWinter();
    if (!svc) { layers.setHealth("wpcwinter", false, "service unavailable"); return; }
    const id = await wpcDay1LayerId(svc);
    if (id == null) { layers.setHealth("wpcwinter", false, "day 1 layer not found"); return; }
    const gj = await fetchGeo(queryUrl(svc, id), WPC_WINTER_REFRESH_MS * 0.9);
    if (!layers.isOn("wpcwinter")) return;
    const m = mapMod.getMap();
    if (!m) return;
    wpcLyr = drop(wpcLyr);
    // One uniform token fill, not a graduated ramp. SPC's categorical outlooks
    // have a small published enum with official colors; WPC's accumulation
    // renderer breaks are not confirmed, and inventing a ramp would be a guess
    // dressed up as data. Same choice spc.js already makes for MD/tropical.
    const c = cssVar("--snow");
    wpcLyr = window.L.geoJSON(gj, {
      pane: pane(m),
      interactive: false,
      style: { color: c, weight: 1, opacity: 0.85, fillColor: c, fillOpacity: 0.22 }
    }).addTo(m);
    layers.setHealth("wpcwinter", true, count(gj) + " areas");
  } catch (e) {
    layers.setHealth("wpcwinter", false, why(e));
  }
}

// ---------------------------------------------------------------------------
// layer toggles / timers

function clearLayer(id) {
  if (id === "nohrsc") {
    nohrscLyr = drop(nohrscLyr);
    nohrscStale = drop(nohrscStale);   // the outgoing raster is on the map too
  } else if (id === "wpcwinter") wpcLyr = drop(wpcLyr);
}

function stopTimer(id) { if (timers[id]) { clearInterval(timers[id]); timers[id] = null; } }

function startTimer(id, draw, ms) {
  stopTimer(id);
  timers[id] = setInterval(() => {
    if (layers.isOn(id)) draw();
    else stopTimer(id);
  }, ms);
}

// onToggle runs synchronously inside layers.register(), so the draw is deferred
// to a microtask: boot never waits on the network, and an off layer never fetches.
function toggle(id, draw, ms) {
  const run = () => { Promise.resolve().then(draw).catch((e) => layers.setHealth(id, false, why(e))); };
  return (on) => {
    stopTimer(id);
    if (!on) { clearLayer(id); return; }
    run();
    startTimer(id, run, ms);
  };
}

// The NOHRSC raster is exported for the exact viewport, so a pan or zoom
// invalidates it. Debounced so a pinch-zoom is one export, not thirty.
function onMoveEnd() {
  if (!layers.isOn("nohrsc")) return;
  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    moveTimer = null;
    if (layers.isOn("nohrsc")) drawNohrsc();
  }, MOVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// NWS gridpoint snow / ice

function toInches(uom, v) {
  if (v == null || isNaN(v)) return null;
  const f = UOM_TO_IN[uom];
  return f == null ? null : v * f;    // an unknown unit is missing data, never a guessed factor
}

// A field the app cannot read is MISSING DATA, and missing data has to stay
// distinguishable from a confirmed zero. Numerically it already was — nothing is
// ever coerced to 0 — but that is worth nothing while both cases render as the
// same empty strip under the same green dot. So every field reports WHY it
// produced no numbers:
//   ok      at least one value parsed
//   nounit  values are there but the uom is not one we can convert (a WFO on
//           different units, or NWS renaming/rescaling the field) — the case
//           that would otherwise hide a 12-inch storm behind a blank strip
//   missing the field is absent, empty, or entirely null
function convertField(field) {
  if (!field || !Array.isArray(field.values) || !field.values.length) {
    return { values: [], state: "missing", uom: null };
  }
  if (UOM_TO_IN[field.uom] == null) {
    return { values: [], state: "nounit", uom: String(field.uom || "none") };
  }
  const values = field.values
    .map((v) => ({ validTime: v && v.validTime, value: toInches(field.uom, v && v.value) }))
    .filter((v) => v.value != null);
  return { values, state: values.length ? "ok" : "missing", uom: field.uom };
}

// Human sentence for a field that carried nothing readable, or null when it did.
function fieldNote(label, st) {
  if (!st || st.state === "ok") return null;
  return st.state === "nounit"
    ? label + " UNREADABLE — UNRECOGNISED UNIT " + String(st.uom).toUpperCase()
    : label + " MISSING FROM GRIDPOINT";
}

// Short form of the same notes for the status panel, which is one mono line
// per source: "SNOW UNREADABLE — UNRECOGNISED UNIT WMOUNIT:MM S-1" becomes
// "snow unreadable". The full sentence lives on the board.
function healthDetail(notes) {
  if (!notes.length) return "gridpoint ok";
  return notes.map((n) => n.split(" —")[0].toLowerCase()).join(" · ");
}

// "wmoUnit:mm" -> "MM", so the disclosure names the unit actually converted
// instead of asserting millimetres whatever arrived.
function unitLabel(states) {
  const seen = [];
  for (const st of states) {
    if (!st || st.state !== "ok" || !st.uom) continue;
    const u = String(st.uom).split(":").pop().toUpperCase();
    if (!seen.includes(u)) seen.push(u);
  }
  return seen.join("/");
}

async function fetchWinterGrid(loc) {
  const points = await fetchT(NWS_POINTS + loc.lat.toFixed(4) + "," + loc.lon.toFixed(4), META_MS)
    .then(okJson);
  const props = (points && points.properties) || {};
  const gridUrl = props.forecastGridData;
  if (!gridUrl) throw new Error("no gridpoint");
  const gp = await fetchT(gridUrl, META_MS).then(okJson).then((j) => (j && j.properties) || {});
  const src = props.gridId
    ? props.gridId + " " + props.gridX + "," + props.gridY
    : String(gridUrl).split("/gridpoints/")[1] || "NWS GRID";
  const snow = convertField(gp.snowfallAmount);
  const ice = convertField(gp.iceAccumulation);
  return {
    snow: expandGridSeries(snow.values), ice: expandGridSeries(ice.values),
    notes: [fieldNote("SNOW", snow), fieldNote("ICE", ice)].filter(Boolean),
    unit: unitLabel([snow, ice]),
    src: String(src).replace("/", " ").toUpperCase()
  };
}

function ensureWinterFresh(loc) {
  if (!loc) return;
  const hit = gridCache.get(loc.id);
  if (hit && Date.now() - hit.t < WINTER_REFRESH_MS) return;
  if (pending.has(loc.id)) return;
  pending.add(loc.id);
  const seq = ++winterSeq;
  fetchWinterGrid(loc).then((d) => {
    pending.delete(loc.id);
    if (seq !== winterSeq) return;                  // superseded by a later location
    gridCache.set(loc.id, { t: Date.now(), snow: d.snow, ice: d.ice, src: d.src,
                            notes: d.notes, unit: d.unit, err: null });
    // HTTP 200 is not the same as "a field was read". A grid whose winter
    // fields could not be parsed is reported as down, so the green dot keeps
    // meaning what it says.
    net.setHealth("winter", "WINTER", !d.notes.length, healthDetail(d.notes));
    repaint();
  }).catch((e) => {
    pending.delete(loc.id);
    if (seq !== winterSeq) return;
    gridCache.set(loc.id, { t: Date.now(), snow: [], ice: [], src: null,
                            notes: [], unit: "", err: why(e) });
    net.setHealth("winter", "WINTER", false, why(e));
    repaint();
  });
}

function repaint() {
  const host = document.getElementById("winterStrip");
  if (host) renderWinterStrip(host);
}

// ---------------------------------------------------------------------------
// FCAST board strip

function hourLabel(d) {
  const h = d.getHours(), m = d.getMinutes();
  const ap = h < 12 ? "AM" : "PM";
  return (h % 12 || 12) + (m ? ":" + pad(m, 2) : "") + ap;
}
function dayLabel(d) { return DOW[d.getDay()] + " " + MON[d.getMonth()] + " " + d.getDate(); }
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}
function intervalLabel(iv) {
  const from = DOW[iv.start.getDay()] + " " + hourLabel(iv.start);
  const to = (sameDay(iv.start, iv.end) ? "" : DOW[iv.end.getDay()] + " ") + hourLabel(iv.end);
  return from + "–" + to;
}

// A number that rounds to 0.0 must not be printed as 0.0 — it reads as "none"
// when the forecast actually says "a little".
function amount(v) {
  if (v == null || isNaN(v)) return "--";
  if (v > 0 && v < TRACE_IN) return "TRACE";
  return inches(v, 1);
}

function totalOf(series) {
  if (!series.length) return null;
  return sumGridWindow(series, series[0].start.getTime(),
                       series[series.length - 1].end.getTime());
}

function lastMeaningful(series) {
  for (let i = series.length - 1; i >= 0; i--) if (series[i].value >= TRACE_IN) return series[i];
  return null;
}

function totalRow(kind, label, series) {
  const total = totalOf(series);
  if (total == null || total <= 0) return null;
  const last = lastMeaningful(series) || series[series.length - 1];
  return el("div", { class: "winterrow " + kind },
    el("span", { class: "k" }, label),
    el("span", { class: "v" }, amount(total) + " THROUGH " + dayLabel(last.end)));
}

function periodRows(series) {
  return series.filter((iv) => iv.value >= TRACE_IN).slice(0, 8).map((iv) =>
    el("div", { class: "winterper" },
      el("span", { class: "k" }, intervalLabel(iv)),
      el("span", { class: "v" }, amount(iv.value))));
}

export function renderWinterStrip(container) {
  if (!container) return;
  container.className = "winterstrip";
  const loc = locations.active();
  if (!loc) {
    container.replaceChildren(el("div", { class: "srcnote" }, "WINTER HAZARDS — NO LOCATION SET"));
    return;
  }
  const c = gridCache.get(loc.id);
  // Nothing fetched yet: render nothing at all rather than a LOADING box that
  // will, in the overwhelmingly common case, resolve to nothing anyway.
  if (!c) { container.replaceChildren(); return; }
  if (c.err) {
    container.replaceChildren(el("div", { class: "srcnote" }, "WINTER HAZARDS UNAVAILABLE — " + c.err));
    return;
  }
  const snowRow = totalRow("snow", "SNOW:", c.snow);
  const iceRow = totalRow("ice", "ICE ACCUMULATION:", c.ice);
  const notes = c.notes || [];
  // The seasonality rule, and the only one: a CONFIRMED all-zero forecast
  // renders nothing. This is the live August-in-Iowa case (30 non-null zeroes),
  // and it is a success, not a failure. A field that could not be read is not
  // that case and never renders as it — notes carries the reason, and it is
  // printed below.
  if (!snowRow && !iceRow && !notes.length) { container.replaceChildren(); return; }

  const kids = [el("div", { class: "sect" }, "WINTER HAZARDS")];
  if (snowRow) kids.push(snowRow);
  if (iceRow) kids.push(iceRow);
  kids.push(...periodRows(c.snow));
  if (notes.length) {
    kids.push(el("div", { class: "srcnote" },
      (snowRow || iceRow ? "NOT AVAILABLE: " : "WINTER HAZARDS UNAVAILABLE — ") +
      notes.join(" · ")));
  }
  kids.push(el("div", { class: "srcnote" },
    "NWS GRIDPOINT FORECAST · " + (c.src || "NWS GRID") +
    (c.unit ? " · VALUES CONVERTED FROM " + c.unit + " TO INCHES" : "")));
  container.replaceChildren(...kids);
}

// ---------------------------------------------------------------------------

export function init() {
  try {
    // "MODELLED" is on the label, not only in the image's alt text: NOHRSC's
    // National Snow Analysis is a snow model assimilating observations, not a
    // field of measured depths, and a bare "SNOW DEPTH" invites reading it as
    // the latter.
    layers.register({ id: "nohrsc", label: "SNOW DEPTH (NOHRSC) · MODELLED", defaultOn: false,
                      onToggle: toggle("nohrsc", drawNohrsc, NOHRSC_REFRESH_MS) });
    layers.register({ id: "wpcwinter", label: "WPC WINTER GUIDANCE (DAY 1)", defaultOn: false,
                      onToggle: toggle("wpcwinter", drawWpcWinter, WPC_WINTER_REFRESH_MS) });

    const m = mapMod.getMap();
    if (m) m.on("moveend", onMoveEnd);

    // forecastx.js drops an empty #winterStrip into the FCAST board and emits
    // this on every repaint, so the strip is re-rendered into the fresh node.
    state.on("castboard", (d) => {
      const host = d && d.el && d.el.querySelector("#winterStrip");
      if (!host) return;
      renderWinterStrip(host);
      ensureWinterFresh(locations.active());
    });

    locations.onChange(() => { repaint(); ensureWinterFresh(locations.active()); });
  } catch { /* a broken winter module must never take boot down */ }
}
