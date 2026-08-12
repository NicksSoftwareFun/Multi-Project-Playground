// Multi-location model + the location bottom sheet + the GPS entry.
// The active location drives everything; alerts (M2) will watch all of them.

import { ZIPPO, NWS_POINTS } from "./config.js";
import { fetchT, okJson } from "./net.js";
import { el, degF } from "./util.js";
import * as store from "./store.js";
import * as state from "./state.js";

const GPS_ID = "gps";
const GPS_REFRESH_MS = 15 * 60 * 1000;

let locs = { v: 2, activeId: null, list: [] };
let sheetEl, listEl, zipEl, msgEl, gpsBtn;
let gpsTimer = null;
const changeHandlers = new Set();

export function onChange(fn) { changeHandlers.add(fn); }
function fireChange() {
  mirrorLegacy();
  for (const fn of changeHandlers) fn(active());
}

export function active() {
  return locs.list.find((l) => l.id === locs.activeId) || null;
}
export function list() { return locs.list.slice(); }

// keep the legacy key mirroring the active location for one release (rollback safety)
function mirrorLegacy() {
  const a = active();
  if (a && a.kind === "zip") {
    store.saveLoc({ zip: a.zip, lat: a.lat, lon: a.lon, name: a.name, state: a.state });
  }
}

export function init() {
  locs = store.loadLocs();
  buildSheet();
  const btn = document.getElementById("locsBtn");
  if (btn) btn.addEventListener("click", () => {
    if (state.overlayOpen("locsheet")) state.closeOverlay("locsheet");
    else openSheet();
  });
  if (active() && active().kind === "gps") scheduleGpsRefresh();
}

export function setActive(id) {
  if (!locs.list.some((l) => l.id === id)) return;
  locs.activeId = id;
  store.saveLocs(locs);
  if (id === GPS_ID) scheduleGpsRefresh(); else stopGpsRefresh();
  fireChange();
}

export function addZip(zip) {
  return fetchT(ZIPPO + zip)
    .then((r) => { if (!r.ok) throw new Error("notfound"); return r.json(); })
    .then((j) => {
      const p = j.places[0];
      const loc = {
        id: "z" + zip, kind: "zip", zip,
        lat: parseFloat(p.latitude), lon: parseFloat(p.longitude),
        name: p["place name"], state: p["state abbreviation"]
      };
      locs.list = locs.list.filter((l) => l.id !== loc.id).concat(loc);
      locs.activeId = loc.id;
      store.saveLocs(locs);
      fireChange();
      return loc;
    });
}

export function remove(id) {
  locs.list = locs.list.filter((l) => l.id !== id);
  store.dropSnap(id);
  if (locs.activeId === id) locs.activeId = locs.list.length ? locs.list[0].id : null;
  store.saveLocs(locs);
  fireChange();
}

// ---- GPS ----
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("unsupported")); return; }
    navigator.geolocation.getCurrentPosition(resolve, reject,
      { timeout: 10000, maximumAge: 5 * 60 * 1000 });
  });
}

async function reverseName(lat, lon) {
  try {
    const p = await fetchT(NWS_POINTS + lat.toFixed(4) + "," + lon.toFixed(4)).then(okJson);
    const rel = p.properties && p.properties.relativeLocation && p.properties.relativeLocation.properties;
    if (rel && rel.city) return { name: rel.city, state: rel.state || "" };
  } catch { /* name is cosmetic */ }
  return { name: "CURRENT LOCATION", state: "" };
}

export async function useGps() {
  const pos = await getPosition();     // throws on denial/timeout — caller shows retry
  const lat = pos.coords.latitude, lon = pos.coords.longitude;
  const named = await reverseName(lat, lon);
  const entry = {
    id: GPS_ID, kind: "gps", lat, lon,
    name: named.name, state: named.state, updatedAt: Date.now()
  };
  locs.list = locs.list.filter((l) => l.id !== GPS_ID).concat(entry);
  locs.activeId = GPS_ID;
  store.saveLocs(locs);
  scheduleGpsRefresh();
  fireChange();
  return entry;
}

function scheduleGpsRefresh() {
  stopGpsRefresh();
  gpsTimer = setInterval(async () => {
    if (!active() || active().id !== GPS_ID) { stopGpsRefresh(); return; }
    try {
      const pos = await getPosition();
      const g = locs.list.find((l) => l.id === GPS_ID);
      if (!g) return;
      // only re-resolve the name when we actually moved (~2 km)
      const moved = Math.hypot(pos.coords.latitude - g.lat, pos.coords.longitude - g.lon) > 0.02;
      g.lat = pos.coords.latitude; g.lon = pos.coords.longitude; g.updatedAt = Date.now();
      if (moved) {
        const named = await reverseName(g.lat, g.lon);
        g.name = named.name; g.state = named.state;
      }
      store.saveLocs(locs);
      if (moved) fireChange();
    } catch { /* keep last fix */ }
  }, GPS_REFRESH_MS);
}
function stopGpsRefresh() { if (gpsTimer) { clearInterval(gpsTimer); gpsTimer = null; } }

// ---- bottom sheet UI ----
export function openSheet() {
  renderSheet();
  state.openOverlay("locsheet");
  zipEl.value = "";
  msgEl.textContent = "";
  msgEl.className = "msg";
}

function buildSheet() {
  listEl = el("div", { class: "locrows" });
  zipEl = el("input", { id: "locZip", inputmode: "numeric", maxlength: "5", placeholder: "ADD ZIP" });
  msgEl = el("div", { class: "msg", id: "locMsg" });
  gpsBtn = el("button", { class: "btn small", id: "gpsBtn" }, "◎ USE CURRENT LOCATION");
  const addBtn = el("button", { class: "btn small", id: "locAdd" }, "ADD");

  addBtn.addEventListener("click", submitZip);
  zipEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submitZip(); });
  gpsBtn.addEventListener("click", async () => {
    gpsBtn.disabled = true;
    msgEl.textContent = "LOCATING…";
    msgEl.className = "msg";
    try {
      await useGps();
      state.closeOverlay("locsheet");
    } catch {
      msgEl.textContent = "LOCATION OFF — TAP TO RETRY";
      msgEl.className = "msg err";
    } finally {
      gpsBtn.disabled = false;
    }
  });

  sheetEl = el("div", { id: "locsheet" },
    el("div", { class: "grab" }),
    el("div", { class: "title" }, "LOCATIONS"),
    listEl,
    el("div", { class: "addrow" }, zipEl, addBtn, gpsBtn),
    msgEl
  );
  document.getElementById("screen").appendChild(sheetEl);
}

function submitZip() {
  const zip = zipEl.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    msgEl.textContent = "ENTER A 5-DIGIT ZIP";
    msgEl.className = "msg err";
    return;
  }
  msgEl.textContent = "LOOKING UP " + zip + "…";
  msgEl.className = "msg";
  addZip(zip)
    .then(() => state.closeOverlay("locsheet"))
    .catch((e) => {
      msgEl.textContent = e.message === "notfound" ? "ZIP NOT FOUND" : "LOOKUP FAILED — CHECK CONNECTION";
      msgEl.className = "msg err";
    });
}

function renderSheet() {
  listEl.replaceChildren();
  if (!locs.list.length) {
    listEl.append(el("div", { class: "empty" }, "NO LOCATIONS YET — ADD A ZIP BELOW"));
    return;
  }
  for (const l of locs.list) {
    const snap = store.loadSnap(l.id);
    const row = el("div", { class: "locrow" + (l.id === locs.activeId ? " active" : "") },
      el("span", { class: "nm" }, (l.kind === "gps" ? "◎ " : "") + l.name + (l.state ? ", " + l.state : "")),
      el("span", { class: "tmp" }, snap && snap.temp != null ? degF(snap.temp) : "--"),
      el("button", { class: "del", "aria-label": "Remove " + l.name }, "✕")
    );
    row.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      remove(l.id);
      renderSheet();
    });
    row.addEventListener("click", () => {
      setActive(l.id);
      state.closeOverlay("locsheet");
    });
    listEl.append(row);
  }
}
