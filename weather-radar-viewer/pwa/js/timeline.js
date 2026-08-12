// Timeline chrome: scrubber, play loop, frame badge/time, prediction frame.

import { PAST, NOW_I, NFRAMES, frameT, T_MIN, T_SPAN, FRAME_MS } from "./config.js";
import { pad, fmt, fmtLead } from "./util.js";
import * as map from "./map.js";
import * as state from "./state.js";
import { View } from "./state.js";
import * as sat from "./sat.js";
import * as wx from "./wx.js";

let playing = true;
let screenEl, trackbox, thumb, predTab, playBtn, srcBadge, frameTimeEl;

export function isPlaying() { return playing; }
export function setPlaying(on) {
  playing = on;
  playBtn.textContent = playing ? "⏸" : "▶";
}

export function init() {
  screenEl = document.getElementById("screen");
  trackbox = document.getElementById("trackbox");
  thumb = document.getElementById("thumb");
  predTab = document.getElementById("predTab");
  playBtn = document.getElementById("playBtn");
  srcBadge = document.getElementById("srcBadge");
  frameTimeEl = document.getElementById("frameTime");

  // --now-pct is derived from the frame constants so CSS can never desync
  const nowPct = ((0 - T_MIN) / T_SPAN * 100).toFixed(1) + "%";
  screenEl.style.setProperty("--now-pct", nowPct);

  playBtn.addEventListener("click", () => setPlaying(!playing));

  // scrubbing: nearest frame to the pointer position
  let scrubbing = false;
  const scrubTo = (i) => {
    setPlaying(false);
    if (i !== map.getFrame()) map.show(i); else updateChrome();
  };
  const fromEvent = (e) => {
    const r = trackbox.getBoundingClientRect();
    return frameAtFraction((e.clientX - r.left) / r.width);
  };
  trackbox.addEventListener("pointerdown", (e) => {
    scrubbing = true;
    trackbox.setPointerCapture(e.pointerId);
    scrubTo(fromEvent(e));
  });
  trackbox.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(fromEvent(e)); });
  trackbox.addEventListener("pointerup", () => { scrubbing = false; });
  trackbox.addEventListener("keydown", (e) => {
    const f = map.getFrame();
    if (e.key === "ArrowLeft" && f > 0) { e.preventDefault(); scrubTo(f - 1); }
    if (e.key === "ArrowRight" && f < NFRAMES - 1) { e.preventDefault(); scrubTo(f + 1); }
    if (e.key === "Home") { e.preventDefault(); scrubTo(NOW_I); }
  });

  // animation loop — drives the map's frame engine
  setInterval(() => {
    if (state.overlayOpen()) return;
    if (state.getView() !== View.RADAR) return;
    if (!playing) return;
    map.show((map.getFrame() + 1) % NFRAMES);
  }, FRAME_MS);

  state.on("frame", updateChrome);
  state.on("view", updateChrome);
  updateChrome();
}

function frameAtFraction(frac) {
  const t = T_MIN + Math.max(0, Math.min(1, frac)) * T_SPAN;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < NFRAMES; i++) {
    const d = Math.abs(frameT(i) - t);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function updateChrome() {
  const view = state.getView();
  screenEl.classList.toggle("pred", map.getFrame() >= PAST && view === View.RADAR);

  if (view === View.BOARD) {
    srcBadge.textContent = "CONDITIONS + FORECAST";
    srcBadge.className = "badge mrms";
    const loc = wx.getLoc();
    frameTimeEl.textContent = loc ? loc.name.toUpperCase() + ", " + loc.state : "";
    frameTimeEl.className = "frametime";
    return;
  }
  if (view === View.SAT) {
    srcBadge.textContent = "GOES-EAST GEOCOLOR · CONUS";
    srcBadge.className = "badge sat";
    const fetched = sat.getFetched();
    frameTimeEl.textContent = fetched ? "FETCHED " + fmt(fetched) : "--:--";
    frameTimeEl.className = "frametime";
    return;
  }

  const f = map.getFrame();
  const t = frameT(f);
  thumb.style.left = ((t - T_MIN) / T_SPAN * 100) + "%";
  trackbox.setAttribute("aria-valuenow", String(t));
  trackbox.setAttribute("aria-valuetext",
    t === 0 ? "now" : (t < 0 ? t + " minutes" : "+" + t + " minutes forecast"));
  const d = new Date(Date.now() + t * 60000);
  if (f < PAST) {
    srcBadge.textContent = "NEXRAD N0Q · IEM COMPOSITE";
    srcBadge.className = "badge mrms";
    frameTimeEl.textContent = fmt(d) + (f === NOW_I ? " · LATEST" : "");
    frameTimeEl.className = "frametime";
  } else {
    srcBadge.textContent = "HRRR REFD · " + fmtLead(t);
    srcBadge.className = "badge fcst";
    frameTimeEl.textContent = "FCST " + fmt(d);
    frameTimeEl.className = "frametime fcst";
    predTab.textContent = "PREDICTION · " + fmt(d);
  }
}
