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

// ------------------------------------------------------------ DC Metro

const METRO_TTL_MS = 7 * 24 * 3600 * 1000;
let metroPromise = null;

// Each line in the DC GIS layer was digitized on its own, in whatever
// direction. The page draws lines that share track side by side using a
// per-line offset to the left of travel, so lines that share track must run
// the same way. Orient each line to agree with the nearest already-oriented
// line it runs alongside.
function orientLines(lines) {
  const mx = (dLng) => dLng * 86650; // metres per degree of longitude at DC's latitude
  const done = [];
  for (const line of lines) {
    let agree = 0, disagree = 0;
    const pts = line.path;
    for (let i = 0; i + 1 < pts.length; i += 20) {
      const [x, y] = pts[i];
      const tx = pts[i + 1][0] - x, ty = pts[i + 1][1] - y;
      for (const other of done) {
        const q = other.path;
        let best = Infinity, bj = -1;
        for (let j = 0; j + 1 < q.length; j++) {
          const d = mx(q[j][0] - x) ** 2 + ((q[j][1] - y) * 111000) ** 2;
          if (d < best) { best = d; bj = j; }
        }
        if (best > 40 * 40) continue; // not sharing track here
        const ox = q[bj + 1][0] - q[bj][0], oy = q[bj + 1][1] - q[bj][1];
        if (tx * ox + ty * oy >= 0) agree++;
        else disagree++;
      }
    }
    if (disagree > agree) line.path.reverse();
    done.push(line);
  }
  return lines;
}

async function fetchMetro() {
  const { METRO } = self.ZRO_CONFIG;
  const base = METRO.SERVICE_URL;
  const q = (layer, extra) =>
    `${base}/${layer}/query?${new URLSearchParams({ where: '1=1', outSR: '4326', f: 'geojson', ...extra })}`;
  const [linesJson, stationsJson] = await Promise.all([
    getJson(q(METRO.LINES_LAYER, { outFields: 'NAME', geometryPrecision: '6', maxAllowableOffset: '0.00001' })),
    getJson(q(METRO.STATIONS_LAYER, { outFields: 'NAME,LINE', geometryPrecision: '6' })),
  ]);
  const lines = [];
  for (const f of linesJson.features || []) {
    const name = String((f.properties || {}).NAME || '').toLowerCase();
    const g = f.geometry;
    if (!g) continue;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const path of parts) if (path.length > 1) lines.push({ name, path });
  }
  // Orient in a fixed order so trunk lines lead and branches follow them.
  const order = METRO.LINES.map((l) => l.name);
  lines.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  orientLines(lines);
  const stations = (stationsJson.features || [])
    .filter((f) => f.geometry && f.geometry.type === 'Point')
    .map((f) => ({
      name: f.properties.NAME,
      lines: String(f.properties.LINE || '').toLowerCase(),
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));
  return { lines, stations };
}

function getMetro() {
  if (!metroPromise) {
    metroPromise = (async () => {
      const { metro } = await chrome.storage.local.get('metro');
      if (metro && metro.version === 2 && Date.now() - metro.at < METRO_TTL_MS) return metro.data;
      const data = await fetchMetro();
      await chrome.storage.local.set({ metro: { version: 2, at: Date.now(), data } });
      return data;
    })();
    metroPromise.catch(() => (metroPromise = null));
  }
  return metroPromise;
}

// ------------------------------------------------------------- routing

// Driving route between two points from the public OSRM server
// (OpenStreetMap roads, free-flow speeds, no traffic).
async function getRoute(from, to) {
  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* fall through */
  }
  if (!json || json.code !== 'Ok' || !json.routes || !json.routes.length) {
    const why = json && json.code === 'NoRoute' ? 'No road route between those points' : json && json.message;
    throw new Error(why || `Routing service error (HTTP ${res.status})`);
  }
  const r = json.routes[0];
  return { meters: r.distance, seconds: r.duration, path: r.geometry.coordinates };
}

// ----------------------------------------------------------- messages

const isLngLat = (p) =>
  Array.isArray(p) && p.length === 2 && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 && p.every(Number.isFinite);

function handle(method, params) {
  params = params || {};
  if (method === 'tile') {
    const { level, tile } = params;
    if (!LEVELS[level] || !tile || ![tile.z, tile.x, tile.y].every(Number.isInteger)) throw new Error('bad request');
    return getTile(level, tile).then((features) => ({ features }));
  }
  if (method === 'metro') return getMetro();
  if (method === 'route') {
    if (!isLngLat(params.from) || !isLngLat(params.to)) throw new Error('bad request');
    return getRoute(params.from, params.to);
  }
  throw new Error('unknown method');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'zro-rpc') return false;
  Promise.resolve()
    .then(() => handle(msg.method, msg.params))
    .then(
      (result) => sendResponse({ result }),
      (err) => sendResponse({ error: String((err && err.message) || err) })
    );
  return true; // async response
});

chrome.runtime.onInstalled.addListener(async ({ previousVersion }) => {
  const { DEFAULT_SETTINGS } = self.ZRO_CONFIG;
  const stored = await chrome.storage.sync.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  // 1.1.0 switched the legend, outlines and darkening off; 1.2.0 brings
  // back the full 1.0 feature set, so restore them for 1.1.0 installs.
  if (previousVersion === '1.1.0') Object.assign(settings, { legend: true, outlines: true, dim: DEFAULT_SETTINGS.dim });
  await chrome.storage.sync.set({ settings });
});
