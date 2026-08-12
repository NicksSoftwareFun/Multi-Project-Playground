// Boot. Order matters: state (history sentinel) -> net/status -> map -> views.

import { NOW_I } from "./config.js";
import { fmt, pad } from "./util.js";
import * as state from "./state.js";
import * as net from "./net.js";
import * as mapMod from "./map.js";
import * as sat from "./sat.js";
import * as wx from "./wx.js";
import * as locations from "./locations.js";
import * as timeline from "./timeline.js";
import * as auto from "./auto.js";
import * as settings from "./settings.js";

const screenEl = document.getElementById("screen");

state.init(screenEl);
net.initStatus(document.getElementById("status"));
mapMod.init();
sat.init();
locations.init();   // migrates storage, builds the sheet — before wx reads active()
wx.init();          // reads locations.active(), feeds map.setActiveLatLon
auto.init();
timeline.init();
settings.init();

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
auto.start();               // begins the kiosk cycle if enabled

// PWA: offline app shell
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* not fatal */ });
}
