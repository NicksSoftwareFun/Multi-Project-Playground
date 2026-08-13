// CAST board: forecast depth. Three independent Open-Meteo requests per
// location — base (48h meteogram + 15-min nowcast + 7-day), model compare,
// and ensemble spread — each cached and degraded on its own so one dead feed
// never blanks the sections that still have data.
//
//   base:      temp/pop meteogram, next-2h precip strip (US/HRRR only), 7-day
//   compare:   one line per COMPARE_MODELS model, same chart
//   ensemble:  client-side p10/p25/p50/p75/p90 across the GEFS member set
//
// Nothing is fetched at boot. boards.js calls render() (paint from cache) and
// then onEnter() (kick off any stale fetch) every time the deck switches to
// this board; locations.onChange() does the same on a location switch.

import { OM_FORECAST, OM_ENSEMBLE, WMO, CAST_TTL_MS, ENSEMBLE_TTL_MS,
         COMPARE_MODELS, ENSEMBLE_MODELS } from "./config.js";
import { el, pct } from "./util.js";
import { fetchT, okJson, setHealth } from "./net.js";
import { chart } from "./charts.js";
import * as locations from "./locations.js";
import * as boards from "./boards.js";
import * as state from "./state.js";

let boardEl = null;
let activeCharts = [];          // torn down before every repaint so ResizeObservers don't leak
let confidenceOpen = true;      // CONFIDENCE section starts expanded

// locId -> { base, baseSeq, compare, compareSeq, ensemble, ensembleSeq }
// each slot is null (never tried) or { t, data, err }
const cache = new Map();

function cacheFor(id) {
  let c = cache.get(id);
  if (!c) {
    c = { base: null, baseSeq: 0, compare: null, compareSeq: 0, ensemble: null, ensembleSeq: 0 };
    cache.set(id, c);
  }
  return c;
}

function msg(e) {
  const m = e && e.message ? String(e.message) : "error";
  return m === "TIMEOUT" ? "timeout" : m;
}

function cssVar(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || "#8FA5B7";
}

// ---- requests ---------------------------------------------------------------

function baseUrl(loc) {
  return OM_FORECAST + "?latitude=" + loc.lat + "&longitude=" + loc.lon +
    "&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m" +
    "&minutely_15=precipitation" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
    "&forecast_days=7&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch" +
    "&timezone=auto&timeformat=unixtime";
}

function compareUrl(loc) {
  const ids = COMPARE_MODELS.map((m) => m.id).join(",");
  return OM_FORECAST + "?latitude=" + loc.lat + "&longitude=" + loc.lon +
    "&hourly=temperature_2m&forecast_days=5" +
    "&models=" + ids + "&temperature_unit=fahrenheit&timezone=auto&timeformat=unixtime";
}

function ensembleUrl(loc) {
  return OM_ENSEMBLE + "?latitude=" + loc.lat + "&longitude=" + loc.lon +
    "&hourly=temperature_2m&models=" + ENSEMBLE_MODELS[0].id + "&forecast_days=7" +
    "&temperature_unit=fahrenheit&timezone=auto&timeformat=unixtime";
}

// ---- parsing ------------------------------------------------------------

// Local weekday at the forecast location, independent of the viewer's own
// timezone: shift the unix seconds by utc_offset_seconds, then read the
// shifted instant back out via UTC accessors so the browser's real zone
// never gets applied a second time.
function dayAbbr(unixSec, offsetSec) {
  const d = new Date((unixSec + (offsetSec || 0)) * 1000);
  return d.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }).toUpperCase();
}

// "8/13" for the row beneath the weekday. UTC accessors on purpose: the epoch
// has already had the location's offset folded in above, so reading it in the
// device's zone would shift the date for anyone in a different one.
function dayDate(unixSec, offsetSec) {
  const d = new Date((unixSec + (offsetSec || 0)) * 1000);
  return (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
}

// Trim an hourly series to roughly now..+48h. x values stay true unix ms —
// the chart engine positions everything (including `now`) off that epoch.
// Grace equals the grid spacing (1h) — same margin wx.js's own hourly slice
// uses — so the most recent past grid point is always kept and `now` never
// lands to the left of xMin no matter how far past the hour mark it is.
function sliceHourly48(h, key) {
  if (!h || !h.time || !h[key]) return [];
  const nowS = Date.now() / 1000;
  let i0 = 0;
  while (i0 < h.time.length - 1 && h.time[i0] < nowS - 3600) i0++;
  const end = Math.min(h.time.length, i0 + 49);
  const pts = [];
  for (let i = i0; i < end; i++) pts.push([h.time[i] * 1000, h[key][i]]);
  return pts;
}

// minutely_15 precipitation is HRRR-backed and only populated over the US —
// null across the board outside that coverage. Report that as "no section"
// (null) rather than a chart full of zero-height bars.
function sliceMinutely15(m) {
  if (!m || !m.time || !m.precipitation) return null;
  if (!m.precipitation.some((v) => v != null)) return null;
  const nowS = Date.now() / 1000;
  let i0 = 0;
  while (i0 < m.time.length - 1 && m.time[i0] < nowS - 900) i0++;   // grace = the 15-min grid spacing
  const end = Math.min(m.time.length, i0 + 8);   // 8 * 15min = 2h
  const pts = [];
  for (let i = i0; i < end; i++) pts.push([m.time[i] * 1000, m.precipitation[i]]);
  return pts.length ? pts : null;
}

function parseBase(j) {
  const offset = j.utc_offset_seconds || 0;
  const h = j.hourly || {};
  const d = j.daily || {};
  const days = [];
  if (d.time) {
    for (let i = 0; i < d.time.length; i++) {
      days.push({
        label: dayAbbr(d.time[i], offset),
        date: dayDate(d.time[i], offset),
        hi: d.temperature_2m_max ? d.temperature_2m_max[i] : null,
        lo: d.temperature_2m_min ? d.temperature_2m_min[i] : null,
        pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
        cond: d.weather_code && d.weather_code[i] != null ? (WMO[d.weather_code[i]] || "") : ""
      });
    }
  }
  return {
    temp: sliceHourly48(h, "temperature_2m"),
    pop: sliceHourly48(h, "precipitation_probability"),
    precip15: sliceMinutely15(j.minutely_15),
    days
  };
}

function parseCompare(j) {
  const h = j.hourly || {};
  const times = h.time || [];
  return COMPARE_MODELS.map((model) => {
    const vals = h["temperature_2m_" + model.id];
    const data = vals ? times.map((t, i) => [t * 1000, vals[i] == null ? null : vals[i]]) : [];
    return { model, data };
  });
}

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function parseEnsemble(j) {
  const h = j.hourly || {};
  const times = h.time || [];
  const memberKeys = Object.keys(h).filter((k) => /^temperature_2m_member\d+$/.test(k));
  const p10 = [], p25 = [], p50 = [], p75 = [], p90 = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i] * 1000;
    const vals = memberKeys.map((k) => h[k][i]).filter((v) => v != null).sort((a, b) => a - b);
    if (vals.length < 2) {
      p10.push([t, null]); p25.push([t, null]); p50.push([t, null]); p75.push([t, null]); p90.push([t, null]);
      continue;
    }
    p10.push([t, percentile(vals, 10)]);
    p25.push([t, percentile(vals, 25)]);
    p50.push([t, percentile(vals, 50)]);
    p75.push([t, percentile(vals, 75)]);
    p90.push([t, percentile(vals, 90)]);
  }
  return { n: memberKeys.length, p10, p25, p50, p75, p90 };
}

// ---- fetch + cache --------------------------------------------------------

function repaintIfActive(loc) {
  if (boards.current() !== "cast") return;
  if (!boardEl || !boardEl.isConnected) return;
  const active = locations.active();
  if (!active || active.id !== loc.id) return;   // superseded by a location switch
  paint();
}

function fetchBase(loc) {
  const c = cacheFor(loc.id);
  const seq = ++c.baseSeq;
  fetchT(baseUrl(loc)).then(okJson).then((j) => {
    if (c.baseSeq !== seq) return;
    c.base = { t: Date.now(), data: parseBase(j), err: null };
    setHealth("cast", "FCAST ", true, "ok");
    repaintIfActive(loc);
  }).catch((e) => {
    if (c.baseSeq !== seq) return;
    c.base = { t: Date.now(), data: null, err: msg(e) };
    setHealth("cast", "FCAST ", false, msg(e));
    repaintIfActive(loc);
  });
}

function fetchCompare(loc) {
  const c = cacheFor(loc.id);
  const seq = ++c.compareSeq;
  fetchT(compareUrl(loc)).then(okJson).then((j) => {
    if (c.compareSeq !== seq) return;
    c.compare = { t: Date.now(), data: parseCompare(j), err: null };
    setHealth("cast", "FCAST ", true, "compare ok");
    repaintIfActive(loc);
  }).catch((e) => {
    if (c.compareSeq !== seq) return;
    c.compare = { t: Date.now(), data: null, err: msg(e) };
    setHealth("cast", "FCAST ", false, "compare " + msg(e));
    repaintIfActive(loc);
  });
}

function fetchEnsemble(loc) {
  const c = cacheFor(loc.id);
  const seq = ++c.ensembleSeq;
  fetchT(ensembleUrl(loc), 15000).then(okJson).then((j) => {
    if (c.ensembleSeq !== seq) return;
    c.ensemble = { t: Date.now(), data: parseEnsemble(j), err: null };
    setHealth("cast", "FCAST ", true, "ensemble ok");
    repaintIfActive(loc);
  }).catch((e) => {
    if (c.ensembleSeq !== seq) return;
    c.ensemble = { t: Date.now(), data: null, err: msg(e) };
    setHealth("cast", "FCAST ", false, "ensemble " + msg(e));
    repaintIfActive(loc);
  });
}

function ensureEnsemble(loc) {
  const c = cacheFor(loc.id);
  if (!c.ensemble || Date.now() - c.ensemble.t > ENSEMBLE_TTL_MS) fetchEnsemble(loc);
}

function ensureFresh(loc) {
  if (!loc) return;
  const c = cacheFor(loc.id);
  const now = Date.now();
  if (!c.base || now - c.base.t > CAST_TTL_MS) fetchBase(loc);
  if (!c.compare || now - c.compare.t > ENSEMBLE_TTL_MS) fetchCompare(loc);
  if (confidenceOpen) ensureEnsemble(loc);
}

// ---- render -----------------------------------------------------------------

function sectionMsg(text) {
  return el("div", { class: "srcnote" }, text);
}

function meteogramSection(c) {
  const box = el("div", { class: "col" }, el("div", { class: "sect" }, "48-HOUR OUTLOOK"));
  if (!c.base) { box.append(sectionMsg("LOADING…")); return box; }
  if (c.base.err) { box.append(sectionMsg("FORECAST UNAVAILABLE — " + c.base.err)); return box; }
  if (!c.base.data.temp.length) { box.append(sectionMsg("NO DATA")); return box; }
  const host = el("div");
  box.append(host);
  activeCharts.push(chart(host, {
    height: 170,
    now: Date.now(),
    y: { unit: "°F" },
    y2: { unit: "%", min: 0, max: 100 },
    cursor: true,
    series: [
      // Same yellow as the ensemble median below it — the temperature trace is
      // the same quantity in both charts and should not change color between them.
      { type: "line", data: c.base.data.temp, token: "--pred-soft", width: 1.75, label: "TEMP" },
      { type: "bars", data: c.base.data.pop, token: "--info", axis: "y2", label: "POP" }
    ]
  }));
  return box;
}

// Omitted entirely (not even a header) when base hasn't landed yet or the
// point is outside HRRR coverage — never an empty box.
function nextTwoHoursSection(c) {
  if (!c.base || c.base.err || !c.base.data.precip15) return null;
  const box = el("div", { class: "col" }, el("div", { class: "sect" }, "NEXT 2 HOURS"));
  const host = el("div");
  box.append(host);
  activeCharts.push(chart(host, {
    height: 70,
    now: Date.now(),
    y: { unit: "IN", min: 0 },        // rainfall has a floor; a dry day is flat at 0, not -1
    cursor: true,
    series: [{ type: "bars", data: c.base.data.precip15, token: "--info", label: "PRECIP" }]
  }));
  return box;
}

function sevenDaySection(c) {
  const box = el("div", { class: "col" }, el("div", { class: "sect" }, "7-DAY"));
  if (!c.base) { box.append(sectionMsg("LOADING…")); return box; }
  if (c.base.err) { box.append(sectionMsg("FORECAST UNAVAILABLE — " + c.base.err)); return box; }
  const days = c.base.data.days;
  if (!days.length) { box.append(sectionMsg("NO DATA")); return box; }
  // A table, not a sentence per day. Each value sits in its own column so the
  // week reads down a column — the numbers are the point, and a run-on line of
  // "HI 72 / LO 52 · POP 15% · MOSTLY CLEAR" made them impossible to scan.
  // The high/low bar shows each day's range against the week's own span, so a
  // cold front is visible before you have read a single number.
  const his = days.map((d) => d.hi).filter((v) => v != null);
  const los = days.map((d) => d.lo).filter((v) => v != null);
  const wkHi = his.length ? Math.max(...his) : null;
  const wkLo = los.length ? Math.min(...los) : null;
  const span = wkHi != null && wkLo != null && wkHi > wkLo ? wkHi - wkLo : null;

  const list = el("div", { class: "castdays" });
  for (const d of days) {
    const hi = d.hi == null ? "--" : Math.round(d.hi) + "°";
    const lo = d.lo == null ? "--" : Math.round(d.lo) + "°";
    const bar = el("div", { class: "rangebar" });
    if (span != null && d.hi != null && d.lo != null) {
      const fill = el("div", { class: "fill" });
      fill.style.left = ((d.lo - wkLo) / span * 100) + "%";
      fill.style.width = Math.max(2, (d.hi - d.lo) / span * 100) + "%";
      bar.append(fill);
    }
    list.append(el("div", { class: "castday" },
      el("div", { class: "when" },
        el("span", { class: "dow" }, d.label),
        el("span", { class: "date" }, d.date || "")),
      el("div", { class: "lo" }, lo),
      bar,
      el("div", { class: "hi" }, hi),
      el("div", { class: "pop" }, d.pop == null ? "--" : pct(d.pop)),
      el("div", { class: "cond" }, d.cond || "")
    ));
  }
  box.append(list);
  return box;
}

function confidenceSection(loc, c) {
  const head = el("div", { class: "sect" }, "CONFIDENCE (ENSEMBLE) " + (confidenceOpen ? "▾" : "▸"));
  head.style.cursor = "pointer";
  head.addEventListener("click", () => {
    confidenceOpen = !confidenceOpen;
    if (confidenceOpen) ensureEnsemble(loc);
    paint();
  });
  const box = el("div", { class: "col" }, head);
  if (!confidenceOpen) return box;
  if (!c.ensemble) { box.append(sectionMsg("LOADING…")); return box; }
  if (c.ensemble.err) { box.append(sectionMsg("ENSEMBLE UNAVAILABLE — " + c.ensemble.err)); return box; }
  const e = c.ensemble.data;
  if (!e.n) { box.append(sectionMsg("NO ENSEMBLE MEMBERS RETURNED")); return box; }
  const host = el("div");
  box.append(host);
  activeCharts.push(chart(host, {
    height: 170,
    now: Date.now(),
    y: { unit: "°F" },
    cursor: true,
    series: [
      { type: "band", lo: e.p10, hi: e.p90, token: "--pred", alpha: 0.14 },
      { type: "band", lo: e.p25, hi: e.p75, token: "--pred", alpha: 0.22 },
      { type: "line", data: e.p50, token: "--pred-soft", width: 1.75, label: "MEDIAN" }
    ]
  }));
  box.append(sectionMsg(ENSEMBLE_MODELS[0].label + " " + e.n + " MEMBERS · BAND = 10–90% OF RUNS"));
  return box;
}

function modelAgreementSection(c) {
  const box = el("div", { class: "col" }, el("div", { class: "sect" }, "MODEL AGREEMENT"));
  if (!c.compare) { box.append(sectionMsg("LOADING…")); return box; }
  if (c.compare.err) { box.append(sectionMsg("MODEL COMPARE UNAVAILABLE — " + c.compare.err)); return box; }
  const series = c.compare.data;
  if (!series.some((s) => s.data.length)) { box.append(sectionMsg("NO DATA")); return box; }
  const host = el("div");
  box.append(host);
  activeCharts.push(chart(host, {
    height: 170,
    now: Date.now(),
    y: { unit: "°F" },
    cursor: true,
    series: series.map((s) => ({ type: "line", data: s.data, token: s.model.token, width: 1.5, label: s.model.label }))
  }));
  box.append(el("div", { class: "chiplegend" }, ...series.map((s) => {
    const color = cssVar(s.model.token);
    return el("span", { class: "lchip", style: "color:" + color + ";border-color:" + color }, s.model.label);
  })));
  box.append(sectionMsg("HRRR ENDS ~48H OUT · SPREAD BETWEEN MODEL LINES = FORECAST UNCERTAINTY"));
  return box;
}

function paint() {
  for (const c of activeCharts) c.destroy();
  activeCharts = [];
  if (!boardEl) return;

  const loc = locations.active();
  if (!loc) {
    boardEl.replaceChildren(el("div", { class: "bigmsg" }, "SET A LOCATION — TAP THE CONDITIONS PANEL"));
    return;
  }

  // Board deck default is a two-column flex row; lay this board out as a
  // stacked column the same way #board-severe already does in boards.css,
  // without adding any new CSS.
  const c = cacheFor(loc.id);
  const kids = [el("div", { class: "place" }, loc.name + (loc.state ? ", " + loc.state : "") + " · FORECAST")];

  kids.push(meteogramSection(c));
  kids.push(sevenDaySection(c));
  // winter.js fills this on the "castboard" event below, and leaves it empty
  // (CSS collapses it) whenever there is no snow or ice in the forecast — which
  // is most of the year, and is a correct answer rather than a missing one.
  kids.push(el("div", { id: "winterStrip" }));
  kids.push(confidenceSection(loc, c));
  kids.push(modelAgreementSection(c));
  // profile.js fills this on the "castboard" event below: freezing level,
  // precipitation-type reasoning, and cloud bases/tops. Its own fetch, so a
  // dead pressure-level response never blanks the sections above it.
  kids.push(el("div", { id: "profileStrip" }));
  // The 15-minute precipitation strip reads as a footnote to the forecast, not
  // a headline: it sits under the model comparison rather than above the 48h
  // meteogram, where it was the first thing on screen.
  const strip = nextTwoHoursSection(c);
  if (strip) kids.push(strip);
  kids.push(el("div", { class: "attrib" },
    "WEATHER DATA BY ", el("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noopener" }, "OPEN-METEO.COM")));

  boardEl.replaceChildren(...kids);
  // Every repaint builds a fresh #winterStrip node, so the owner has to be told
  // to refill it. Emitted last, when the node is actually in the document.
  state.emit("castboard", { el: boardEl });
}

function render() { paint(); }
function onEnter() { ensureFresh(locations.active()); }

// ---- public -------------------------------------------------------------

export function init() {
  boardEl = document.getElementById("board-cast");
  if (!boardEl) return;
  boards.register({ id: "cast", label: "FCAST", el: boardEl, render, onEnter });

  locations.onChange(() => {
    if (boards.current() !== "cast") return;
    paint();
    ensureFresh(locations.active());
  });
}

export function refresh() {
  const loc = locations.active();
  if (!loc) return;
  const c = cacheFor(loc.id);
  c.base = null;
  c.compare = null;
  c.ensemble = null;
  ensureFresh(loc);
  if (boards.current() === "cast" && boardEl && boardEl.isConnected) paint();
}
