#!/usr/bin/env node
// Live endpoint health checks for the SKYWATCH data sources.
// Plain Node >= 20 (global fetch), no dependencies, no Playwright.
//
// Every check is advisory: failures are recorded, a summary table is printed,
// endpoint-results.json is written, and the process always exits 0.
// Run: node integration/endpoint-checks.mjs   (or `npm run endpoints`)

const ORIGIN = "https://nickssoftwarefun.github.io";
const results = [];

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${id}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function check(id, fn) {
  try {
    const detail = await fn();
    record(id, true, detail ?? "");
  } catch (e) {
    record(id, false, String(e && e.message ? e.message : e));
  }
}

function acao(res) {
  return res.headers.get("access-control-allow-origin");
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- helpers used by the M5/M6/M7 probes (checks 11-18) --------------------
// Never set a custom User-Agent anywhere below: api.weather.gov answers the
// resulting CORS preflight with a rejection, which is the whole point of the
// browser-default-UA rule in the app.

// Text fetch that also reports payload size and CORS posture.
async function get(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const res = await fetch(url, {
    headers: { Origin: ORIGIN, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return {
    url,
    text,
    status: res.status,
    // bytes = decoded size (what IndexedDB/parse cost is measured in);
    // contentLength = wire size, gzip already applied by the server.
    bytes: Buffer.byteLength(text, "utf8"),
    contentLength: res.headers.get("content-length"),
    contentType: res.headers.get("content-type") || "",
    acao: acao(res),
    headers: res.headers,
    json() { try { return JSON.parse(this.text); } catch { return null; } },
  };
}

// Binary fetch, for tiles and ArcGIS export images.
async function getBin(url, { timeoutMs = 30000 } = {}) {
  const res = await fetch(url, {
    headers: { Origin: ORIGIN },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = await res.arrayBuffer();
  return {
    url,
    status: res.status,
    bytes: buf.byteLength,
    contentType: res.headers.get("content-type") || "",
    acao: acao(res),
  };
}

// Truncate anything for the results file — probes must never dump a whole feed.
function clip(v, n = 400) {
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  s = s == null ? "" : String(s);
  return s.length > n ? s.slice(0, n) + "...(truncated)" : s;
}

// UTC yyyy-mm-dd, `days` from today (negative = past).
function isoDay(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

// XYZ/Web-Mercator tile coordinates for a lon/lat — aims tile probes at CONUS.
function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    z,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

// Depth- and count-capped hunt for keys matching `re`, returning the dotted
// path plus the object that holds them (so an unknown schema can be reported).
function findKeyNodes(node, re, path = "", out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 6 || out.length >= 24) return out;
  if (Array.isArray(node)) {
    if (node.length) findKeyNodes(node[0], re, path + "[0]", out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    const p = path ? path + "." + k : k;
    if (re.test(k)) out.push({ path: p, containerPath: path || "(root)", container: node });
    findKeyNodes(v, re, p, out, depth + 1);
  }
  return out;
}

// One ArcGIS service-directory listing. Never throws; returns {error} instead.
// In a folder listing ArcGIS already prefixes service names with the folder,
// so `${root}/rest/services/${name}/${type}` is a full URL at any level.
async function arcgisServices(root, folder) {
  const base = `${root}/rest/services${folder ? "/" + folder : ""}`;
  try {
    const r = await get(base + "?f=json", { timeoutMs: 20000 });
    const j = r.json();
    if (!j) return { folders: [], services: [], error: `HTTP ${r.status} (non-JSON)` };
    if (j.error) return { folders: [], services: [], error: clip(j.error.message || j.error, 120) };
    return {
      folders: Array.isArray(j.folders) ? j.folders : [],
      services: (Array.isArray(j.services) ? j.services : []).map((s) => ({
        name: s.name,
        type: s.type,
        url: `${root}/rest/services/${s.name}/${s.type}`,
      })),
      error: null,
    };
  } catch (e) {
    return { folders: [], services: [], error: String((e && e.message) || e) };
  }
}

// Walk a whole ArcGIS root (root + every folder, capped) collecting services
// whose name matches `re`. NOAA moves services between folders without notice,
// so nothing here may assume a folder name.
async function arcgisScan(root, re, maxFolders = 24) {
  const out = { root, folders: [], scanned: [], serviceCount: 0, matches: [], errors: [] };
  const top = await arcgisServices(root, "");
  if (top.error) {
    out.errors.push(`(root): ${top.error}`);
    return out;
  }
  out.folders = top.folders;
  out.serviceCount += top.services.length;
  for (const s of top.services) if (re.test(s.name)) out.matches.push(s);
  for (const f of top.folders.slice(0, maxFolders)) {
    const r = await arcgisServices(root, f);
    out.scanned.push(f);
    if (r.error) { out.errors.push(`${f}: ${r.error}`); continue; }
    out.serviceCount += r.services.length;
    for (const s of r.services) if (re.test(s.name)) out.matches.push(s);
  }
  return out;
}

// Layer catalog for one discovered MapServer (ids are hints only — see spc.js).
async function arcgisLayers(serviceUrl) {
  try {
    const r = await get(serviceUrl + "/layers?f=json", { timeoutMs: 20000 });
    const j = r.json();
    if (!j || j.error) return { error: j && j.error ? clip(j.error.message || j.error, 120) : `HTTP ${r.status}` };
    const layers = {};
    for (const l of j.layers || []) layers[l.id] = l.name;
    return { count: (j.layers || []).length, layers };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------

// 1. SPC convective outlooks MapServer — CORS + layer catalog
await check("spc-outlooks-layers", async () => {
  const res = await fetch(
    "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer/layers?f=json",
    { headers: { Origin: ORIGIN } }
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(acao(res), "no access-control-allow-origin header");
  const j = await res.json();
  assert(Array.isArray(j.layers), "no layers array in response");
  const layerMap = {};
  for (const l of j.layers) layerMap[l.id] = l.name;
  return { acao: acao(res), layerCount: j.layers.length, layers: layerMap };
});

// 2. NHC tropical weather summary MapServer — CORS + service metadata
await check("nhc-tropical-summary-mapserver", async () => {
  const res = await fetch(
    "https://mapservices.weather.noaa.gov/vector/rest/services/tropical/NHC_tropical_weather_summary/MapServer?f=json",
    { headers: { Origin: ORIGIN } }
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(acao(res), "no access-control-allow-origin header");
  const j = await res.json();
  assert(!j.error, `service error: ${JSON.stringify(j.error)}`);
  return { acao: acao(res), mapName: j.mapName, layerCount: (j.layers || []).length };
});

// 3. NWS active alerts by point — no custom User-Agent, CORS, geometry census
await check("nws-alerts-active-point", async () => {
  const res = await fetch("https://api.weather.gov/alerts/active?point=41.7300,-93.6000", {
    headers: { Origin: ORIGIN },
  });
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(acao(res), "no access-control-allow-origin header");
  const j = await res.json();
  assert(Array.isArray(j.features), "no features array");
  const sample = j.features.slice(0, 20);
  const nullGeom = sample.filter((f) => f.geometry == null).length;
  const detail = {
    acao: acao(res),
    features: j.features.length,
    sampled: sample.length,
    nullGeometryFraction: sample.length ? +(nullGeom / sample.length).toFixed(2) : null,
  };
  const withZones = sample.find(
    (f) => f.properties && Array.isArray(f.properties.affectedZones) && f.properties.affectedZones.length
  );
  if (withZones) {
    const zres = await fetch(withZones.properties.affectedZones[0], { headers: { Origin: ORIGIN } });
    assert(zres.status === 200, `zone fetch HTTP ${zres.status}`);
    const z = await zres.json();
    assert(z.geometry != null, "zone response has no geometry");
    detail.zoneGeometry = z.geometry.type;
  } else {
    detail.zoneGeometry = "no alerts with affectedZones to sample";
  }
  return detail;
});

// 4. NHC CurrentStorms.json — record CORS posture (absence expected, not a failure)
await check("nhc-current-storms-cors", async () => {
  const res = await fetch("https://nhc.noaa.gov/CurrentStorms.json", {
    headers: { Origin: ORIGIN },
    redirect: "follow",
  });
  return {
    status: res.status,
    acaoPresent: Boolean(acao(res)),
    acao: acao(res) || "(absent — expected; needs a proxy or server-side fetch)",
  };
});

// 5. Open-Meteo ensemble (GFS 0.25°) — availability + payload size
await check("open-meteo-ensemble-gfs025", async () => {
  const res = await fetch(
    "https://ensemble-api.open-meteo.com/v1/ensemble?latitude=41.73&longitude=-93.6&hourly=temperature_2m&models=gfs025&forecast_days=7"
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = buf.byteLength;
  const warn = bytes > 3 * 1024 * 1024;
  if (warn) console.warn(`  warning: ensemble payload is ${(bytes / 1048576).toFixed(1)} MB (>3MB)`);
  return { bytes, megabytes: +(bytes / 1048576).toFixed(2), over3MB: warn };
});

// 6. Open-Meteo air quality pollen — are CONUS values all null?
await check("open-meteo-pollen-conus", async () => {
  const points = [
    { name: "Ankeny IA", lat: 41.73, lon: -93.6 },
    { name: "Denver CO", lat: 39.74, lon: -104.99 },
    { name: "Atlanta GA", lat: 33.75, lon: -84.39 },
  ];
  const perPoint = {};
  let anyValue = false;
  for (const p of points) {
    const res = await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat}&longitude=${p.lon}&hourly=birch_pollen,grass_pollen,ragweed_pollen`
    );
    assert(res.status === 200, `${p.name}: HTTP ${res.status}`);
    const j = await res.json();
    const h = j.hourly || {};
    const vals = [
      ...(h.birch_pollen || []),
      ...(h.grass_pollen || []),
      ...(h.ragweed_pollen || []),
    ];
    const nonNull = vals.filter((v) => v != null).length;
    if (nonNull > 0) anyValue = true;
    perPoint[p.name] = { values: vals.length, nonNull };
  }
  return { allValuesNull: !anyValue, perPoint };
});

// 7. NOHRSC snow analysis export — must return an image
//    (this hardcoded obs/ URL now 404s — check 12 rediscovers the service)
await check("nohrsc-snow-export-image", async () => {
  const res = await fetch(
    "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/export" +
      "?f=image&bbox=-94.0,41.4,-93.2,42.0&bboxSR=4326&imageSR=4326&size=128,96&format=png&transparent=true",
    { headers: { Origin: ORIGIN } }
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  assert(ct.startsWith("image/"), `content-type is ${ct}, expected image/*`);
  const buf = await res.arrayBuffer();
  return { contentType: ct, bytes: buf.byteLength, acaoPresent: Boolean(acao(res)) };
});

// 8. NWPS gauges API — record CORS posture on a known gauge
await check("nwps-gauge-desi4-cors", async () => {
  const res = await fetch("https://api.water.noaa.gov/nwps/v1/gauges/DESI4", {
    headers: { Origin: ORIGIN },
  });
  return {
    status: res.status,
    acaoPresent: Boolean(acao(res)),
    acao: acao(res) || "(absent)",
  };
});

// 9. USGS instantaneous values — 200 + CORS
await check("usgs-iv-gauge-height", async () => {
  const res = await fetch(
    "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=05481950&parameterCd=00065&siteStatus=all",
    { headers: { Origin: ORIGIN } }
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(acao(res), "no access-control-allow-origin header");
  const j = await res.json();
  const series = j.value && Array.isArray(j.value.timeSeries) ? j.value.timeSeries.length : 0;
  return { acao: acao(res), timeSeries: series };
});

// 10. Open-Meteo NBM model — accepted (200) or rejected (400)?
await check("open-meteo-nbm-model", async () => {
  const res = await fetch(
    "https://api.open-meteo.com/v1/forecast?latitude=41.73&longitude=-93.6&hourly=temperature_2m&models=ncep_nbm_conus"
  );
  const body = await res.text();
  let reason = "";
  if (res.status !== 200) {
    try { reason = JSON.parse(body).reason || ""; } catch { /* ignore */ }
  }
  return { status: res.status, nbmAccepted: res.status === 200, reason };
});

// 11. ERA5 archive (M5 almanac) — CORS, how far back start_date goes, and the
//     real byte cost of a 10-year daily chunk so chunking can be sized.
await check("era5-archive-almanac", async () => {
  const BASE = "https://archive-api.open-meteo.com/v1/archive";
  const PT = "latitude=41.73&longitude=-93.6";
  const detail = {};

  // (a) how far back does start_date go? 1939 is expected to be rejected.
  const ladder = {};
  for (const start of ["1939-01-01", "1940-01-01", "1950-01-01", "1979-01-01"]) {
    try {
      const end = start.slice(0, 4) + "-01-05";
      const r = await get(
        `${BASE}?${PT}&start_date=${start}&end_date=${end}&daily=temperature_2m_max&timezone=UTC`
      );
      const j = r.json();
      const days = j && j.daily && Array.isArray(j.daily.time) ? j.daily.time.length : 0;
      const vals = j && j.daily && Array.isArray(j.daily.temperature_2m_max)
        ? j.daily.temperature_2m_max.filter((v) => v != null).length
        : 0;
      ladder[start] = {
        status: r.status,
        days,
        nonNull: vals,
        reason: r.status === 200 ? "" : clip((j && j.reason) || r.text, 140),
      };
    } catch (e) {
      ladder[start] = { status: null, error: String((e && e.message) || e) };
    }
  }
  detail.startDateLadder = ladder;
  detail.earliestAccepted =
    Object.keys(ladder).find((s) => ladder[s].status === 200 && ladder[s].nonNull > 0) || null;

  // (b) the realistic almanac chunk: 10 years of daily max/min for one point.
  const start = "2015-01-01";
  const end = "2024-12-31";
  const chunkUrl =
    `${BASE}?${PT}&start_date=${start}&end_date=${end}` +
    "&daily=temperature_2m_max,temperature_2m_min&timezone=America%2FChicago";
  const c = await get(chunkUrl, { timeoutMs: 90000 });
  detail.acao = c.acao || "(absent)";
  detail.acaoPresent = Boolean(c.acao);
  const ctx = `earliestAccepted=${detail.earliestAccepted}`;
  assert(c.status === 200, `10-year chunk HTTP ${c.status} (${ctx}): ${clip(c.text, 140)}`);
  const cj = c.json();
  assert(cj && cj.daily && Array.isArray(cj.daily.time), `no daily.time in 10-year response (${ctx})`);
  const days = cj.daily.time.length;
  const tmax = Array.isArray(cj.daily.temperature_2m_max) ? cj.daily.temperature_2m_max : [];
  const tmin = Array.isArray(cj.daily.temperature_2m_min) ? cj.daily.temperature_2m_min : [];
  detail.tenYearChunk = {
    span: `${start}..${end}`,
    days,
    bytes: c.bytes,
    kilobytes: +(c.bytes / 1024).toFixed(1),
    bytesPerDay: +(c.bytes / Math.max(days, 1)).toFixed(1),
    wireBytes: c.contentLength,
    tmaxNull: tmax.filter((v) => v == null).length,
    tminNull: tmin.filter((v) => v == null).length,
    units: cj.daily_units || null,
    url: chunkUrl,
  };

  // (c) how current is the archive? (ERA5 lags; an almanac must not promise today)
  try {
    const rEnd = isoDay(0);
    const r = await get(
      `${BASE}?${PT}&start_date=${isoDay(-35)}&end_date=${rEnd}&daily=temperature_2m_max&timezone=UTC`
    );
    const j = r.json();
    let lastDay = null;
    if (j && j.daily && Array.isArray(j.daily.time)) {
      for (let i = j.daily.time.length - 1; i >= 0; i--) {
        if (j.daily.temperature_2m_max[i] != null) { lastDay = j.daily.time[i]; break; }
      }
    }
    detail.recency = {
      status: r.status,
      requestedThrough: rEnd,
      lastNonNullDay: lastDay,
      lagDays: lastDay ? Math.round((Date.parse(rEnd) - Date.parse(lastDay)) / 86400000) : null,
    };
  } catch (e) {
    detail.recency = { error: String((e && e.message) || e) };
  }

  return detail;
});

// 12. NOHRSC snow analysis REDISCOVERY (M6). The hardcoded obs/ URL 404s, so
//     walk the service directory and report every snow/ice-looking service.
//     Discovery only — nothing here asserts a service name.
await check("nohrsc-snow-rediscovery", async () => {
  const HOST = "https://mapservices.weather.noaa.gov";
  const SNOWY = /snow|nohrsc|sno_|swe|ice|sfav/i;
  const detail = {};

  // what the shipped URL does now
  try {
    const legacy = await get(`${HOST}/raster/rest/services/obs/NOHRSC_Snow_Analysis/MapServer?f=json`);
    const lj = legacy.json();
    detail.legacyHardcodedUrl = {
      url: `${HOST}/raster/rest/services/obs/NOHRSC_Snow_Analysis/MapServer`,
      status: legacy.status,
      error: lj && lj.error ? clip(lj.error.message || lj.error, 140) : null,
    };
  } catch (e) {
    detail.legacyHardcodedUrl = { error: String((e && e.message) || e) };
  }

  const scans = [];
  const raster = await arcgisScan(`${HOST}/raster`, SNOWY);
  scans.push(raster);
  assert(
    !raster.errors.some((x) => x.startsWith("(root)")),
    `raster root unreachable: ${clip(raster.errors, 140)} (legacy url: ${clip(detail.legacyHardcodedUrl, 120)})`
  );
  if (!raster.matches.length) scans.push(await arcgisScan(`${HOST}/vector`, SNOWY));

  const candidates = [];
  for (const s of scans) {
    detail[s.root.endsWith("/raster") ? "rasterRoot" : "vectorRoot"] = {
      folders: s.folders,
      scanned: s.scanned,
      serviceCount: s.serviceCount,
      errors: s.errors.slice(0, 8),
    };
    for (const m of s.matches) candidates.push(m);
  }
  detail.candidates = candidates;
  detail.candidateCount = candidates.length;

  // best guess: an explicit NOHRSC service, else the first snow-ish one
  const best =
    candidates.find((c) => /nohrsc/i.test(c.name)) ||
    candidates.find((c) => /snow_analysis/i.test(c.name)) ||
    candidates[0] ||
    null;
  detail.bestCandidate = best;

  if (best) {
    if (best.type === "MapServer") detail.bestCandidateLayers = await arcgisLayers(best.url);
    const op = best.type === "ImageServer" ? "exportImage" : "export";
    const img = await getBin(
      `${best.url}/${op}?f=image&bbox=-97.0,40.0,-90.0,44.0&bboxSR=4326&imageSR=4326` +
        "&size=256,192&format=png&transparent=true",
      { timeoutMs: 45000 }
    );
    detail.exportProbe = {
      op,
      status: img.status,
      contentType: img.contentType,
      bytes: img.bytes,
      isImage: img.contentType.startsWith("image/"),
      acaoPresent: Boolean(img.acao),
      url: img.url,
    };
  } else {
    detail.exportProbe = "no snow/ice-looking service found to probe";
  }
  return detail;
});

// 13. NWS gridpoints (M6 winter) — are snowfallAmount / iceAccumulation there,
//     in what units, how many values, and what does a validTime look like?
await check("nws-gridpoints-winter-fields", async () => {
  const p = await get("https://api.weather.gov/points/41.7300,-93.6000");
  assert(p.status === 200, `points HTTP ${p.status}`);
  const pj = p.json();
  const props = (pj && pj.properties) || {};
  const gridUrl = props.forecastGridData;
  assert(gridUrl, "no properties.forecastGridData on the points response");

  const g = await get(gridUrl, { timeoutMs: 60000 });
  assert(g.status === 200, `gridpoints HTTP ${g.status}`);
  const gj = g.json();
  const gp = (gj && gj.properties) || {};

  const describe = (name) => {
    const f = gp[name];
    if (!f) return { present: false };
    const values = Array.isArray(f.values) ? f.values : [];
    const nonNull = values.filter((v) => v && v.value != null);
    const nonZero = nonNull.filter((v) => typeof v.value === "number" && v.value > 0);
    return {
      present: true,
      uom: f.uom || null,
      values: values.length,
      nonNull: nonNull.length,
      nonZero: nonZero.length,
      // verbatim — the ISO8601 interval suffix (…/PT6H) is the part that matters
      sampleValidTime: values.length ? String(values[0].validTime) : null,
      sampleValue: values.length ? values[0].value : null,
      sampleNonZeroValidTime: nonZero.length ? String(nonZero[0].validTime) : null,
      sampleNonZeroValue: nonZero.length ? nonZero[0].value : null,
    };
  };

  return {
    acao: g.acao || "(absent)",
    gridId: props.gridId,
    gridX: props.gridX,
    gridY: props.gridY,
    gridUrl,
    bytes: g.bytes,
    wireBytes: g.contentLength,
    updateTime: gp.updateTime || null,
    validTimesFormat: "<ISO8601 start>/<ISO8601 duration>, one interval per value",
    snowfallAmount: describe("snowfallAmount"),
    iceAccumulation: describe("iceAccumulation"),
    snowLevel: describe("snowLevel"),
    snowIceFields: Object.keys(gp).filter((k) => /snow|ice|freez/i.test(k)),
  };
});

// 14. IEM GOES tiles (M6). IEM documents its TMS layers as
//     goes_<bird>_<sector>_ch<NN> (bird east|west; sector fulldisk|conus|
//     alaska|mesoscale-1|mesoscale-2|puertorico; channel 01-16, zero padded)
//     under two cache prefixes: /cache/ (5 min) and /c/ (14 day). GEOCOLOR is
//     not an ABI channel, so it may simply not exist — probe aliases and report
//     which template actually returned an image.
await check("iem-goes-tile-channels", async () => {
  const PREFIXES = [
    "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/",
    "https://mesonet.agron.iastate.edu/c/tile.py/1.0.0/",
  ];
  const t = tileXY(-93.6, 41.73, 5);   // CONUS tile over central Iowa
  // kind:"exact" = really is that product; kind:"alias" = an older IEM layer
  // that is NOT the same imagery (a vis/IR composite), recorded separately so
  // the report never claims GeoColor when it actually served channel 2.
  const CANDIDATES = {
    GEOCOLOR: [
      { layer: "goes_east_conus_geocolor", kind: "exact" },
      { layer: "goes_east_conus_truecolor", kind: "exact" },
      { layer: "goes-east-vis-1km", kind: "alias", note: "legacy visible composite, not GeoColor" },
    ],
    CH13: [
      { layer: "goes_east_conus_ch13", kind: "exact" },
      { layer: "goes-east-ir-4km", kind: "alias", note: "legacy 4km IR composite" },
    ],
    CH02: [
      { layer: "goes_east_conus_ch02", kind: "exact" },
      { layer: "goes-east-vis-1km", kind: "alias", note: "legacy 1km visible composite" },
    ],
  };

  const perChannel = {};
  const workingTemplates = {};
  for (const [chan, cands] of Object.entries(CANDIDATES)) {
    const attempts = [];
    let exact = null;
    let alias = null;
    for (const prefix of PREFIXES) {
      if (exact) break;
      for (const c of cands) {
        if (exact) break;
        if (c.kind === "alias" && alias) continue;
        const url = `${prefix}${c.layer}/${t.z}/${t.x}/${t.y}.png`;
        try {
          const r = await getBin(url, { timeoutMs: 20000 });
          const isImage = r.status === 200 && r.contentType.startsWith("image/") && r.bytes > 0;
          attempts.push({
            layer: c.layer,
            kind: c.kind,
            prefix,
            status: r.status,
            contentType: r.contentType,
            bytes: r.bytes,
            // a tile cache answers 200 with a tiny transparent PNG for no data
            likelyBlank: isImage && r.bytes < 500,
            acaoPresent: Boolean(r.acao),
          });
          if (isImage) {
            const win = {
              template: `${prefix}${c.layer}/{z}/{x}/{y}.png`,
              bytes: r.bytes,
              contentType: r.contentType,
              note: c.note || null,
            };
            if (c.kind === "exact") exact = win;
            else if (!alias) alias = win;
          }
        } catch (e) {
          attempts.push({ layer: c.layer, kind: c.kind, prefix, error: String((e && e.message) || e) });
        }
      }
    }
    perChannel[chan] = { attempts, working: exact, aliasFallback: alias };
    workingTemplates[chan] = exact ? exact.template : null;
  }

  return {
    tile: t,
    tileNote: "z/x/y computed from 41.73,-93.6 (Web Mercator, 256px tiles)",
    layerTemplate: "goes_<east|west>_<fulldisk|conus|alaska|mesoscale-1|mesoscale-2|puertorico>_ch<01-16>",
    prefixes: { live: PREFIXES[0], archived14d: PREFIXES[1] },
    workingTemplates,
    perChannel,
  };
});

// 15. Open-Meteo pressure levels (M7 soundings-lite) — is a multi-level request
//     accepted, which variables come back, and how big is the payload?
await check("open-meteo-pressure-levels", async () => {
  const levels = [1000, 925, 850, 700, 500, 300];
  const fields = ["temperature", "relative_humidity", "wind_speed", "wind_direction", "geopotential_height"];
  const wanted = [];
  for (const l of levels) for (const f of fields) wanted.push(`${f}_${l}hPa`);
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=41.73&longitude=-93.6" +
    `&hourly=${wanted.join(",")}&forecast_days=2&timezone=UTC`;

  const r = await get(url, { timeoutMs: 60000 });
  const j = r.json();
  if (r.status !== 200) {
    // Open-Meteo rejects the whole request over one bad name — bisect by field
    // family at 500 hPa so the report says which one is unsupported.
    const perField = {};
    for (const f of fields) {
      try {
        const one = await get(
          "https://api.open-meteo.com/v1/forecast?latitude=41.73&longitude=-93.6" +
            `&hourly=${f}_500hPa&forecast_days=1&timezone=UTC`
        );
        const oj = one.json();
        perField[f] = {
          status: one.status,
          reason: one.status === 200 ? "" : clip((oj && oj.reason) || one.text, 140),
        };
      } catch (e) {
        perField[f] = { error: String((e && e.message) || e) };
      }
    }
    return {
      accepted: false,
      status: r.status,
      reason: clip((j && j.reason) || r.text, 200),
      requested: wanted.length,
      perFieldAt500hPa: perField,
      url,
    };
  }
  const hourly = (j && j.hourly) || {};
  const returned = wanted.filter((k) => Array.isArray(hourly[k]));
  const missing = wanted.filter((k) => !Array.isArray(hourly[k]));
  const allNull = returned.filter((k) => hourly[k].every((v) => v == null));
  return {
    accepted: true,
    status: r.status,
    acao: r.acao || "(absent)",
    levels,
    requested: wanted.length,
    returned: returned.length,
    missing,
    allNullVariables: allNull,
    hours: Array.isArray(hourly.time) ? hourly.time.length : 0,
    bytes: r.bytes,
    kilobytes: +(r.bytes / 1024).toFixed(1),
    wireBytes: r.contentLength,
    // one level's worth of units is enough to size the sounding board
    sampleUnitsAt850: Object.fromEntries(
      fields.map((f) => [f, (j && j.hourly_units && j.hourly_units[`${f}_850hPa`]) || null])
    ),
    url,
  };
});

// 16. NWPS flood categories (M7) — are action/minor/moderate/major stages in
//     the gauge payload, and under which JSON path? Also probe bbox gauge
//     discovery so the app can find a gauge near a location.
await check("nwps-flood-categories", async () => {
  const BASE = "https://api.water.noaa.gov/nwps/v1/gauges";
  const CAT = /^(action|minor|moderate|major)$/i;
  const detail = {};

  const readGauge = async (id) => {
    const r = await get(`${BASE}/${id}`, { timeoutMs: 30000 });
    const j = r.json();
    const hits = j ? findKeyNodes(j, CAT) : [];
    const containers = [...new Set(hits.map((h) => h.containerPath))];
    return {
      gaugeId: id,
      status: r.status,
      acao: r.acao || "(absent)",
      acaoPresent: Boolean(r.acao),
      bytes: r.bytes,
      topLevelKeys: j ? Object.keys(j).slice(0, 30) : null,
      categoryPaths: hits.map((h) => h.path),
      categoryContainerPaths: containers,
      categorySample: hits.length ? clip(hits[0].container, 500) : null,
      hasFloodCategories: hits.length > 0,
    };
  };

  detail.primary = await readGauge("DESI4");

  // bbox discovery — never asserted, the parameter names are the unknown here
  try {
    const q =
      "?bbox.xmin=-93.9&bbox.ymin=41.5&bbox.xmax=-93.3&bbox.ymax=42.0" +
      "&srid=EPSG_4326";
    const r = await get(BASE + q, { timeoutMs: 30000 });
    const j = r.json();
    const list = j && Array.isArray(j.gauges) ? j.gauges : Array.isArray(j) ? j : [];
    detail.bboxDiscovery = {
      url: BASE + q,
      status: r.status,
      acaoPresent: Boolean(r.acao),
      bytes: r.bytes,
      count: list.length,
      topLevelKeys: j && !Array.isArray(j) ? Object.keys(j).slice(0, 20) : null,
      sampleIds: list.slice(0, 8).map((g) => g && (g.lid || g.id || g.gaugeId)).filter(Boolean),
      body: r.status === 200 ? null : clip(r.text, 200),
    };
    // if DESI4 carried no categories, try a gauge the bbox query found
    if (!detail.primary.hasFloodCategories) {
      const alt = detail.bboxDiscovery.sampleIds[0];
      if (alt) detail.secondary = await readGauge(alt);
    }
  } catch (e) {
    detail.bboxDiscovery = { error: String((e && e.message) || e) };
  }

  return detail;
});

// 17. USGS gauge DISCOVERY by bounding box (M7) — so a location can find its
//     own gauges instead of shipping a hardcoded site id.
await check("usgs-sites-bbox-discovery", async () => {
  const LAT = 41.73;
  const LON = -93.6;
  const attempts = [];
  for (const d of [0.2, 0.5, 1.0]) {
    // USGS bBox order is west,south,east,north
    const bbox = [(LON - d).toFixed(4), (LAT - d).toFixed(4), (LON + d).toFixed(4), (LAT + d).toFixed(4)].join(",");
    const url =
      "https://waterservices.usgs.gov/nwis/iv/?format=json" +
      `&bBox=${bbox}&parameterCd=00065,00060&siteStatus=active`;
    try {
      const r = await get(url, { timeoutMs: 45000 });
      const j = r.json();
      const series = j && j.value && Array.isArray(j.value.timeSeries) ? j.value.timeSeries : [];
      const sites = new Map();
      for (const s of series) {
        const si = s.sourceInfo || {};
        const code = si.siteCode && si.siteCode[0] ? si.siteCode[0].value : null;
        if (!code) continue;
        if (!sites.has(code)) sites.set(code, { name: si.siteName || null, params: [] });
        const pc = s.variable && s.variable.variableCode && s.variable.variableCode[0]
          ? s.variable.variableCode[0].value
          : null;
        if (pc) sites.get(code).params.push(pc);
      }
      attempts.push({
        degrees: d,
        bbox,
        status: r.status,
        acao: r.acao || "(absent)",
        bytes: r.bytes,
        wireBytes: r.contentLength,
        timeSeries: series.length,
        sites: sites.size,
        sample: [...sites.entries()].slice(0, 5).map(([code, v]) => ({ code, name: v.name, params: v.params })),
        body: r.status === 200 ? null : clip(r.text, 200),
      });
    } catch (e) {
      attempts.push({ degrees: d, bbox, error: String((e && e.message) || e) });
    }
  }
  const detail = {
    point: { lat: LAT, lon: LON },
    attempts,
    smallestBboxWithSites: (attempts.find((a) => a.sites > 0) || {}).degrees ?? null,
  };

  // secondary candidate: the newer USGS OGC API (recorded, never asserted)
  try {
    const url =
      "https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items" +
      "?bbox=-93.8,41.53,-93.4,41.93&limit=50&f=json";
    const r = await get(url, { timeoutMs: 45000 });
    const j = r.json();
    detail.ogcApiCandidate = {
      url,
      status: r.status,
      acaoPresent: Boolean(r.acao),
      bytes: r.bytes,
      count: j && Array.isArray(j.features) ? j.features.length : (j && j.numberReturned) || 0,
      body: r.status === 200 ? null : clip(r.text, 200),
    };
  } catch (e) {
    detail.ogcApiCandidate = { error: String((e && e.message) || e) };
  }

  return detail;
});

// 18. WPC probabilistic winter guidance DISCOVERY (M6) — does such a service
//     exist on mapservices.weather.noaa.gov, and under which root/folder?
//     Discovery only: report the catalog, assert nothing about a name.
await check("wpc-winter-guidance-discovery", async () => {
  const HOST = "https://mapservices.weather.noaa.gov";
  const WINTER = /wpc|winter|wssi|snow|ice|prob/i;
  const roots = ["vector", "experimental", "raster"];
  const detail = { roots: {}, matches: [] };
  let anyRootOk = false;

  for (const root of roots) {
    const s = await arcgisScan(`${HOST}/${root}`, WINTER);
    const rootFailed = s.errors.some((x) => x.startsWith("(root)"));
    if (!rootFailed) anyRootOk = true;
    detail.roots[root] = {
      reachable: !rootFailed,
      folders: s.folders,
      scanned: s.scanned,
      serviceCount: s.serviceCount,
      matchCount: s.matches.length,
      errors: s.errors.slice(0, 8),
    };
    for (const m of s.matches) detail.matches.push({ root, ...m });
  }
  assert(anyRootOk, `no mapservices root listed: ${clip(detail.roots, 200)}`);
  detail.matchCount = detail.matches.length;

  // the probabilistic-winter-precip flavor specifically, if one turned up
  const best =
    detail.matches.find((m) => /prob.*winter|winter.*prob/i.test(m.name)) ||
    detail.matches.find((m) => /wssi/i.test(m.name)) ||
    null;
  detail.bestProbabilisticCandidate = best;
  if (best && best.type === "MapServer") detail.bestCandidateLayers = await arcgisLayers(best.url);
  return detail;
});

// ---------------------------------------------------------------------------
// summary

const pad = (s, n) => String(s).padEnd(n);
const wId = Math.max(...results.map((r) => r.id.length), 2) + 2;
console.log("\n" + pad("CHECK", wId) + pad("OK", 6) + "DETAIL");
console.log("-".repeat(wId + 6 + 60));
for (const r of results) {
  const detail = typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail);
  console.log(pad(r.id, wId) + pad(r.ok ? "yes" : "NO", 6) + detail.slice(0, 160));
}
const failures = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failures}/${results.length} checks ok (advisory — exit 0 regardless)`);

const { writeFileSync } = await import("node:fs");
writeFileSync(
  "endpoint-results.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), origin: ORIGIN, results }, null, 2) + "\n"
);
console.log("wrote endpoint-results.json");

process.exit(0);
