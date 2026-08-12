// Full-frame GOES-East viewer (raw STAR CDN image, refreshed every 5 minutes).

import { GOES_PRIMARY, GOES_FALLBACK, REFRESH_MS } from "./config.js";
import * as net from "./net.js";
import * as state from "./state.js";
import { View } from "./state.js";

let satview, satimg, satBtn;
let goesOk = false;
let goesFetched = null;
let triedFallback = false;

export function getFetched() { return goesFetched; }

export function init() {
  satview = document.getElementById("satview");
  satimg = document.getElementById("satimg");
  satBtn = document.getElementById("satBtn");

  satimg.addEventListener("load", () => {
    goesOk = true;
    goesFetched = new Date();
    satview.classList.remove("err");
    net.setHealth("goes", "GOES-E", true, "ok");
    state.emit("goes", {});
  });
  satimg.addEventListener("error", () => {
    if (!triedFallback) {
      triedFallback = true;
      satimg.src = GOES_FALLBACK + "?t=" + Date.now();
      return;
    }
    goesOk = false;
    satview.classList.add("err");
    net.setHealth("goes", "GOES-E", false, "unavailable");
  });

  satBtn.addEventListener("click", () => {
    if (state.getView() === View.SAT) state.goBack();
    else state.setView(View.SAT);
  });

  state.on("view", ({ view }) => {
    satBtn.textContent = view === View.SAT ? "RADAR" : "SAT";
    satBtn.classList.toggle("on", view === View.SAT);
    if (view === View.SAT && (!goesFetched || Date.now() - goesFetched.getTime() > REFRESH_MS)) {
      loadGoes();
    }
  });

  loadGoes();
  setInterval(loadGoes, REFRESH_MS);
}

export function loadGoes() {
  triedFallback = false;
  satimg.src = GOES_PRIMARY + "?t=" + Date.now();
}
