// RIVER GAUGES (M7): nearby USGS stream gauges, always read against their own
// NWS flood categories — never as a bare number. "11.2 FT" on its own means
// nothing to anyone; "11.2 FT, 8.8 FT below action stage (20 FT)" is a decision.
//
// Architecture is a forced two-step, from live probing:
//   DISCOVERY  api.waterdata.usgs.gov OGC API by bounding box. The classic
//              waterservices bbox form is unusable — it did not answer at all
//              for a 0.2 deg or 0.5 deg box (~45 s abort each) and only replied
//              to a ~110 km box with 150 KB / 55 sites. Never fall back to it:
//              that hangs the board instead of degrading it.
//   READINGS   classic waterservices IV by EXPLICIT SITE IDS, which is fast and
//              confirmed working. Discovery caches for 24 h (gauges do not
//              move), the reading refetches on its own 15-minute cadence.
//
// Flood context comes from NWPS. Its "not applicable" sentinel is -9999, NOT 0
// (config.NWPS_ABSENT_SENTINEL): read literally, -9999 is a discharge threshold
// every gauge on earth exceeds, which would mis-classify all of them.
//
// Two failure modes are deliberately kept independent: USGS down means no
// reading, NWPS down means no flood context — neither blanks the other.

import { USGS_OGC_SITES, USGS_IV, NWPS_GAUGES, RIVER_TTL_MS, GAUGE_CATALOG_TTL_MS,
         RIVER_BBOX_DEG, RIVER_DISCOVER_LIMIT, RIVER_MAX_GAUGES, GAUGE_MATCH_MI,
         GAUGE_STALE_MS, NWPS_ABSENT_SENTINEL } from "./config.js";
import { el, fmt } from "./util.js";
import { fetchT, okJson, setHealth } from "./net.js";
import * as layers from "./layers.js";
import * as mapMod from "./map.js";
import * as locations from "./locations.js";
import * as state from "./state.js";

const CAT_ORDER = ["action", "minor", "moderate", "major"];
const CAT_LABEL = { action: "ACTION", minor: "MINOR", moderate: "MODERATE", major: "MAJOR" };
// Reused severity tokens — no parallel flood palette is invented.
//
// UNKNOWN IS NOT SAFE. A gauge whose radio is down and a gauge confirmed 9 ft
// below action stage are different facts, and on a map — the glanceable
// surface — painting them the same green asserts safety about a gauge nobody
// assessed. Both unknown cases get the dim token and a hollow marker instead.
const STATUS_TOKEN = {
  "below-action": "--ok", action: "--sev-stmt",
  minor: "--sev-adv", moderate: "--sev-watch", major: "--sev-warn",
  "no-reading": "--sub-dim", "no-thresholds": "--sub-dim"
};
const UNKNOWN_STATUS = new Set(["no-reading", "no-thresholds"]);
const CATALOG_PREFIX = "skywatch_river_";
const DISCOVER_MS = 12000;      // OGC feature queries run past the 8s default
const MILES_PER_DEG = 69;
// The box is RIVER_BBOX_DEG in EACH direction, but a degree of longitude is
// only cos(lat) as long as a degree of latitude — 12.9 mi at 41.7N against
// 17.3 mi N-S. The narrower half-width is the only radius the search can
// actually claim to have covered.
function radiusMi(loc) {
  const c = Math.cos((Number(loc && loc.lat) || 0) * Math.PI / 180);
  return Math.max(1, Math.round(RIVER_BBOX_DEG * MILES_PER_DEG * Math.abs(c)));
}

// locId -> { t, gauges, err }   (24h, localStorage-persisted)
const catalogs = new Map();
// locId -> { t, byId, err }     (15 min, memory only)
const readings = new Map();
const inflight = new Set();

function why(e) {
  const m = e && e.message ? String(e.message) : "error";
  return m === "TIMEOUT" ? "timeout" : m;
}
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function cssVar(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || "#8FA5B7";
}
function one(x) { return Math.round(x * 10) / 10; }
function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

// Small-angle great-circle distance. Good to well under a mile at these scales,
// which is all a "3 MI AWAY" label needs.
function distMi(aLat, aLon, bLat, bLon) {
  const dLat = (aLat - bLat) * MILES_PER_DEG;
  const dLon = (aLon - bLon) * MILES_PER_DEG * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// ---- persistence -----------------------------------------------------------

function readPersisted(locId) {
  try {
    const j = JSON.parse(localStorage.getItem(CATALOG_PREFIX + locId) || "null");
    if (j && typeof j.t === "number" && Array.isArray(j.gauges)) return j;
  } catch { /* corrupt entry — rediscover */ }
  return null;
}
function persist(locId, cat) {
  try { localStorage.setItem(CATALOG_PREFIX + locId, JSON.stringify(cat)); }
  catch { /* quota — the catalog is recomputable */ }
}

// ---- discovery: USGS OGC monitoring locations ------------------------------

function bbox(loc) {
  const d = RIVER_BBOX_DEG;
  return { w: loc.lon - d, s: loc.lat - d, e: loc.lon + d, n: loc.lat + d };
}

function usgsSite(f) {
  const pr = (f && f.properties) || {};
  const geom = (f && f.geometry) || {};
  const co = Array.isArray(geom.coordinates) ? geom.coordinates : [];
  const raw = pr.monitoring_location_number || pr.site_no || pr.identifier || (f && f.id) || "";
  const id = String(raw).replace(/^USGS-/i, "").trim();
  if (!/^\d{8,15}$/.test(id)) return null;             // not a site number: skip, never guess
  const lat = num(co[1]), lon = num(co[0]);
  if (lat == null || lon == null) return null;
  const type = String(pr.site_type_code || pr.site_type || "").toUpperCase();
  // ST = stream. A groundwater well also has a "level", and reporting a well's
  // water level as a river stage would be worse than showing nothing.
  if (type && !type.startsWith("ST")) return null;
  const name = String(pr.monitoring_location_name || pr.station_nm || pr.name || ("USGS " + id));
  return { id, name, lat, lon };
}

async function discoverUsgs(loc) {
  const b = bbox(loc);
  const u = USGS_OGC_SITES + "?bbox=" + b.w + "," + b.s + "," + b.e + "," + b.n +
            "&limit=" + RIVER_DISCOVER_LIMIT + "&f=json";
  const j = await fetchT(u, DISCOVER_MS).then(okJson);
  const feats = (j && j.features) || [];
  const sites = [];
  for (const f of feats) {
    const s = usgsSite(f);
    if (s) { s.dist = distMi(loc.lat, loc.lon, s.lat, s.lon); sites.push(s); }
  }
  sites.sort((a, b2) => a.dist - b2.dist);
  // The collection is mostly wells, the page is not distance-ordered, and the
  // type filter runs HERE, on the client. So when the response is truncated,
  // this list is 20 arbitrary sites out of an unknown number and nothing about
  // it supports the words "there is no gauge nearby" — the caller is told.
  const matched = num(j && j.numberMatched);
  const returned = num(j && j.numberReturned);
  const truncated = matched != null && returned != null
    ? matched > returned
    : feats.length >= RIVER_DISCOVER_LIMIT;
  return { sites: sites.slice(0, RIVER_MAX_GAUGES), truncated, scanned: feats.length };
}

// ---- discovery: NWPS gauges + flood categories -----------------------------

function nwpsCoord(g) {
  let lat = num(g && (g.latitude != null ? g.latitude : g.lat));
  let lon = num(g && (g.longitude != null ? g.longitude : g.lon));
  const geom = g && g.geometry;
  if ((lat == null || lon == null) && geom && Array.isArray(geom.coordinates)) {
    lon = num(geom.coordinates[0]);
    lat = num(geom.coordinates[1]);
  }
  return { lat, lon };
}

async function discoverNwps(loc) {
  const b = bbox(loc);
  const u = NWPS_GAUGES + "?bbox.xmin=" + b.w + "&bbox.ymin=" + b.s +
            "&bbox.xmax=" + b.e + "&bbox.ymax=" + b.n + "&srid=EPSG_4326";
  const j = await fetchT(u, DISCOVER_MS).then(okJson);
  const list = (j && (j.gauges || j.features)) || [];
  const out = [];
  for (const g of list) {
    const lid = String((g && (g.lid || g.gaugeLid || g.id)) || "").trim();
    if (!lid) continue;
    const c = nwpsCoord(g);
    out.push({ lid, name: String((g && (g.name || g.location)) || ""), lat: c.lat, lon: c.lon });
  }
  return out;
}

function parseCategories(j) {
  const cats = ((j && j.flood) || {}).categories || {};
  const stages = {}, flows = {};
  for (const k of CAT_ORDER) {
    const entry = cats[k];
    if (!entry) continue;                                   // absent means "not defined", not zero
    const st = num(entry.stage);
    if (st != null && st > NWPS_ABSENT_SENTINEL) stages[k] = st;
    const fl = num(entry.flow);
    // -9999 is NWPS's "not applicable" sentinel, not a discharge threshold.
    if (fl != null && fl > NWPS_ABSENT_SENTINEL && fl > 0) flows[k] = fl;
  }
  const c = nwpsCoord(j);
  return {
    stages, flows,
    hasStages: Object.keys(stages).length > 0,
    hasFlows: Object.keys(flows).length > 0,
    lat: c.lat, lon: c.lon
  };
}

function fetchGaugeDetail(lid) {
  return fetchT(NWPS_GAUGES + "/" + encodeURIComponent(lid), DISCOVER_MS)
    .then(okJson).then(parseCategories);
}

// NWPS's own pairing, when the payload carries it. An id match is an identity,
// not a guess about geometry, so it is tried first and is never overruled.
function nwpsUsgsId(g) {
  const raw = g && (g.usgsId || g.usgs_id || g.usgsID ||
                    (g.usgs && (g.usgs.id || g.usgs.siteId)));
  const id = String(raw == null ? "" : raw).replace(/^USGS-/i, "").trim();
  return /^\d{8,15}$/.test(id) ? id : null;
}

// Strategy A when the bbox listing carries coordinates; Strategy B (fetch each
// candidate's detail and read the coordinates from there) when it does not.
// Name-similarity matching is explicitly NOT used — "Beaver Ck" near two
// different rivers is exactly how a gauge gets the wrong flood stages.
//
// The geometric fallback is ONE-TO-ONE and mutual. At a confluence, or at a
// bridge where a tributary gauge sits beside a mainstem forecast point, a
// one-way nearest-neighbour lookup hands the same lid to two sites and the
// creek then reports the river's flood stages — the same false pairing that
// refusing name matching was supposed to prevent. Pairs are sorted by real
// distance in miles and claimed once: closest wins, the loser gets no lid and
// says so.
async function joinGauges(sites, nwpsList) {
  if (!sites.length || !nwpsList.length) return sites;
  let candidates = nwpsList.filter((g) => g.lat != null && g.lon != null);
  const details = new Map();
  if (!candidates.length) {
    const probe = nwpsList.slice(0, RIVER_MAX_GAUGES * 2);
    const got = await Promise.all(probe.map((g) =>
      fetchGaugeDetail(g.lid).then((d) => ({ g, d })).catch(() => null)));
    candidates = [];
    for (const hit of got) {
      if (!hit || hit.d.lat == null || hit.d.lon == null) continue;
      details.set(hit.g.lid, hit.d);
      candidates.push({ ...hit.g, lat: hit.d.lat, lon: hit.d.lon });
    }
  }

  const claimedLid = new Set();
  const byUsgs = new Map();
  for (const g of nwpsList) {
    const uid = nwpsUsgsId(g);
    if (uid && !byUsgs.has(uid)) byUsgs.set(uid, g);
  }
  for (const s of sites) {
    const g = byUsgs.get(s.id);
    if (!g || claimedLid.has(g.lid)) continue;
    s.lid = g.lid; s.lidName = g.name; s.lidBy = "id"; s.lidMi = null;
    claimedLid.add(g.lid);
  }

  const pairs = [];
  for (const s of sites) {
    if (s.lid) continue;
    for (const g of candidates) {
      const mi = distMi(s.lat, s.lon, g.lat, g.lon);
      if (mi <= GAUGE_MATCH_MI) pairs.push({ s, g, mi });
    }
  }
  pairs.sort((x, y) => x.mi - y.mi);
  for (const p of pairs) {
    if (p.s.lid || claimedLid.has(p.g.lid)) continue;
    p.s.lid = p.g.lid; p.s.lidName = p.g.name; p.s.lidBy = "near"; p.s.lidMi = p.mi;
    claimedLid.add(p.g.lid);
  }
  const wanted = [...new Set(sites.filter((s) => s.lid).map((s) => s.lid))];
  await Promise.all(wanted.map(async (lid) => {
    if (!details.has(lid)) {
      try { details.set(lid, await fetchGaugeDetail(lid)); }
      catch { details.set(lid, null); }                  // context degrades; the reading still shows
    }
  }));
  for (const s of sites) {
    if (!s.lid) continue;
    const d = details.get(s.lid);
    s.cats = d ? { stages: d.stages, flows: d.flows, hasStages: d.hasStages, hasFlows: d.hasFlows } : null;
  }
  return sites;
}

// ---- readings: classic IV by explicit site id ------------------------------

function parseIv(j) {
  const out = {};
  const ts = ((j && j.value) || {}).timeSeries || [];
  for (const s of ts) {
    const src = s.sourceInfo || {};
    const code = String((((src.siteCode || [])[0]) || {}).value || "");
    if (!code) continue;
    const varCode = String(((((s.variable || {}).variableCode || [])[0]) || {}).value || "");
    const unit = String((((s.variable || {}).unit) || {}).unitCode || "");
    const vals = (((s.values || [])[0]) || {}).value || [];
    const last = vals.length ? vals[vals.length - 1] : null;
    const v = last ? num(last.value) : null;
    // USGS writes -999999 when the instrument reported nothing at that instant.
    if (v == null || v <= -999999) continue;
    const rec = out[code] || { name: String(src.siteName || ""), stage: null, stageUnit: "", flow: null, when: null };
    // The observation time is the difference between "the river is at 11.2 ft"
    // and "the river was at 11.2 ft when this gauge last managed to transmit".
    // IV answers with the newest value it holds, however old that is, so the
    // timestamp is kept and rendered rather than parsed and dropped.
    if (varCode === "00065") {
      rec.stage = v; rec.stageUnit = unit;
      const ms = last.dateTime ? Date.parse(last.dateTime) : NaN;
      rec.when = isFinite(ms) ? ms : null;
    }
    else if (varCode === "00060") rec.flow = v;
    if (!rec.name) rec.name = String(src.siteName || "");
    out[code] = rec;
  }
  return out;
}

function fetchReadings(loc, sites) {
  const ids = sites.map((s) => s.id).join(",");
  if (!ids) { readings.set(loc.id, { t: Date.now(), byId: {}, err: null }); return Promise.resolve(); }
  const u = USGS_IV + "?format=json&sites=" + ids + "&parameterCd=00065,00060&siteStatus=active";
  return fetchT(u).then(okJson).then((j) => {
    readings.set(loc.id, { t: Date.now(), byId: parseIv(j), err: null });
    setHealth("rivers", "RIVERS", true, "ok");
  }).catch((e) => {
    readings.set(loc.id, { t: Date.now(), byId: {}, err: why(e) });
    setHealth("rivers", "RIVERS", false, why(e));
  });
}

// ---- freshness -------------------------------------------------------------

function ensureFresh(loc) {
  if (!loc || inflight.has(loc.id)) return;
  const now = Date.now();
  let cat = catalogs.get(loc.id);
  if (!cat) {
    const stored = readPersisted(loc.id);
    if (stored) { cat = stored; catalogs.set(loc.id, stored); }
  }
  // The catalog is keyed on loc.id, and the GPS entry keeps the fixed id "gps"
  // while its coordinates move underneath it. Age alone therefore does not make
  // a catalog fresh: drive 60 miles and a 24-hour-old-but-not-expired record
  // would keep listing the origin city's gauges, with the origin city's
  // distances, refetching their readings so the numbers still look live. So the
  // record carries the coordinates it was discovered from and goes stale when
  // the location leaves a quarter of the search box.
  const moved = !cat || cat.lat == null || cat.lon == null ||
    distMi(loc.lat, loc.lon, cat.lat, cat.lon) > (RIVER_BBOX_DEG / 4) * MILES_PER_DEG;
  const catStale = !cat || cat.err || moved || now - cat.t > GAUGE_CATALOG_TTL_MS;
  const rd = readings.get(loc.id);
  const readStale = !rd || now - rd.t > RIVER_TTL_MS;
  if (!catStale && !readStale) return;

  inflight.add(loc.id);
  (async () => {
    let c = cat;
    if (catStale) {
      try {
        const found = await discoverUsgs(loc);
        const nwps = await discoverNwps(loc).catch(() => []);   // flood context is optional
        c = {
          t: Date.now(), lat: loc.lat, lon: loc.lon,
          gauges: await joinGauges(found.sites, nwps),
          truncated: found.truncated, scanned: found.scanned, err: null
        };
        catalogs.set(loc.id, c);
        persist(loc.id, c);
      } catch (e) {
        // An expired catalog still beats nothing — but only if it belongs to
        // where we are now; a catalog from 60 miles back is not a degraded
        // answer, it is a wrong one.
        if (!moved && cat && cat.gauges && cat.gauges.length) { c = cat; }
        else { c = { t: Date.now(), lat: loc.lat, lon: loc.lon, gauges: [], err: why(e) }; catalogs.set(loc.id, c); }
        setHealth("rivers", "RIVERS", false, why(e));
      }
    }
    if (c && c.gauges && c.gauges.length) await fetchReadings(loc, c.gauges);
    else if (c && !c.err) setHealth("rivers", "RIVERS", true, "no gauges nearby");
  })().catch(() => { /* handled above */ }).then(() => {
    inflight.delete(loc.id);
    repaint();
    if (layers.isOn("rivers")) drawPins();
  });
}

// ---- classification --------------------------------------------------------

// Two different unknowns, kept apart: "nothing came back from this gauge" and
// "this gauge has a reading but no thresholds to read it against". Neither is
// "below action stage", and neither may be drawn as if it were.
function classify(stage, cats) {
  if (stage == null) return { status: "no-reading" };
  if (!cats || !cats.hasStages) return { status: "no-thresholds" };
  let status = "below-action";
  for (const k of CAT_ORDER) {
    const v = cats.stages[k];
    if (v != null && stage >= v) status = k;
  }
  return { status };
}

// The sentence under the bar. Always relates the reading to a NAMED threshold —
// a bar with no words is another way of printing a bare number.
function relationLine(stage, cats) {
  const defined = CAT_ORDER.filter((k) => cats.stages[k] != null);
  if (!defined.length || stage == null) return null;
  const { status } = classify(stage, cats);
  if (status === "below-action") {
    const first = defined[0];
    return one(cats.stages[first] - stage) + " FT BELOW " + CAT_LABEL[first] +
           (first === "action" ? " STAGE" : " FLOOD STAGE") + " (" + one(cats.stages[first]) + " FT)";
  }
  const above = "ABOVE " + CAT_LABEL[status] + " (" + one(cats.stages[status]) + " FT)";
  const next = defined[defined.indexOf(status) + 1];
  if (!next) return "ABOVE " + CAT_LABEL[status] + " FLOOD STAGE (" + one(cats.stages[status]) + " FT)";
  return above + ", " + one(cats.stages[next] - stage) + " FT BELOW " + CAT_LABEL[next] +
         " (" + one(cats.stages[next]) + " FT)";
}

// ---- DOM -------------------------------------------------------------------

function note(text) { return el("div", { class: "srcnote" }, text); }

function gaugeBar(stage, cats) {
  const defined = CAT_ORDER.filter((k) => cats.stages[k] != null);
  if (!defined.length) return null;
  const values = defined.map((k) => cats.stages[k]);
  let lo = Math.min(...values, stage);
  let hi = Math.max(...values, stage);
  const pad = Math.max((hi - lo) * 0.15, 1);
  lo -= pad; hi += pad;
  const span = hi - lo;
  const pctOf = (v) => ((v - lo) / span) * 100;

  const bar = el("div", { class: "gaugebar" });
  // Zone colors live in boards.css against these class names — never in JS.
  let from = lo, cls = "below";
  for (const k of defined) {
    const to = cats.stages[k];
    bar.append(el("div", { class: "zone " + cls,
      style: "left:" + pctOf(from) + "%;width:" + (pctOf(to) - pctOf(from)) + "%" }));
    from = to; cls = k;
  }
  bar.append(el("div", { class: "zone " + cls,
    style: "left:" + pctOf(from) + "%;width:" + (100 - pctOf(from)) + "%" }));
  if (stage != null) {
    bar.append(el("div", { class: "now", style: "left:" + pctOf(stage) + "%" }));
  }
  return bar;
}

function stageText(rd) {
  if (!rd || rd.stage == null) return null;
  const unit = rd.stageUnit && !/^ft$/i.test(rd.stageUnit) ? rd.stageUnit.toUpperCase() : "FT";
  return one(rd.stage) + " " + unit;
}

// How old the reading is, in the coarsest unit that is still honest.
function ageStr(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 90 ? min + " MIN" : Math.round(min / 60) + " H";
}
function readingAge(rd) {
  return rd && rd.when != null ? Date.now() - rd.when : null;
}

// The flood-context ladder, shared by the row and the map popup so the two can
// never contradict each other about the same gauge. "No categories defined" is
// an affirmative denial of data that may well exist, so it is the LAST rung,
// reached only when the gauge really defines neither stages nor flows.
function floodContext(g, stage) {
  const cats = g.cats;
  if (cats && cats.hasStages && stage != null) {
    const rel = relationLine(stage, cats);
    if (rel) return { status: classify(stage, cats).status, text: rel };
  }
  if (cats && cats.hasStages) {
    return { text: "FLOOD STAGES ARE DEFINED FOR THIS SITE, BUT THERE IS NO CURRENT STAGE TO COMPARE THEM TO" };
  }
  if (cats && cats.hasFlows) {
    // Never silently classify off a discharge threshold: -9999 is the "not
    // applicable" sentinel and a stage cannot be compared to a flow anyway.
    return { text: "NEARBY NWS GAUGE " + g.lid + " DEFINES ITS FLOOD CATEGORIES BY DISCHARGE, NOT STAGE — NOT COMPARED HERE" };
  }
  if (g.lid) return { text: "NEARBY NWS GAUGE " + g.lid + " DEFINES NO FLOOD CATEGORIES FOR THIS SITE" };
  return { text: "NO FLOOD STAGE CONTEXT — NO NEARBY NWS FLOOD GAUGE FOUND" };
}

// Where the thresholds came from. The row's own caveat says stages are not
// comparable between gauges, so the reader has to be able to see that these
// belong to a DIFFERENT gauge a fraction of a mile away.
function provenanceNote(g) {
  if (!g.lid || !g.cats || !(g.cats.hasStages || g.cats.hasFlows)) return null;
  const near = g.lidMi == null ? " · PAIRED BY THE NWS TO THIS SITE"
    : g.lidMi < 0.1 ? " · UNDER 0.1 MI FROM THIS SITE"
    : " · " + one(g.lidMi) + " MI FROM THIS SITE";
  return note("FLOOD CATEGORIES FROM NWS GAUGE " + g.lid + near);
}

function gaugeRow(g, rd, readErr, loc) {
  // Distance against the CURRENT location, not the one the catalog was built
  // from: the GPS entry moves under a fixed id, and a frozen "4.2 MI AWAY" on a
  // gauge now 60 miles back is a lie that reads like a fact.
  const dist = loc && g.lat != null && g.lon != null
    ? distMi(loc.lat, loc.lon, g.lat, g.lon) : g.dist;
  const kids = [el("div", { class: "name" },
    g.name + " · USGS " + g.id + (dist != null ? " · " + one(dist) + " MI AWAY" : ""))];

  const st = stageText(rd);
  if (st) {
    kids.push(el("div", { class: "stage" }, st));
  } else if (readErr) {
    kids.push(el("div", { class: "stage" }, "--"));
    kids.push(note("STAGE UNAVAILABLE — " + readErr));
  } else if (rd && rd.flow != null) {
    kids.push(el("div", { class: "stage" }, "--"));
    kids.push(note("THIS GAUGE REPORTS DISCHARGE BUT NO GAUGE HEIGHT RIGHT NOW"));
  } else {
    kids.push(el("div", { class: "stage" }, "--"));
    kids.push(note("NO CURRENT READING FROM THIS GAUGE"));
  }

  const cats = g.cats;
  const stage = rd && rd.stage != null ? rd.stage : null;
  const age = readingAge(rd);
  const stale = age != null && age > GAUGE_STALE_MS;
  if (st && rd.when != null && !stale) kids.push(note("READING AS OF " + fmt(new Date(rd.when))));

  if (stale) {
    // A stage this old is not the river's present level, so it does not get a
    // present-tense flood comparison — the zone bar and the relation line are
    // both withheld and the age is stated instead.
    kids.push(el("div", { class: "rel" },
      "THIS READING IS " + ageStr(age) + " OLD (" + fmt(new Date(rd.when)) +
      ") — TOO OLD TO PLACE AGAINST FLOOD STAGE. THE GAUGE MAY HAVE STOPPED REPORTING."));
  } else {
    if (cats && cats.hasStages && stage != null) {
      const bar = gaugeBar(stage, cats);
      if (bar) kids.push(bar);
    }
    const ctx = floodContext(g, stage);
    kids.push(el("div", { class: "rel" + (ctx.status ? " " + ctx.status : "") }, ctx.text));
  }
  const prov = provenanceNote(g);
  if (prov) kids.push(prov);

  if (rd && rd.flow != null) {
    kids.push(el("div", { class: "grid" },
      el("span", { class: "k" }, "FLOW"),
      el("span", { class: "v" }, comma(Math.round(rd.flow)) + " CFS")));
  }
  // The datum trap, on every row without exception.
  kids.push(note("STAGE IS RELATIVE TO THIS GAUGE'S OWN DATUM — NOT SEA LEVEL, AND NOT COMPARABLE BETWEEN GAUGES."));
  return el("div", { class: "gaugerow" }, ...kids);
}

export function renderStrip(host) {
  if (!host) return;
  host.className = "riverstrip";
  const loc = locations.active();
  if (!loc) { host.replaceChildren(); return; }

  const kids = [el("div", { class: "sect" }, "NEARBY RIVER GAUGES")];
  const cat = catalogs.get(loc.id);
  if (!cat) {
    kids.push(note("RIVER GAUGES LOADING…"));
    host.replaceChildren(...kids);
    return;
  }
  if (cat.err) {
    kids.push(note("RIVER GAUGES UNAVAILABLE — " + cat.err));
    host.replaceChildren(...kids);
    return;
  }
  if (!cat.gauges.length) {
    // "There is no gauge near you" is an absolute claim, and discovery cannot
    // support it when the page came back full: the collection is mostly
    // groundwater wells, the stream filter runs on the client, and the page is
    // not distance-ordered, so a full page of wells says nothing about what a
    // deeper page holds. Say what was actually searched instead.
    kids.push(note(cat.truncated
      ? "NO STREAM GAUGE AMONG THE " + (cat.scanned || RIVER_DISCOVER_LIMIT) +
        " SITES THIS SEARCH RETURNED — THE AREA HAS MORE MONITORING SITES THAN ONE PAGE, SO A RIVER GAUGE MAY STILL BE NEARBY"
      : "NO USGS RIVER GAUGE WITHIN ~" + radiusMi(loc) + " MI"));
    host.replaceChildren(...kids);
    return;
  }
  const rd = readings.get(loc.id);
  if (!rd) {
    kids.push(note("RIVER GAUGES LOADING…"));
    host.replaceChildren(...kids);
    return;
  }
  for (const g of cat.gauges) kids.push(gaugeRow(g, rd.byId[g.id], rd.err, loc));
  if (cat.truncated) {
    kids.push(note("THE SITE SEARCH RETURNED A FULL PAGE, SO THESE ARE THE NEAREST STREAM GAUGES AMONG THE SITES IT LISTED — NOT NECESSARILY THE NEAREST THAT EXIST."));
  }
  kids.push(note("USGS WATERSERVICES · NOAA/NWS NATIONAL WATER PREDICTION SERVICE"));
  host.replaceChildren(...kids);
}

function repaint() {
  const host = document.getElementById("riverStrip");
  if (host) renderStrip(host);
}

// ---- map pins --------------------------------------------------------------

let pinLyr = null;

// Own pane at 460: above the alert polygons (450), below the place labels
// (465). A gauge pin is a 6-pixel target and an alert polygon is a
// county-sized interactive fill — under it, the pin would be untappable
// during exactly the weather that makes river stage worth checking, while the
// polygon stays tappable everywhere the pins are not.
const PIN_PANE = "swRivers";
function pinPane(map) {
  if (!map.getPane(PIN_PANE)) {
    const p = map.createPane(PIN_PANE);
    p.style.zIndex = "460";
  }
  return PIN_PANE;
}

function dropPins() {
  const map = mapMod.getMap();
  if (pinLyr && map && map.hasLayer(pinLyr)) map.removeLayer(pinLyr);
  pinLyr = null;
}

function pinPopup(g, rd) {
  const kids = [el("div", null, g.name + " · USGS " + g.id)];
  const st = stageText(rd);
  const age = readingAge(rd);
  const stale = age != null && age > GAUGE_STALE_MS;
  kids.push(el("div", null, st
    ? "STAGE " + st + (rd.when != null ? " AS OF " + fmt(new Date(rd.when)) : "")
    : "NO CURRENT READING"));
  // The same ladder the row uses. The popup used to answer "no flood categories
  // defined for SAYI4" whenever there was no stage — affirmatively denying
  // thresholds that gauge publishes, and contradicting the row beside it.
  if (stale) {
    kids.push(el("div", null, "THIS READING IS " + ageStr(age) + " OLD — TOO OLD TO PLACE AGAINST FLOOD STAGE."));
  } else {
    kids.push(el("div", null, floodContext(g, rd && rd.stage != null ? rd.stage : null).text));
  }
  if (g.lid && g.cats && (g.cats.hasStages || g.cats.hasFlows)) {
    kids.push(el("div", null, "FLOOD CATEGORIES FROM NWS GAUGE " + g.lid + "."));
  }
  kids.push(el("div", null, "STAGE IS RELATIVE TO THIS GAUGE'S OWN DATUM."));
  // A built node, never a string: Leaflet treats a string as markup and these
  // names come straight off a remote service.
  return el("div", { class: "srcnote", style: "color:#1B232C" }, ...kids);
}

export function drawPins() {
  const map = mapMod.getMap();
  if (!map || !window.L) { layers.setHealth("rivers", false, "map unavailable"); return; }
  const loc = locations.active();
  if (!loc) { layers.setHealth("rivers", false, "no location"); return; }
  const cat = catalogs.get(loc.id);
  if (!cat || cat.err || !cat.gauges.length) {
    ensureFresh(loc);
    layers.setHealth("rivers", !(cat && cat.err), cat && cat.err ? cat.err : "waiting for gauges");
    return;
  }
  const rd = readings.get(loc.id);
  dropPins();
  const group = window.L.layerGroup();
  for (const g of cat.gauges) {
    const reading = rd ? rd.byId[g.id] : null;
    // A stage from hours ago cannot colour a pin either: the popup already
    // refuses to compare it to flood stage, and the pin must not quietly do
    // what the popup declines to do.
    const age = readingAge(reading);
    const usable = reading && reading.stage != null && !(age != null && age > GAUGE_STALE_MS);
    const stage = usable ? reading.stage : null;
    const status = classify(stage, g.cats).status;
    const unknown = UNKNOWN_STATUS.has(status);
    const color = cssVar(STATUS_TOKEN[status] || "--sub-dim");
    // A gauge that could not be assessed is drawn hollow and dashed as well as
    // dim, so it cannot be read as a filled "assessed and fine" pin at a glance
    // or in monochrome.
    const m = window.L.circleMarker([g.lat, g.lon], {
      pane: pinPane(map), radius: 6, color, weight: 2,
      dashArray: unknown ? "3 3" : null,
      fillColor: color, fillOpacity: unknown ? 0 : 0.45
    });
    m.bindPopup(pinPopup(g, reading));
    group.addLayer(m);
  }
  pinLyr = group.addTo(map);
  layers.setHealth("rivers", true, cat.gauges.length + " gauges");
}

// onToggle runs synchronously inside layers.register(), so the draw is deferred
// to a microtask: registration (and therefore boot) never waits on the network.
function toggle(on) {
  if (!on) { dropPins(); return; }
  Promise.resolve().then(() => {
    const loc = locations.active();
    if (loc) ensureFresh(loc);
    drawPins();
  }).catch((e) => layers.setHealth("rivers", false, why(e)));
}

// ---- public ----------------------------------------------------------------

export function init() {
  try {
    layers.register({ id: "rivers", label: "RIVER GAUGES", defaultOn: false, onToggle: toggle });

    // alerts.js owns the SEVERE board and drops an empty #riverStrip into it,
    // re-emitting on every render — same contract spc.js uses for #spcStrip.
    state.on("severeboard", (d) => {
      const host = d && d.el && d.el.querySelector("#riverStrip");
      if (!host) return;
      renderStrip(host);
      ensureFresh(locations.active());
    });

    locations.onChange(() => {
      repaint();
      if (document.getElementById("riverStrip") || layers.isOn("rivers")) {
        ensureFresh(locations.active());
      }
      if (layers.isOn("rivers")) drawPins();
    });
  } catch { /* a broken river section must never take boot down */ }
}
