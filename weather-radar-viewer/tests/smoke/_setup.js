// Shared helpers for the SKYWATCH smoke suite.
//
// routeAll(page): intercepts every request. localhost passes through to the
// static server; every known external feed is answered from fixtures; any
// other external domain is blocked. The suite therefore never touches the
// live network and is fully deterministic.
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

async function routeAll(page) {
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

    // conditions + forecast
    if (host === "api.open-meteo.com") return json(route, OM_FORECAST);
    if (host === "api.weather.gov") {
      if (url.pathname.includes("/points/")) return json(route, NWS_POINTS);
      if (url.pathname.includes("hourly")) return json(route, NWS_HOURLY);
      if (url.pathname.includes("forecast")) return json(route, NWS_DAILY);
      return json(route, "{}");
    }
    if (host === "api.zippopotam.us") return json(route, ZIPPO);

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

module.exports = { routeAll, boot, DEFAULT_LOC, HOSTILE, OM_FORECAST, ZIPPO };
