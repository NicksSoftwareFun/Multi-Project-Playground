// Settings overlay: ZIP entry (Zippopotam geocode) + Auto Mode toggle.

import { ZIPPO } from "./config.js";
import { fetchT, okJson } from "./net.js";
import * as state from "./state.js";
import * as wx from "./wx.js";
import * as auto from "./auto.js";
import * as mapMod from "./map.js";

let zipInput, autoChk, setMsg;

export function init() {
  zipInput = document.getElementById("zipInput");
  autoChk = document.getElementById("autoChk");
  setMsg = document.getElementById("setMsg");

  const open = () => {
    const loc = wx.getLoc();
    zipInput.value = loc ? loc.zip : "";
    autoChk.checked = auto.isOn();
    setMsg.textContent = "";
    setMsg.className = "msg";
    state.openOverlay("settings");
    zipInput.focus();
  };
  document.getElementById("settingsBtn").addEventListener("click", open);
  document.getElementById("wxPanel").addEventListener("click", open);
  document.getElementById("cancelBtn").addEventListener("click", () => state.closeOverlay("settings"));
  document.getElementById("saveBtn").addEventListener("click", save);
  zipInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

function save() {
  const zip = zipInput.value.trim();
  if (zip === "") {            // no ZIP change — just apply the auto-mode choice
    auto.setOn(autoChk.checked);
    state.closeOverlay("settings");
    return;
  }
  if (!/^\d{5}$/.test(zip)) {
    setMsg.textContent = "ENTER A 5-DIGIT ZIP";
    setMsg.className = "msg err";
    return;
  }
  setMsg.textContent = "LOOKING UP " + zip + "…";
  setMsg.className = "msg";
  fetchT(ZIPPO + zip)
    .then((r) => { if (!r.ok) throw new Error("notfound"); return r.json(); })
    .then((j) => {
      const p = j.places[0];
      wx.setLoc({
        zip,
        lat: parseFloat(p.latitude),
        lon: parseFloat(p.longitude),
        name: p["place name"],
        state: p["state abbreviation"]
      });
      auto.setOn(autoChk.checked);
      state.closeOverlay("settings");
      mapMod.goDefaultView();
    })
    .catch((e) => {
      setMsg.textContent = e.message === "notfound" ? "ZIP NOT FOUND" : "LOOKUP FAILED — CHECK CONNECTION";
      setMsg.className = "msg err";
    });
}
