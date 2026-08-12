// Leaflet map + the radar frame engine (window-of-two tile layers).

import { IEM, BASEMAP, BASEMAP_LABELS, BASEMAP_ATTRIB, HOME_VIEW, DEFAULT_VIEW_KM,
         PAST, NFRAMES, NOW_I, frameT, REFRESH_MS, PAL } from "./config.js";
import { pad, utcStamp, el } from "./util.js";
import * as net from "./net.js";
import * as state from "./state.js";

let map = null;
let frame = NOW_I;
const layers = new Array(NFRAMES).fill(null);
let hrrrRunOffsetHrs = 2;     // HRRR takes 1-2h to appear on IEM; walk older on 404s
let hrrrErrors = 0;
let radarErrors = 0;
let nextRefresh = Date.now() + REFRESH_MS;
let activeLatLon = null;      // [lat, lon] of the active location, set by wx/locations

export function getMap() { return map; }
export function getFrame() { return frame; }
export function nextRefreshAt() { return nextRefresh; }
export function setActiveLatLon(ll) { activeLatLon = ll; }
export function getActiveLatLon() { return activeLatLon; }

export function zoomForWidthKm(km, lat) {
  const px = window.innerWidth || 1024;
  return Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) * px / (km * 1000));
}

// Default framing: active location at DEFAULT_VIEW_KM across; eastern-US fallback.
export function goDefaultView() {
  if (!map) return;
  if (activeLatLon) map.setView(activeLatLon, zoomForWidthKm(DEFAULT_VIEW_KM, activeLatLon[0]));
  else map.setView(HOME_VIEW.center, HOME_VIEW.zoom);
}

export function init() {
  if (window.L) {
    map = L.map("lmap", {
      center: HOME_VIEW.center,
      zoom: HOME_VIEW.zoom,
      minZoom: 4,
      maxZoom: 10,
      zoomSnap: 0,               // fractional zooms for exact-width framings
      zoomControl: false,
      attributionControl: true
    });
    L.tileLayer(BASEMAP, { attribution: BASEMAP_ATTRIB, subdomains: "abcd" }).addTo(map);
    // Labels ride in their own pane above radar, alerts, and outlook fills, so
    // no amount of reflectivity can hide which county you are looking at.
    // pointer-events: none keeps drags and polygon taps reaching the layers below.
    const lab = map.createPane("labels");
    lab.style.zIndex = 465;
    lab.style.pointerEvents = "none";
    L.tileLayer(BASEMAP_LABELS, { pane: "labels", subdomains: "abcd" }).addTo(map);
    net.setHealth("radar", "RADAR ", true, "ok");
  } else {
    net.setHealth("radar", "RADAR ", false, "map lib unavailable");
  }
  net.setHealth("hrrr", "HRRR  ", true, "run -" + hrrrRunOffsetHrs + "h");

  buildLegend();

  document.getElementById("zoomIn").addEventListener("click", () => { if (map) map.zoomIn(); });
  document.getElementById("zoomOut").addEventListener("click", () => { if (map) map.zoomOut(); });

  window.addEventListener("resize", () => { if (map) map.invalidateSize(); });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => { if (map) map.invalidateSize(); }, 300);
  });

  // Rebuild ALL frames every 5 minutes — past frames pick up new scans and
  // future frames re-anchor to the current clock (their URLs bake in Date.now()).
  setInterval(() => {
    nextRefresh = Date.now() + REFRESH_MS;
    radarErrors = 0;
    net.setHealth("radar", "RADAR ", !!map, map ? "ok" : "map lib unavailable");
    for (let i = 0; i < NFRAMES; i++) dropLayer(i);
    show(frame);
  }, REFRESH_MS);
}

function buildLegend() {
  const box = document.getElementById("legendSwatches");
  box.replaceChildren(...PAL.map((c) => {
    const i = el("i");
    i.style.background = c;
    return i;
  }));
}

function layerUrl(i) {
  const t = frameT(i);
  if (i < PAST) {
    // explicit timestamps for every frame (~3 min processing lag) — the "-0"
    // current alias mixes per-tile cache ages and tears at tile seams
    const d = new Date(Date.now() - 180000 + t * 60000);
    return IEM + "ridge::USCOMP-N0Q-" + utcStamp(d, 5) + "/{z}/{x}/{y}.png";
  }
  const init = hrrrInit();
  const validMs = Date.now() + t * 60000;
  let fmin = Math.round((validMs - init.getTime()) / 900000) * 15;
  fmin = Math.max(0, Math.min(1080, fmin));
  return IEM + "hrrr::REFD-F" + pad(fmin, 4) + "-" + utcStamp(init, 60) + "/{z}/{x}/{y}.png";
}

function hrrrInit() {
  const d = new Date(Date.now() - hrrrRunOffsetHrs * 3600 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

function buildLayer(i) {
  if (!map) return null;
  const lyr = L.tileLayer(layerUrl(i), {
    opacity: 0, zIndex: 400, maxNativeZoom: 9,
    updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 0
  });
  lyr.on("tileerror", () => {
    if (i < PAST) {
      radarErrors++;
      if (radarErrors >= 20) net.setHealth("radar", "RADAR ", false, "errors");
    } else {
      hrrrErrors++;
      if (hrrrErrors > 12 && hrrrRunOffsetHrs < 6) {
        hrrrErrors = 0;
        hrrrRunOffsetHrs++;      // this HRRR run isn't on IEM yet — use an older one
        net.setHealth("hrrr", "HRRR  ", true, "run -" + hrrrRunOffsetHrs + "h");
        rebuildFuture();
      }
    }
  });
  lyr.addTo(map);
  return lyr;
}

function dropLayer(i) {
  if (layers[i]) {
    if (map && map.hasLayer(layers[i])) map.removeLayer(layers[i]);
    layers[i] = null;
  }
}

export function rebuildFuture() {
  for (let i = PAST; i < NFRAMES; i++) dropLayer(i);
  if (frame >= PAST) show(frame);
}

// Only the visible frame and the preloading next one stay attached — keeping
// all frames on the map multiplies tile requests on every pan/zoom.
export function show(i) {
  frame = i;
  const nx = (i + 1) % NFRAMES;
  if (!layers[i]) layers[i] = buildLayer(i);
  if (!layers[nx]) layers[nx] = buildLayer(nx);
  for (let j = 0; j < NFRAMES; j++) {
    const lyr = layers[j];
    if (!lyr || !map) continue;
    if (j === i || j === nx) {
      if (!map.hasLayer(lyr)) lyr.addTo(map);
      lyr.setOpacity(j === i ? 0.75 : 0);
    } else if (map.hasLayer(lyr)) {
      map.removeLayer(lyr);
    }
  }
  state.emit("frame", { frame });
}
