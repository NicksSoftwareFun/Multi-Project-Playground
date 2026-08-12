// SPC convective outlooks (Day 1-3 categorical), mesoscale discussions, and
// tropical products — three map layers plus the risk strip on the SEVERE board.
//
// Everything remote here is an ArcGIS MapServer that NOAA renumbers and moves
// without notice, so nothing is hardcoded that can be discovered instead:
// layer ids come from /layers?f=json, the category field is sniffed off the
// first feature that carries a known category, and the tropical service is
// resolved from the service directory at runtime. Every failure path ends in a
// visible "N/A" (layers.setHealth) or an "UNAVAILABLE" line — never a silently
// empty layer or box.

import { SPC_OUTLOOKS, SPC_MD, SPC_LAYER_HINTS, SPC_CAT_COLORS, SPC_REFRESH_MS,
         ARCGIS_TROPICAL_ROOT } from "./config.js";
import { fetchT, okJson } from "./net.js";
import { el } from "./util.js";
import * as layers from "./layers.js";
import * as mapMod from "./map.js";
import * as state from "./state.js";
import * as locations from "./locations.js";

// ascending severity — index doubles as the rank used to pick the worst
// category when a point falls inside several nested outlook polygons
const CATS = ["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH"];
const CAT_SET = new Set(CATS);
const CAT_LABEL = {
  TSTM: "GENERAL THUNDERSTORMS", MRGL: "MARGINAL RISK", SLGT: "SLIGHT RISK",
  ENH: "ENHANCED RISK", MDT: "MODERATE RISK", HIGH: "HIGH RISK"
};
const NEUTRAL = "#8FA3B5";        // unknown category / tropical products

const GEO_MS = 15000;             // outlook geojson is big; 8s default is too tight
const META_MS = 10000;
const CATALOG_KEY = "skywatch_spc_layers";
const CATALOG_TTL = 24 * 60 * 60 * 1000;

// fetchGeo() stamps its cache entry when a request is *issued*, and a timer
// fire lands almost exactly SPC_REFRESH_MS after the issue of the fetch it is
// meant to replace — real fetch latency and setInterval drift are enough to
// let "elapsed < SPC_REFRESH_MS" read true at that instant, so the timer's
// own refetch silently no-ops and the layer only really turns over every
// other tick. Give the timer-driven draw a shorter TTL so it never races the
// same clock it is measured against.
const TIMER_TTL_MS = SPC_REFRESH_MS * 0.9;

// Dedicated panes so outlooks sit under the alert polygons (alerts own >=450).
// [paneName, zIndex]
const PANES = { spc: ["swSpc", 430], tropical: ["swTropical", 435], spcmd: ["swSpcMd", 440] };

// ---------------------------------------------------------------------------
// remote plumbing

// Shared geojson cache: the map layer and the board strip hit the same Day 1
// URL, so one fetch serves both and reopening the board is free for the TTL.
const geo = new Map();            // url -> { t, p }

function fetchGeo(url, ttl) {
  const hit = geo.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = fetchT(url, GEO_MS).then(okJson).then((j) => {
    // ArcGIS answers 200 with an {error:{...}} body when a layer id has moved
    if (!j || j.error) throw new Error("layer error");
    if (!Array.isArray(j.features)) throw new Error("not geojson");
    return j;
  });
  // never let a rejection sit in the cache for the full TTL — drop it so the
  // next toggle/board open retries instead of replaying a 30-minute-old failure
  p.catch(() => { const cur = geo.get(url); if (cur && cur.p === p) geo.delete(url); });
  geo.set(url, { t: Date.now(), p });
  return p;
}

function queryUrl(service, id) {
  return service + "/" + id + "/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson";
}

// Layer catalog: { t, map:{id:name}, group:[ids], geom:{id:esriGeometryType} }.
// group + geom matter because a group layer is not queryable and we only want
// drawable geometry — but `map` is kept as a plain id->name map on purpose.
const catalogs = new Map();       // serviceUrl -> Promise<catalog|null>

function readPersisted(key) {
  try {
    const j = JSON.parse(localStorage.getItem(key) || "null");
    if (j && j.map && typeof j.t === "number") return j;
  } catch { /* corrupt entry — refetch */ }
  return null;
}

function serviceLayers(service, persistKey) {
  if (catalogs.has(service)) return catalogs.get(service);
  const stored = persistKey ? readPersisted(persistKey) : null;
  if (stored && Date.now() - stored.t < CATALOG_TTL) {
    const cached = Promise.resolve(stored);
    catalogs.set(service, cached);
    return cached;
  }
  const p = fetchT(service + "/layers?f=json", META_MS).then(okJson).then((j) => {
    if (!j || !Array.isArray(j.layers) || !j.layers.length) throw new Error("no layers");
    const cat = { t: Date.now(), map: {}, group: [], geom: {} };
    for (const l of j.layers) {
      cat.map[l.id] = String(l.name || "");
      cat.geom[l.id] = String(l.geometryType || "");
      if (Array.isArray(l.subLayerIds) && l.subLayerIds.length) cat.group.push(l.id);
    }
    if (persistKey) {
      try { localStorage.setItem(persistKey, JSON.stringify(cat)); } catch { /* quota */ }
    }
    return cat;
  }).catch(() => {
    catalogs.delete(service);     // transient failure: let the next attempt retry
    return stored;                // an expired catalog still beats guessing (null if none)
  });
  catalogs.set(service, p);
  return p;
}

// Resolve the Day N CATEGORICAL layer by name. Falls back to the CI-verified
// hint ids, which are only ever a last resort — NOAA renumbers this service.
async function outlookLayerId(day) {
  const hint = SPC_LAYER_HINTS["d" + day];
  const cat = await serviceLayers(SPC_OUTLOOKS, CATALOG_KEY);
  if (!cat || !cat.map) return hint;
  const dayRe = new RegExp("day\\s*0*" + day + "(?!\\d)", "i");
  const groups = new Set(cat.group || []);
  let groupHit = null;
  for (const key of Object.keys(cat.map)) {          // integer keys iterate ascending
    const name = cat.map[key];
    if (!/categor/i.test(name) || !dayRe.test(name)) continue;
    const id = Number(key);
    // A same-named polyline/point companion layer must never win the pick —
    // absent geometryType is accepted, matching mdLayerIds' own default.
    const geomType = cat.geom && cat.geom[id];
    if (geomType && !/polygon/i.test(geomType)) continue;
    if (groups.has(id)) { if (groupHit == null) groupHit = id; continue; }
    return id;
  }
  return groupHit != null ? groupHit : hint;
}

// The categorical field name varies by service revision (label / LABEL / dn…),
// so identify it by VALUE: the first string property that is a known category.
function catOf(props) {
  if (!props) return null;
  for (const k in props) {
    const v = props[k];
    if (typeof v !== "string") continue;
    const s = v.trim().toUpperCase();
    if (CAT_SET.has(s)) return s;
  }
  return null;
}

function why(e) {
  const m = e && e.message ? String(e.message) : "error";
  return m === "TIMEOUT" ? "timeout" : m.toLowerCase().slice(0, 28);
}

// ---------------------------------------------------------------------------
// point-in-polygon (self-contained: util.js is owned by another module)

// Ray casting on one ring. GeoJSON coordinates are [lon, lat].
function inRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (!a || !b) continue;
    const xi = a[0], yi = a[1], xj = b[0], yj = b[1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// rings[0] is the outer ring, rings[1..] are holes
function inPolygon(lon, lat, rings) {
  if (!Array.isArray(rings) || !rings.length) return false;
  if (!inRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(lon, lat, rings[i])) return false;
  return true;
}

function inGeometry(lon, lat, g) {
  if (!g) return false;
  if (g.type === "Polygon") return inPolygon(lon, lat, g.coordinates);
  if (g.type === "MultiPolygon") {
    return (g.coordinates || []).some((poly) => inPolygon(lon, lat, poly));
  }
  if (g.type === "GeometryCollection") {
    return (g.geometries || []).some((sub) => inGeometry(lon, lat, sub));
  }
  return false;
}

function highestCatAt(gj, lon, lat) {
  let best = -1;
  for (const f of (gj && gj.features) || []) {
    const c = catOf(f && f.properties);
    if (!c) continue;
    const rank = CATS.indexOf(c);
    if (rank <= best) continue;                 // can't improve on what we have — skip the math
    if (inGeometry(lon, lat, f.geometry)) best = rank;
  }
  return best < 0 ? null : CATS[best];
}

// ---------------------------------------------------------------------------
// SEVERE board strip

let stripSeq = 0;

async function dayCategory(day, lat, lon) {
  const id = await outlookLayerId(day);
  const gj = await fetchGeo(queryUrl(SPC_OUTLOOKS, id), SPC_REFRESH_MS);
  const cat = highestCatAt(gj, lon, lat);
  const feats = (gj && gj.features) || [];
  // highestCatAt() returns null both when the point is genuinely outside every
  // polygon AND when nothing in the payload carried a category we recognise
  // (e.g. NOAA renamed the field). Only the first is really "no severe risk" —
  // the second is an outage and must fall into the err/UNAVAILABLE branch
  // instead of confidently reporting no risk during a real one.
  if (!cat && feats.length && !feats.some((f) => catOf(f && f.properties))) {
    throw new Error("no recognised category field");
  }
  return cat;
}

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
             "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// SPC outlook periods run 12Z-to-12Z, so Day 1 is today, Day 2 tomorrow, and so
// on in the user's local calendar. Naming the date beats "DAY 2", which forces
// the reader to do the arithmetic.
function dayLabel(day) {
  const d = new Date();
  d.setDate(d.getDate() + day - 1);
  return DOW[d.getDay()] + " " + MON[d.getMonth()] + " " + d.getDate();
}

function dayRow(r) {
  let val;
  if (r.err) {
    val = el("span", { class: "none" }, "UNAVAILABLE");
  } else if (!r.cat) {
    val = el("span", { class: "none" }, "NO SEVERE RISK");
  } else {
    val = el("span", { class: "cat" }, r.cat + " — " + (CAT_LABEL[r.cat] || "RISK"));
    val.style.background = SPC_CAT_COLORS[r.cat] || NEUTRAL;
  }
  return el("div", { class: "spcday" }, el("span", { class: "d" }, dayLabel(r.day)), val);
}

export function renderStrip(container) {
  if (!container) return;
  container.className = "spcstrip";
  const seq = ++stripSeq;                       // a later render always wins
  const loc = locations.active();
  if (!loc) {
    container.replaceChildren(el("div", { class: "srcnote" }, "SPC OUTLOOK — NO LOCATION SET"));
    return;
  }
  const lat = loc.lat, lon = loc.lon;
  // honest intermediate state: the box is never blank while the fetch is out
  container.replaceChildren(el("div", { class: "srcnote" }, "SPC OUTLOOK LOADING…"));
  Promise.all([1, 2, 3].map((d) =>
    dayCategory(d, lat, lon)
      .then((cat) => ({ day: d, cat }))
      .catch(() => ({ day: d, err: true }))
  )).then((rows) => {
    if (seq !== stripSeq || !container.isConnected) return;   // superseded or detached
    // all three down = the source is down; a partial failure still shows the
    // days we do know, with the missing one marked rather than hidden
    if (rows.every((r) => r.err)) {
      container.replaceChildren(el("div", { class: "srcnote" }, "SPC OUTLOOK UNAVAILABLE"));
      layers.setHealth("spc", false, "outlook unavailable");
      return;
    }
    container.replaceChildren(...rows.map(dayRow));
    // Recovery must clear the N/A the all-fail branch above sets — otherwise
    // a transient outage leaves the layers drawer pinned on N/A forever.
    layers.setHealth("spc", true, "strip ok");
  });
}

// ---------------------------------------------------------------------------
// map layers

let spcLyr = null, mdLyr = null, tropLyr = null;
const timers = { spc: null, spcmd: null, tropical: null };

function pane(map, id) {
  const [name, z] = PANES[id];
  if (!map.getPane(name)) {
    const p = map.createPane(name);
    p.style.zIndex = String(z);
    // outlook/tropical fills blanket the viewport — they must not swallow map
    // drags or clicks meant for the alert polygons above them
    if (id !== "spcmd") p.style.pointerEvents = "none";
  }
  return name;
}

function drop(lyr) {
  const map = mapMod.getMap();
  if (lyr && map && map.hasLayer(lyr)) map.removeLayer(lyr);
  return null;
}

function stopTimer(id) { if (timers[id]) { clearInterval(timers[id]); timers[id] = null; } }

function startTimer(id, draw) {
  stopTimer(id);
  timers[id] = setInterval(() => {
    if (layers.isOn(id)) draw();
    else stopTimer(id);                         // belt and braces: never poll a layer that is off
  }, SPC_REFRESH_MS);
}

function count(gj) { return ((gj && gj.features) || []).length; }

// Categorical outlook areas are nested (an ENH polygon sits inside its SLGT
// and MRGL parents), so draw order must encode severity — the payload's own
// feature order is not guaranteed ascending. L.geoJSON draws in array order
// and later paths land on top, so sort lowest-rank-first here rather than
// trust the source. Copies rather than mutates: gj is the shared fetchGeo
// cache entry, also read by dayCategory()/highestCatAt().
function sortedByCat(gj) {
  const feats = ((gj && gj.features) || []).slice()
    .sort((a, b) => CATS.indexOf(catOf(a && a.properties)) - CATS.indexOf(catOf(b && b.properties)));
  return { ...gj, features: feats };
}

async function drawOutlook() {
  const map = mapMod.getMap();
  if (!map || !window.L) { layers.setHealth("spc", false, "map unavailable"); return; }
  try {
    const id = await outlookLayerId(1);
    const gj = await fetchGeo(queryUrl(SPC_OUTLOOKS, id), TIMER_TTL_MS);
    if (!layers.isOn("spc")) return;            // toggled off mid-flight
    const m = mapMod.getMap();
    if (!m) return;
    spcLyr = drop(spcLyr);
    spcLyr = window.L.geoJSON(sortedByCat(gj), {
      pane: pane(m, "spc"),
      interactive: false,
      style: (f) => {
        const c = SPC_CAT_COLORS[catOf(f && f.properties)] || NEUTRAL;
        return { color: c, weight: 1, opacity: 0.9, fillColor: c, fillOpacity: 0.25 };
      }
    }).addTo(m);
    layers.setHealth("spc", true, "day 1 · " + count(gj) + " areas");
  } catch (e) {
    layers.setHealth("spc", false, why(e));
  }
}

// MD services publish the discussion polygons as plain (non-group) polygon
// layers; 0 is the conventional id when discovery is unavailable.
async function mdLayerIds() {
  const cat = await serviceLayers(SPC_MD, null);
  if (!cat || !cat.map) return [0];
  const groups = new Set(cat.group || []);
  const ids = Object.keys(cat.map).map(Number).filter((n) =>
    !groups.has(n) && /polygon/i.test(cat.geom[n] || "esriGeometryPolygon"));
  return ids.length ? ids.slice(0, 3) : [0];
}

function mdTitle(p) {
  if (p) {
    for (const k of Object.keys(p)) {
      if (!/num/i.test(k)) continue;
      const v = p[k];
      if (v == null || v === "") continue;
      return "MESOSCALE DISCUSSION #" + String(v).trim();
    }
  }
  return "MESOSCALE DISCUSSION";
}

async function drawMd() {
  const map = mapMod.getMap();
  if (!map || !window.L) { layers.setHealth("spcmd", false, "map unavailable"); return; }
  try {
    const ids = await mdLayerIds();
    const sets = await Promise.all(ids.map((id) =>
      fetchGeo(queryUrl(SPC_MD, id), TIMER_TTL_MS).catch(() => null)));
    if (!layers.isOn("spcmd")) return;
    const m = mapMod.getMap();
    if (!m) return;
    const good = sets.filter(Boolean);
    if (!good.length) throw new Error("query failed");
    mdLyr = drop(mdLyr);
    const group = window.L.layerGroup();
    let n = 0;
    for (const gj of good) {
      n += count(gj);
      group.addLayer(window.L.geoJSON(gj, {
        pane: pane(m, "spcmd"),
        // fill:false emits fill="none", which is not hit-testable under
        // pointer-events:visiblePainted — only the 1.2px stroke would respond,
        // unusable on touch. fillOpacity:0 keeps the same blank look but the
        // interior still hit-tests.
        style: { color: "#F2C14E", weight: 1.2, opacity: 0.95, fill: true, fillOpacity: 0 },
        // popup content is a built node, never a string — Leaflet would treat a
        // string as HTML and these fields come straight off a remote service.
        // Explicit dark text: --sub-dim is tuned for the app's dark console
        // and fails contrast on Leaflet's white popup background.
        onEachFeature: (f, lyr) =>
          lyr.bindPopup(el("div", { class: "srcnote", style: "color:#1B232C" }, mdTitle(f && f.properties)))
      }));
    }
    mdLyr = group.addTo(m);
    layers.setHealth("spcmd", true, n ? n + " active" : "none active");
  } catch (e) {
    layers.setHealth("spcmd", false, why(e));
  }
}

// ---- tropical: the previously documented service 404s, so resolve at runtime ----
let tropicalSvc = null;           // Promise<string|null>, memoized for the session

function svcUrl(name, type) {
  return ARCGIS_TROPICAL_ROOT + "/" + String(name).replace(/^\/+/, "") + "/" + (type || "MapServer");
}

function pickTropical(services) {
  const maps = (services || []).filter((s) =>
    s && /MapServer/i.test(String(s.type || "")) && /tropical|nhc/i.test(String(s.name || "")));
  if (!maps.length) return null;
  // the summary/weather service is the one carrying the cone + track layers
  return maps.find((s) => /summary/i.test(s.name)) ||
         maps.find((s) => /weather/i.test(s.name)) || maps[0];
}

function discoverTropical() {
  if (tropicalSvc) return tropicalSvc;
  tropicalSvc = (async () => {
    const root = await fetchT(ARCGIS_TROPICAL_ROOT + "?f=json", META_MS).then(okJson);
    let hit = pickTropical(root && root.services);
    if (hit) return svcUrl(hit.name, hit.type);
    // some deployments keep everything one level down — walk the tropical folder
    const folders = ((root && root.folders) || [])
      .filter((f) => /tropical|nhc|storm/i.test(String(f))).slice(0, 2);
    for (const f of folders) {
      try {
        const sub = await fetchT(ARCGIS_TROPICAL_ROOT + "/" + f + "?f=json", META_MS).then(okJson);
        hit = pickTropical(sub && sub.services);
        if (hit) return svcUrl(hit.name, hit.type);   // folder listings return "folder/name"
      } catch { /* try the next folder */ }
    }
    throw new Error("no service");
  })().catch(() => {
    tropicalSvc = null;           // transient outage: a later toggle rediscovers
    return null;
  });
  return tropicalSvc;
}

async function drawTropical() {
  const map = mapMod.getMap();
  if (!map || !window.L) { layers.setHealth("tropical", false, "map unavailable"); return; }
  try {
    const svc = await discoverTropical();
    if (!svc) { layers.setHealth("tropical", false, "service unavailable"); return; }
    const cat = await serviceLayers(svc, null);
    if (!cat || !cat.map) { layers.setHealth("tropical", false, "service unavailable"); return; }
    const groups = new Set(cat.group || []);
    const ids = Object.keys(cat.map).map(Number).filter((n) =>
      !groups.has(n) && /polygon|polyline/i.test(cat.geom[n] || "")).slice(0, 6);
    if (!ids.length) { layers.setHealth("tropical", false, "no drawable layers"); return; }
    const sets = await Promise.all(ids.map((id) =>
      fetchGeo(queryUrl(svc, id), TIMER_TTL_MS).then((gj) => ({ id, gj })).catch(() => null)));
    if (!layers.isOn("tropical")) return;
    const m = mapMod.getMap();
    if (!m) return;
    const good = sets.filter(Boolean);
    if (!good.length) { layers.setHealth("tropical", false, "query failed"); return; }
    tropLyr = drop(tropLyr);
    const group = window.L.layerGroup();
    let n = 0;
    for (const { id, gj } of good) {
      n += count(gj);
      const line = /polyline/i.test(cat.geom[id] || "");
      group.addLayer(window.L.geoJSON(gj, {
        pane: pane(m, "tropical"),
        interactive: false,
        style: line
          ? { color: "#CFE6FF", weight: 1.6, opacity: 0.9, dashArray: "5 4", fill: false }
          : { color: "#CFE6FF", weight: 1, opacity: 0.8, fillColor: "#CFE6FF", fillOpacity: 0.12 }
      }));
    }
    tropLyr = group.addTo(m);
    layers.setHealth("tropical", true, n ? n + " features" : "no active storms");
  } catch (e) {
    layers.setHealth("tropical", false, why(e));
  }
}

function clearLayer(id) {
  if (id === "spc") spcLyr = drop(spcLyr);
  else if (id === "spcmd") mdLyr = drop(mdLyr);
  else if (id === "tropical") tropLyr = drop(tropLyr);
}

// onToggle runs synchronously inside layers.register(), so the draw is deferred
// to a microtask: registration (and therefore boot) never waits on the network,
// and nothing is requested at all while the layer is off.
function toggle(id, draw) {
  const run = () => { Promise.resolve().then(draw).catch((e) => layers.setHealth(id, false, why(e))); };
  return (on) => {
    stopTimer(id);
    if (!on) { clearLayer(id); return; }
    run();
    startTimer(id, run);
  };
}

// ---------------------------------------------------------------------------

export function init() {
  try {
    layers.register({ id: "spc", label: "SPC OUTLOOK", defaultOn: false, onToggle: toggle("spc", drawOutlook) });
    // Labelled for what it actually draws: the service behind it is SPC's
    // mesoscale-discussion layer. Watch boxes are NWS active alerts and reach
    // the map through the "alerts" layer, not this one.
    layers.register({ id: "spcmd", label: "MESOSCALE DISCUSSIONS", defaultOn: false, onToggle: toggle("spcmd", drawMd) });
    layers.register({ id: "tropical", label: "TROPICAL", defaultOn: false, onToggle: toggle("tropical", drawTropical) });

    // alerts.js owns the SEVERE board and drops an empty #spcStrip into it
    state.on("severeboard", (d) => {
      const root = d && d.el;
      if (!root) return;
      const strip = root.querySelector("#spcStrip");
      if (strip) renderStrip(strip);
    });

    // the strip is per-location: repaint on a location switch. The geojson is
    // already cached, so this costs nothing on the wire.
    locations.onChange(() => {
      const strip = document.getElementById("spcStrip");
      if (strip) renderStrip(strip);
    });
  } catch { /* a broken outlook layer must never take boot down */ }
}
