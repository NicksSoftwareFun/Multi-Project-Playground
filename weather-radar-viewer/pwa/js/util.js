// Pure helpers. No DOM ids, no fetches, no state.

export function pad(n, w) { return String(n).padStart(w, "0"); }
export function fmt(d) { return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2); }
export function fmtLead(min) { return "+" + Math.floor(min / 60) + ":" + pad(min % 60, 2); }
export function degF(x) { return x == null || isNaN(x) ? "--" : Math.round(x) + "°F"; }
export function pct(x) { return x == null || isNaN(x) ? "--" : Math.round(x) + "%"; }
export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

export function utcStamp(d, minStep) {
  const m = Math.floor(d.getUTCMinutes() / minStep) * minStep;
  return "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2) +
         pad(d.getUTCHours(), 2) + pad(m, 2);
}

// Safe-DOM convention: build nodes, never interpolate third-party strings into
// innerHTML. esc() exists for the rare template-string case; prefer el().
export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Expand an NWS gridpoint ISO8601 validTime like "2026-08-12T06:00:00+00:00/PT13H"
// into { start: Date, hours: n, repeat: n }. Used by winter gridpoint parsing (M6).
//
// The live M6 probe only ever saw the plain "<start>/<duration>" shape, so the
// leading "Rn/" repeating-interval form is handled defensively rather than
// because it is known to occur — ISO 8601 permits it and a silently
// mis-parsed start date would move a snow total onto the wrong day.
// Returns null (never a half-parsed object) when the start instant is
// unreadable, so callers can drop the entry instead of doing arithmetic on
// an Invalid Date.
export function parseValidTime(vt) {
  const parts = String(vt).split("/");
  let repeat = 1;
  const rep = /^R(\d*)$/i.exec(parts[0] || "");
  if (rep) {
    parts.shift();
    repeat = rep[1] === "" ? 1 : parseInt(rep[1], 10) + 1;   // R3 = the run plus 3 repeats
    if (!isFinite(repeat) || repeat < 1) repeat = 1;
  }
  const start = new Date(parts[0]);
  if (!isValidDate(start)) return null;
  const dur = parts[1] || "";
  let hours = 0;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(dur);
  if (m) {
    hours = parseInt(m[1] || 0, 10) * 24 + parseInt(m[2] || 0, 10) + parseInt(m[3] || 0, 10) / 60;
  }
  return { start, hours: hours || 1, repeat };
}

// Turn NWS gridpoint {validTime, value} entries into a chronological series of
// NON-OVERLAPPING intervals: [{ start: Date, end: Date, hours, value }].
//
// Double-counting is the whole hazard here. A snow total that adds two
// intervals covering the same six hours is worse than no total at all, so any
// overlap is resolved by clipping the later interval to the part of the
// timeline nothing has claimed yet and pro-rating its value by the surviving
// fraction. NWS publishes non-overlapping intervals today, in which case every
// fraction is 1 and this is a plain pass-through; it only bites if that ever
// stops being true. Entries with a null value or an unreadable validTime are
// dropped, never coerced to zero — "no forecast" is not "no snow".
export function expandGridSeries(values) {
  const raw = [];
  for (const v of values || []) {
    if (!v || v.value == null || isNaN(v.value)) continue;
    const p = parseValidTime(v.validTime);
    if (!p) continue;
    const ms = p.hours * 3600000;
    for (let r = 0; r < p.repeat; r++) {
      const startMs = p.start.getTime() + r * ms;
      raw.push({ startMs, endMs: startMs + ms, value: v.value });
    }
  }
  raw.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out = [];
  let covered = -Infinity;
  for (const iv of raw) {
    const span = iv.endMs - iv.startMs;
    if (span <= 0) continue;
    const startMs = Math.max(iv.startMs, covered);
    if (iv.endMs <= startMs) continue;              // wholly inside an earlier interval
    const frac = (iv.endMs - startMs) / span;
    out.push({
      start: new Date(startMs), end: new Date(iv.endMs),
      hours: (iv.endMs - startMs) / 3600000,
      value: iv.value * frac
    });
    covered = iv.endMs;
  }
  return out;
}

// Sum an expandGridSeries() series over [fromMs, toMs), pro-rating any interval
// that only partly overlaps the window. Returns null — not 0 — when no interval
// touches the window at all, so a caller can tell "the forecast says none" from
// "the forecast does not reach that far".
export function sumGridWindow(series, fromMs, toMs) {
  let total = 0, touched = false;
  for (const iv of series || []) {
    const a = Math.max(iv.start.getTime(), fromMs);
    const b = Math.min(iv.end.getTime(), toMs);
    if (b <= a) continue;
    const span = iv.end.getTime() - iv.start.getTime();
    total += span > 0 ? iv.value * ((b - a) / span) : 0;
    touched = true;
  }
  return touched ? total : null;
}

// Slippy-map tile coordinates for a lon/lat at zoom z (Web Mercator, the
// scheme every {z}/{x}/{y} tile service uses). Used to aim a single canary
// tile request at the active location instead of a fixed corner of the map.
export function tileXY(lon, lat, z) {
  const n = Math.pow(2, z);
  const latR = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180;
  const x = Math.floor(((Number(lon) + 180) / 360) * n);
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
  return { z, x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

// Inches, already converted by the caller — this only formats. "--" for
// missing, never 0.0 standing in for "unknown".
export function inches(x, dp) {
  if (x == null || isNaN(x)) return "--";
  return x.toFixed(dp == null ? 1 : dp) + " IN";
}

// SunCalc's getTimes() signals "this event doesn't happen here today" with an
// Invalid Date object (NaN time), never null/undefined/a missing key — the
// sharpest trap in the vendored astronomy engine (see astro.js). Lives here
// rather than in astro.js because M6's ISO-duration/gridpoint parsing wants
// the same guard.
export function isValidDate(d) { return d instanceof Date && !isNaN(d.getTime()); }

// Magnus dewpoint (°C in, °C out) — soundings (M7)
export function dewpointC(tempC, rhPct) {
  if (tempC == null || rhPct == null || rhPct <= 0) return null;
  const a = 17.625, b = 243.04;
  const g = Math.log(rhPct / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}
