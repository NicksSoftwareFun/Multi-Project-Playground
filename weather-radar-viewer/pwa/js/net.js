// Network primitives + per-source health.
// RULE: never set a custom User-Agent header on any request — api.weather.gov's
// CORS preflight rejects it and the browser default UA is explicitly fine.

import { el } from "./util.js";

// a blocked domain often hangs instead of failing — time out so fallbacks engage fast
export function fetchT(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal })
    .catch((e) => { throw (e && e.name === "AbortError") ? new Error("TIMEOUT") : e; })
    .finally(() => clearTimeout(t));
}

export function okJson(r) {
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// ---- health registry (grows into the full source registry in M2) ----
// health: ok | down | idle; detail: short mono string shown in the status panel
const health = new Map();     // id -> { label, ok, detail }
let statusEl = null;

export function initStatus(elRef) { statusEl = elRef; }

export function setHealth(id, label, ok, detail) {
  health.set(id, { label, ok, detail: detail || (ok ? "ok" : "down") });
  renderStatus();
}

export function getHealth(id) { return health.get(id); }

function renderStatus() {
  if (!statusEl) return;
  statusEl.replaceChildren();
  for (const { label, ok, detail } of health.values()) {
    statusEl.append(
      el("span", null, label + " "),
      el("span", { class: ok ? "on" : "off" }, detail),
      el("br")
    );
  }
}
