// Shared helpers for the SKYWATCH smoke suite.
//
// routeAll(page, opts): intercepts every request. localhost passes through to
// the static server; every known external feed is answered from fixtures; any
// other external domain is blocked. The suite therefore never touches the
// live network and is fully deterministic.
//
//   opts.alerts — body served for api.weather.gov/alerts/active.
//                 Defaults to ALERTS_ACTIVE; pass ALERTS_EMPTY (or any JSON
//                 string) to exercise the no-alerts paths. This is the
//                 supported per-test override; a test may also register its
//                 own page.route() AFTER routeAll, since Playwright checks
//                 the most recently added handler first (see xss.spec.js).
//   opts.gridpoints — body served for api.weather.gov/gridpoints/{WFO}/{x},{y}
//                 (M6 winter hazards). Defaults to NWS_GRIDPOINTS, which
//                 carries non-zero snow and ice in millimetres; pass
//                 NWS_GRIDPOINTS_NONE for the confirmed-zero case.
//
// boot(page, {localStorage}): seeds localStorage (default: a saved Ankeny, IA
// location under skywatch_loc) via addInitScript, starts a pageerror
// collector, and navigates to "/". Returns { errors }.
//
// Stubbed feeds: api.open-meteo.com, ensemble-api.open-meteo.com,
// air-quality-api.open-meteo.com, archive-api.open-meteo.com (era5Chunk(),
// M5 ALMANAC), api.weather.gov, api.zippopotam.us, mapservices.weather.noaa.gov,
// mesonet.agron.iastate.edu, *.basemaps.cartocdn.com, cdn.star.nesdis.noaa.gov.
"use strict";
const fs = require("fs");
const path = require("path");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const PWA = path.join(__dirname, "..", "..", "pwa");

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

const TILE_PNG = fixture("tile.png");
const OM_FORECAST = fixture("om-forecast.json").toString("utf8");
const NWS_POINTS = fixture("nws-points.json").toString("utf8");
const NWS_HOURLY = fixture("nws-hourly.json").toString("utf8");
const NWS_DAILY = fixture("nws-daily.json").toString("utf8");
const ZIPPO = fixture("zippo.json").toString("utf8");
const HOSTILE = JSON.parse(fixture("hostile-strings.json").toString("utf8"));

// severe weather (M2)
const ALERTS_ACTIVE = fixture("alerts-active.json").toString("utf8");
const ALERTS_EMPTY = fixture("alerts-empty.json").toString("utf8");
const ALERTS_ZONE = fixture("alerts-zone.json").toString("utf8");
const SPC_LAYERS = fixture("spc-layers.json").toString("utf8");
const SPC_OUTLOOK = fixture("spc-outlook.json").toString("utf8");
const TROPICAL_SERVICES = fixture("arcgis-tropical-services.json").toString("utf8");
// MAP alerts (viewport polygons drawn by alerts.js's syncLayer(), a different
// service — /eventdriven/ — from the /vector/ SPC outlook MapServer above,
// even though both live on mapservices.weather.noaa.gov).
const WWA_LAYERS = fixture("wwa-layers.json").toString("utf8");
const WWA_QUERY = fixture("wwa-query.json").toString("utf8");

// winter hazards (M6)
const NWS_GRIDPOINTS = fixture("nws-gridpoints.json").toString("utf8");
const NWS_GRIDPOINTS_NONE = fixture("nws-gridpoints-none.json").toString("utf8");
const NOHRSC_SERVICES = fixture("nohrsc-services.json").toString("utf8");
const NOHRSC_SNOW_FOLDER = fixture("nohrsc-snow-folder.json").toString("utf8");
const NOHRSC_OBS_FOLDER = fixture("nohrsc-obs-folder.json").toString("utf8");
const NOHRSC_LAYERS = fixture("nohrsc-layers.json").toString("utf8");
const NOHRSC_SERVICE = fixture("nohrsc-service.json").toString("utf8");
const WPC_WINTER_SERVICES = fixture("wpc-winter-services.json").toString("utf8");
const WPC_WINTER_PRECIP_FOLDER = fixture("wpc-winter-precip-folder.json").toString("utf8");
const WPC_WINTER_DECOY_FOLDER = fixture("wpc-winter-decoy-folder.json").toString("utf8");
const WPC_WINTER_LAYERS = fixture("wpc-winter-layers.json").toString("utf8");
const WPC_WINTER_QUERY = fixture("wpc-winter-query.json").toString("utf8");
const EMPTY_FOLDER = JSON.stringify({ currentVersion: 11.2, folders: [], services: [] });

// forecast depth + air quality (M3/M4)
//
// The CAST/AIR fixtures store their hourly/minutely_15/daily "time" arrays as
// offsets from a fixed ANCHOR (2030-01-01T00:00:00Z, matching om-forecast.json's
// own fixed-future convention) instead of real timestamps, because a static
// file can't know what day the suite will run on. anchoredFixture() re-parses
// the fixture on every request and shifts every "time" array by a delta that
// lands ANCHOR on the current hour, so the series always straddles the real
// Date.now() the page sees — which is what makes the NOW rule / future tint
// in charts.js exercise-able at all. Non-time fields are untouched.
const OM_ANCHOR = 1893456000; // 2030-01-01T00:00:00Z
function anchorDelta() {
  return Math.floor(Date.now() / 3600000) * 3600 - OM_ANCHOR;
}
function shiftTimeArray(arr, delta) {
  return arr.map((t) => (t == null ? t : t + delta));
}
function reanchor(obj, delta) {
  for (const key of ["hourly", "minutely_15", "daily"]) {
    const bucket = obj[key];
    if (bucket && Array.isArray(bucket.time)) bucket.time = shiftTimeArray(bucket.time, delta);
  }
  if (obj.current && typeof obj.current.time === "number") obj.current.time += delta;
  return obj;
}
function anchoredFixture(name) {
  const raw = JSON.parse(fixture(name).toString("utf8"));
  // fresh clone + shift per call so every request gets today's anchoring
  return () => JSON.stringify(reanchor(JSON.parse(JSON.stringify(raw)), anchorDelta()));
}
const OM_CAST = anchoredFixture("om-cast.json");
const OM_MODELS = anchoredFixture("om-models.json");
const OM_ENSEMBLE = anchoredFixture("om-ensemble.json");
const OM_AIR = anchoredFixture("om-air.json");

// ERA5 archive (M5 ALMANAC). A static fixture can't work here — the board
// asks for whatever calendar day the suite runs on — so this synthesizes the
// response from the request's own start_date/end_date, the same reasoning as
// anchoredFixture() above. seeded() is a deterministic integer hash in
// {-1,0,1} so a spec can reproduce the exact warmest/coldest year and rank
// independently, without reaching into this module's internals.
function seeded(year, doy) {
  const h = Math.abs(Math.sin(year * 374761393 + doy * 668265263) * 43758.5453) % 1;
  return Math.floor(h * 3) - 1;   // -1, 0, or 1
}
// The real archive answers 400 "out of allowed range" for a start_date before
// 1940-01-01 or an end_date past today — it does NOT clip the request. A stub
// that cheerfully serves any range hides exactly one class of bug, and did:
// the newest chunk asked through Dec 31 of the current year and the whole
// board failed with HTTP 400 in production while every test passed.
function era5OutOfRange(url) {
  const s = url.searchParams.get("start_date");
  const e = url.searchParams.get("end_date");
  const d = new Date();
  const today = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
                "-" + String(d.getDate()).padStart(2, "0");
  if (!s || !e) return "missing start_date or end_date";
  if (s < "1940-01-01") return "start_date " + s + " is out of allowed range from 1940-01-01 to " + today;
  if (e > today) return "end_date " + e + " is out of allowed range from 1940-01-01 to " + today;
  return null;
}

function era5Chunk(url) {
  const s = url.searchParams.get("start_date");
  const e = url.searchParams.get("end_date");
  const startMs = Date.parse(s + "T00:00:00Z");
  const endMs = Date.parse(e + "T00:00:00Z");
  const time = [], tmax = [], tmin = [];
  for (let t = startMs; t <= endMs; t += 86400000) {
    const dt = new Date(t);
    const y = dt.getUTCFullYear();
    const doy = Math.round((t - Date.UTC(y, 0, 1)) / 86400000) + 1;
    const seed = seeded(y, doy);
    const hi = 62 + 26 * Math.sin((2 * Math.PI * (doy - 105)) / 365) + (y - 1940) * 0.02 + 6 * seed;
    const lo = hi - 20 - 3 * seed;
    time.push(dt.toISOString().slice(0, 10));
    tmax.push(Math.round(hi * 10) / 10);
    tmin.push(Math.round(lo * 10) / 10);
  }
  return JSON.stringify({
    latitude: 41.75, longitude: -93.5, timezone: "America/Chicago", utc_offset_seconds: -21600,
    daily_units: { temperature_2m_max: "°F", temperature_2m_min: "°F" },
    daily: { time, temperature_2m_max: tmax, temperature_2m_min: tmin },
  });
}

// Leaflet, served from the PWA's vendor copy when present (post-refactor it
// is loaded same-origin anyway; pre-refactor the page pulls it from unpkg and
// we answer with the same files). Falls back to a stub that leaves window.L
// undefined — the app guards for that.
function vendorOr(rel, fallback) {
  const p = path.join(PWA, "vendor", rel);
  return fs.existsSync(p) ? fs.readFileSync(p) : Buffer.from(fallback);
}
const LEAFLET_JS = vendorOr(path.join("leaflet", "leaflet.js"), "/* leaflet unavailable in test */");
const LEAFLET_CSS = vendorOr(path.join("leaflet", "leaflet.css"), "/* leaflet css unavailable in test */");

const CORS = { "access-control-allow-origin": "*" };

function json(route, body, extra) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: Object.assign({}, CORS, extra || {}),
    body,
  });
}
function png(route) {
  return route.fulfill({
    status: 200,
    contentType: "image/png",
    headers: CORS,
    body: TILE_PNG,
  });
}

// ---------------------------------------------------------------------------
// M6 fixtures that REJECT malformed requests.
//
// The lesson these encode was paid for by the ERA5 stub, which synthesized a
// valid answer for any date range and so let the app ship asking the archive
// for future dates — green tests, HTTP 400 in production. A fixture that
// always says yes only ever tests one side of the conversation, so the ArcGIS
// and gridpoint stubs below refuse exactly what the real services refuse.

// ArcGIS answers a bad /export with an HTTP 400 and a JSON error body.
function arcgisFail(route, status, detail) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS,
    body: JSON.stringify({
      error: { code: status, message: "Unable to complete operation.", details: [detail] },
    }),
  });
}
// ArcGIS answers a bad /query with HTTP 200 and an {error} body — the shape
// that made spc.js's fetchGeo() check j.error in the first place.
function arcgisQueryFail(route, detail) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: CORS,
    body: JSON.stringify({
      error: { code: 400, message: "Unable to perform query.", details: [detail] },
    }),
  });
}
function needsJsonFormat(url) {
  return url.searchParams.get("f") === "json" ? null : "f=json is required for a directory read";
}
function badExport(url) {
  const q = url.searchParams;
  if (q.get("f") !== "image") return "f=image is required";
  const raw = q.get("bbox");
  if (!raw) return "bbox is required";
  const bbox = raw.split(",");
  if (bbox.length !== 4 || !bbox.every((v) => v !== "" && Number.isFinite(Number(v)))) {
    return "bbox must be 4 numbers: " + raw;
  }
  const [w, s, e, n] = bbox.map(Number);
  if (!(e > w) || !(n > s)) return "degenerate bbox: " + raw;
  if (!q.get("bboxSR")) return "bboxSR is required";
  const size = (q.get("size") || "").split(",");
  // ArcGIS wants bare integers here — "800px,600px" is NOT accepted
  if (size.length !== 2 || !size.every((v) => /^\d+$/.test(v) && Number(v) > 0)) {
    return "size must be <width>,<height> in pixels: " + q.get("size");
  }
  if (!q.get("format")) return "format is required";
  return null;
}
function badQuery(url) {
  const q = url.searchParams;
  if (!q.get("where")) return "where is required";
  if (q.get("f") !== "geojson") return "unsupported response format: " + q.get("f");
  return null;
}

// NOHRSC lives at raster/rest/services/snow/… today. The root listing does NOT
// contain it — NOAA moved it out of obs/ — so anything that finds it has
// walked the folders, which is the whole point of the fixture.
// NOTE on layers=show: nohrsc-layers.json records the live shape — two mosaic
// datasets published as GROUP layers (0 -> 1,2,3 Boundary/Footprint/Image, and
// 4 -> 5,6,7). ArcGIS does not error on a group-only show:0; it answers 200
// with a fully transparent image, which no stub can express in a 1x1 PNG. That
// case is therefore asserted on the REQUEST in winter.spec.js — the export must
// name the raster child — rather than on the response.
function rasterRoute(route, url) {
  const p = url.pathname;
  if (/\/MapServer\/export$/.test(p)) {
    const bad = badExport(url);
    return bad ? arcgisFail(route, 400, bad) : png(route);
  }
  const bad = needsJsonFormat(url);
  if (/\/MapServer\/layers$/.test(p)) return bad ? arcgisFail(route, 400, bad) : json(route, NOHRSC_LAYERS);
  if (/\/MapServer\/?$/.test(p)) return bad ? arcgisFail(route, 400, bad) : json(route, NOHRSC_SERVICE);
  if (/^\/raster\/rest\/services\/?$/.test(p)) {
    return bad ? arcgisFail(route, 400, bad) : json(route, NOHRSC_SERVICES);
  }
  const folder = /^\/raster\/rest\/services\/([^/]+)\/?$/.exec(p);
  if (folder) {
    if (bad) return arcgisFail(route, 400, bad);
    if (folder[1] === "snow") return json(route, NOHRSC_SNOW_FOLDER);
    if (folder[1] === "obs") return json(route, NOHRSC_OBS_FOLDER);
    return json(route, EMPTY_FOLDER);
  }
  return arcgisFail(route, 404, "unknown raster path " + p);
}

function wpcWinterRoute(route, url) {
  const p = url.pathname;
  if (/\/MapServer\/layers$/.test(p)) {
    const bad = needsJsonFormat(url);
    return bad ? arcgisFail(route, 400, bad) : json(route, WPC_WINTER_LAYERS);
  }
  if (/\/MapServer\/(\d+)\/query$/.test(p)) {
    const bad = badQuery(url);
    return bad ? arcgisQueryFail(route, bad) : json(route, WPC_WINTER_QUERY);
  }
  return json(route, "{}");
}

// ---------------------------------------------------------------------------
// M7 fixtures: Open-Meteo pressure levels, USGS gauges, NWPS flood categories.
// Same rule as the M6 block above — these REFUSE what the real services refuse.

// Open-Meteo's real accepted pressure levels. Asking for one that is not on
// this list is an HTTP 400, not a column of nulls, so a future edit that adds
// (say) 880 hPa to config.OM_LEVELS fails the suite instead of shipping.
const OM_PRESSURE_LEVELS = new Set([
  1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30,
]);
const OM_LEVEL_VARS = new Set(["temperature", "relative_humidity", "geopotential_height",
                               "wind_speed", "wind_direction", "cloud_cover", "vertical_velocity"]);
const OM_SURFACE_HOURLY = new Set(["boundary_layer_height", "temperature_2m",
                                   "relative_humidity_2m", "precipitation"]);

// [tempC, rhPct, geopotentialHeightM] per level, plus surface + PBL. Held as
// data rather than a JSON file because every hour of the response repeats the
// same profile: the app resolves "now" as an hourly index, and a value that
// changed hour to hour would make an assertion depend on when the suite ran.
//
// Elevation is 287 m throughout, so the 1000 hPa level (110 m) is UNDERGROUND
// at this point and must be dropped — the normal case at any inland location.
const PROFILE_KINDS = {
  // freezing level aloft between 850 and 700 hPa, one mid-level cloud deck
  base: { elevation: 287, t2m: 20, rh2m: 60, pbl: 1200, levels: {
    1000: [21, 62, 110], 925: [15, 55, 800], 850: [10, 85, 1500],
    700: [-2, 88, 3100], 500: [-20, 40, 5700], 300: [-50, 20, 9300] } },
  // temperature RISES with height off the surface: the freezing level above it
  // must refuse to interpolate
  inversion: { elevation: 287, t2m: 1, rh2m: 90, pbl: 300, levels: {
    1000: [2, 92, 110], 925: [4, 95, 800], 850: [2, 80, 1500],
    700: [-5, 50, 3100], 500: [-22, 30, 5700], 300: [-52, 15, 9300] } },
  // sub-freezing surface under a warm layer aloft: sleet vs freezing rain, which
  // six levels cannot resolve
  warmnose: { elevation: 287, t2m: -3, rh2m: 88, pbl: 250, levels: {
    1000: [-2, 90, 110], 925: [2, 92, 800], 850: [1, 85, 1500],
    700: [-6, 60, 3100], 500: [-24, 35, 5700], 300: [-54, 18, 9300] } },
  // cold all the way up
  snow: { elevation: 287, t2m: -8, rh2m: 85, pbl: 400, levels: {
    1000: [-7, 88, 110], 925: [-10, 90, 800], 850: [-13, 92, 1500],
    700: [-20, 70, 3100], 500: [-35, 40, 5700], 300: [-58, 20, 9300] } },
  // RH missing at every level AND at the surface — the cloud-layer feature has
  // to say so rather than render an empty box
  norh: { elevation: 287, t2m: 20, rh2m: null, pbl: 1200, levels: {
    1000: [21, null, 110], 925: [15, null, 800], 850: [10, null, 1500],
    700: [-2, null, 3100], 500: [-20, null, 5700], 300: [-50, null, 9300] } },
  // the model returns no boundary layer height for this point
  nopbl: { elevation: 287, t2m: 20, rh2m: 60, pbl: null, levels: {
    1000: [21, 62, 110], 925: [15, 55, 800], 850: [10, 85, 1500],
    700: [-2, 88, 3100], 500: [-20, 40, 5700], 300: [-50, 20, 9300] } },
  // The warmnose column served with NO elevation key, which is the case the
  // module's own comment anticipates. The ground anchor cannot be built, so the
  // lowest point is the 1000 hPa level at 110 m — and nothing may call that
  // "the surface": at -2°C under +2°C aloft it would read as plain rain.
  noelev: { elevation: null, t2m: -3, rh2m: 88, pbl: 250, levels: {
    1000: [-2, 90, 110], 925: [2, 92, 800], 850: [1, 85, 1500],
    700: [-6, 60, 3100], 500: [-24, 35, 5700], 300: [-54, 18, 9300] } },
  // An ordinary clear summer night: the 2 m temperature is radiationally
  // cooled below 925 hPa, so temperature rises with height off the ground in
  // air nowhere near freezing, and the 2 m humidity is 93% with a bone-dry
  // column above it. Neither fact may touch the freezing level or the clouds —
  // this shape occurs on most clear nights across the CONUS.
  nocturnal: { elevation: 250, t2m: 18, rh2m: 93, pbl: 200, levels: {
    1000: [19, 70, 110], 925: [20.5, 55, 790], 850: [17, 50, 1500],
    700: [7, 45, 3100], 500: [-6, 40, 5800], 300: [-45, 20, 9300] } },
  // Every sampled level is below freezing, but the warmest is -0.2°C: a real
  // warm nose thinner than the 925-850 spacing would be invisible here.
  nearsnow: { elevation: 287, t2m: -3, rh2m: 80, pbl: 300, levels: {
    1000: [-2, 88, 110], 925: [-0.2, 92, 800], 850: [-1, 90, 1500],
    700: [-8, 70, 3100], 500: [-25, 40, 5700], 300: [-55, 20, 9300] } },
  // Overrunning/warm-advection ice-storm shape: the column is nearly
  // isothermal through 0°C, so the crossing is arithmetically well inside a
  // narrow gap and physically worth kilofeet of uncertainty.
  isothermal: { elevation: 230, t2m: 3, rh2m: 70, pbl: 400, levels: {
    1000: [3.2, 70, 110], 925: [1.5, 60, 780], 850: [0.3, 60, 1450],
    700: [-0.4, 60, 3000], 500: [-15, 40, 5700], 300: [-45, 20, 9300] } },
};

function omBadRequest(route, reason) {
  return route.fulfill({
    status: 400, contentType: "application/json", headers: CORS,
    body: JSON.stringify({ error: true, reason }),
  });
}

// Answers the pressure-level request shape, and 400s the ways the real API
// 400s: a missing coordinate, an unknown hourly variable, an unaccepted
// pressure level. timeformat=unixtime is honoured rather than assumed — the
// app parses numbers, so a stub that always emitted them would hide a
// regression that dropped the parameter.
function omProfileRoute(route, url, kind) {
  const q = url.searchParams;
  const lat = Number(q.get("latitude")), lon = Number(q.get("longitude"));
  if (!isFinite(lat) || lat < -90 || lat > 90) return omBadRequest(route, "Latitude must be in range of -90 to 90°. Given: " + q.get("latitude") + ".");
  if (!isFinite(lon) || lon < -180 || lon > 180) return omBadRequest(route, "Longitude must be in range of -180 to 180°. Given: " + q.get("longitude") + ".");

  const wanted = (q.get("hourly") || "").split(",").filter(Boolean);
  if (!wanted.length) return omBadRequest(route, "Parameter 'hourly' is required for this request.");
  const spec = PROFILE_KINDS[kind] || PROFILE_KINDS.base;
  const parsed = [];
  for (const v of wanted) {
    const m = /^([a-z_]+?)_(\d+)hPa$/.exec(v);
    if (m) {
      if (!OM_LEVEL_VARS.has(m[1])) {
        return omBadRequest(route, "Data corrupted at path ''. Cannot initialize ForecastVariable from invalid String value " + v + ".");
      }
      if (!OM_PRESSURE_LEVELS.has(Number(m[2]))) {
        return omBadRequest(route, "Data corrupted at path ''. Cannot initialize PressureLevel from invalid String value " + m[2] + " hPa.");
      }
      parsed.push({ name: v, level: Number(m[2]), field: m[1] });
      continue;
    }
    if (!OM_SURFACE_HOURLY.has(v)) {
      return omBadRequest(route, "Data corrupted at path ''. Cannot initialize ForecastVariable from invalid String value " + v + ".");
    }
    parsed.push({ name: v, level: null, field: v });
  }

  const days = Number(q.get("forecast_days") || 7);
  if (!isFinite(days) || days < 1 || days > 16) return omBadRequest(route, "Parameter 'forecast_days' is out of allowed range from 0 to 16.");
  const unix = q.get("timeformat") === "unixtime";
  const hours = Math.min(24 * days + 1, 49);
  const startS = Math.floor(Date.now() / 3600000) * 3600;
  const time = [];
  for (let i = 0; i < hours; i++) {
    const s = startS + i * 3600;
    time.push(unix ? s : new Date(s * 1000).toISOString().slice(0, 16));
  }

  const hourly = { time };
  const units = { time: unix ? "unixtime" : "iso8601" };
  const FIELD_IDX = { temperature: 0, relative_humidity: 1, geopotential_height: 2 };
  const UNIT = { temperature: "°C", relative_humidity: "%", geopotential_height: "m",
                 boundary_layer_height: "m" };
  for (const p of parsed) {
    let value = null;
    if (p.level != null) {
      const row = spec.levels[p.level];
      value = row ? row[FIELD_IDX[p.field]] : null;
      if (value === undefined) value = null;
    } else if (p.field === "boundary_layer_height") {
      value = spec.pbl;
    } else if (p.field === "temperature_2m") {
      value = spec.t2m;
    } else if (p.field === "relative_humidity_2m") {
      value = spec.rh2m;
    }
    hourly[p.name] = time.map(() => value);
    units[p.name] = UNIT[p.field] || "";
  }

  const body = {
    latitude: lat, longitude: lon,
    generationtime_ms: 1.2, utc_offset_seconds: 0, timezone: "GMT", timezone_abbreviation: "GMT",
    hourly_units: units, hourly,
  };
  // A spec with elevation null OMITS the key rather than sending null: an
  // absent elevation is what the app has to survive, and null coerces to 0,
  // which would silently place the ground at sea level.
  if (spec.elevation != null) body.elevation = spec.elevation;
  if ((q.get("current") || "").length) {
    body.current_units = { temperature_2m: "°C", relative_humidity_2m: "%" };
    body.current = { time: unix ? startS : new Date(startS * 1000).toISOString().slice(0, 16),
                     interval: 900, temperature_2m: spec.t2m, relative_humidity_2m: spec.rh2m };
  }
  return json(route, JSON.stringify(body));
}

// --- water -----------------------------------------------------------------

const USGS_OGC_SITES = fixture("usgs-ogc-sites.json").toString("utf8");
const USGS_OGC_SITES_EMPTY = fixture("usgs-ogc-sites-empty.json").toString("utf8");
const NWPS_GAUGES_BBOX = fixture("nwps-gauges-bbox.json").toString("utf8");
const NWPS_GAUGE_SAYI4 = fixture("nwps-gauge-sayi4.json").toString("utf8");
const NWPS_GAUGE_ANKI4 = fixture("nwps-gauge-anki4.json").toString("utf8");
const NWPS_GAUGE_DESI4 = fixture("nwps-gauge-desi4.json").toString("utf8");
const NWPS_GAUGE_FLOW_ONLY = fixture("nwps-gauge-flow-only.json").toString("utf8");
const NWPS_DETAILS = { SAYI4: NWPS_GAUGE_SAYI4, ANKI4: NWPS_GAUGE_ANKI4, DESI4: NWPS_GAUGE_DESI4 };

// Live readings for the three fixture stream sites. stage in feet (00065),
// discharge in cfs (00060); a site absent from this table is unknown to the
// service, which 404s rather than answering with an empty series.
const USGS_READINGS = {
  "05485500": { name: "Des Moines River near Saylorville, IA", stage: 11.2, flow: 4820 },
  "05484800": { name: "Fourmile Creek at Ankeny, IA", stage: 5.4, flow: null },
  "05481950": { name: "Beaver Creek near Grimes, IA", stage: 3.1, flow: 210 },
};

function ogcError(route, status, description) {
  return route.fulfill({
    status, contentType: "application/json", headers: CORS,
    body: JSON.stringify({ code: String(status), description }),
  });
}

// The modern OGC API is the only discovery endpoint that answers a small box.
// It rejects a malformed bbox, an out-of-range limit, and — as the OGC API -
// Features spec requires — any query parameter it does not know.
const OGC_ALLOWED = new Set(["bbox", "limit", "f", "offset", "skipGeometry", "properties"]);
function usgsOgcRoute(route, url, empty) {
  const q = url.searchParams;
  for (const k of q.keys()) {
    if (!OGC_ALLOWED.has(k)) return ogcError(route, 400, "Unknown query parameter: " + k);
  }
  const raw = q.get("bbox");
  if (!raw) return ogcError(route, 400, "bbox is required for a nearby-sites query");
  const parts = raw.split(",");
  if (parts.length !== 4 || !parts.every((v) => v !== "" && Number.isFinite(Number(v)))) {
    return ogcError(route, 400, "bbox must be 4 numbers (minx,miny,maxx,maxy): " + raw);
  }
  const [w, s, e, n] = parts.map(Number);
  if (!(e > w) || !(n > s)) return ogcError(route, 400, "degenerate bbox: " + raw);
  if (Math.abs(w) > 180 || Math.abs(e) > 180 || Math.abs(s) > 90 || Math.abs(n) > 90) {
    return ogcError(route, 400, "bbox out of range: " + raw);
  }
  const limit = q.get("limit");
  if (limit != null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 10000)) {
    return ogcError(route, 400, "limit must be between 1 and 10000: " + limit);
  }
  const f = q.get("f");
  if (f != null && f !== "json" && f !== "geojson") {
    return ogcError(route, 400, "unsupported format: " + f);
  }
  return json(route, empty ? USGS_OGC_SITES_EMPTY : USGS_OGC_SITES);
}

function usgsText(route, status, body) {
  return route.fulfill({ status, contentType: "text/plain", headers: CORS, body });
}

// Classic waterservices, READINGS ONLY. The bbox form is the one that probed
// as unusable — it did not answer at all for a small box — so the stub refuses
// it outright: if rivers.js ever reaches for bbox discovery here again, the
// suite fails instead of shipping a board that hangs for 45 seconds.
function usgsIvRoute(route, url) {
  const q = url.searchParams;
  if (q.get("bBox") || q.get("bbox")) {
    return usgsText(route, 504, "The operation was aborted due to timeout");
  }
  if (q.get("format") !== "json") return usgsText(route, 400, "Unsupported format: " + q.get("format"));
  const sites = (q.get("sites") || "").split(",").filter(Boolean);
  if (!sites.length) return usgsText(route, 400, "No sites requested: provide sites= or a bBox=");
  if (!q.get("parameterCd")) return usgsText(route, 400, "parameterCd is required");
  const known = sites.filter((s) => USGS_READINGS[s]);
  if (!known.length) {
    return usgsText(route, 404, "No sites found matching all criteria: " + sites.join(","));
  }
  const wanted = new Set((q.get("parameterCd") || "").split(","));
  // A reading with no timestamp is a reading of unknown age, so the stub dates
  // it to the current quarter hour the way the real service does.
  // IV dateTimes look like "2026-08-13T02:15:00.000-05:00" — an offset, never a
  // Z. toISOString() already carries the milliseconds, so only the zone is
  // swapped; appending a second ".000" produced a string nothing can parse,
  // which silently hid the observation time from everything downstream.
  const stamp = new Date(Math.floor(Date.now() / 900000) * 900000).toISOString().replace("Z", "-00:00");
  const timeSeries = [];
  const push = (site, code, name, unit, value) => {
    timeSeries.push({
      sourceInfo: { siteName: USGS_READINGS[site].name, siteCode: [{ value: site, agencyCode: "USGS" }] },
      variable: { variableCode: [{ value: code }], variableName: name, unit: { unitCode: unit } },
      values: [{ value: [{ value: String(value), qualifiers: ["P"], dateTime: stamp }] }],
    });
  };
  for (const site of known) {
    const r = USGS_READINGS[site];
    if (wanted.has("00065") && r.stage != null) push(site, "00065", "Gage height, ft", "ft", r.stage);
    if (wanted.has("00060") && r.flow != null) push(site, "00060", "Discharge, cubic feet per second", "ft3/s", r.flow);
  }
  return json(route, JSON.stringify({ value: { timeSeries } }));
}

function nwpsRoute(route, url) {
  const p = url.pathname;
  const detail = /^\/nwps\/v1\/gauges\/([A-Za-z0-9]+)$/.exec(p);
  if (detail) {
    const body = NWPS_DETAILS[detail[1].toUpperCase()];
    if (!body) {
      return route.fulfill({
        status: 404, contentType: "application/json", headers: CORS,
        body: JSON.stringify({ code: 404, message: "gauge " + detail[1] + " not found" }),
      });
    }
    return json(route, body);
  }
  if (/^\/nwps\/v1\/gauges\/?$/.test(p)) {
    const q = url.searchParams;
    const box = ["bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax"].map((k) => q.get(k));
    if (box.some((v) => v == null || v === "" || !Number.isFinite(Number(v)))) {
      return route.fulfill({
        status: 400, contentType: "application/json", headers: CORS,
        body: JSON.stringify({ code: 400, message: "bbox.xmin, bbox.ymin, bbox.xmax and bbox.ymax are all required" }),
      });
    }
    if (q.get("srid") !== "EPSG_4326") {
      return route.fulfill({
        status: 400, contentType: "application/json", headers: CORS,
        body: JSON.stringify({ code: 400, message: "srid must be EPSG_4326, got " + q.get("srid") }),
      });
    }
    return json(route, NWPS_GAUGES_BBOX);
  }
  return route.fulfill({
    status: 404, contentType: "application/json", headers: CORS,
    body: JSON.stringify({ code: 404, message: "unknown path " + p }),
  });
}

function nwsNotFound(route, detail) {
  return route.fulfill({
    status: 404,
    contentType: "application/problem+json",
    headers: CORS,
    body: JSON.stringify({
      type: "https://api.weather.gov/problems/NotFound",
      title: "Not Found", status: 404, detail,
    }),
  });
}

async function routeAll(page, opts) {
  const alertsBody = (opts && opts.alerts) || ALERTS_ACTIVE;
  const gridpointsBody = (opts && opts.gridpoints) || NWS_GRIDPOINTS;
  // M7. opts.profile names a PROFILE_KINDS entry ("base" by default); opts.rivers
  // === "empty" makes gauge discovery return zero features.
  const profileKind = (opts && opts.profile) || "base";
  const riversEmpty = !!(opts && opts.rivers === "empty");
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const host = url.hostname;

    // our static server — let it through
    if (host === "localhost" || host === "127.0.0.1") return route.fallback();

    // map/radar/satellite imagery → 1x1 png
    if (
      host === "mesonet.agron.iastate.edu" ||
      host.endsWith("basemaps.cartocdn.com") ||
      host === "cdn.star.nesdis.noaa.gov"
    ) return png(route);

    // conditions + forecast. The CAST board makes two extra request shapes
    // against this same host (multi-model compare, base meteogram) — branch
    // on the query string so the plain conditions fetch (wx.js) is untouched.
    if (host === "api.open-meteo.com") {
      const qs = url.search;
      // M7 pressure levels: checked first, since the profile request carries
      // neither models= nor minutely_15 and would otherwise fall through to the
      // plain conditions fixture.
      if (qs.includes("hPa") || qs.includes("boundary_layer_height")) {
        return omProfileRoute(route, url, profileKind);
      }
      if (qs.includes("models=")) return json(route, OM_MODELS());
      if (qs.includes("minutely_15") || qs.includes("forecast_days=7")) return json(route, OM_CAST());
      return json(route, OM_FORECAST);
    }
    if (host === "ensemble-api.open-meteo.com") return json(route, OM_ENSEMBLE());
    if (host === "air-quality-api.open-meteo.com") return json(route, OM_AIR());
    if (host === "archive-api.open-meteo.com") {
      const bad = era5OutOfRange(url);
      if (bad) {
        return route.fulfill({
          status: 400, contentType: "application/json", headers: CORS,
          body: JSON.stringify({ error: true, reason: "Parameter '" + bad + "'" }),
        });
      }
      return json(route, era5Chunk(url));
    }
    if (host === "api.weather.gov") {
      // alerts + zones first: /zones/forecast/IAZ060 would otherwise be caught
      // by the "forecast" branch below
      if (url.pathname.startsWith("/alerts/active")) return json(route, alertsBody);
      if (url.pathname.startsWith("/zones/")) return json(route, ALERTS_ZONE);
      if (url.pathname.includes("/points/")) return json(route, NWS_POINTS);
      // M6 winter hazards. The real service 404s a gridpoint path whose office
      // or x,y is malformed rather than answering with an empty grid, so the
      // stub does too — a fixture that answers anything can't catch a bad URL.
      // Longer paths (…/forecast, …/forecast/hourly) fall through untouched.
      if (url.pathname.startsWith("/gridpoints/")) {
        const seg = url.pathname.split("/").filter(Boolean);
        if (seg.length < 3 || !/^[A-Z]{2,4}$/.test(seg[1]) || !/^-?\d+,-?\d+$/.test(seg[2])) {
          return nwsNotFound(route, "malformed gridpoint path " + url.pathname);
        }
        if (seg.length === 3) return json(route, gridpointsBody);
      }
      if (url.pathname.includes("hourly")) return json(route, NWS_HOURLY);
      if (url.pathname.includes("forecast")) return json(route, NWS_DAILY);
      return json(route, "{}");
    }
    if (host === "api.zippopotam.us") return json(route, ZIPPO);

    // M7 water. Discovery and readings are deliberately different hosts: the
    // OGC API answers the small bounding box, the classic service answers by
    // explicit site id and refuses the bbox form entirely.
    if (host === "api.waterdata.usgs.gov") return usgsOgcRoute(route, url, riversEmpty);
    if (host === "waterservices.usgs.gov") return usgsIvRoute(route, url);
    if (host === "api.water.noaa.gov") return nwpsRoute(route, url);

    // SPC outlooks / mesoscale discussions / tropical (ArcGIS MapServers) +
    // the WWA watch/warning/advisory MapServer (alerts.js MAP alerts).
    if (host === "mapservices.weather.noaa.gov") {
      const p = url.pathname;
      // WWA (/eventdriven/) is checked first — its layer-catalog and query
      // URLs match the same generic patterns as the SPC (/vector/) routes below.
      if (p.includes("/eventdriven/")) {
        if (/\/MapServer\/layers$/.test(p)) return json(route, WWA_LAYERS);
        if (/\/query$/.test(p)) return json(route, WWA_QUERY);
        return json(route, "{}");
      }
      // service directory used by spc.js's runtime tropical discovery —
      // checked before the generic /rest/services root rule added for M6
      if (/^\/tropical\/rest\/services\/?$/.test(p)) return json(route, TROPICAL_SERVICES);
      // M6: NOHRSC snow depth lives on the /raster/ root, a different service
      // directory from the /vector/ one the SPC routes below serve.
      if (p.startsWith("/raster/")) return rasterRoute(route, url);
      // M6: WPC winter guidance shares the /vector/ root with SPC, so it is
      // distinguished by path — the same way /eventdriven/ is above.
      if (p.includes("/wpc_prob_winter_precip/")) return wpcWinterRoute(route, url);
      if (/^\/vector\/rest\/services\/?$/.test(p)) {
        const bad = needsJsonFormat(url);
        return bad ? arcgisFail(route, 400, bad) : json(route, WPC_WINTER_SERVICES);
      }
      const vecFolder = /^\/vector\/rest\/services\/([^/]+)\/?$/.exec(p);
      if (vecFolder) {
        const bad = needsJsonFormat(url);
        if (bad) return arcgisFail(route, 400, bad);
        if (vecFolder[1] === "precip") return json(route, WPC_WINTER_PRECIP_FOLDER);
        // outlooks/obs carry the decoys the WPC tie-break has to refuse
        if (vecFolder[1] === "outlooks" || vecFolder[1] === "obs") {
          return json(route, WPC_WINTER_DECOY_FOLDER);
        }
        return json(route, EMPTY_FOLDER);
      }
      if (/\/MapServer\/layers$/.test(p)) return json(route, SPC_LAYERS);
      if (/\/query$/.test(p)) return json(route, SPC_OUTLOOK);
      return json(route, "{}");
    }

    // Leaflet CDN (pre-refactor markup) → local vendor copy
    if (host === "unpkg.com") {
      if (url.pathname.endsWith(".js")) {
        return route.fulfill({ status: 200, contentType: "application/javascript", headers: CORS, body: LEAFLET_JS });
      }
      if (url.pathname.endsWith(".css")) {
        return route.fulfill({ status: 200, contentType: "text/css", headers: CORS, body: LEAFLET_CSS });
      }
      return png(route);
    }

    // anything else external: hard-block, so a new unstubbed dependency is
    // caught by the suite instead of silently hitting the live network
    return route.abort("blockedbyclient");
  });
}

const DEFAULT_LOC = { zip: "50021", lat: 41.73, lon: -93.6, name: "Ankeny", state: "IA" };

async function boot(page, opts) {
  opts = opts || {};
  const seed = Object.assign(
    { skywatch_loc: JSON.stringify(DEFAULT_LOC) },
    opts.localStorage || {}
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.addInitScript((entries) => {
    for (const k of Object.keys(entries)) {
      try { window.localStorage.setItem(k, entries[k]); } catch (e) { /* ignore */ }
    }
  }, seed);
  await page.goto("/");
  return { errors };
}

module.exports = {
  routeAll, boot, DEFAULT_LOC, HOSTILE, OM_FORECAST, ZIPPO,
  ALERTS_ACTIVE, ALERTS_EMPTY, ALERTS_ZONE, SPC_LAYERS, SPC_OUTLOOK, TROPICAL_SERVICES,
  WWA_LAYERS, WWA_QUERY,
  OM_CAST, OM_MODELS, OM_ENSEMBLE, OM_AIR, CORS,
  era5Chunk,
  NWS_GRIDPOINTS, NWS_GRIDPOINTS_NONE,
  NOHRSC_SERVICES, NOHRSC_SNOW_FOLDER, NOHRSC_OBS_FOLDER, NOHRSC_LAYERS, NOHRSC_SERVICE,
  WPC_WINTER_SERVICES, WPC_WINTER_PRECIP_FOLDER, WPC_WINTER_DECOY_FOLDER,
  WPC_WINTER_LAYERS, WPC_WINTER_QUERY,
  // M7 profile + water
  PROFILE_KINDS, USGS_OGC_SITES, USGS_OGC_SITES_EMPTY, USGS_READINGS,
  NWPS_GAUGES_BBOX, NWPS_GAUGE_SAYI4, NWPS_GAUGE_ANKI4, NWPS_GAUGE_DESI4,
  NWPS_GAUGE_FLOW_ONLY,
};
