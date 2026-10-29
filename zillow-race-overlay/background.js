// Fetches ACS race polygons from ArcGIS for one tile of one geography level.
// Runs in the extension's service worker so Zillow's CSP never sees the
// requests, and so the cache is shared between Zillow tabs.
importScripts('config.js');

const { SERVICE_URL, RACES, LEVELS } = self.ZRO_CONFIG;
const PAGE_SIZE = 50; // the service's maxRecordCount
const MAX_PARALLEL = 6;
const CACHE_LIMIT = 400;

const cache = new Map(); // key -> Promise<features>, insertion-ordered for LRU
let active = 0;
const waiting = [];

function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(resolve, reject).finally(() => {
        active--;
        if (waiting.length) waiting.shift()();
      });
    };
    if (active < MAX_PARALLEL) run();
    else waiting.push(run);
  });
}

function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lng = (i) => (i / n) * 360 - 180;
  const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return { xmin: lng(x), xmax: lng(x + 1), ymin: lat(y + 1), ymax: lat(y) };
}

function queryUrl(level, tile, extra) {
  const lvl = LEVELS[level];
  const b = tileBounds(tile.z, tile.x, tile.y);
  const params = new URLSearchParams({
    where: '1=1',
    geometry: JSON.stringify({ ...b, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    f: 'geojson',
    ...extra,
  });
  return `${SERVICE_URL}/${lvl.layer}/query?${params}`;
}

async function getJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await limited(() => fetch(url));
      if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`ArcGIS: ${json.error.message || 'query failed'}`);
      return json;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

function simplifyFeature(f, level) {
  const p = f.properties || {};
  const g = f.geometry;
  if (!g) return null;
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!polygons) return null;
  const counts = {};
  for (const r of RACES) counts[r.field] = Math.max(0, Number(p[r.field]) || 0);
  const name = LEVELS[level].nameFields.map((k) => p[k]).filter(Boolean).join(', ');
  return { id: `${level}:${p.GEOID}`, name, total: Number(p.B03002_001E) || 0, counts, polygons };
}

async function fetchTile(level, tile) {
  const lvl = LEVELS[level];
  const countJson = await getJson(
    queryUrl(level, tile, { returnCountOnly: 'true', f: 'json' })
  );
  const count = countJson.count || 0;
  const outFields = ['GEOID', ...lvl.nameFields, 'B03002_001E', ...RACES.map((r) => r.field)].join(',');
  const pages = [];
  for (let offset = 0; offset < count; offset += PAGE_SIZE) {
    pages.push(
      getJson(
        queryUrl(level, tile, {
          outFields,
          returnGeometry: 'true',
          outSR: '4326',
          geometryPrecision: '5',
          maxAllowableOffset: String(lvl.maxAllowableOffset),
          orderByFields: 'OBJECTID',
          resultOffset: String(offset),
          resultRecordCount: String(PAGE_SIZE),
        })
      )
    );
  }
  const results = await Promise.all(pages);
  const out = [];
  for (const json of results) {
    for (const f of json.features || []) {
      const s = simplifyFeature(f, level);
      if (s) out.push(s);
    }
  }
  return out;
}

function getTile(level, tile) {
  const key = `${level}/${tile.z}/${tile.x}/${tile.y}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = fetchTile(level, tile);
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return p;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'zro-query') return false;
  const { level, tile } = msg;
  if (!LEVELS[level] || !tile || ![tile.z, tile.x, tile.y].every(Number.isInteger)) {
    sendResponse({ error: 'bad request' });
    return false;
  }
  getTile(level, tile).then(
    (features) => sendResponse({ features }),
    (err) => sendResponse({ error: String((err && err.message) || err) })
  );
  return true; // async response
});

chrome.runtime.onInstalled.addListener(async ({ previousVersion }) => {
  const { DEFAULT_SETTINGS } = self.ZRO_CONFIG;
  const stored = await chrome.storage.sync.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  // 1.1.0 made the map show only dots by default; carry that to 1.0.0 installs.
  if (previousVersion === '1.0.0') Object.assign(settings, { legend: false, outlines: false, dim: 0 });
  await chrome.storage.sync.set({ settings });
});
