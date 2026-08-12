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
// into { start: Date, hours: n }. Used by winter gridpoint parsing (M6).
export function parseValidTime(vt) {
  const [startIso, dur] = String(vt).split("/");
  const start = new Date(startIso);
  let hours = 0;
  const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(dur || "");
  if (m) hours = (parseInt(m[1] || 0, 10) * 24) + parseInt(m[2] || 0, 10) + Math.ceil(parseInt(m[3] || 0, 10) / 60);
  return { start, hours: hours || 1 };
}

// Magnus dewpoint (°C in, °C out) — soundings (M7)
export function dewpointC(tempC, rhPct) {
  if (tempC == null || rhPct == null || rhPct <= 0) return null;
  const a = 17.625, b = 243.04;
  const g = Math.log(rhPct / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}
