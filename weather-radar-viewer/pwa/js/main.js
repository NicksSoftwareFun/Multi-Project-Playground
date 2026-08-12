// Boot. Order matters: state (history sentinel) -> net/status -> map -> views.

import { NOW_I } from "./config.js";
import { fmt, pad } from "./util.js";
import * as state from "./state.js";
import * as net from "./net.js";
import * as mapMod from "./map.js";
import * as sat from "./sat.js";
import * as wx from "./wx.js";
import * as locations from "./locations.js";
import * as layers from "./layers.js";
import * as boards from "./boards.js";
import * as alerts from "./alerts.js";
import * as spc from "./spc.js";
import * as forecastx from "./forecastx.js";
import * as airq from "./airq.js";
import * as astro from "./astro.js";
import * as timeline from "./timeline.js";

const screenEl = document.getElementById("screen");

state.init(screenEl);
net.initStatus(document.getElementById("status"));
mapMod.init();
sat.init();
layers.init();      // loads layer prefs — before any module registers a layer
locations.init();   // migrates storage, builds the sheet — before wx reads active()
// Board registration order is deck order: NOW ⇄ CAST ⇄ SEVERE ⇄ AIR ⇄ SKY
wx.init();          // reads locations.active(), registers the NOW board
forecastx.init();   // CAST board (lazy: fetches on first open)
alerts.init();      // registers the alerts layer + SEVERE board, starts polling
airq.init();        // AIR board (lazy)
astro.init();   // SKY board (offline: computed on-device from vendor/suncalc.js)
spc.init();         // registers outlook/MD/tropical layers (lazy: no fetch until on)
boards.init();      // deck navigation, after boards are registered
timeline.init();

// board entry: NOW board renders when the view flips (wired in wx.init)

// clock + countdown to the next radar rebuild
const clockEl = document.getElementById("clock");
const updEl = document.getElementById("updCount");
setInterval(() => {
  clockEl.textContent = fmt(new Date());
  const s = Math.max(0, Math.round((mapMod.nextRefreshAt() - Date.now()) / 1000));
  updEl.textContent = Math.floor(s / 60) + ":" + pad(s % 60, 2);
}, 1000);
clockEl.textContent = fmt(new Date());

// default view on open: radar centered on the active location, 200 km across
mapMod.goDefaultView();
mapMod.show(NOW_I);         // first frame paint

// PWA: offline app shell
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* not fatal */ });
}
