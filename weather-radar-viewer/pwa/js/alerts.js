// NWS active alerts: the poller, the topbar chip, the map polygons, and the
// SEVERE board. This is the one feed in the app that is time-critical, so it
// prefers stale-but-labelled data over blank panels, and silence over a warning
// it can no longer vouch for.

import { NWS_ALERTS, ALERT_POLL_QUIET_MS, ALERT_POLL_ACTIVE_MS, ALERT_STALE_MS,
         ZONE_CACHE_VER, SEV, alertClass, EVENT_ABBR } from "./config.js";
import { el, fmt } from "./util.js";
import { fetchT, okJson, setHealth } from "./net.js";
import * as store from "./store.js";
import * as state from "./state.js";
import * as layers from "./layers.js";
import * as boards from "./boards.js";
import * as mapMod from "./map.js";
import * as locations from "./locations.js";

// One timer for every location. Each tick asks "who is due?" rather than each
// location owning a timer — N locations must not mean N drifting schedules.
const TICK_MS = 30 * 1000;

// ---- MAP alerts config ------------------------------------------------------
// NOAA's pre-joined watch/warning/advisory polygons, queried by the current
// map bbox — this is what actually draws on the radar (see "MAP alerts"
// below). Layer ids on this service move without notice, same story as
// spc.js's outlook layers, so nothing here is hardcoded that isn't a
// last-resort fallback (see wwaLayerIds()).
const ARCGIS_WWA = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer";
const MAP_CATALOG_KEY = "skywatch_alerts_map_layers";
const MAP_CATALOG_TTL = 24 * 60 * 60 * 1000;
const MAP_META_MS = 10000;
const MAP_QUERY_MS = 10000;
const MOVE_DEBOUNCE_MS = 600;
const BBOX_PAD = 0.2;             // pad the requested bbox so small pans don't refetch

const recs = new Map();       // locId -> { alerts, etag, fetchedAt, lastTry, err }
const openIds = new Set();    // alert ids whose card body is expanded (survives re-render)
const zoneMem = new Map();    // zone id -> Promise<geometry|null>, dedupes in-flight lookups

let chipEl = null;
let boardEl = null;
let group = null;             // the Leaflet featureGroup holding every alert polygon
let useConditional = true;    // see requestAlerts(): flipped off if preflight is refused
// Last painted chip state, so a 30s repaint never restarts the pulse animation.
// Starts null rather than "": the first paint must assert the hidden state
// itself instead of trusting the markup to have shipped it hidden.
let chipSig = null;
let emitSig = null;           // last announced active-location alert set
// Last union-of-all-locations signature publish() ran against. Lets the 30s
// tick and settle() notice an alert expiring on the clock (no poll involved)
// and promote that into a real publish() instead of only repainting the chip.
let liveSig = "";

// ---- MAP alerts state --------------------------------------------------------
// mapCache.ok: null = ArcGIS has never yet answered, true = the last query
// succeeded (an empty alerts list is a legitimate answer, not a failure),
// false = the last query failed and syncLayer() is drawing the point-query
// fallback instead.
let mapCache = { bbox: null, fetchedAt: 0, alerts: [], ok: null };
let mapFetchInFlight = false;
let moveTimer = null;

function recFor(id) {
  let r = recs.get(id);
  if (!r) { r = { alerts: [], etag: null, fetchedAt: 0, lastTry: 0, err: "" }; recs.set(id, r); }
  return r;
}

function ms(iso) {
  const t = Date.parse(iso || "");
  return isNaN(t) ? null : t;
}

// ---- normalized alert record ----------------------------------------------

function normalize(f) {
  const p = f && f.properties;
  if (!p) return null;
  const event = p.event || "ALERT";
  const zones = Array.isArray(p.affectedZones) ? p.affectedZones : [];
  return {
    // NWS ids are stable URNs; the composite fallback only exists so a feed
    // missing them still de-dupes across two locations sharing one alert.
    id: f.id || p.id || event + "|" + (p.onset || p.effective || "") + "|" + (p.areaDesc || ""),
    event,
    cls: alertClass(event),
    severity: p.severity || "",
    urgency: p.urgency || "",
    headline: p.headline || "",
    description: p.description || "",
    instruction: p.instruction || "",
    areaDesc: p.areaDesc || "",
    senderName: p.senderName || "",
    onset: ms(p.onset) || ms(p.effective),
    expires: ms(p.expires) || ms(p.ends),
    geometry: f.geometry || null,
    zoneUrl: zones.length ? zones[0] : null,
    zoneTried: false
  };
}

// An alert that has run out its own clock is expired regardless of how fresh
// the fetch was — cheaper and more honest than waiting for the next poll.
function live(a) { return !(a.expires && a.expires < Date.now()); }

function alertsFor(locId) {
  const r = recs.get(locId);
  return r ? r.alerts.filter(live) : [];
}

function unionAlerts() {
  const seen = new Map();
  for (const r of recs.values()) {
    for (const a of r.alerts) if (live(a) && !seen.has(a.id)) seen.set(a.id, a);
  }
  return [...seen.values()];
}

function byChip(list) {
  return list.slice().sort((a, b) =>
    SEV[a.cls].rank - SEV[b.cls].rank || (b.onset || 0) - (a.onset || 0));
}
function byBoard(list) {
  return list.slice().sort((a, b) =>
    SEV[a.cls].rank - SEV[b.cls].rank || (a.expires || Infinity) - (b.expires || Infinity));
}

function activeList() {
  const loc = locations.active();
  return loc ? byChip(alertsFor(loc.id)) : [];
}

export function activeCount() { return activeList().length; }
export function highest() { return activeList()[0] || null; }

// ---- polling ---------------------------------------------------------------

// fetchT() cannot carry headers, and this is the only request in the app that
// needs one: an If-None-Match round trip is a 304 with no body almost every
// time, which is what makes a 60s cadence during severe weather affordable.
// Same AbortController timeout as fetchT. Still no User-Agent, ever.
function fetchCond(url, etag, msTimeout = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), msTimeout);
  const opts = { signal: ctl.signal };
  if (etag) opts.headers = { "If-None-Match": etag };
  return fetch(url, opts)
    .catch((e) => { throw (e && e.name === "AbortError") ? new Error("TIMEOUT") : e; })
    .finally(() => clearTimeout(t));
}

// If-None-Match is not a CORS-safelisted header, so a conditional GET forces a
// preflight that plain polling never triggers. If that preflight is ever
// refused the bare request still works — prove it once, then drop conditional
// requests for the session rather than let a bandwidth optimization take the
// whole alert feed down with it.
async function requestAlerts(url, rec) {
  try {
    return await fetchCond(url, useConditional ? rec.etag : null);
  } catch (err) {
    if (!useConditional || !rec.etag || (err && err.message === "TIMEOUT")) throw err;
    const res = await fetchCond(url, null);
    useConditional = false;
    return res;
  }
}

async function pollLoc(loc) {
  const rec = recFor(loc.id);
  rec.lastTry = Date.now();
  const url = NWS_ALERTS + "?point=" + loc.lat.toFixed(4) + "," + loc.lon.toFixed(4);
  const res = await requestAlerts(url, rec);
  // 304: the copy we already hold is current, so this counts as a successful
  // fetch — the freshness clock restarts even though nothing was transferred.
  if (res.status === 304) {
    rec.fetchedAt = Date.now();
    rec.err = "";
    return false;
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const next = (j.features || []).map(normalize).filter(Boolean);
  const changed = sig(next) !== sig(rec.alerts);
  // resolveZones() only runs from publish(), which an unchanged id set never
  // triggers — carry forward geometry it already resolved so an unrelated poll
  // can't quietly discard a watch's zone-derived polygon.
  const prev = new Map(rec.alerts.map((a) => [a.id, a]));
  for (const a of next) {
    const o = prev.get(a.id);
    if (o && !a.geometry && o.geometry) { a.geometry = o.geometry; a.zoneTried = o.zoneTried; }
  }
  rec.etag = res.headers.get("ETag") || null;
  rec.alerts = next;
  rec.fetchedAt = Date.now();
  rec.err = "";
  return changed;
}

function sig(list) { return list.map((a) => a.id).sort().join("\n"); }

function anyActive() {
  for (const r of recs.values()) if (r.alerts.some(live)) return true;
  return false;
}

function prune() {
  const ids = new Set(locations.list().map((l) => l.id));
  for (const id of [...recs.keys()]) if (!ids.has(id)) recs.delete(id);
}

function tick(force) {
  // MAP alerts follow the same cadence as MY alerts; fetchMapAlerts() itself
  // no-ops when the layer is off or the viewport/data are still fresh, so
  // this is cheap on the common (nothing changed) path.
  fetchMapAlerts();
  const list = locations.list();
  if (!list.length) {
    setHealth("alerts", "ALERTS", true, "no location");
    paintChip();
    return;
  }
  // Any alert anywhere tightens the cadence for every location: during severe
  // weather the neighbouring county's warning is the one about to be yours.
  const cadence = anyActive() ? ALERT_POLL_ACTIVE_MS : ALERT_POLL_QUIET_MS;
  const now = Date.now();
  const due = list.filter((l) => force || now - recFor(l.id).lastTry >= cadence);

  // The chip repaints every tick even with no request in flight — data going
  // stale is a clock event, not a network event. An alert can also expire on
  // this same clock with no poll ever reporting a change, so check the union
  // signature too: a drop must reach the board/map/event, not just the chip.
  const s = sig(unionAlerts());
  if (s !== liveSig) { liveSig = s; publish(); } else paintChip();
  if (!due.length) return;

  Promise.all(due.map((l) => pollLoc(l).then(
    (changed) => ({ ok: true, changed }),
    (err) => {
      recFor(l.id).err = (err && err.message) || "NETWORK";
      return { ok: false };
    }
  ))).then(settle);
}

function settle(results) {
  const anyOk = results.some((r) => r.ok);
  const count = unionAlerts().length;
  // The "alerts" layer's own health (the ≡ drawer dot) is owned by
  // fetchMapAlerts() now — it reflects the viewport query, not this point
  // poll, which answers a different question (see "MAP alerts" below).
  if (anyOk) {
    setHealth("alerts", "ALERTS", true, count + " active");
  } else {
    setHealth("alerts", "ALERTS", false, "down");
  }
  if (results.some((r) => r.changed)) { publish(); return; }
  // No poll reported a changed id set, but local expiry runs on the same
  // clock as the poll — an alert can still have aged out since the last
  // publish() (see the tick handler above for the full rationale).
  const s = sig(unionAlerts());
  if (s !== liveSig) { liveSig = s; publish(); } else paintChip();
}

// Fan out one coherent update: chip, board (if visible), polygons, listeners.
function publish() {
  liveSig = sig(unionAlerts());
  paintChip();
  if (state.getView() === "board" && boards.current() === "severe") renderBoard();
  syncLayer();
  resolveZones();
  // Polling every location means most changes belong to somewhere the user is
  // not looking; the event is scoped to the active set, so only announce it
  // when that set actually moved.
  const list = activeList();
  const next = sig(list);
  if (next === emitSig) return;
  emitSig = next;
  state.emit("alerts", { count: list.length, highest: list[0] || null });
}

// ---- chip ------------------------------------------------------------------

function abbrFor(event) {
  const e = String(event || "").toLowerCase();
  let best = "";
  for (const k of Object.keys(EVENT_ABBR)) {
    if (e.includes(k) && k.length > best.length) best = k;
  }
  if (best) return EVENT_ABBR[best];
  return (e.split(/\s+/)[0] || "").toUpperCase();
}

function paintChip() {
  if (!chipEl) return;
  const loc = locations.active();
  const rec = loc ? recs.get(loc.id) : null;
  const top = activeList()[0];
  // A warning we cannot re-confirm may already have been cancelled, and a
  // cancelled warning left on screen is worse than no chip at all.
  const fresh = rec && rec.fetchedAt && Date.now() - rec.fetchedAt <= ALERT_STALE_MS;
  const next = top && fresh ? top.cls + "|" + top.event : "";
  if (next === chipSig) return;
  chipSig = next;
  if (!next) {
    chipEl.hidden = true;
    chipEl.textContent = "";
    return;
  }
  chipEl.textContent = "⚠ " + abbrFor(top.event) + " " + SEV[top.cls].label;
  chipEl.className = "badge alertchip " + top.cls;
  chipEl.hidden = false;
}

// ---- map polygons ----------------------------------------------------------

const colorMem = new Map();
function sevColor(cls) {
  if (!colorMem.has(cls)) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(SEV[cls].token);
    colorMem.set(cls, (v || "").trim() || "#FF5B5B");
  }
  return colorMem.get(cls);
}

// Radar tiles live at zIndex 400. A dedicated pane pins alert polygons just
// above them no matter which module attaches its layer first — relying on
// insertion order across independent modules is how ordering bugs start.
function ensurePane(m) {
  if (m.getPane("alerts")) return;
  const p = m.createPane("alerts");
  p.style.zIndex = 450;
  p.style.pointerEvents = "auto";
}

// ---- MAP alerts: NOAA's viewport-queryable watch/warning/advisory service --
//
// The point-query alerts above answer "does MY saved location have an
// alert" — a radar view spanning five states needs "what alerts touch the
// area on screen right now", a different question with a different feed.
// This service ships pre-joined geometry per feature (no per-alert zone
// lookup needed, unlike the point feed's watches). Layer ids on it are
// renumbered without notice, so discovery follows spc.js's approach: ask
// /layers?f=json, cache the catalog, and fall back to id 0 only if discovery
// itself fails — never trust one hardcoded id as the only option.

function readWwaPersisted() {
  try {
    const j = JSON.parse(localStorage.getItem(MAP_CATALOG_KEY) || "null");
    if (j && j.map && typeof j.t === "number") return j;
  } catch { /* corrupt entry — refetch */ }
  return null;
}

let wwaCatalogP = null;    // Promise<catalog|null>, memoized for the session
function wwaCatalog() {
  if (wwaCatalogP) return wwaCatalogP;
  const stored = readWwaPersisted();
  if (stored && Date.now() - stored.t < MAP_CATALOG_TTL) {
    wwaCatalogP = Promise.resolve(stored);
    return wwaCatalogP;
  }
  wwaCatalogP = fetchT(ARCGIS_WWA + "/layers?f=json", MAP_META_MS).then(okJson).then((j) => {
    if (!j || !Array.isArray(j.layers) || !j.layers.length) throw new Error("no layers");
    const cat = { t: Date.now(), map: {}, group: [], geom: {} };
    for (const l of j.layers) {
      cat.map[l.id] = String(l.name || "");
      cat.geom[l.id] = String(l.geometryType || "");
      if (Array.isArray(l.subLayerIds) && l.subLayerIds.length) cat.group.push(l.id);
    }
    try { localStorage.setItem(MAP_CATALOG_KEY, JSON.stringify(cat)); } catch { /* quota */ }
    return cat;
  }).catch(() => {
    wwaCatalogP = null;      // transient failure: let the next attempt retry
    return stored;           // an expired catalog still beats guessing (null if none)
  });
  return wwaCatalogP;
}

// Prefer layers whose name reads like an actual hazard product; if none of
// the discovered polygon layers match, query all of them (still capped at 3)
// rather than guess which single one is right.
async function wwaLayerIds() {
  const cat = await wwaCatalog();
  if (!cat || !cat.map) return [0];
  const groups = new Set(cat.group || []);
  const polys = Object.keys(cat.map).map(Number).filter((n) =>
    !groups.has(n) && /polygon/i.test(cat.geom[n] || "esriGeometryPolygon"));
  if (!polys.length) return [0];
  const named = polys.filter((n) => /warning|watch|advisory|hazard/i.test(cat.map[n] || ""));
  return (named.length ? named : polys).slice(0, 3);
}

function wwaQueryUrl(id, b) {
  const geom = b.w.toFixed(4) + "," + b.s.toFixed(4) + "," + b.e.toFixed(4) + "," + b.n.toFixed(4);
  return ARCGIS_WWA + "/" + id + "/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson" +
    "&geometry=" + geom + "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects";
}

// Leaflet lets you keep dragging past the antimeridian, so getBounds() can hand
// back longitudes several globes out (w=1541). ArcGIS answers that with nothing
// and the layer would quietly fall back; clamp into a sane envelope instead.
function mapBBox(m) {
  const b = m.getBounds();
  let w = b.getWest(), e = b.getEast();
  if (e - w >= 360) { w = -180; e = 180; }
  else {
    const wrap = (x) => ((x + 180) % 360 + 360) % 360 - 180;
    w = wrap(w); e = wrap(e);
    if (w > e) { w = -180; e = 180; }        // straddles the seam — just ask for the world
  }
  return {
    w, e,
    s: Math.max(-90, b.getSouth()),
    n: Math.min(90, b.getNorth())
  };
}
function padBBox(b) {
  const dw = (b.e - b.w) * BBOX_PAD, dh = (b.n - b.s) * BBOX_PAD;
  return { w: b.w - dw, s: b.s - dh, e: b.e + dw, n: b.n + dh };
}
function bboxContains(outer, inner) {
  return !!outer && inner.w >= outer.w && inner.s >= outer.s && inner.e <= outer.e && inner.n <= outer.n;
}

// The ArcGIS field carrying the plain-English event name varies by service
// revision — prod_type and event both show up in the wild. Sniff by key
// first; only fall back to scanning values for a hazard-shaped string when
// neither key is present, so a payload that isn't alert data at all (wrong
// layer, a renamed field — e.g. an outlook categorical fixture in tests)
// degrades to "skip this feature" instead of inventing an event name.
function sniffEventName(p) {
  const keys = Object.keys(p);
  for (const want of ["prod_type", "event", "phenomena", "hazard"]) {
    const hit = keys.find((k) => k.toLowerCase() === want);
    if (hit && p[hit]) return String(p[hit]);
  }
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && /warning|watch|advisory/i.test(v)) return v;
  }
  return null;
}
function sniffAreaText(p) {
  const hit = Object.keys(p).find((k) => /area/i.test(k) && typeof p[k] === "string" && p[k]);
  return hit ? p[hit] : "";
}

function normalizeMapFeature(f, layerId) {
  const p = f && f.properties;
  if (!p) return null;
  const event = sniffEventName(p);
  if (!event) return null;     // nothing alert-ish here — drop it, never guess
  const idVal = p.OBJECTID ?? p.objectid ?? p.GLOBALID ?? p.globalid ?? f.id;
  return {
    id: "wwa:" + layerId + ":" + (idVal != null ? idVal : event + "|" + sniffAreaText(p)),
    event,
    cls: alertClass(event),
    areaDesc: sniffAreaText(p),
    geometry: f.geometry || null
  };
}

// Heat/cold products are the ones that blanket a viewport by the hundreds
// during a heat wave (the complaint that started this feature) — a dedicated
// toggle lets a user drop those without also losing every other advisory.
// "Heat Advisory" is heat-family AND cls "advisory", so it is hidden by
// either toggle being off; that overlap is intended, not a bug.
const HEAT_COLD_RE = /heat|wind chill|extreme cold|cold weather|freeze|frost/i;
function isHeatCold(event) { return HEAT_COLD_RE.test(String(event || "")); }

// The single predicate that decides whether a map alert (viewport feature or
// point-query fallback) actually gets a polygon on screen. Reused by
// reportMapHealth() below so the drawer's counts and the drawn set can never
// drift apart.
function mapDrawable(a) {
  if (!layers.isOn("alerts")) return false;
  if (isHeatCold(a.event) && !layers.isOn("alertsheat")) return false;
  if ((a.cls === "advisory" || a.cls === "statement") && !layers.isOn("alertsadv")) return false;
  return true;
}

// Toggling HEAT/COLD or ADVISORIES never re-fetches — the counts always
// describe the raw viewport cache, filtered or not, so "how many of these
// are heat advisories?" has an answer even while that row is off.
function reportMapHealth() {
  const heat = mapCache.alerts.filter((a) => isHeatCold(a.event)).length;
  const adv = mapCache.alerts.filter((a) => a.cls === "advisory" || a.cls === "statement").length;
  layers.setHealth("alertsheat", true, heat ? heat + " in view" : "none in view");
  layers.setHealth("alertsadv", true, adv ? adv + " in view" : "none in view");
  // A failed/never-succeeded viewport query is already reported as "my
  // alerts only" from fetchMapAlerts()'s catch — leave that note alone.
  if (mapCache.ok !== true) return;
  const total = mapCache.alerts.length;
  const shown = mapCache.alerts.filter(mapDrawable).length;
  layers.setHealth("alerts", true,
    shown === total ? total + " in view" : shown + " of " + total + " in view");
}

function mapCadenceMs() { return anyActive() ? ALERT_POLL_ACTIVE_MS : ALERT_POLL_QUIET_MS; }

function needsMapFetch(m) {
  if (!mapCache.bbox) return true;
  const fresh = Date.now() - mapCache.fetchedAt < mapCadenceMs();
  return !(fresh && bboxContains(mapCache.bbox, mapBBox(m)));
}

// Fetch every alert touching the current viewport. Never throws: a query
// failure leaves last-good mapCache data in place (syncLayer() falls back to
// the point-query geometry once there is nothing usable left) and is
// reported honestly through layers.setHealth rather than silently emptying
// the layer.
async function fetchMapAlerts() {
  const m = mapMod.getMap();
  if (!m || !window.L) { layers.setHealth("alerts", false, "map unavailable"); return; }
  if (!layers.isOn("alerts")) return;
  if (mapFetchInFlight || !needsMapFetch(m)) return;
  mapFetchInFlight = true;
  const padded = padBBox(mapBBox(m));
  try {
    const ids = await wwaLayerIds();
    const sets = await Promise.all(ids.map((id) =>
      fetchT(wwaQueryUrl(id, padded), MAP_QUERY_MS).then(okJson)
        .then((j) => ({ id, j })).catch(() => null)));
    const good = sets.filter(Boolean);
    if (!good.length) throw new Error("query failed");
    const seen = new Map();
    for (const { id, j } of good) {
      for (const f of (j && j.features) || []) {
        const a = normalizeMapFeature(f, id);
        if (a && a.geometry && !seen.has(a.id)) seen.set(a.id, a);
      }
    }
    mapCache = { bbox: padded, fetchedAt: Date.now(), alerts: [...seen.values()], ok: true };
    reportMapHealth();
  } catch {
    mapCache = { bbox: mapCache.bbox, fetchedAt: mapCache.fetchedAt, alerts: mapCache.alerts, ok: false };
    layers.setHealth("alerts", true, "my alerts only");
  } finally {
    mapFetchInFlight = false;
  }
  syncLayer();
}

function onMapMoveEnd() {
  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = setTimeout(() => { moveTimer = null; fetchMapAlerts(); }, MOVE_DEBOUNCE_MS);
}

function syncLayer() {
  const m = mapMod.getMap();
  if (!m || !window.L) return;          // Leaflet unavailable: chip and board carry on alone
  if (group) { m.removeLayer(group); group = null; }
  if (!layers.isOn("alerts")) return;

  // Recompute the drawer counts every time this runs, not just after a fetch
  // — toggling HEAT/COLD or ADVISORIES changes the shown/total split without
  // any network activity.
  reportMapHealth();

  // Trust the viewport layer once it has ever answered successfully — a
  // genuine "nothing in view" from ArcGIS must not be papered over with the
  // (unrelated) saved-location set. Only fall back when ArcGIS has never
  // succeeded, so the map is never emptier than it was before this feature
  // existed.
  const useMap = mapCache.ok === true;
  const drawable = (useMap ? mapCache.alerts : unionAlerts()).filter((a) => a.geometry && mapDrawable(a));
  if (!drawable.length) return;
  ensurePane(m);

  // Least severe first, so warnings are added last and land on top inside the
  // pane — a tornado warning must never hide under the flood watch it sits in.
  const ordered = drawable.slice().sort((a, b) => SEV[b.cls].rank - SEV[a.cls].rank);
  group = L.featureGroup();
  for (const a of ordered) {
    let lyr;
    try {
      lyr = L.geoJSON(a.geometry, {
        pane: "alerts",
        style: { color: sevColor(a.cls), weight: 2, fillColor: sevColor(a.cls), fillOpacity: 0.12 }
      });
    } catch { continue; }              // malformed geometry: skip this one, keep the rest
    // ArcGIS features carry no CAP text — a tap re-queries NWS directly for
    // exactly the point tapped, which is the only way to get a description
    // and instruction for what's actually under the finger. Stop the click
    // from also reaching the map (which would otherwise pan/zoom under it).
    lyr.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      openAlertSheet(e.latlng.lat, e.latlng.lng);
    });
    group.addLayer(lyr);
    if (a.cls === "warning") lyr.bringToFront();
  }
  group.addTo(m);
  // Belt-and-braces: a layer toggle calls syncLayer() directly, outside
  // publish(). resolveZones() is a no-op once every pending watch has been
  // tried, so this costs nothing on the common path.
  resolveZones();
}

// ---- alert detail sheet (tap a polygon) ------------------------------------
//
// The ArcGIS viewport features never carry CAP text, so a tap re-queries NWS
// directly for the point that was tapped instead of trying to enrich the
// polygon's own (id-only) properties. A later tap must always win over a
// slower earlier response — same stale-response guard as spc.js's stripSeq.

let sheetBodyEl = null;
let sheetSeq = 0;

function bySeverity(list) {
  return list.slice().sort((a, b) => SEV[a.cls].rank - SEV[b.cls].rank);
}

function sheetMsg(text) {
  return el("div", { class: "bigmsg" }, text);
}

function sheetCard(a) {
  const bodyText = [a.description, a.instruction].filter(Boolean).join("\n\n") || "NO DETAILS PROVIDED";
  return el("div", { class: "alertcard " + a.cls },
    el("div", { class: "ev" }, a.event.toUpperCase()),
    el("div", { class: "meta" }, "UNTIL " + (a.expires ? fmt(new Date(a.expires)) : "--:--")),
    a.senderName ? el("div", { class: "meta" }, a.senderName.toUpperCase()) : null,
    el("div", { class: "area" }, a.areaDesc || "--"),
    el("div", { class: "body" }, bodyText)
  );
}

async function openAlertSheet(lat, lon) {
  const seq = ++sheetSeq;
  state.openOverlay("alertsheet");
  if (sheetBodyEl) sheetBodyEl.replaceChildren(sheetMsg("LOADING…"));

  let list;
  try {
    const j = await fetchT(NWS_ALERTS + "?point=" + lat.toFixed(4) + "," + lon.toFixed(4)).then(okJson);
    list = (j.features || []).map(normalize).filter(Boolean).filter(live);
  } catch (err) {
    if (seq !== sheetSeq || !sheetBodyEl) return;   // superseded by a later tap
    sheetBodyEl.replaceChildren(sheetMsg("ALERT TEXT UNAVAILABLE — " + ((err && err.message) || "NETWORK")));
    return;
  }
  if (seq !== sheetSeq || !sheetBodyEl) return;      // superseded by a later tap
  if (!list.length) {
    sheetBodyEl.replaceChildren(sheetMsg("NO ACTIVE ALERTS AT THIS POINT"));
    return;
  }
  sheetBodyEl.replaceChildren(...bySeverity(list).map(sheetCard));
}

// ---- zone geometry (watches ship without one) ------------------------------

// Zone boundaries are redistricted on a multi-year cadence and never change
// under a given id, so the cache has no expiry — ZONE_CACHE_VER is the only
// way an entry is ever invalidated.
function zoneGeometry(zoneUrl) {
  // Keep the zone *type* segment in the id, not just the trailing one: two
  // different zone types can share a trailing id (/zones/fire/AZZ101 vs.
  // /zones/forecast/AZZ101) and would otherwise collide in a cache that never
  // expires.
  const parts = String(zoneUrl).split("?")[0].split("/").filter(Boolean);
  const id = parts.slice(-2).join("/");    // "fire/AZZ101"
  if (!id) return Promise.resolve(null);
  if (zoneMem.has(id)) return zoneMem.get(id);
  const key = "v" + ZONE_CACHE_VER + ":" + id;
  const p = store.idbGet("zones", key)
    .then((hit) => hit || fetchT(zoneUrl).then(okJson).then((j) => {
      const g = j && j.geometry;
      if (g) store.idbPut("zones", key, g);
      return g || null;
    }))
    // A failure here is a network blip, not proof the zone has no geometry —
    // drop the memo so the next publish() actually retries instead of
    // replaying the same null forever.
    .catch(() => { zoneMem.delete(id); return null; });
  zoneMem.set(id, p);
  return p;
}

// Deliberately fire-and-forget: the chip and the board must paint from the
// alert payload alone, and polygons fill in whenever the zones come back.
function resolveZones() {
  const pending = unionAlerts().filter((a) => !a.geometry && !a.zoneTried && a.zoneUrl);
  if (!pending.length) return;
  for (const a of pending) a.zoneTried = true;
  Promise.all(pending.map((a) => zoneGeometry(a.zoneUrl).then((g) => {
    if (g) a.geometry = g;
    else a.zoneTried = false;    // no memoized failure to trust — let a later publish retry
    return !!g;
  }))).then((got) => { if (got.some(Boolean)) syncLayer(); });
}

// ---- SEVERE board ----------------------------------------------------------

function metaLine(a) {
  const bits = [];
  const sv = [a.severity, a.urgency].filter(Boolean).join("/").toUpperCase();
  if (sv) bits.push(sv);
  bits.push("UNTIL " + (a.expires ? fmt(new Date(a.expires)) : "--:--"));
  if (a.senderName) bits.push(a.senderName.toUpperCase());
  return bits.join(" · ");
}

function card(a) {
  const c = el("div", { class: "alertcard " + a.cls + (openIds.has(a.id) ? " open" : "") },
    el("div", { class: "ev" }, a.event.toUpperCase()),
    el("div", { class: "meta" }, metaLine(a)),
    el("div", { class: "area" }, a.areaDesc || "--"),
    el("div", { class: "body" }, a.description || a.instruction || "NO DETAILS PROVIDED")
  );
  c.addEventListener("click", () => {
    if (c.classList.toggle("open")) openIds.add(a.id);
    else openIds.delete(a.id);
  });
  return c;
}

function renderBoard() {
  if (!boardEl) return;
  const loc = locations.active();
  const rec = loc ? recs.get(loc.id) : null;
  const list = loc ? byBoard(alertsFor(loc.id)) : [];

  const box = el("div", { class: "alerts" });
  if (!loc) {
    box.append(el("div", { class: "bigmsg" }, "NO LOCATION SET"));
  } else if (!rec || !rec.fetchedAt) {
    // never a blank panel: say whether we are still asking or have given up
    box.append(el("div", { class: "bigmsg" },
      rec && rec.err ? "ALERTS UNAVAILABLE — " + rec.err : "CHECKING FOR ALERTS…"));
  } else if (!list.length) {
    box.append(el("div", { class: "bigmsg" }, "NO ACTIVE ALERTS"));
  } else {
    box.append(...list.map(card));
  }

  boardEl.replaceChildren(
    el("div", { class: "hdr" }, "SEVERE WEATHER",
      el("span", { class: "asof" },
        "AS OF " + (rec && rec.fetchedAt ? fmt(new Date(rec.fetchedAt)) : "--:--"))),
    box,
    // A live river reading is worth seeing before a multi-day outlook, so the
    // gauges sit above the SPC strip.
    el("div", { id: "riverStrip" }),
    el("div", { id: "spcStrip" }),
    el("div", { class: "srcnote" }, "NWS api.weather.gov · SPC")
  );
  // spc.js owns #spcStrip and rivers.js owns #riverStrip; both refill after
  // every one of our re-renders.
  state.emit("severeboard", { el: boardEl });
}

// ---- init ------------------------------------------------------------------

// onToggle runs synchronously inside layers.register(), so the viewport
// fetch is deferred to a microtask — registration (and therefore boot) never
// waits on the network, and nothing is requested while the layer is off.
function alertsToggle(on) {
  if (!on) {
    const m = mapMod.getMap();
    if (group && m) m.removeLayer(group);
    group = null;
    return;
  }
  syncLayer();                                          // paint whatever is already cached
  Promise.resolve().then(fetchMapAlerts).catch(() => {});
}

export function init() {
  chipEl = document.getElementById("alertChip");
  boardEl = document.getElementById("board-severe");
  sheetBodyEl = document.getElementById("alertsheetBody");

  if (chipEl) chipEl.addEventListener("click", () => boards.show("severe"));
  if (boardEl) {
    boards.register({ id: "severe", label: "SEVERE", el: boardEl, render: renderBoard });
  }
  const sheetCloseBtn = document.getElementById("alertsheetClose");
  if (sheetCloseBtn) sheetCloseBtn.addEventListener("click", () => state.closeOverlay("alertsheet"));

  layers.register({ id: "alerts", label: "ALERT POLYGONS", defaultOn: true, onToggle: alertsToggle });
  // Both toggles only change what syncLayer() draws/reports — never a fetch.
  layers.register({ id: "alertsheat", label: "HEAT / COLD ALERTS", defaultOn: false, onToggle: () => syncLayer() });
  layers.register({ id: "alertsadv", label: "ADVISORIES", defaultOn: false, onToggle: () => syncLayer() });

  // Viewport-driven MAP alerts refetch on pan/zoom, debounced so a drag
  // gesture doesn't fire a request per frame.
  const mm = mapMod.getMap();
  if (mm) mm.on("moveend", onMapMoveEnd);

  locations.onChange(() => {
    prune();
    publish();      // repaint for the new active location before its poll returns
    tick(true);
  });

  tick(true);
  setInterval(tick, TICK_MS);
}
