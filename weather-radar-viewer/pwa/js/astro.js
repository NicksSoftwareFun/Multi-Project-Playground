// SKY board (M5): day length + its day-over-day change, the three twilights,
// golden hour, solar noon, moonrise/moonset, phase, and the next full/new
// moon — every value a pure function of (instant, latitude, longitude)
// evaluated on-device from vendor/suncalc.js. No fetch, no store, no
// IndexedDB, no loading state: render() computes and paints in one
// synchronous pass (measured ~2ms — 578 getPosition/getMoonPosition calls
// plus two phase root-finds), so there is nothing to be "loading".
//
// window.SunCalc is a classic script global (index.html loads
// vendor/suncalc.js before js/main.js, the same contract map.js relies on
// for window.L) — this module must never touch it at import time, only
// inside functions, so import order can never matter. sc() is the single
// gate; every entry point checks it and prints one honest sentence instead
// of throwing when the vendor script didn't load.
//
// The one rule that keeps "NaN:NaN"/"Invalid Date" off the screen: SunCalc's
// getTimes() always returns every key, always as a Date instance, and
// signals "this event does not happen here today" with an Invalid Date
// (NaN time) — not undefined, not a missing key. Every value pulled out of
// getTimes() is run through util.isValidDate at the boundary (see d()
// below) so nothing downstream ever sees a NaN.

import { SKY_TICK_MS, SKY_SAMPLE_MIN, SKY_TZ_WARN_H, SKY_PHASE_UNCERTAINTY_H } from "./config.js";
import { el, pad, fmt, isValidDate } from "./util.js";
import { setHealth } from "./net.js";
import { chart } from "./charts.js";
import * as locations from "./locations.js";
import * as boards from "./boards.js";
import * as state from "./state.js";
import { View } from "./state.js";

let boardEl = null;
let chartInst = null;
let tickTimer = null;
let lastPaintedDay = null;   // local "YYYY-MM-DD" of the last full paint
let nextEl = null;           // live text node for the 30s countdown — see startTick()

const SVG_NS = "http://www.w3.org/2000/svg";
const PHASE_NAMES = [
  "NEW MOON", "WAXING CRESCENT", "FIRST QUARTER", "WAXING GIBBOUS",
  "FULL MOON", "WANING GIBBOUS", "LAST QUARTER", "WANING CRESCENT"
];

// ---- engine access ----------------------------------------------------

function sc() { return (typeof window !== "undefined" && window.SunCalc) || null; }

// The Invalid-Date-object trap, at the boundary and nowhere else.
function d(v) { return isValidDate(v) ? v : null; }

// ---- small pure helpers -------------------------------------------------

function degs(rad) { return (rad * 180) / Math.PI; }

function localMidnight(date) {
  const m = new Date(date);
  m.setHours(0, 0, 0, 0);
  return m;
}
function localDayKey(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1, 2) + "-" + pad(date.getDate(), 2);
}

// Day length in ms for one calendar instant, independent of computeSky() so
// findTurning()'s day-by-day scan and the yesterday comparison can call it
// directly without building the rest of the board's data.
function dayLength(date, lat, lon) {
  const SunCalc = sc();
  if (!SunCalc) return null;
  const raw = SunCalc.getTimes(date, lat, lon);
  const posNoon = SunCalc.getPosition(raw.solarNoon, lat, lon);
  const posNadir = SunCalc.getPosition(raw.nadir, lat, lon);
  if (posNoon.altitude > 0 && posNadir.altitude > 0) return 86400000;   // polar day
  if (posNoon.altitude < 0 && posNadir.altitude < 0) return 0;         // polar night
  const sunrise = d(raw.sunrise), sunset = d(raw.sunset);
  return (sunrise && sunset) ? sunset - sunrise : null;
}

// Steps forward a day at a time until today's day-length trend (growing or
// shrinking) reverses — that reversal day is the shortest/longest day of the
// year. Capped at 400 iterations (more than a full year); returns null with
// no sign flip found at all (equatorial latitudes barely change, and polar
// latitudes can return null day-lengths outright) — an omitted note is
// honest, an empty one is not.
function findTurning(date, lat, lon, todayDeltaMs) {
  if (todayDeltaMs == null || todayDeltaMs === 0) return null;
  const wantSign = todayDeltaMs < 0 ? -1 : 1;
  let prevLen = dayLength(date, lat, lon);
  if (prevLen == null) return null;
  for (let i = 1; i <= 400; i++) {
    const cur = new Date(date.getTime() + i * 86400000);
    const len = dayLength(cur, lat, lon);
    if (len == null) return null;
    const delta = len - prevLen;
    if (delta !== 0 && Math.sign(delta) !== wantSign) {
      return {
        date: new Date(date.getTime() + (i - 1) * 86400000),
        dayLengthMs: prevLen,
        days: i - 1,
        kind: wantSign < 0 ? "SHORTEST" : "LONGEST"
      };
    }
    prevLen = len;
  }
  return null;
}

// Buckets SunCalc's `phase` (0/1 = new, 0.5 = full) into the fixed eight-name
// set, each 1/8 wide and centered on the four named points (new/first
// quarter/full/last quarter).
function phaseName(phase) {
  const p = ((phase % 1) + 1) % 1;
  const idx = Math.floor(((p + 0.0625) % 1) / 0.125);
  return PHASE_NAMES[idx];
}

// Generic bisection: assumes pred(lo) !== pred(hi) and narrows the bracket
// toward the crossing. Used only for the phase root-finds below.
function bisect(pred, lo, hi, iters) {
  let a = lo, b = hi;
  const pa = pred(a);
  for (let i = 0; i < iters; i++) {
    const mid = (a + b) / 2;
    if (pred(mid) === pa) a = mid; else b = mid;
  }
  return (a + b) / 2;
}

function phaseAt(t) { return sc().getMoonIllumination(new Date(t)).phase; }

// Coarse 1-hour scan up to 45 days for a bracket, then 24 bisections
// (measured ~1ms for both events combined). Full = the upward crossing of
// phase 0.5; new = the 1->0 wrap (phase drops by more than 0.5 in one hourly
// step), bisected on the same predicate crossing through the wrap point.
function nextFullMoon(nowMs) {
  const SunCalc = sc();
  if (!SunCalc) return null;
  const stepMs = 3600000;
  let t0 = nowMs, p0 = phaseAt(t0);
  for (let i = 1; i <= 45 * 24; i++) {
    const t1 = nowMs + i * stepMs, p1 = phaseAt(t1);
    if (p0 < 0.5 && p1 >= 0.5) return new Date(bisect((t) => phaseAt(t) < 0.5, t0, t1, 24));
    t0 = t1; p0 = p1;
  }
  return null;
}
function nextNewMoon(nowMs) {
  const SunCalc = sc();
  if (!SunCalc) return null;
  const stepMs = 3600000;
  let t0 = nowMs, p0 = phaseAt(t0);
  for (let i = 1; i <= 45 * 24; i++) {
    const t1 = nowMs + i * stepMs, p1 = phaseAt(t1);
    if (p1 < p0 - 0.5) return new Date(bisect((t) => phaseAt(t) > 0.5, t0, t1, 24));
    t0 = t1; p0 = p1;
  }
  return null;
}

// Walks local midnight -> local midnight + 24h in SKY_SAMPLE_MIN steps
// (289 samples/body at the default 5-minute step, ~1ms for both bodies).
function sampleTrack(date, lat, lon) {
  const SunCalc = sc();
  const start = localMidnight(date).getTime();
  const end = start + 86400000;
  const stepMs = SKY_SAMPLE_MIN * 60000;
  const sun = [], moon = [];
  for (let t = start; t <= end; t += stepMs) {
    const dt = new Date(t);
    sun.push([t, degs(SunCalc.getPosition(dt, lat, lon).altitude)]);
    moon.push([t, degs(SunCalc.getMoonPosition(dt, lat, lon).altitude)]);
  }
  return { sun, moon, x0: start, x1: end };
}

// First labelled instant strictly after `date`, drawn from today's sun/moon
// events plus tomorrow's sunrise — so the list never runs dry after sunset.
function nextEvent(date, lat, lon, sun, moon) {
  const SunCalc = sc();
  const now = date.getTime();
  const candidates = [];
  const add = (label, dt) => { if (dt && dt.getTime() > now) candidates.push({ label, at: dt }); };
  add("ASTRONOMICAL DAWN", sun.nightEnd);
  add("NAUTICAL DAWN", sun.nauticalDawn);
  add("CIVIL DAWN", sun.dawn);
  add("SUNRISE", sun.sunrise);
  add("SOLAR NOON", sun.solarNoon);
  add("SUNSET", sun.sunset);
  add("CIVIL DUSK", sun.dusk);
  add("NAUTICAL DUSK", sun.nauticalDusk);
  add("ASTRONOMICAL DUSK", sun.night);
  add("MOONRISE", moon.rise);
  add("MOONSET", moon.set);
  const tomorrow = new Date(date.getTime() + 86400000);
  add("SUNRISE", d(SunCalc.getTimes(tomorrow, lat, lon).sunrise));
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0];
}

// Device-vs-longitude timezone gap. 3 hours rather than 1-2 so genuinely
// wide legitimate zones (Indiana on EDT at lon -86, which rounds to UTC-6)
// don't false-positive.
function tzHint(lon) {
  const deviceH = -new Date().getTimezoneOffset() / 60;
  const lonH = Math.round(lon / 15);
  return Math.abs(lonH - deviceH) >= SKY_TZ_WARN_H ? { deviceH, lonH } : null;
}

// ---- pure computation (exported) ----------------------------------------

export function computeSky(date, lat, lon) {
  const SunCalc = sc();
  if (!SunCalc) return null;

  const rawSun = SunCalc.getTimes(date, lat, lon);
  const sun = {};
  for (const k of Object.keys(rawSun)) sun[k] = d(rawSun[k]);

  // Polar state is read from the sun's actual position at noon/nadir rather
  // than from the absence of sunrise, so "always up" and "always down" are
  // distinguished instead of both collapsing into one blank sunrise row.
  const posNoon = SunCalc.getPosition(rawSun.solarNoon, lat, lon);
  const posNadir = SunCalc.getPosition(rawSun.nadir, lat, lon);
  let polar = null;
  if (posNoon.altitude > 0 && posNadir.altitude > 0) polar = "day";
  else if (posNoon.altitude < 0 && posNadir.altitude < 0) polar = "night";

  let dayLengthMs;
  if (polar === "day") dayLengthMs = 86400000;
  else if (polar === "night") dayLengthMs = 0;
  else dayLengthMs = (sun.sunrise && sun.sunset) ? sun.sunset - sun.sunrise : null;

  const yesterdayLen = dayLength(new Date(date.getTime() - 86400000), lat, lon);
  const dayDeltaMs = (dayLengthMs != null && yesterdayLen != null) ? dayLengthMs - yesterdayLen : null;

  const turning = findTurning(date, lat, lon, dayDeltaMs);

  // Verified ordering: nightEnd < nauticalDawn < dawn < sunrise ...
  // sunset < dusk < nauticalDusk < night. A leg whose endpoint is null
  // becomes null (never a half-interval); a category with both legs null
  // collapses to null itself (see the "no astronomical/nautical night"
  // degrade modes — the row then prints a fact, not a dash).
  const leg = (aKey, bKey) => (sun[aKey] && sun[bKey]) ? [sun[aKey], sun[bKey]] : null;
  const category = (am, pm) => (am || pm) ? { am, pm } : null;
  const twilight = {
    civil: category(leg("dawn", "sunrise"), leg("sunset", "dusk")),
    nautical: category(leg("nauticalDawn", "dawn"), leg("dusk", "nauticalDusk")),
    astronomical: category(leg("nightEnd", "nauticalDawn"), leg("nauticalDusk", "night"))
  };

  const golden = {
    am: (sun.sunrise && sun.goldenHourEnd) ? [sun.sunrise, sun.goldenHourEnd] : null,
    pm: (sun.goldenHour && sun.sunset) ? [sun.goldenHour, sun.sunset] : null
  };

  // getMoonTimes omits `rise`/`set` entirely (not null) roughly monthly, and
  // returns {alwaysUp:true}/{alwaysDown:true} at extreme latitudes instead —
  // normalise all three shapes into one object so the renderer never has to
  // know which one it got.
  const rawMoon = SunCalc.getMoonTimes(date, lat, lon);
  const illum = SunCalc.getMoonIllumination(date);
  const moon = {
    rise: d(rawMoon.rise),
    set: d(rawMoon.set),
    alwaysUp: !!rawMoon.alwaysUp,
    alwaysDown: !!rawMoon.alwaysDown,
    fraction: illum.fraction,
    phase: illum.phase,
    angle: illum.angle,
    waxing: illum.phase < 0.5,
    phaseName: phaseName(illum.phase)
  };

  const nowMs = date.getTime();
  const events = { nextFull: nextFullMoon(nowMs), nextNew: nextNewMoon(nowMs) };
  const next = nextEvent(date, lat, lon, sun, moon);
  const track = sampleTrack(date, lat, lon);

  return {
    sun, polar, dayLengthMs, dayDeltaMs, turning, twilight, golden, moon,
    events, next, track, tzHint: tzHint(lon)
  };
}

// ---- formatters (local to this module — only SKY formats durations this way) --

function fmtHMS(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h + "H " + pad(m, 2) + "M " + pad(ss, 2) + "S";
}
// Minutes+seconds only (day-length deltas never reach an hour); the sign is
// carried by the GAINING/LOSING word at the call site, not a glyph — "-2M
// 23S" reads as a temperature to anyone scanning.
function fmtDelta(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  const m = Math.floor(s / 60), ss = s % 60;
  return m + "M " + pad(ss, 2) + "S";
}
// Hours+minutes only, for the countdown row (a "2H 14M 07S" countdown feels
// falsely precise, and reprinting seconds would fight the 30s tick).
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h + "H " + pad(m, 2) + "M";
}
// util.fmt() plus a " +1" (or " +N") suffix when the event's local calendar
// date differs from today's — moonset routinely lands after midnight.
function at(date, todayMidnight) {
  if (!date) return "--";
  const diffDays = Math.round((localMidnight(date) - todayMidnight) / 86400000);
  return fmt(date) + (diffDays > 0 ? " +" + diffDays : "");
}
function span(a, b, mid) { return at(a, mid) + " – " + at(b, mid); }
function dateAbbr(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase();
}
function dateAndDays(date, now) {
  if (!date) return "--";
  const days = Math.round((date.getTime() - now.getTime()) / 86400000);
  return dateAbbr(date) + " · IN " + days + (days === 1 ? " DAY" : " DAYS");
}
function fmtUtcOffset(h) {
  return "UTC" + (h < 0 ? "−" : "+") + pad(Math.abs(h), 2);
}
function nextText(sky, now) {
  if (!sky || !sky.next) return "--";
  return sky.next.label + " IN " + fmtDur(sky.next.at.getTime() - now.getTime());
}

// ---- rendering ------------------------------------------------------------

function row(k, v) { return [el("span", { class: "k" }, k), el("span", { class: "v" }, v)]; }
function note(txt) { return el("div", { class: "srcnote" }, txt); }

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// The one piece of bespoke SVG in this module — a glyph, not a plot. The lit
// region is the outer semicircle of radius r on the illuminated limb (right
// for waxing, left for waning) plus an inner elliptical arc with
// rx = r * |1 - 2*fraction|; the inner arc's sweep flag flips at fraction
// 0.5 so crescents bow the same way as the outer arc (a thin sliver) while
// gibbous phases bow the opposite way (nearly the full disc). Verified
// against first quarter (fraction=0.5, waxing): rx collapses to 0 (a
// straight terminator) and the lit shape is exactly the right half of the
// disc, matching the real sky convention this glyph follows.
function moonDisc(fraction, waxing) {
  const cx = 32, cy = 32, r = 28;
  const rx = r * Math.abs(1 - 2 * fraction);
  const outerSweep = waxing ? 1 : 0;
  const innerSweep = fraction < 0.5 ? outerSweep : 1 - outerSweep;
  const path = "M " + cx + " " + (cy - r) +
    " A " + r + " " + r + " 0 0 " + outerSweep + " " + cx + " " + (cy + r) +
    " A " + rx.toFixed(2) + " " + r + " 0 0 " + innerSweep + " " + cx + " " + (cy - r) + " Z";
  const root = svgEl("svg", { class: "moondisc", viewBox: "0 0 64 64" });
  root.append(
    svgEl("circle", { class: "dark", cx, cy, r }),
    svgEl("path", { class: "lit", d: path }),
    svgEl("circle", { class: "rim", cx, cy, r, fill: "none" })
  );
  return root;
}

function turningNote(t) {
  if (!t) return null;
  return t.kind + " DAY " + dateAbbr(t.date) + " · " + fmtDur(t.dayLengthMs) + " · IN " + t.days + " DAYS";
}

function heroSection(sky, now, mid) {
  const bigNum = el("div", { class: "bigtemp" }, sky.dayLengthMs != null ? fmtHMS(sky.dayLengthMs) : "--");
  const condTxt = sky.dayDeltaMs == null
    ? "DAY-LENGTH CHANGE UNAVAILABLE AT THIS LATITUDE"
    : (sky.dayDeltaMs < 0 ? "LOSING " : "GAINING ") + fmtDelta(sky.dayDeltaMs) + " PER DAY";
  const bigCond = el("div", { class: "bigcond" }, condTxt);

  const nextV = el("span", { class: "v" }, nextText(sky, now));
  nextEl = nextV;
  const grid = el("div", { class: "grid" }, el("span", { class: "k" }, "NEXT"), nextV);

  const kids = [el("div", { class: "sect" }, "DAY LENGTH"), bigNum, bigCond, grid];
  const tnote = turningNote(sky.turning);
  if (tnote) kids.push(note(tnote));
  return el("div", { class: "col" }, ...kids);
}

function polarNoteText(polar) {
  if (polar === "day") return "SUN UP ALL DAY — NO SUNRISE OR SUNSET";
  if (polar === "night") return "SUN DOWN ALL DAY — NO SUNRISE OR SUNSET";
  return null;
}

function legPart(leg, mid) { return leg ? span(leg[0], leg[1], mid) : "NONE"; }
function twilightValue(cat, bothNoneText, mid) {
  if (!cat) return bothNoneText;
  return legPart(cat.am, mid) + " / " + legPart(cat.pm, mid);
}
function spanOrDash(pair, mid) { return pair ? span(pair[0], pair[1], mid) : "--"; }

function sunSection(sky, now, mid) {
  const host = el("div");
  const x0 = sky.track.x0, x1 = sky.track.x1;
  chartInst = chart(host, {
    height: 200,
    now: now.getTime(),
    x: { min: x0, max: x1 },
    y: { unit: "°" },
    cursor: true,
    series: [
      { type: "line", data: sky.track.sun, token: "--pred-soft", width: 1.75, label: "SUN" },
      { type: "line", data: sky.track.moon, token: "--sub-faint", width: 1.25, label: "MOON" },
      { type: "line", data: [[x0, 0], [x1, 0]], token: "--sub-dim", width: 1, dash: "2 4" }
    ]
  });

  const gridRows = [
    ...row("SUNRISE", sky.sun.sunrise ? at(sky.sun.sunrise, mid) : "--"),
    ...row("SOLAR NOON", sky.sun.solarNoon ? at(sky.sun.solarNoon, mid) : "--"),
    ...row("SUNSET", sky.sun.sunset ? at(sky.sun.sunset, mid) : "--"),
    ...row("GOLDEN HOUR AM", spanOrDash(sky.golden.am, mid)),
    ...row("GOLDEN HOUR PM", spanOrDash(sky.golden.pm, mid)),
    ...row("CIVIL TWILIGHT", twilightValue(sky.twilight.civil, "NONE", mid)),
    ...row("NAUTICAL TWILIGHT", twilightValue(sky.twilight.nautical, "NONE — SUN STAYS ABOVE −12°", mid)),
    ...row("ASTRONOMICAL TWILIGHT", twilightValue(sky.twilight.astronomical, "NONE — SUN STAYS ABOVE −18°", mid))
  ];

  const kids = [
    el("div", { class: "sect" }, "SUN"),
    host,
    note("0° = HORIZON · DRAG ACROSS THE CHART TO READ SUN AND MOON ALTITUDE AT ANY MINUTE"),
    el("div", { class: "grid" }, ...gridRows)
  ];
  const pn = polarNoteText(sky.polar);
  if (pn) kids.push(note(pn));
  kids.push(note("SUN TIMES ±1 MIN · SEA-LEVEL HORIZON, NO TERRAIN SHADING · GOLDEN HOUR = SUN BELOW 6°"));
  return el("div", { class: "col" }, ...kids);
}

function moonSection(sky, now, mid) {
  const disc = moonDisc(sky.moon.fraction, sky.moon.waxing);
  const illumEl = el("div", { class: "skyillum" }, Math.round(sky.moon.fraction * 100) + "%");
  const phaseEl = el("div", { class: "skyphase" }, sky.moon.phaseName + " · ILLUMINATED");
  const skymoon = el("div", { class: "skymoon" }, disc, el("div", { class: "col" }, illumEl, phaseEl));

  const hidden = sky.moon.alwaysUp || sky.moon.alwaysDown;
  const riseVal = hidden ? "--" : (sky.moon.rise ? at(sky.moon.rise, mid) : "--");
  const setVal = hidden ? "--" : (sky.moon.set ? at(sky.moon.set, mid) : "--");
  const gridRows = [
    ...row("MOONRISE", riseVal),
    ...row("MOONSET", setVal),
    ...row("NEXT FULL", dateAndDays(sky.events.nextFull, now)),
    ...row("NEXT NEW", dateAndDays(sky.events.nextNew, now))
  ];

  const kids = [el("div", { class: "sect" }, "MOON"), skymoon, el("div", { class: "grid" }, ...gridRows)];
  if (sky.moon.alwaysUp) kids.push(note("MOON ABOVE THE HORIZON ALL DAY"));
  else if (sky.moon.alwaysDown) kids.push(note("MOON BELOW THE HORIZON ALL DAY"));
  else {
    if (!sky.moon.rise) kids.push(note("NO MOONRISE ON THIS CALENDAR DAY — THE MOON RISES ABOUT 50 MIN LATER EACH DAY"));
    if (!sky.moon.set) kids.push(note("NO MOONSET ON THIS CALENDAR DAY"));
  }
  kids.push(note("MOON TIMES ±5 MIN · PHASE DATES ±" + SKY_PHASE_UNCERTAINTY_H +
    " H — SUNCALC USES A LOW-ORDER LUNAR MODEL"));
  kids.push(note("DISC DRAWN NORTH-UP (CELESTIAL) — APPARENT TILT IN THE SKY VARIES WITH THE MOON'S POSITION"));
  return el("div", { class: "col" }, ...kids);
}

function placeLine(loc) {
  return loc.name + (loc.state ? ", " + loc.state : "") + " · SKY · COMPUTED ON DEVICE";
}

function paint(sky, loc, now) {
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  const mid = localMidnight(now);
  const kids = [
    el("div", { class: "place" }, placeLine(loc)),
    heroSection(sky, now, mid),
    sunSection(sky, now, mid),
    moonSection(sky, now, mid)
  ];
  if (sky.tzHint) {
    kids.push(note("TIMES SHOWN IN DEVICE TIME (" + fmtUtcOffset(sky.tzHint.deviceH) + ") — THIS LOCATION LIES NEAR " +
      fmtUtcOffset(sky.tzHint.lonH)));
  }
  kids.push(el("div", { class: "attrib" },
    "COMPUTED ON DEVICE · SUNCALC © 2011–2015 V. AGAFONKIN (BSD-2) · NO NETWORK USED"));
  boardEl.replaceChildren(...kids);
}

function render() {
  if (!boardEl) return;
  if (!sc()) {
    boardEl.replaceChildren(el("div", { class: "bigmsg" },
      "ASTRONOMY ENGINE UNAVAILABLE — vendor/suncalc.js DID NOT LOAD"));
    return;
  }
  const loc = locations.active();
  if (!loc) {
    boardEl.replaceChildren(el("div", { class: "bigmsg" }, "NO LOCATION SET"));
    return;
  }
  const now = new Date();
  const sky = computeSky(now, loc.lat, loc.lon);
  paint(sky, loc, now);
  lastPaintedDay = localDayKey(now);
}

// ---- 30s countdown tick --------------------------------------------------
// Rewrites only the NEXT row's text node — a full repaint every 30s would
// tear down and rebuild the chart and throw away the user's crosshair drag
// mid-gesture. Recomputes computeSky() (still ~2ms) rather than caching the
// last result, so the module carries no state beyond what's listed above.

function tick() {
  if (!boardEl || !boardEl.isConnected) { stopTick(); return; }
  const now = new Date();
  if (localDayKey(now) !== lastPaintedDay) { render(); return; }   // calendar day rolled — full repaint
  if (!nextEl) return;
  const loc = locations.active();
  if (!loc || !sc()) return;
  const sky = computeSky(now, loc.lat, loc.lon);
  nextEl.textContent = nextText(sky, now);
}

function startTick() {
  stopTick();
  tickTimer = setInterval(tick, SKY_TICK_MS);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

function onEnter() {
  render();
  startTick();
}

// ---- public ---------------------------------------------------------------

export function init() {
  boardEl = document.getElementById("board-sky");
  if (!boardEl) return;
  boards.register({ id: "sky", label: "SKY", el: boardEl, render, onEnter });

  locations.onChange(() => { if (boards.current() === "sky") render(); });

  state.on("view", ({ view, board }) => {
    if (view === View.BOARD && board === "sky") startTick(); else stopTick();
  });

  // structurally incapable of going down — the status panel says so
  setHealth("sky", "SKY   ", true, "on-device");
}
