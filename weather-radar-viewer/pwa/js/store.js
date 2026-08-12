// Persistence: localStorage schema + a minimal IndexedDB promise wrapper.
// M0 keeps the legacy single-location key; the v2 multi-location schema and
// its migration land in M1 (locations.js).

const K_LOC = "skywatch_loc";
const K_AUTO = "skywatch_auto";

export function loadLoc() {
  try { return JSON.parse(localStorage.getItem(K_LOC) || "null"); }
  catch { return null; }
}
export function saveLoc(loc) { localStorage.setItem(K_LOC, JSON.stringify(loc)); }

export function loadAuto() { return localStorage.getItem(K_AUTO) === "1"; }
export function saveAuto(on) { localStorage.setItem(K_AUTO, on ? "1" : "0"); }

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
