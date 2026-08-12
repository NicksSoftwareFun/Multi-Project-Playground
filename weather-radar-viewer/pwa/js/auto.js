// Auto mode: a data-driven kiosk playlist.
// M0 sequence reproduces the classic cycle exactly: radar x2 (regional, then
// 175 km close-up) -> satellite 10 s -> NOW board 20 s -> repeat.
// Later milestones append conditional entries (e.g. SEVERE when alerts active).

import { HOME_VIEW, AUTO_CLOSE_KM } from "./config.js";
import * as store from "./store.js";
import * as mapMod from "./map.js";
import * as state from "./state.js";
import { View, Board } from "./state.js";
import * as timeline from "./timeline.js";
import * as alerts from "./alerts.js";

// The kiosk playlist. Conditional entries keep the loop lean when nothing is
// happening — the SEVERE board only earns screen time during active weather.
const SEQ = [
  { type: "radar", loops: 2 },
  { type: "sat", ms: 10000 },
  { type: "board", board: Board.NOW, ms: 20000 },
  { type: "board", board: Board.SEVERE, ms: 15000, when: () => alerts.activeCount() > 0 },
];

let autoOn = false;
let idx = 0;
let radarPass = 0;
let timer = null;
let fader = null;

export function isOn() { return autoOn; }
export function driving() { return autoOn && SEQ[idx].type === "radar" && state.getView() === View.RADAR; }

export function init() {
  fader = document.getElementById("fader");
  autoOn = store.loadAuto();
}

export function start() {
  if (!autoOn) return;
  enter(0);
}

export function setOn(on) {
  const was = autoOn;
  autoOn = on;
  store.saveAuto(on);
  if (on && !was) {
    enter(0);
  } else if (!on && was) {
    clearTimeout(timer);
    if (state.getView() !== View.RADAR) {
      fadeSwap(() => state.setView(View.RADAR));
    }
  }
}

export function fadeSwap(fn) {
  fader.classList.add("show");
  setTimeout(() => { fn(); fader.classList.remove("show"); }, 480);
}

// Called by the timeline tick when the frame is about to wrap to 0 during a
// radar phase. Returns true when auto consumed the wrap (phase transition).
export function handleWrap() {
  if (!driving()) return false;
  radarPass++;
  const step = SEQ[idx];
  if (radarPass >= (step.loops || 2)) {
    next();
    return true;
  }
  radarView(radarPass);   // second pass: zoom in on the location
  return false;
}

function next() { enter((idx + 1) % SEQ.length); }

function enter(i) {
  idx = i;
  clearTimeout(timer);
  const step = SEQ[idx];
  if (step.when && !step.when()) { next(); return; }

  if (step.type === "radar") {
    fadeSwap(() => {
      state.setView(View.RADAR);
      radarPass = 0;
      timeline.setPlaying(true);
      radarView(0);
      mapMod.show(0);
    });
    return;   // advanced by handleWrap()
  }
  if (step.type === "sat") {
    fadeSwap(() => state.setView(View.SAT));
  } else if (step.type === "board") {
    fadeSwap(() => state.setView(View.BOARD, step.board));
  }
  timer = setTimeout(next, step.ms);
}

// pass 0: zoomed-out regional; pass 1+: AUTO_CLOSE_KM across — centered on the location
function radarView(pass) {
  const m = mapMod.getMap();
  if (!m) return;
  const ll = mapMod.getActiveLatLon() || HOME_VIEW.center;
  m.setView(ll, pass === 0 ? 5 : mapMod.zoomForWidthKm(AUTO_CLOSE_KM, ll[0]));
}
