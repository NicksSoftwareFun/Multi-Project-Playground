// GOES-East viewer with a channel selector (M6).
//
// The selector is honestly HYBRID, because the data is:
//
//   GEOCOLOR  a single fixed full-CONUS frame from the NOAA STAR CDN. There is
//             no GeoColor tile layer to switch to — every IEM candidate name
//             (goes_east_conus_geocolor, _truecolor) 503s live and 404s in the
//             archive — so this channel keeps exactly the mechanism it has had
//             since the app shipped, and says on screen that it does not pan.
//   CH13/CH02 real IEM tile layers, drawn on the shared Leaflet map, so they
//             pan and zoom with everything else.
//
// One selector with three buttons rather than two differently-shaped controls:
// GEOCOLOR is the view most people want first, and burying it behind a second
// control would cost more in discoverability than the mechanism split costs in
// clarity. The split is named on screen instead of left to be discovered by
// poking at controls that turn out to be inert.
//
// A legacy alias layer is tried only if the exact channel misses, and when one
// is used the UI says so — a 4 km legacy IR composite is not CH13 and must
// never be labelled as it.

import { GOES_PRIMARY, GOES_FALLBACK, IEM, IEM_GOES_ARCHIVE, GOES_CHANNELS,
         REFRESH_MS } from "./config.js";
import { el, tileXY } from "./util.js";
import { fetchT } from "./net.js";
import * as net from "./net.js";
import * as state from "./state.js";
import { View } from "./state.js";
import * as mapMod from "./map.js";
import * as locations from "./locations.js";

const CH_KEY = "skywatch_sat_channel";
// [paneName, zIndex] — above the radar frames (they live in Leaflet's tilePane,
// z 200, so any pane clears them) and BELOW every vector overlay: spc(430),
// wpcwinter(433), tropical(435), spcmd(440), alerts(450), labels(465).
//
// The imagery is opaque and #satview.tiles is pointer-events:none, so a channel
// drawn OVER the alert polygons would leave them painted-out but still
// interactive: a tap meant for a cloud top opens an alert sheet with nothing on
// screen to say the polygon was there. Same rule the place-labels pane already
// follows — imagery never hides what is under the storm.
const PANE = ["swGoes", 425];
const CANARY_Z = 5;                // the zoom the live probe actually exercised
const TILE_ERROR_LIMIT = 6;
const PROBE_MS = 8000;

let satview, satimg, satBtn, satChannelsEl, satNoteEl, satMsgEl;
let activeChannel = "geocolor";
let tileLyr = null, tileErrors = 0, tileSeq = 0;
let triedFallback = false;
const fetchedAt = { geocolor: null, ch13: null, ch02: null };

export function getFetched() { return fetchedAt[activeChannel] || null; }
export function getActiveChannel() {
  return GOES_CHANNELS.find((c) => c.id === activeChannel) || GOES_CHANNELS[0];
}

function chan(id) { return GOES_CHANNELS.find((c) => c.id === id) || GOES_CHANNELS[0]; }

function pane(m) {
  const [name, z] = PANE;
  if (!m.getPane(name)) {
    const p = m.createPane(name);
    p.style.zIndex = String(z);
    p.style.pointerEvents = "none";
  }
  return name;
}

// SunCalc is vendored and loaded as a classic script; treat its absence as
// "unknown", never as "daytime".
function isNightAt(loc) {
  if (!window.SunCalc || !loc) return null;
  try {
    const t = window.SunCalc.getTimes(new Date(), loc.lat, loc.lon);
    const rise = t.sunrise && t.sunrise.getTime(), set = t.sunset && t.sunset.getTime();
    if (isNaN(rise) || isNaN(set)) return null;     // polar day/night: no answer, not a guess
    const now = Date.now();
    return now < rise || now > set;
  } catch { return null; }
}

function persistedChannel() {
  try {
    const v = localStorage.getItem(CH_KEY);
    return GOES_CHANNELS.some((c) => c.id === v) ? v : null;
  } catch { return null; }
}

function defaultChannel() {
  return persistedChannel() || (isNightAt(locations.active()) === true ? "ch13" : "geocolor");
}

// ---------------------------------------------------------------------------
// GEOCOLOR: the pre-M6 mechanism, unchanged

export function loadGoes() {
  triedFallback = false;
  satimg.src = GOES_PRIMARY + "?t=" + Date.now();
}

function showUnavailable(ch) {
  satview.classList.add("err");
  satMsgEl.textContent = ch.label + " IMAGERY UNAVAILABLE — CHECK CONNECTION";
  net.setHealth("goes", "GOES-E", false, ch.id + " unavailable");
  fetchedAt[ch.id] = null;
}

function setImageChannel() {
  dropTiles();
  satview.classList.remove("tiles");
  satNoteEl.textContent = "FIXED FULL-CONUS FRAME — ZOOM/PAN INACTIVE";
  const stale = !fetchedAt.geocolor || Date.now() - fetchedAt.geocolor.getTime() > REFRESH_MS;
  if (stale || satview.classList.contains("err")) loadGoes();
}

// ---------------------------------------------------------------------------
// CH13 / CH02: IEM tiles on the shared map

function detachTiles() {
  const m = mapMod.getMap();
  if (tileLyr && m && m.hasLayer(tileLyr)) m.removeLayer(tileLyr);
}
function dropTiles() { detachTiles(); tileLyr = null; }

// Three answers, not two. "hit" and "miss" are what the server said; "unknown"
// is what happens when the browser refuses to tell us — a CORS rejection, an
// offline stack, an abort. That is NOT evidence a tile is missing: this probe is
// the only fetch() the app makes against IEM, every other use loads tiles as
// <img> (map.js), and an <img> needs no Access-Control-Allow-Origin at all. A
// probe that cannot reach a verdict must not be allowed to veto a layer that
// would render perfectly.
async function probeTile(url) {
  try {
    const r = await fetchT(url, PROBE_MS);
    return r.ok && (r.headers.get("content-type") || "").startsWith("image/") ? "hit" : "miss";
  } catch { return "unknown"; }
}

// One canary tile aimed at the active location, then the template is trusted.
// Exact layer names first; the legacy alias names are a fallback that has to
// announce itself if it ever wins.
async function resolveTile(ch) {
  const loc = locations.active();
  const t = tileXY(loc ? loc.lon : -93.6, loc ? loc.lat : 41.7, CANARY_Z);
  const attempts = [
    { names: ch.layers, kind: "exact", note: null },
    { names: ch.aliasLayers, kind: "alias", note: ch.aliasNote }
  ];
  const exact = (ch.layers || [])[0];
  for (const a of attempts) {
    for (const prefix of [IEM, IEM_GOES_ARCHIVE]) {
      for (const layer of a.names || []) {
        const url = prefix + layer + "/" + t.z + "/" + t.x + "/" + t.y + ".png";
        const verdict = await probeTile(url);
        if (verdict === "hit") {
          return { template: prefix + layer + "/{z}/{x}/{y}.png", kind: a.kind,
                   note: a.note, probed: true };
        }
        if (verdict === "unknown" && exact) {
          // Every candidate lives on the same host, so no later probe can reach
          // a verdict this one could not. Attach the exact channel anyway and
          // let the tiles answer for themselves — probed:false tells the caller
          // this template is unconfirmed, so the FIRST tile that really fails
          // is decisive rather than waiting for TILE_ERROR_LIMIT.
          return { template: IEM + exact + "/{z}/{x}/{y}.png", kind: "exact",
                   note: null, probed: false };
        }
      }
    }
  }
  return null;
}

async function setTileChannel(ch) {
  const seq = ++tileSeq;
  satview.classList.add("tiles");
  satNoteEl.textContent = ch.id === "ch02" && isNightAt(locations.active()) === true
    ? "VISIBLE IMAGERY — LIKELY DARK AT NIGHT" : "RESOLVING " + ch.label + " TILES…";
  const resolved = await resolveTile(ch);
  if (seq !== tileSeq || activeChannel !== ch.id) return;   // superseded by a later click
  const m = mapMod.getMap();
  dropTiles();
  if (!resolved || !m || !window.L) {
    satNoteEl.textContent = "";
    showUnavailable(ch);
    return;
  }
  satview.classList.remove("err");
  satMsgEl.textContent = "";
  satNoteEl.textContent = resolved.kind === "alias"
    ? "USING " + resolved.note
    : (ch.id === "ch02" && isNightAt(locations.active()) === true
        ? "VISIBLE IMAGERY — LIKELY DARK AT NIGHT" : "PAN AND ZOOM ACTIVE");
  tileErrors = 0;
  let sawTile = false;                 // has one real tile ever arrived?
  const lyr = window.L.tileLayer(resolved.template, {
    pane: pane(m), maxNativeZoom: 6, updateWhenIdle: true, keepBuffer: 1
  });
  lyr.on("tileload", () => { sawTile = true; });
  lyr.on("tileerror", () => {
    if (tileLyr !== lyr) return;
    tileErrors++;
    // A template the probe could not confirm is decided by its first real tile
    // failure — at these zooms a viewport can be a single tile, so waiting for
    // TILE_ERROR_LIMIT would leave a dead channel silent. Once imagery has
    // landed, only a sustained run of errors counts (domain-edge 404s).
    if (tileErrors >= TILE_ERROR_LIMIT || (!resolved.probed && !sawTile)) showUnavailable(ch);
  });
  lyr.on("load", () => {
    // Leaflet fires "load" once every tile has SETTLED, errors included — so a
    // channel where nothing arrived must not report itself healthy.
    if (tileLyr !== lyr || !sawTile) return;
    satMsgEl.textContent = "";
    fetchedAt[ch.id] = new Date();
    satview.classList.remove("err");
    net.setHealth("goes", "GOES-E", true,
      resolved.kind === "alias" ? ch.id + " (legacy alias)" : ch.id + " ok");
    // the topbar shows FETCHED hh:mm off getFetched(); it only repaints on a
    // state event, so the tiles landing has to announce itself
    state.emit("goes", { channel: ch.id });
  });
  tileLyr = lyr;
  lyr.addTo(m);
}

// ---------------------------------------------------------------------------

function renderChannelStrip() {
  if (!satChannelsEl) return;
  satChannelsEl.replaceChildren(...GOES_CHANNELS.map((c) => {
    const b = el("button", {
      class: "satchbtn" + (c.id === activeChannel ? " on" : ""),
      "aria-pressed": String(c.id === activeChannel)
    }, c.label);
    b.addEventListener("click", () => setChannel(c.id, true));
    return b;
  }));
}

function setChannel(id, persist) {
  activeChannel = chan(id).id;
  renderChannelStrip();
  satview.classList.remove("err");
  satMsgEl.textContent = "";
  if (persist) { try { localStorage.setItem(CH_KEY, activeChannel); } catch { /* quota */ } }
  const ch = chan(activeChannel);
  if (ch.mech === "image") setImageChannel(); else setTileChannel(ch);
  state.emit("goes", { channel: activeChannel });
}

function enterSat() {
  const ch = chan(activeChannel);
  if (ch.mech === "image") { setImageChannel(); return; }
  const stale = !fetchedAt[ch.id] || Date.now() - fetchedAt[ch.id].getTime() > REFRESH_MS;
  const m = mapMod.getMap();
  if (tileLyr && m && !stale) { satview.classList.add("tiles"); tileLyr.addTo(m); return; }
  setTileChannel(ch);
}

// Tiles come off the map on the way out — the radar view must not keep a
// satellite layer painted over it. The layer object is kept so re-entering
// within REFRESH_MS re-attaches it instead of re-probing and refetching.
function exitSat() { detachTiles(); }

export function init() {
  satview = document.getElementById("satview");
  satimg = document.getElementById("satimg");
  satBtn = document.getElementById("satBtn");
  satChannelsEl = document.getElementById("satChannels");
  satNoteEl = document.getElementById("satNote");
  satMsgEl = document.getElementById("satMsg");

  satimg.addEventListener("load", () => {
    fetchedAt.geocolor = new Date();
    if (activeChannel === "geocolor") {
      satview.classList.remove("err");
      net.setHealth("goes", "GOES-E", true, "geocolor ok");
    }
    state.emit("goes", { channel: "geocolor" });
  });
  satimg.addEventListener("error", () => {
    if (!triedFallback) {
      triedFallback = true;
      satimg.src = GOES_FALLBACK + "?t=" + Date.now();
      return;
    }
    if (activeChannel === "geocolor") showUnavailable(chan("geocolor"));
  });

  satBtn.addEventListener("click", () => {
    if (state.getView() === View.SAT) state.goBack();
    else state.setView(View.SAT);
  });

  state.on("view", ({ view }) => {
    satBtn.textContent = view === View.SAT ? "RADAR" : "SAT";
    satBtn.classList.toggle("on", view === View.SAT);
    if (view === View.SAT) enterSat(); else exitSat();
  });

  activeChannel = defaultChannel();
  renderChannelStrip();
  // Pre-M6 the STAR frame was fetched at boot so the view was warm on first
  // open; that is kept — but only when GEOCOLOR is actually the channel that
  // will be shown, so a user who has chosen a tile channel no longer pays for
  // a 2500x1500 JPEG they will never look at.
  if (chan(activeChannel).mech === "image") {
    satNoteEl.textContent = "FIXED FULL-CONUS FRAME — ZOOM/PAN INACTIVE";
    loadGoes();
  }
  setInterval(() => {
    if (chan(activeChannel).mech === "image") loadGoes();
    else if (state.getView() === View.SAT && tileLyr) tileLyr.redraw();
  }, REFRESH_MS);
}
