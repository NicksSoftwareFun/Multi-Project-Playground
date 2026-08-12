// AIR board (M4): current US AQI + pollutants + a 48-hour AQI chart, from
// Open-Meteo's air-quality API (CAMS-backed, keyless, no User-Agent needed).
// Lazy like CAST: no fetch until the board is opened the first time, then
// cached per location in memory and refreshed on re-entry once stale.

import { OM_AIR, AIR_REFRESH_MS, aqiCat, POLLEN_AVAILABLE_US } from "./config.js";
import { el } from "./util.js";
import { fetchT, okJson, setHealth } from "./net.js";
import { chart } from "./charts.js";
import * as locations from "./locations.js";
import * as boards from "./boards.js";

let boardEl = null;
let loc = null;               // mirror of locations.active()
let chartInst = null;
let seq = 0;                  // supersedes in-flight fetches on relocate/re-render

// locId -> { fetchedAt: number|null, err: string|null, data: object|null }
const cache = new Map();

export function currentAqi() {
  if (!loc) return null;
  const rec = cache.get(loc.id);
  const v = rec && rec.data && rec.data.current.us_aqi;
  return v == null || isNaN(v) ? null : v;
}

export function init() {
  boardEl = document.getElementById("board-air");
  loc = locations.active();
  if (boardEl) boards.register({ id: "air", label: "AIR", el: boardEl, render, onEnter });

  locations.onChange((newLoc) => {
    loc = newLoc;
    // stay lazy: only touch the network if the AIR board is the one on screen
    if (boards.current() === "air") { render(); ensureFresh(); }
  });
}

// ---- EPA US AQI sub-index math (used only to name a plausible driving
// pollutant on the headline — see deriveDriver for the honesty guard) ----

// Breakpoints in µg/m3, matching the units the API already returns for PM —
// no ppb/ppm conversion needed, unlike the gas pollutants.
const PM25_BP = [
  [0.0, 12.0, 0, 50], [12.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
  [55.5, 150.4, 151, 200], [150.5, 250.4, 201, 300],
  [250.5, 350.4, 301, 400], [350.5, 500.4, 401, 500]
];
const PM10_BP = [
  [0, 54, 0, 50], [55, 154, 51, 100], [155, 254, 101, 150],
  [255, 354, 151, 200], [355, 424, 201, 300],
  [425, 504, 301, 400], [505, 604, 401, 500]
];
function subIndex(bp, c) {
  if (c == null || isNaN(c) || c < 0) return null;
  for (const [lo, hi, aLo, aHi] of bp) {
    if (c <= hi) return ((aHi - aLo) / (hi - lo)) * (c - lo) + aLo;
  }
  return bp[bp.length - 1][3];   // off the top of the table — cap rather than extrapolate
}

// JUDGMENT CALL: the request intentionally omits Open-Meteo's per-pollutant
// us_aqi_* fields (not in the spec'd query), and EPA's official sub-indices
// need running averages (24h for PM, 8h for ozone) we don't have from a
// single instantaneous reading. Rather than guess at ozone/NO2/SO2/CO — whose
// breakpoints are in ppb/ppm and would need an unverified molar-mass
// conversion from Open-Meteo's µg/m3 — this only ever names PM2.5 or PM10,
// computed directly in the units the API already gives us, and only when that
// computed sub-index actually lands close to the reported us_aqi. Anything
// else (ozone-driven days, etc.) is left unlabeled rather than guessed.
const DRIVER_TOLERANCE = 20;
function deriveDriver(cur) {
  if (cur.us_aqi == null) return null;
  const pm25 = subIndex(PM25_BP, cur.pm2_5);
  const pm10 = subIndex(PM10_BP, cur.pm10);
  let label = null, best = -1;
  if (pm25 != null && pm25 > best) { best = pm25; label = "PM2.5"; }
  if (pm10 != null && pm10 > best) { best = pm10; label = "PM10"; }
  if (label && Math.abs(best - cur.us_aqi) <= DRIVER_TOLERANCE) return label;
  return null;
}

// JUDGMENT CALL: there is no keyless US smoke-plume feed, so this infers
// "possible smoke" rather than observes it, from two independent signals:
//   1. PM2.5 well above today's own baseline (>=1.5x the past-day median AND
//      >=20 ug/m3 absolute, so a jump from a trivially clean 2 -> 3 ug/m3
//      doesn't false-positive) — a baseline-relative jump matters more than
//      an absolute PM2.5 level because "normal" varies a lot by city;
//      with no baseline at all (e.g. past-day series missing), fall back to
//      an absolute EPA "unhealthy" floor (35 ug/m3) instead of guessing 1.5x
//      of nothing.
//   2. AND aerosol optical depth >=0.3 (clear-sky days are typically <0.1;
//      wildfire haze commonly pushes AOD past 0.3-0.5) or surface dust
//      >=50 ug/m3 (distinguishes a dust event from smoke, but either counts
//      as "elevated aerosol" for this note's purpose).
// Both signals must agree — PM2.5 alone is often just traffic/inversion, and
// AOD/dust alone can be a clean high-altitude aerosol layer with no surface
// impact — before this ever prints a smoke line.
const SMOKE_PM_MULT = 1.5;
const SMOKE_PM_FLOOR = 20;      // ug/m3, absolute floor even with a baseline
const SMOKE_PM_FALLBACK = 35;   // ug/m3, used only when no baseline exists
const SMOKE_AOD_MIN = 0.3;
const SMOKE_DUST_MIN = 50;      // ug/m3
function inferSmoke(cur, baseline) {
  if (cur.pm2_5 == null) return false;
  const elevatedPm = baseline != null && baseline > 0
    ? (cur.pm2_5 >= baseline * SMOKE_PM_MULT && cur.pm2_5 >= SMOKE_PM_FLOOR)
    : cur.pm2_5 >= SMOKE_PM_FALLBACK;
  if (!elevatedPm) return false;
  const elevatedAod = cur.aod != null && cur.aod >= SMOKE_AOD_MIN;
  const elevatedDust = cur.dust != null && cur.dust >= SMOKE_DUST_MIN;
  return elevatedAod || elevatedDust;
}

function numOrNull(v) { return v == null || isNaN(v) ? null : v; }
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function buildUrl(l) {
  return OM_AIR + "?latitude=" + l.lat + "&longitude=" + l.lon +
    "&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,uv_index,dust,aerosol_optical_depth" +
    "&hourly=us_aqi,pm2_5,ozone,uv_index,dust,aerosol_optical_depth" +
    "&past_days=1&forecast_days=2&timezone=auto&timeformat=unixtime";
}

function normalize(j) {
  const c = j.current || {};
  const h = j.hourly || {};
  const times = h.time || [];
  const aqiArr = h.us_aqi || [];
  const pmArr = h.pm2_5 || [];

  const hourlyAqi = times.map((t, i) => [t * 1000, numOrNull(aqiArr[i])]);

  const nowS = Date.now() / 1000;
  const pastPm = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= nowS && pmArr[i] != null && !isNaN(pmArr[i])) pastPm.push(pmArr[i]);
  }
  const baseline = median(pastPm);

  const cur = {
    us_aqi: numOrNull(c.us_aqi),
    pm2_5: numOrNull(c.pm2_5),
    pm10: numOrNull(c.pm10),
    ozone: numOrNull(c.ozone),
    no2: numOrNull(c.nitrogen_dioxide),
    so2: numOrNull(c.sulphur_dioxide),
    co: numOrNull(c.carbon_monoxide),
    uv: numOrNull(c.uv_index),
    dust: numOrNull(c.dust),
    aod: numOrNull(c.aerosol_optical_depth)
  };

  return {
    current: cur,
    hourlyAqi,
    driver: deriveDriver(cur),
    smoke: inferSmoke(cur, baseline)
  };
}

// ---- fetch / cache lifecycle ----

function ensureFresh() {
  if (!loc) return;
  const rec = cache.get(loc.id);
  const stale = !rec || !rec.fetchedAt || (Date.now() - rec.fetchedAt) >= AIR_REFRESH_MS;
  if (stale) fetchFor(loc);
}

function fetchFor(target) {
  const mySeq = ++seq;
  fetchT(buildUrl(target)).then(okJson)
    .then((j) => {
      if (seq !== mySeq || !boardEl || !boardEl.isConnected) return;   // superseded or detached
      cache.set(target.id, { fetchedAt: Date.now(), err: null, data: normalize(j) });
      setHealth("air", "AIR   ", true, "ok");
      if (loc && loc.id === target.id) render();
    })
    .catch((err) => {
      if (seq !== mySeq || !boardEl || !boardEl.isConnected) return;
      cache.set(target.id, { fetchedAt: null, err: (err && err.message) || "NETWORK", data: null });
      setHealth("air", "AIR   ", false, "down");
      if (loc && loc.id === target.id) render();
    });
}

function onEnter() {
  loc = locations.active();
  ensureFresh();
}

// ---- rendering ----

function row(k, v) {
  return [el("span", { class: "k" }, k), el("span", { class: "v" }, v)];
}

function fmtUnit(v, decimals, unit) {
  return v == null || isNaN(v) ? "--" : v.toFixed(decimals) + " " + unit;
}

function placeLine(l) {
  return l.name + (l.state ? ", " + l.state : "") + " · AIR QUALITY";
}

function pollenNote() {
  // config.POLLEN_AVAILABLE_US is the single source of truth here: Open-Meteo's
  // pollen fields come from CAMS Europe and read null across CONUS (verified
  // in CI over 3 points), so those variables are never requested at all, and
  // this prints one honest line instead of a column of "--".
  if (POLLEN_AVAILABLE_US) return null;
  return el("div", { class: "srcnote" },
    "POLLEN DATA NOT AVAILABLE FOR US LOCATIONS — OPEN-METEO POLLEN FIELDS ARE CAMS EUROPE-ONLY");
}

function renderBoard(data, activeLoc) {
  const cur = data.current;
  const cat = aqiCat(cur.us_aqi);

  const bigNum = el("div", { class: "bigtemp" },
    cur.us_aqi == null ? "--" : String(Math.round(cur.us_aqi)));
  let condTxt = cat ? cat.label : "--";
  if (cat && data.driver) condTxt += " · " + data.driver;
  const bigCond = el("div", { class: "bigcond" }, condTxt);
  if (cat) {
    // official EPA category colors from config.AQI_CATS, not app tokens
    bigNum.style.color = cat.color;
    bigCond.style.color = cat.color;
  }

  const gridRows = [
    ...row("PM2.5", fmtUnit(cur.pm2_5, 1, "µg/m³")),
    ...row("PM10", fmtUnit(cur.pm10, 1, "µg/m³")),
    ...row("OZONE", fmtUnit(cur.ozone, 0, "µg/m³")),
    ...row("NO₂", fmtUnit(cur.no2, 0, "µg/m³")),
    ...row("SO₂", fmtUnit(cur.so2, 0, "µg/m³")),
    ...row("CO", fmtUnit(cur.co, 0, "µg/m³")),
    ...row("UV INDEX", cur.uv == null ? "--" : cur.uv.toFixed(1))
  ];
  if (cur.dust != null) gridRows.push(...row("DUST", fmtUnit(cur.dust, 0, "µg/m³")));
  if (cur.aod != null) gridRows.push(...row("AEROSOL OPTICAL DEPTH", cur.aod.toFixed(2)));

  const left = el("div", { class: "col" },
    el("div", { class: "place" }, placeLine(activeLoc)),
    bigNum, bigCond,
    el("div", { class: "grid" }, ...gridRows)
  );

  const chartHolder = el("div");
  const rightKids = [el("div", { class: "sect" }, "48-HOUR AQI"), chartHolder];
  if (data.smoke) {
    rightKids.push(el("div", { class: "srcnote" },
      "ELEVATED AEROSOL — POSSIBLE SMOKE (INFERRED FROM PM2.5 + AOD)"));
  }
  const pn = pollenNote();
  if (pn) rightKids.push(pn);
  const right = el("div", { class: "col" }, ...rightKids);

  const attrib = el("div", { class: "attrib" },
    "AIR QUALITY DATA BY ",
    el("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noopener" }, "OPEN-METEO.COM"),
    " · CAMS (COPERNICUS ATMOSPHERE MONITORING SERVICE)");

  boardEl.replaceChildren(left, right, attrib);

  // repeated opens must not leak ResizeObservers — destroy the previous
  // instance before wiring a new one to the freshly-attached container
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  const now = Date.now();
  chartInst = chart(chartHolder, {
    height: 170,
    now,
    x: { min: now - 24 * 3600 * 1000, max: now + 24 * 3600 * 1000 },
    y: { unit: "AQI", min: 0 },       // AQI has a floor of 0
    series: [{ type: "line", data: data.hourlyAqi, token: "--accent", width: 1.5, label: "AQI" }],
    cursor: true
  });
}

function render() {
  if (!boardEl) return;
  if (!loc) { boardEl.replaceChildren(el("div", { class: "bigmsg" }, "NO LOCATION SET")); return; }
  const rec = cache.get(loc.id);
  if (!rec || !rec.fetchedAt) {
    boardEl.replaceChildren(el("div", { class: "bigmsg" },
      rec && rec.err ? "AIR QUALITY UNAVAILABLE — " + rec.err : "CHECKING AIR QUALITY…"));
    return;
  }
  renderBoard(rec.data, loc);
}
