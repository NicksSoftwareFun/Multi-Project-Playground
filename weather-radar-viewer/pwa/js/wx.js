// Conditions: Open-Meteo primary, NWS fallback, normalized to one record shape:
//   { src, temp, feels, rh, dew, windTxt, gust, pres, precip, cond,
//     hours: [{label, temp, pp}], daily: {hi, lo, pp} }
// Renders the corner wx panel and the NOW board.

import { OM_FORECAST, NWS_POINTS, WMO, DIRS, WX_REFRESH_MS } from "./config.js";
import { fmt, degF, pct, el } from "./util.js";
import { fetchT, okJson, setHealth } from "./net.js";
import * as store from "./store.js";
import * as mapMod from "./map.js";
import * as state from "./state.js";
import * as locations from "./locations.js";
import * as boards from "./boards.js";

let loc = null;          // the active location (mirror of locations.active())
let lastWx = null;

let wxPanel, wxPlace, wxHint, wxBig, wxTemp, wxCond, wxRows, statsEl;

export function getLoc() { return loc; }
export function getLastWx() { return lastWx; }

export function init() {
  wxPanel = document.getElementById("wxPanel");
  wxPlace = document.getElementById("wxPlace");
  wxHint = document.getElementById("wxHint");
  wxBig = document.getElementById("wxBig");
  wxTemp = document.getElementById("wxTemp");
  wxCond = document.getElementById("wxCond");
  wxRows = document.getElementById("wxRows");
  statsEl = document.getElementById("statsview");

  loc = locations.active();
  mapMod.setActiveLatLon(loc ? [loc.lat, loc.lon] : null);

  boards.register({ id: "now", label: "NOW", el: statsEl, render: renderStats });

  // location switch: paint the last-good snapshot instantly, then refresh live
  locations.onChange((newLoc) => {
    loc = newLoc;
    mapMod.setActiveLatLon(loc ? [loc.lat, loc.lon] : null);
    mapMod.goDefaultView();
    lastWx = loc ? store.loadSnap(loc.id) : null;
    if (lastWx) renderPanel(lastWx);
    if (state.getView() === "board") renderStats();
    refreshWx();
  });

  // Tapping the conditions panel opens the full data boards — the panel is a
  // summary of exactly what the NOW board shows, so it reads as "expand this".
  // Locations live on the ⌂ button in the side rail.
  wxPanel.addEventListener("click", () => boards.show("now"));

  state.on("view", ({ view }) => { if (view === "board") renderStats(); });

  // instant paint from snapshot on boot too
  if (loc) {
    lastWx = store.loadSnap(loc.id);
    if (lastWx) renderPanel(lastWx);
  }

  refreshWx();
  setInterval(refreshWx, WX_REFRESH_MS);
}

function omFetch() {
  const base = OM_FORECAST + "?latitude=" + loc.lat + "&longitude=" + loc.lon +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m," +
    "precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch" +
    "&timezone=auto&timeformat=unixtime";
  const full = base +
    "&hourly=temperature_2m,precipitation_probability,weather_code" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=2";
  return fetchT(full).then(okJson)
    .catch((e) => {
      // retry without forecast params only if the API rejected them;
      // an unreachable domain (timeout/network) goes straight to the NWS fallback
      if (!(e && /^HTTP 4/.test(e.message))) throw e;
      return fetchT(base).then(okJson);
    })
    .then((j) => {
      const c = j.current;
      const hours = [];
      const hl = j.hourly;
      if (hl && hl.time) {
        const off = j.utc_offset_seconds || 0;
        const nowS = Date.now() / 1000;
        let s0 = 0;
        while (s0 < hl.time.length - 1 && hl.time[s0] < nowS - 3600) s0++;
        for (let i = s0; i < Math.min(s0 + 8, hl.time.length); i++) {
          hours.push({
            label: new Date((hl.time[i] + off) * 1000).toISOString().slice(11, 16),
            temp: hl.temperature_2m[i],
            pp: hl.precipitation_probability ? hl.precipitation_probability[i] : null
          });
        }
      }
      const dl = j.daily;
      return {
        src: "OPEN-METEO",
        temp: c.temperature_2m, feels: c.apparent_temperature,
        rh: c.relative_humidity_2m, dew: c.dew_point_2m,
        windTxt: DIRS[Math.round(c.wind_direction_10m / 22.5) % 16] + " " +
                 Math.round(c.wind_speed_10m) + " MPH",
        gust: Math.round(c.wind_gusts_10m) + " MPH",
        pres: (c.pressure_msl * 0.02953).toFixed(2) + " inHg",
        precip: (c.precipitation || 0).toFixed(2) + " IN/HR",
        cond: WMO[c.weather_code] || "",
        hours,
        daily: dl && dl.time
          ? { hi: dl.temperature_2m_max[0], lo: dl.temperature_2m_min[0], pp: dl.precipitation_probability_max[0] }
          : null
      };
    });
}

// fallback: National Weather Service (different domain, also CORS-open, US only)
function nwsFetch() {
  return fetchT(NWS_POINTS + loc.lat + "," + loc.lon).then(okJson)
    .then((p) => Promise.all([
      fetchT(p.properties.forecastHourly).then(okJson),
      fetchT(p.properties.forecast).then(okJson)
    ]))
    .then(([hj, dj]) => {
      const hp = hj.properties.periods || [];
      const now = hp[0] || {};
      const hours = hp.slice(0, 8).map((per) => ({
        label: per.startTime.slice(11, 16),
        temp: per.temperature,
        pp: per.probabilityOfPrecipitation && per.probabilityOfPrecipitation.value != null
          ? per.probabilityOfPrecipitation.value : null
      }));
      let hi = null, lo = null, ppMax = null;
      (dj.properties.periods || []).slice(0, 2).forEach((per) => {
        if (per.isDaytime) hi = per.temperature; else lo = per.temperature;
        const v = per.probabilityOfPrecipitation && per.probabilityOfPrecipitation.value;
        if (v != null) ppMax = Math.max(ppMax == null ? 0 : ppMax, v);
      });
      return {
        src: "NWS",
        temp: now.temperature, feels: null,
        rh: now.relativeHumidity ? now.relativeHumidity.value : null,
        dew: now.dewpoint && now.dewpoint.value != null ? now.dewpoint.value * 9 / 5 + 32 : null,
        windTxt: (now.windDirection || "--") + " " + (parseInt(now.windSpeed, 10) || "--") + " MPH",
        gust: null, pres: null, precip: null,
        cond: (now.shortForecast || "").toUpperCase(),
        hours,
        daily: hi != null || lo != null ? { hi, lo, pp: ppMax } : null
      };
    });
}

function row(k, v) {
  return [el("span", { class: "k" }, k), el("span", { class: "v" }, v)];
}

function showHint(text) {
  wxHint.textContent = text;
  wxHint.style.display = "block";
  wxBig.style.display = "none";
  wxRows.style.display = "none";
}

function placeLine(withSrc) {
  const zipPart = loc.zip ? " · " + loc.zip : "";
  return loc.name + (loc.state ? ", " + loc.state : "") + zipPart + (withSrc ? " · " + withSrc : "");
}

function renderPanel(n) {
  wxPlace.textContent = placeLine(n.src);
  wxTemp.textContent = degF(n.temp);
  wxCond.textContent = n.cond;
  wxRows.replaceChildren(
    ...row("FEELS", degF(n.feels)),
    ...row("HUMIDITY", pct(n.rh)),
    ...row("DEW PT", degF(n.dew)),
    ...row("WIND", n.windTxt),
    ...row("GUSTS", n.gust || "--"),
    ...row("PRESSURE", n.pres || "--"),
    ...row("PRECIP", n.precip || "--")
  );
  wxHint.style.display = "none";
  wxBig.style.display = "flex";
  wxRows.style.display = "grid";
}

export function refreshWx() {
  if (!loc) {
    wxPlace.textContent = "LOCAL CONDITIONS";
    showHint("TAP TO SET LOCATION");
    return;
  }
  const forLoc = loc.id;
  omFetch()
    .catch((omErr) => nwsFetch().catch((nwsErr) => {
      throw new Error("OM: " + omErr.message + " / NWS: " + nwsErr.message);
    }))
    .then((n) => {
      if (!loc || loc.id !== forLoc) return;   // user switched mid-flight
      lastWx = n;
      store.saveSnap(loc.id, n);
      setHealth("wx", "WX    ", true, n.src.toLowerCase());
      renderPanel(n);
      if (state.getView() === "board") renderStats();
    })
    .catch((err) => {
      if (!loc || loc.id !== forLoc) return;
      lastWx = null;
      setHealth("wx", "WX    ", false, "down");
      wxPlace.textContent = placeLine();
      showHint("WEATHER UNAVAILABLE — " + (err && err.message ? err.message : "NETWORK"));
      if (state.getView() === "board") renderStats();
    });
}

export function renderStats() {
  if (!loc) {
    statsEl.replaceChildren(el("div", { class: "bigmsg" }, "SET A LOCATION — TAP THE CONDITIONS PANEL"));
    return;
  }
  if (!lastWx) {
    statsEl.replaceChildren(el("div", { class: "bigmsg" }, "WEATHER UNAVAILABLE"));
    return;
  }
  const n = lastWx;
  const left = el("div", { class: "col" },
    el("div", { class: "place" }, placeLine(n.src)),
    el("div", { class: "bigtemp" }, degF(n.temp)),
    el("div", { class: "bigcond" }, n.cond),
    el("div", { class: "grid" },
      ...row("FEELS LIKE", degF(n.feels)),
      ...row("HUMIDITY", pct(n.rh)),
      ...row("DEW POINT", degF(n.dew)),
      ...row("WIND", n.windTxt),
      ...row("GUSTS", n.gust || "--"),
      ...row("PRESSURE", n.pres || "--"),
      ...row("PRECIP", n.precip || "--")
    )
  );
  const right = el("div", { class: "col" }, el("div", { class: "sect" }, "PREDICTIONS"));
  if (n.daily) {
    right.append(el("div", { class: "daily" },
      "TODAY — HI " + (n.daily.hi == null ? "--" : Math.round(n.daily.hi) + "°") +
      " · LO " + (n.daily.lo == null ? "--" : Math.round(n.daily.lo) + "°") +
      " · PRECIP " + pct(n.daily.pp)));
  }
  const hours = el("div", { class: "hours" });
  for (const h of n.hours) {
    hours.append(
      el("span", { class: "h" }, h.label),
      el("span", { class: "t" }, h.temp == null ? "--" : Math.round(h.temp) + "°"),
      el("span", { class: "p" }, pct(h.pp))
    );
  }
  right.append(hours);
  const attrib = el("div", { class: "attrib" },
    "WEATHER DATA BY ", el("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noopener" }, "OPEN-METEO.COM"),
    " · NWS · IEM · NOAA");
  statsEl.replaceChildren(left, right, attrib);
}
