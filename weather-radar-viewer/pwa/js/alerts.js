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
  if (anyOk) {
    setHealth("alerts", "ALERTS", true, count + " active");
    layers.setHealth("alerts", true);
  } else {
    setHealth("alerts", "ALERTS", false, "down");
    // Only call the layer unavailable when there is nothing left to draw;
    // last-good polygons on screen are still real, still worth showing.
    if (!count) layers.setHealth("alerts", false, "down");
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

function syncLayer() {
  const m = mapMod.getMap();
  if (!m || !window.L) return;          // Leaflet unavailable: chip and board carry on alone
  if (group) { m.removeLayer(group); group = null; }
  if (!layers.isOn("alerts")) return;

  const drawable = unionAlerts().filter((a) => a.geometry);
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
    lyr.on("click", () => {
      openIds.add(a.id);
      boards.show("severe");
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
    el("div", { id: "spcStrip" }),
    el("div", { class: "srcnote" }, "NWS api.weather.gov · SPC")
  );
  // spc.js owns #spcStrip and refills it after every one of our re-renders.
  state.emit("severeboard", { el: boardEl });
}

// ---- init ------------------------------------------------------------------

export function init() {
  chipEl = document.getElementById("alertChip");
  boardEl = document.getElementById("board-severe");

  if (chipEl) chipEl.addEventListener("click", () => boards.show("severe"));
  if (boardEl) {
    boards.register({ id: "severe", label: "SEVERE", el: boardEl, render: renderBoard });
  }
  layers.register({ id: "alerts", label: "ALERT POLYGONS", defaultOn: true, onToggle: syncLayer });

  locations.onChange(() => {
    prune();
    publish();      // repaint for the new active location before its poll returns
    tick(true);
  });

  tick(true);
  setInterval(tick, TICK_MS);
}
