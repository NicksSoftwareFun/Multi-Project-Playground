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
//
// boot(page, {localStorage}): seeds localStorage (default: a saved Ankeny, IA
// location under skywatch_loc) via addInitScript, starts a pageerror
// collector, and navigates to "/". Returns { errors }.
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

async function routeAll(page, opts) {
  const alertsBody = (opts && opts.alerts) || ALERTS_ACTIVE;
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
      if (qs.includes("models=")) return json(route, OM_MODELS());
      if (qs.includes("minutely_15") || qs.includes("forecast_days=7")) return json(route, OM_CAST());
      return json(route, OM_FORECAST);
    }
    if (host === "ensemble-api.open-meteo.com") return json(route, OM_ENSEMBLE());
    if (host === "air-quality-api.open-meteo.com") return json(route, OM_AIR());
    if (host === "api.weather.gov") {
      // alerts + zones first: /zones/forecast/IAZ060 would otherwise be caught
      // by the "forecast" branch below
      if (url.pathname.startsWith("/alerts/active")) return json(route, alertsBody);
      if (url.pathname.startsWith("/zones/")) return json(route, ALERTS_ZONE);
      if (url.pathname.includes("/points/")) return json(route, NWS_POINTS);
      if (url.pathname.includes("hourly")) return json(route, NWS_HOURLY);
      if (url.pathname.includes("forecast")) return json(route, NWS_DAILY);
      return json(route, "{}");
    }
    if (host === "api.zippopotam.us") return json(route, ZIPPO);

    // SPC outlooks / mesoscale discussions / tropical (ArcGIS MapServers)
    if (host === "mapservices.weather.noaa.gov") {
      const p = url.pathname;
      if (/\/MapServer\/layers$/.test(p)) return json(route, SPC_LAYERS);
      if (/\/query$/.test(p)) return json(route, SPC_OUTLOOK);
      // service directory used by spc.js's runtime tropical discovery
      if (/^\/tropical\/rest\/services\/?$/.test(p)) return json(route, TROPICAL_SERVICES);
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
  OM_CAST, OM_MODELS, OM_ENSEMBLE, OM_AIR, CORS,
};
