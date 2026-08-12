// Map layers drawer. Feature modules register a toggleable overlay; the drawer
// owns the UI, persistence, and per-layer health dots.

import { el } from "./util.js";
import * as state from "./state.js";

const KEY = "skywatch_layers";
const registry = [];      // [{ id, label, defaultOn, onToggle, note }]
let prefs = {};
let rowsEl;

function loadPrefs() {
  try { prefs = JSON.parse(localStorage.getItem(KEY) || "{}"); }
  catch { prefs = {}; }
}
function savePrefs() {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* quota */ }
}

export function isOn(id) {
  const spec = registry.find((r) => r.id === id);
  if (!spec) return false;
  return Object.prototype.hasOwnProperty.call(prefs, id) ? !!prefs[id] : !!spec.defaultOn;
}

export function register(spec) {
  registry.push(spec);
  if (rowsEl) render();
  // apply the persisted state immediately so layers come back after reload
  if (spec.onToggle) spec.onToggle(isOn(spec.id));
}

export function set(id, on) {
  const spec = registry.find((r) => r.id === id);
  if (!spec) return;
  prefs[id] = !!on;
  savePrefs();
  if (spec.onToggle) spec.onToggle(!!on);
  render();
}

// health: true = ok, false = unavailable, null/undefined = unknown/idle
const health = new Map();
export function setHealth(id, ok, note) {
  health.set(id, { ok, note });
  render();
}

export function init() {
  loadPrefs();
  rowsEl = document.getElementById("layerRows");
  document.getElementById("layersBtn").addEventListener("click", () => {
    if (state.overlayOpen("layers")) state.closeOverlay("layers");
    else state.openOverlay("layers");
  });
  render();
}

function render() {
  if (!rowsEl) return;
  rowsEl.replaceChildren(...registry.map((spec) => {
    const on = isOn(spec.id);
    const h = health.get(spec.id);
    const dotClass = "hdot" + (h == null ? "" : (h.ok ? " ok" : " bad"));
    const row = el("button", { class: "layerrow" + (on ? " on" : ""), "aria-pressed": String(on) },
      el("span", { class: dotClass, title: (h && h.note) || "" }),
      el("span", { class: "lname" }, spec.label),
      el("span", { class: "lstate" }, h && !h.ok ? "N/A" : (on ? "ON" : "OFF"))
    );
    row.addEventListener("click", () => set(spec.id, !isOn(spec.id)));
    return row;
  }));
}
