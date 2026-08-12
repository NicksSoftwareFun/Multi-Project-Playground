// Settings overlay: ZIP entry (kept for kiosk parity — adds/switches through
// the locations model) + Auto Mode toggle.

import * as state from "./state.js";
import * as wx from "./wx.js";
import * as auto from "./auto.js";
import * as locations from "./locations.js";

let zipInput, autoChk, setMsg;

export function init() {
  zipInput = document.getElementById("zipInput");
  autoChk = document.getElementById("autoChk");
  setMsg = document.getElementById("setMsg");

  const open = () => {
    const loc = wx.getLoc();
    zipInput.value = loc && loc.zip ? loc.zip : "";
    autoChk.checked = auto.isOn();
    setMsg.textContent = "";
    setMsg.className = "msg";
    state.openOverlay("settings");
    zipInput.focus();
  };
  document.getElementById("settingsBtn").addEventListener("click", open);
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
  locations.addZip(zip)
    .then(() => {
      auto.setOn(autoChk.checked);
      state.closeOverlay("settings");
    })
    .catch((e) => {
      setMsg.textContent = e.message === "notfound" ? "ZIP NOT FOUND" : "LOOKUP FAILED — CHECK CONNECTION";
      setMsg.className = "msg err";
    });
}
