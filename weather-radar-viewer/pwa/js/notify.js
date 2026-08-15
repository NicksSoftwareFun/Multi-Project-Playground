// Alert notifications menu (Android shell only).
//
// Split of responsibilities: this module owns the settings UI and persistence;
// the shell owns delivery — it polls api.weather.gov in the background for the
// saved ZIP locations and posts system notifications, so alerts arrive even
// with the app closed. Whenever the settings or the location list change, the
// full config (toggles + categories + ZIP locations) is pushed to the shell
// over the SkywatchShell JS bridge.
//
// On the hosted site there is no bridge and no background process, so the
// bell button stays hidden there.

import { NOTIFY_CATS } from "./config.js";
import { el } from "./util.js";
import * as state from "./state.js";
import * as locations from "./locations.js";

const KEY = "skywatch_notify";

let prefs = { enabled: false, warnings: true, watches: true, cats: {} };
let permEl;

function bridge() { return window.SkywatchShell || null; }

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") prefs = Object.assign(prefs, saved);
  } catch { /* defaults */ }
  if (!prefs.cats || typeof prefs.cats !== "object") prefs.cats = {};
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* quota */ }
}

// unset category = on: new categories default to enabled
export function catOn(id) {
  return Object.prototype.hasOwnProperty.call(prefs.cats, id) ? !!prefs.cats[id] : true;
}

// Everything the background checker needs, in one message. GPS entries are
// left out on purpose: the shell cannot re-fix the position in the background,
// so notifications only cover the ZIPs the user typed in.
function push() {
  const b = bridge();
  if (!b || !b.setNotifyConfig) return;
  const cfg = {
    enabled: !!prefs.enabled,
    warnings: !!prefs.warnings,
    watches: !!prefs.watches,
    cats: Object.fromEntries(NOTIFY_CATS.map((c) => [c.id, catOn(c.id)])),
    locations: locations.list()
      .filter((l) => l.kind === "zip")
      .map((l) => ({ id: l.id, zip: l.zip, lat: l.lat, lon: l.lon,
                     name: l.name + (l.state ? ", " + l.state : "") }))
  };
  try { b.setNotifyConfig(JSON.stringify(cfg)); } catch { /* older shell */ }
}

export function init() {
  load();
  const btn = document.getElementById("notifBtn");
  if (!btn) return;
  if (!bridge()) return;               // hosted site: delivery lives in the APK
  btn.hidden = false;
  buildSheet();
  btn.addEventListener("click", () => {
    if (state.overlayOpen("notifsheet")) state.closeOverlay("notifsheet");
    else openSheet();
  });
  locations.onChange(push);            // ZIP added/removed → checker follows
  push();                              // sync the shell with saved state at boot
}

export function openSheet() {
  updatePermMsg();
  state.openOverlay("notifsheet");
}

function row(id, label, checked, onchange, cls) {
  const input = el("input", { type: "checkbox", id });
  input.checked = checked;
  input.addEventListener("change", () => onchange(input.checked));
  return el("label", { class: "notifrow" + (cls ? " " + cls : ""), for: id },
    el("span", { class: "nm" }, label), input);
}

function buildSheet() {
  permEl = el("div", { class: "msg", id: "notifPerm" });

  const catRows = el("div", { class: "notifcats", id: "notifCats" });
  for (const c of NOTIFY_CATS) {
    catRows.append(row("nc_" + c.id, c.label, catOn(c.id),
      (on) => { prefs.cats[c.id] = on; save(); push(); }));
  }

  const sheet = el("div", { id: "notifsheet" },
    el("div", { class: "grab" }),
    el("div", { class: "title" }, "NOTIFICATIONS"),
    row("nc_master", "ALERT NOTIFICATIONS", !!prefs.enabled, onMaster, "master"),
    el("div", { class: "sect" }, "SEND FOR"),
    el("div", { class: "notiftypes" },
      row("nc_warn", "WARNINGS", !!prefs.warnings,
        (on) => { prefs.warnings = on; save(); push(); }),
      row("nc_watch", "WATCHES", !!prefs.watches,
        (on) => { prefs.watches = on; save(); push(); })),
    el("div", { class: "sect" }, "CATEGORIES"),
    catRows,
    permEl,
    el("div", { class: "note" },
      "CHECKS YOUR SAVED ZIP LOCATIONS ABOUT EVERY 15 MINUTES, EVEN WITH THE APP CLOSED.")
  );
  document.getElementById("screen").appendChild(sheet);
}

function onMaster(on) {
  prefs.enabled = on;
  save();
  push();
  const b = bridge();
  // Android 13+ needs a runtime permission before anything can be posted;
  // ask the moment the user opts in, while intent is obvious.
  if (on && b && b.requestNotificationPermission) {
    try { b.requestNotificationPermission(); } catch { /* older shell */ }
  }
  updatePermMsg();
}

function updatePermMsg() {
  if (!permEl) return;
  const b = bridge();
  let blocked = false;
  try {
    blocked = !!(b && b.areNotificationsEnabled && !b.areNotificationsEnabled());
  } catch { /* older shell: assume fine */ }
  const show = prefs.enabled && blocked;
  permEl.textContent = show
    ? "NOTIFICATIONS ARE BLOCKED FOR SKYWATCH IN ANDROID SETTINGS" : "";
  permEl.className = "msg" + (show ? " err" : "");
}
