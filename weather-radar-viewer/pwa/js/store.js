// Persistence: localStorage schema + a minimal IndexedDB promise wrapper.

const K_LOC_V1 = "skywatch_loc";     // legacy single location — kept this release for rollback
const K_LOCS = "skywatch_locs";      // v2 multi-location
const SNAP_PREFIX = "skywatch_snap_";

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); }
  catch { return null; }
}

// v2 shape: { v:2, activeId, list:[{id:"gps"|"z<zip>", kind, zip?, lat, lon, name, state}] }
export function loadLocs() {
  let v2 = readJson(K_LOCS);
  if (v2 && v2.v === 2 && Array.isArray(v2.list)) return v2;
  // migration: wrap the legacy single location (legacy key left in place)
  const legacy = readJson(K_LOC_V1);
  if (legacy && legacy.zip) {
    v2 = {
      v: 2,
      activeId: "z" + legacy.zip,
      list: [{ id: "z" + legacy.zip, kind: "zip", zip: legacy.zip,
               lat: legacy.lat, lon: legacy.lon, name: legacy.name, state: legacy.state }]
    };
    saveLocs(v2);
    return v2;
  }
  return { v: 2, activeId: null, list: [] };
}
export function saveLocs(locs) { localStorage.setItem(K_LOCS, JSON.stringify(locs)); }

// legacy accessors (still used to mirror the active ZIP for rollback safety)
export function saveLoc(loc) { localStorage.setItem(K_LOC_V1, JSON.stringify(loc)); }

// last-good normalized wx record per location — instant paint on switch/offline
export function loadSnap(locId) { return readJson(SNAP_PREFIX + locId); }
export function saveSnap(locId, record) {
  try { localStorage.setItem(SNAP_PREFIX + locId, JSON.stringify(record)); }
  catch { /* quota — snapshots are optional */ }
}
export function dropSnap(locId) { localStorage.removeItem(SNAP_PREFIX + locId); }

// ---- IndexedDB (normals forever-cache, alert zone geometries, bulk payloads) ----
const DB_NAME = "skywatch";
const DB_VER = 1;
const STORES = ["normals", "zones", "bulk"];
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        for (const s of STORES) {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function idbGet(storeName, key) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, "readonly").objectStore(storeName).get(key);
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch { return undefined; }   // IDB unavailable/evicted: everything is recomputable
}

export async function idbPut(storeName, key, value) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, "readwrite").objectStore(storeName).put(value, key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* non-fatal */ }
}
