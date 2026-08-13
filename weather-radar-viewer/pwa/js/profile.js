// PROFILE (M7): plain-language, actionable numbers derived from ONE Open-Meteo
// pressure-level request per location. Deliberately NOT a soundings chart — a
// bare temperature-vs-height plot teaches a non-meteorologist nothing, so every
// output here is a number or a sentence someone can act on:
//
//   FCAST board (#profileStrip)  freezing level, precipitation-type reasoning,
//                                cloud layer bases and tops
//   AIR board   (#inversionStrip) mixing depth + surface inversion, which is the
//                                mechanism behind AIR's own smoke inference
//
// The governing rule is the trust gate. A freezing level interpolated straight
// through a temperature inversion is not a freezing level, it is arithmetic on
// the wrong assumption, so that case prints "--" and says why. A six-level
// profile cannot resolve sleet from freezing rain, so the warm-nose case states
// its bounds, its peak temperature and its own limits instead of picking one.
// Nothing here ever prints a verdict the data cannot support.
//
// This module owns no DOM except the two mount points it is handed, makes no
// chart, and fetches nothing at import time — same lazy contract as CAST/AIR.

import { OM_FORECAST, OM_LEVELS, PROFILE_TTL_MS, PROFILE_FETCH_MS,
         CLOUD_RH_THRESHOLD, FOG_RH_THRESHOLD, PROFILE_GAP_WARN_M,
         PROFILE_INVERSION_MIN_C, PROFILE_INVERSION_NEAR_C,
         PROFILE_LAPSE_DT_C, PROFILE_LAPSE_WARN_M, PROFILE_NEAR_ZERO_C,
         PROFILE_MIX_SHALLOW_M, PROFILE_MIX_DEEP_M,
         STANDARD_ATM_FT_BY_HPA } from "./config.js";
import { el, dewpointC } from "./util.js";
import { fetchT, okJson, setHealth } from "./net.js";
import * as locations from "./locations.js";
import * as state from "./state.js";

const M_TO_FT = 3.28084;

// locId -> { t, err, json }
const cache = new Map();
const seqs = new Map();

function msg(e) {
  const m = e && e.message ? String(e.message) : "error";
  return m === "TIMEOUT" ? "timeout" : m;
}

function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

// Heights are printed to the nearest 100 ft. A profile sampled at six pressure
// levels does not know where the freezing level is to the foot, and printing
// "9,317 FT" would claim it does.
function ft100(meters) {
  if (meters == null || isNaN(meters)) return null;
  return Math.round((meters * M_TO_FT) / 100) * 100;
}
function ftStr(meters) {
  const v = ft100(meters);
  return v == null ? "--" : comma(v) + " FT";
}

function levelLabel(pt) { return pt && pt.p ? pt.p + " hPa" : "SURFACE"; }

// ---- request ---------------------------------------------------------------

function url(loc) {
  const fields = [];
  for (const p of OM_LEVELS) {
    fields.push("temperature_" + p + "hPa",
                "relative_humidity_" + p + "hPa",
                "geopotential_height_" + p + "hPa");
  }
  fields.push("boundary_layer_height");
  // Pressure-level variables are requested through &hourly= only. The live
  // probe validated that form; &current= support for them is unconfirmed, so
  // nothing here depends on it — "now" is resolved client-side below.
  return OM_FORECAST + "?latitude=" + loc.lat + "&longitude=" + loc.lon +
    "&current=temperature_2m,relative_humidity_2m" +
    "&hourly=" + fields.join(",") +
    "&forecast_days=1&temperature_unit=celsius&timezone=UTC&timeformat=unixtime";
}

// Same grace-window idiom forecastx.js's sliceHourly48 uses: the most recent
// past grid point is the one that describes the atmosphere right now.
function hourIndex(json) {
  const h = (json && json.hourly) || {};
  const time = h.time || [];
  if (!time.length) return -1;
  const nowS = Date.now() / 1000;
  let i = 0;
  while (i < time.length - 1 && time[i] < nowS - 3600) i++;
  return i;
}

// ---- points ----------------------------------------------------------------

// Point = { p: hPa|null, h: meters, t: °C|null, rh: %|null, approx: bool }
// The ground anchor carries p:null and prints as "SURFACE".
function buildPoints(json, i) {
  const h = (json && json.hourly) || {};
  const cur = (json && json.current) || {};
  const notes = [];
  const points = [];

  // null and "" both coerce to 0, which would put the ground at sea level and
  // then drop every level above it as "underground" nowhere and none of them at
  // Denver. Missing is missing.
  const rawH = json ? json.elevation : null;
  const groundH = Number(rawH);
  const groundOk = rawH != null && rawH !== "" && isFinite(groundH);
  if (!groundOk) {
    // Never assumed to be zero: sea level is a guess, and at a mountain
    // location it is the wrong guess by a mile.
    notes.push("SURFACE ELEVATION NOT REPORTED FOR THIS POINT — GROUND LEVEL EXCLUDED FROM THE PROFILE");
  } else {
    points.push({
      p: null, h: groundH,
      t: numOrNull(cur.temperature_2m), rh: numOrNull(cur.relative_humidity_2m),
      approx: false
    });
  }

  let approxUsed = false;
  for (const p of OM_LEVELS) {
    const t = numOrNull(arrAt(h["temperature_" + p + "hPa"], i));
    const rh = numOrNull(arrAt(h["relative_humidity_" + p + "hPa"], i));
    let gh = numOrNull(arrAt(h["geopotential_height_" + p + "hPa"], i));
    let approx = false;
    if (gh == null) {
      const isa = STANDARD_ATM_FT_BY_HPA[p];
      if (isa == null) continue;
      gh = isa / M_TO_FT;
      approx = true;
      approxUsed = true;
    }
    // Underground at this location's elevation — 1000 hPa routinely sits below
    // a Denver-elevation station. Dropped, not clamped.
    if (groundOk && gh <= groundH) continue;
    points.push({ p, h: gh, t, rh, approx });
  }
  if (approxUsed) {
    notes.push("ONE OR MORE LEVEL HEIGHTS ARE A STANDARD-ATMOSPHERE ESTIMATE, NOT THIS MODEL'S ACTUAL HEIGHT");
  }
  points.sort((a, b) => a.h - b.h);
  return { points, notes };
}

function arrAt(arr, i) { return Array.isArray(arr) && i >= 0 && i < arr.length ? arr[i] : null; }
function numOrNull(v) { return v == null || v === "" || isNaN(Number(v)) ? null : Number(v); }

function tempPoints(points) { return points.filter((p) => p.t != null && p.h != null); }

// The ground anchor is the only point that carries p:null, and buildPoints drops
// every level at or below ground, so it is always the lowest point when it
// exists at all. Without it the lowest point is a pressure level hundreds of
// metres up, and NOTHING here may use the word SURFACE about it: at an inland
// point that level is ~800 m, which is exactly where a freezing-rain profile
// hides its warm nose. Every sentence about the surface is gated on this.
function hasGround(tp) { return tp.length > 0 && tp[0].p == null; }

// Height at which a straight line between two points crosses 0°C. Used for the
// freezing level AND for the warm-nose bounds, which are phase boundaries, not
// sampled level heights.
function zeroCrossM(lo, hi) {
  const dt = hi.t - lo.t;
  if (!dt) return null;
  return lo.h + (hi.h - lo.h) * (-lo.t) / dt;
}

function crossingCount(tp) {
  let n = 0;
  for (let i = 0; i < tp.length - 1; i++) {
    if ((tp[i].t >= 0) !== (tp[i + 1].t >= 0)) n++;
  }
  return n;
}

// ---- freezing level --------------------------------------------------------
// status: ok | at-surface | above-top | insufficient | no-ground | uncertain-inversion
function freezingLevel(points) {
  const tp = tempPoints(points);
  if (tp.length < 2) return { status: "insufficient" };
  const ground = hasGround(tp);
  // "AT THE SURFACE" is a claim about the ground. Without a ground point the
  // freezing level is somewhere below the lowest level we have and cannot be
  // placed at all — refuse, the same way the inversion case refuses.
  if (tp[0].t < 0) return ground ? { status: "at-surface" } : { status: "no-ground", lo: levelLabel(tp[0]) };

  let cross = -1;
  for (let i = 0; i < tp.length - 1; i++) {
    if (tp[i].t >= 0 && tp[i + 1].t < 0) { cross = i; break; }
  }
  if (cross < 0) return { status: "above-top", topFt: ftStr(tp[tp.length - 1].h) };

  // THE TRUST GATE, scoped. A shallow cold pool with milder air riding over it
  // makes temperature RISE with height below the crossing, and interpolating
  // straight through that is not a freezing level. But warming with height in
  // air nowhere near 0°C — the ordinary nocturnal inversion under an 18°C
  // airmass, on most clear nights — cannot move the crossing, and refusing for
  // it would print "--" nearly every night. So distrust only an inversion that
  // happens in air near freezing, or a column that crosses 0°C more than once.
  const multi = crossingCount(tp) > 1;
  for (let j = 0; j < cross; j++) {
    if (tp[j + 1].t - tp[j].t <= PROFILE_INVERSION_MIN_C) continue;
    const nearZero = Math.min(Math.abs(tp[j].t), Math.abs(tp[j + 1].t)) <= PROFILE_INVERSION_NEAR_C;
    if (nearZero || multi) {
      return { status: "uncertain-inversion", lo: levelLabel(tp[j]), hi: levelLabel(tp[j + 1]) };
    }
  }

  const a = tp[cross], b = tp[cross + 1];
  const gap = b.h - a.h;
  // Sensitivity, not just geometry: a 1600 m gap across 12°C pins the crossing,
  // the same gap across 0.7°C does not. Shifting both endpoints by
  // PROFILE_LAPSE_DT_C moves the height by gap * dT / |Δt|.
  const soft = Math.abs(a.t - b.t) > 0
    ? (gap * PROFILE_LAPSE_DT_C) / Math.abs(a.t - b.t) : Infinity;
  return {
    status: "ok",
    ft: ftStr(zeroCrossM(a, b)),
    gap,
    gapWarn: gap > PROFILE_GAP_WARN_M,
    soft: soft > PROFILE_LAPSE_WARN_M ? ftStr(soft) : null,
    lo: levelLabel(a), hi: levelLabel(b),
    approx: !!(a.approx || b.approx)
  };
}

// ---- precipitation type ----------------------------------------------------
// Returns prose lines. The warm-nose case NEVER asserts sleet vs freezing rain.
function precipType(points) {
  const tp = tempPoints(points);
  if (tp.length < 2) return { lines: ["PRECIPITATION TYPE — PROFILE TOO SPARSE TO ASSESS"], trivial: true };
  // Every branch below is a claim about the layer precipitation falls through
  // LAST. Without a ground point there is no such layer in this data, and
  // calling the lowest pressure level "the surface" inverts the answer in the
  // one setup that matters: -2°C at 2 m under +3°C at 925 hPa would read as
  // plain rain during an ice storm.
  if (!hasGround(tp)) {
    return { lines: ["PRECIPITATION TYPE — NO SURFACE LEVEL IN THIS PROFILE, CANNOT ASSESS"], trivial: true };
  }

  const topFt = ftStr(tp[tp.length - 1].h);
  if (tp.every((p) => p.t >= 0)) {
    return { lines: ["RAIN — WARM AIR ALL THE WAY DOWN. ANY FROZEN PRECIPITATION ALOFT MELTS BEFORE REACHING THE SURFACE."] };
  }
  if (tp[0].t >= 0) {
    return { lines: ["RAIN — THE SURFACE LAYER IS ABOVE FREEZING, SO FROZEN PRECIPITATION FORMING ABOVE THE FREEZING LEVEL MELTS ON THE WAY DOWN."] };
  }

  // Surface is sub-freezing. Look for a warm layer riding above it.
  let a = -1;
  for (let i = 1; i < tp.length; i++) if (tp[i].t >= 0) { a = i; break; }
  if (a < 0) {
    const lines = ["SNOW, IF PRECIPITATION FALLS — THE COLUMN STAYS BELOW FREEZING FROM THE SURFACE TO " + topFt + "."];
    // Six levels cannot see a warm nose thinner than the 925-850 spacing
    // (~700 m). When the warmest level is within a degree or so of freezing,
    // "every sampled level is cold" is not the same statement as "the column
    // is cold", and this is the branch that would otherwise say so unhedged.
    let warm = tp[0];
    for (const p of tp) if (p.t > warm.t) warm = p;
    if (warm.t > PROFILE_NEAR_ZERO_C) {
      lines.push("NO SAMPLED LEVEL IS ABOVE FREEZING, BUT THE WARMEST (" +
        (Math.round(warm.t * 10) / 10) + "°C AT " + levelLabel(warm) +
        ") IS CLOSE ENOUGH TO 0°C THAT A THIN WARM LAYER BETWEEN SAMPLED LEVELS CANNOT BE RULED OUT — " +
        "FREEZING RAIN OR SLEET IS STILL POSSIBLE.");
    }
    return { lines };
  }
  let b = a;
  while (b + 1 < tp.length && tp[b + 1].t >= 0) b++;

  let peak = tp[a].t;
  for (let i = a; i <= b; i++) if (tp[i].t > peak) peak = tp[i].t;
  // Bounds are the INTERPOLATED 0°C crossings, not the heights of the sampled
  // levels: tp[a-1] is by definition already below freezing, so printing tp[a].h
  // as the base of the warm layer overstates the sub-freezing surface layer by
  // up to a full level spacing — and that depth is the one number a reader
  // weighs when deciding freezing rain against sleet.
  const baseM = zeroCrossM(tp[a - 1], tp[a]);
  const topM = b + 1 < tp.length ? zeroCrossM(tp[b], tp[b + 1]) : null;
  const coldDepth = baseM == null ? null : baseM - tp[0].h;
  const span = baseM == null ? "BOUNDS NOT RESOLVED"
    : topM == null ? "FROM " + ftStr(baseM) + " UP"
    : ftStr(baseM) + "–" + ftStr(topM);
  const cold = coldDepth == null
    ? "A SUB-FREEZING SURFACE LAYER OF UNRESOLVED DEPTH"
    : "A " + ftStr(coldDepth).replace(" FT", "-FT") + " SUB-FREEZING SURFACE LAYER";
  const lines = [
    "WARM NOSE ALOFT (" + span + ", PEAK " +
    (Math.round(peak * 10) / 10) + "°C) OVER " + cold +
    " — CONSISTENT WITH SLEET OR FREEZING RAIN. THIS " +
    tp.length + "-LEVEL PROFILE CANNOT RELIABLY TELL WHICH: THAT DEPENDS ON THE EXACT DEPTH AND " +
    "COLDNESS OF THE SURFACE LAYER, WHICH IS FINER THAN THIS DATA RESOLVES. A THIN SURFACE COLD " +
    "LAYER FAVORS FREEZING RAIN; A DEEPER ONE FAVORS SLEET. CHECK YOUR LOCAL NWS FORECAST FOR THE OFFICIAL CALL."
  ];
  if (b === tp.length - 1) {
    lines.push("THE WARM LAYER IS STILL ABOVE FREEZING AT THE TOP OF THIS PROFILE, SO ITS TOP IS NOT RESOLVED HERE.");
  }
  return { lines };
}

// ---- cloud layers ----------------------------------------------------------
// RH at pressure levels is confirmed populated live, so this is a real feature —
// but a level whose RH is missing is skipped, never read as dry.
function cloudLayers(points) {
  // PRESSURE LEVELS ONLY. The ground anchor's humidity is a 2 m screen reading,
  // and 80-95% at head height is an ordinary humid night across most of the
  // country — not a cloud. Feeding it to the same threshold opens a "cloud
  // layer" whose base is the ground, which reads as fog that is not there.
  const rhPts = points.filter((p) => p.p != null && p.rh != null && p.h != null);
  const sfc = points.find((p) => p.p == null);
  const surfaceRh = sfc && sfc.rh != null ? sfc.rh : null;
  if (!rhPts.length) return { unavailable: true, surfaceRh };

  const layers = [];
  let cur = null;
  for (const p of rhPts) {
    if (p.rh >= CLOUD_RH_THRESHOLD) {
      if (cur) { cur.top = p; cur.approx = cur.approx || !!p.approx; }
      else { cur = { base: p, top: p, approx: !!p.approx }; layers.push(cur); }
    } else {
      cur = null;
    }
  }
  const last = rhPts[rhPts.length - 1];
  return {
    layers, n: rhPts.length, surfaceRh,
    topCloudy: last.rh >= CLOUD_RH_THRESHOLD,
    topFt: ftStr(last.h)
  };
}

// Reported as its own sentence, never as a cloud base: a screen-level reading
// says something about fog and mist, and nothing about where a deck sits.
function fogLine(cl) {
  return cl.surfaceRh != null && cl.surfaceRh >= FOG_RH_THRESHOLD
    ? "SURFACE HUMIDITY " + Math.round(cl.surfaceRh) + "% AT 2 M — FOG OR MIST IS POSSIBLE NEAR THE GROUND. THAT IS A SCREEN-LEVEL READING, NOT A CLOUD BASE."
    : null;
}

function cloudLines(cl) {
  if (cl.unavailable) {
    const out = ["CLOUD LAYERS — RELATIVE HUMIDITY NOT REPORTED FOR THIS LOCATION'S PRESSURE LEVELS"];
    const fog = fogLine(cl);
    if (fog) out.push(fog);
    return out;
  }
  const out = [];
  for (const layer of cl.layers) {
    // T/Td spread corroborates the RH reading; it is never the trigger, so a
    // level with temperature but no usable dewpoint still reports its layer.
    const td = dewpointC(layer.base.t, layer.base.rh);
    const spread = td == null || layer.base.t == null
      ? "" : " · T/Td SPREAD " + (Math.round(Math.abs(layer.base.t - td) * 10) / 10) + "°C AT BASE";
    if (layer.base === layer.top) {
      out.push("CLOUD LAYER NEAR " + ftStr(layer.base.h) +
               " — ONLY ONE SAMPLED LEVEL IS SATURATED, SO ITS BASE AND TOP ARE NOT RESOLVED" + spread);
    } else {
      out.push("CLOUDS " + ftStr(layer.base.h) + "–" + ftStr(layer.top.h) + spread);
    }
  }
  if (!cl.layers.length) {
    out.push("CLEAR THROUGH " + cl.topFt + " (TOP OF THIS PROFILE)");
  } else if (cl.topCloudy) {
    out.push("CLOUD TOPS ABOVE THE TOP OF THIS PROFILE (" + OM_LEVELS[OM_LEVELS.length - 1] + " hPa)");
  } else {
    out.push("CLEAR ABOVE " + ftStr(cl.layers[cl.layers.length - 1].top.h));
  }
  return out;
}

// ---- mixing depth / surface inversion --------------------------------------
// boundary_layer_height is a direct model diagnostic, not something derived
// here, so the only gate on the number itself is null-handling.
function mixing(pblM, points) {
  if (pblM == null || isNaN(pblM)) {
    return { line: "MIXING DEPTH UNAVAILABLE FOR THIS LOCATION/MODEL" };
  }
  const tp = tempPoints(points);
  // "SURFACE-BASED" is a claim about the ground: without the ground anchor the
  // pair being compared is two pressure levels well above it, which is an
  // elevated inversion at best and not this sentence's subject.
  const inversion = hasGround(tp) && tp.length >= 2 &&
    (tp[1].t - tp[0].t) > PROFILE_INVERSION_MIN_C;
  const ft = ftStr(pblM);
  if (pblM < PROFILE_MIX_SHALLOW_M) {
    return {
      line: inversion
        ? "SHALLOW MIXING LAYER (~" + ft + ") WITH A SURFACE-BASED TEMPERATURE INVERSION — SMOKE, FOG, AND HAZE ARE TRAPPED CLOSE TO THE GROUND."
        : "SHALLOW MIXING LAYER (~" + ft + ") — WHATEVER IS RELEASED NEAR THE GROUND STAYS CONCENTRATED IN A THIN LAYER.",
      inversion, lo: tp.length >= 2 ? levelLabel(tp[0]) : null, hi: tp.length >= 2 ? levelLabel(tp[1]) : null
    };
  }
  if (pblM <= PROFILE_MIX_DEEP_M) {
    return { line: "MODERATE MIXING DEPTH (~" + ft + ") — SOME TRAPPING OF SMOKE OR HAZE IS POSSIBLE, ESPECIALLY OVERNIGHT.", inversion };
  }
  return { line: "DEEP MIXING LAYER (~" + ft + ") — POLLUTANTS DISPERSE READILY; LITTLE TRAPPING EXPECTED.", inversion };
}

// ---- fetch + cache ---------------------------------------------------------

function fetchProfile(loc) {
  const mySeq = (seqs.get(loc.id) || 0) + 1;
  seqs.set(loc.id, mySeq);
  fetchT(url(loc), PROFILE_FETCH_MS).then(okJson).then((j) => {
    if (seqs.get(loc.id) !== mySeq) return;      // superseded by a later request
    if (j && j.error) throw new Error(String(j.reason || "profile error"));
    cache.set(loc.id, { t: Date.now(), err: null, json: j });
    setHealth("profile", "PROFIL", true, "ok");
    repaint();
  }).catch((e) => {
    if (seqs.get(loc.id) !== mySeq) return;
    cache.set(loc.id, { t: Date.now(), err: msg(e), json: null });
    setHealth("profile", "PROFIL", false, msg(e));
    repaint();
  });
}

function ensureFresh(loc) {
  if (!loc) return;
  const rec = cache.get(loc.id);
  if (!rec || Date.now() - rec.t > PROFILE_TTL_MS) fetchProfile(loc);
}

// Derived once per paint and shared by both boards.
function derive(rec) {
  const i = hourIndex(rec.json);
  if (i < 0) return null;
  const { points, notes } = buildPoints(rec.json, i);
  const pbl = numOrNull(arrAt((rec.json.hourly || {}).boundary_layer_height, i));
  return {
    points, notes, pbl,
    freeze: freezingLevel(points),
    precip: precipType(points),
    clouds: cloudLayers(points),
    mix: mixing(pbl, points)
  };
}

// ---- DOM -------------------------------------------------------------------

function note(text) { return el("div", { class: "srcnote" }, text); }
function prose(text) { return el("div", { class: "profline" }, text); }

function freezeRow(f) {
  let value = "--";
  let why = null;
  if (f.status === "ok") {
    value = f.ft;
    if (f.gapWarn) why = "APPROXIMATE — INTERPOLATED ACROSS A " + f.lo + "–" + f.hi + " GAP OF " + ftStr(f.gap);
    if (f.soft) {
      why = (why ? why + " · " : "") +
        "±" + f.soft + " — THE " + f.lo + "–" + f.hi + " LAYER IS NEARLY ISOTHERMAL THROUGH 0°C, SO A " +
        PROFILE_LAPSE_DT_C + "°C DIFFERENCE MOVES THIS HEIGHT THAT FAR";
    }
    if (f.approx) {
      why = (why ? why + " · " : "") +
        "STANDARD-ATMOSPHERE ESTIMATE, NOT THIS MODEL'S ACTUAL HEIGHT";
    }
  } else if (f.status === "at-surface") {
    value = "AT THE SURFACE";
    why = "SURFACE IS ALREADY AT OR BELOW FREEZING";
  } else if (f.status === "above-top") {
    value = "ABOVE " + f.topFt;
    why = "NO FREEZING LAYER WITHIN THIS PROFILE (" + OM_LEVELS[OM_LEVELS.length - 1] + " hPa TOP)";
  } else if (f.status === "no-ground") {
    why = "GROUND LEVEL IS NOT IN THIS PROFILE AND THE LOWEST LEVEL AVAILABLE (" + f.lo +
          ") IS ALREADY BELOW FREEZING — THE FREEZING LEVEL SITS SOMEWHERE UNDER IT AND CANNOT BE PLACED WITHOUT THE SURFACE.";
  } else if (f.status === "uncertain-inversion") {
    why = "FREEZING LEVEL UNCERTAIN — TEMPERATURE INVERSION BETWEEN " + f.lo + "–" + f.hi +
          " (SHALLOW COLD AIRMASS). A SIMPLE INTERPOLATION ACROSS AN INVERSION IS UNRELIABLE.";
  } else {
    why = "NOT ENOUGH USABLE PROFILE DATA AT THIS ELEVATION";
  }
  return { grid: el("div", { class: "grid" }, el("span", { class: "k" }, "FREEZING LEVEL"), el("span", { class: "v" }, value)),
           why: why ? note(why) : null };
}

export function renderCastSection(host) {
  if (!host) return;
  host.className = "profstrip";
  const loc = locations.active();
  if (!loc) { host.replaceChildren(); return; }

  const kids = [el("div", { class: "sect" }, "PROFILE")];
  const rec = cache.get(loc.id);
  if (!rec) { kids.push(note("LOADING…")); host.replaceChildren(...kids); return; }
  if (rec.err) { kids.push(note("PROFILE UNAVAILABLE — " + rec.err)); host.replaceChildren(...kids); return; }

  const d = derive(rec);
  if (!d) { kids.push(note("PROFILE UNAVAILABLE — NO HOURLY DATA RETURNED")); host.replaceChildren(...kids); return; }

  const fr = freezeRow(d.freeze);
  kids.push(fr.grid);
  if (fr.why) kids.push(fr.why);

  kids.push(el("div", { class: "subsect" }, "PRECIPITATION TYPE"));
  for (const line of d.precip.lines) kids.push(prose(line));
  if (!d.precip.trivial) {
    kids.push(note("THIS DESCRIBES THE ATMOSPHERE'S COLUMN, NOT WHETHER PRECIPITATION IS ACTUALLY FALLING — CHECK THE METEOGRAM ABOVE FOR POP."));
  }

  kids.push(el("div", { class: "subsect" }, "CLOUD LAYERS"));
  for (const line of cloudLines(d.clouds)) kids.push(prose(line));
  if (!d.clouds.unavailable) {
    // precipType() interpolates its 0°C bounds precisely because a sampled-level
    // height is not the boundary it brackets. The same is true of a cloud deck,
    // and these heights are NOT interpolated — so the note has to say which one
    // the reader is looking at rather than let a level height pass as a base.
    kids.push(note("APPROXIMATE — BASED ON A " + d.clouds.n + "-LEVEL PROFILE, NOT A TRUE SOUNDING. " +
                   "THE HEIGHTS ARE THE SAMPLED LEVELS THEMSELVES, SO A DECK'S REAL BASE SITS AT OR " +
                   "BELOW THE FIGURE SHOWN AND ITS TOP AT OR ABOVE IT; A THIN LAYER BETWEEN SAMPLED " +
                   "LEVELS CAN BE MISSED ENTIRELY."));
  }
  for (const n of d.notes) kids.push(note(n));
  kids.push(note("OPEN-METEO MODEL PRESSURE LEVELS · " + OM_LEVELS.join("/") +
                 " hPa — MODEL OUTPUT FOR THIS HOUR, NOT AN OBSERVED SOUNDING"));
  host.replaceChildren(...kids);
}

export function renderAirSection(host) {
  if (!host) return;
  host.className = "profstrip";
  const loc = locations.active();
  if (!loc) { host.replaceChildren(); return; }

  const kids = [el("div", { class: "sect" }, "INVERSION / MIXING")];
  const rec = cache.get(loc.id);
  if (!rec) { kids.push(note("LOADING…")); host.replaceChildren(...kids); return; }
  if (rec.err) { kids.push(note("PROFILE UNAVAILABLE — " + rec.err)); host.replaceChildren(...kids); return; }

  const d = derive(rec);
  if (!d) { kids.push(note("PROFILE UNAVAILABLE — NO HOURLY DATA RETURNED")); host.replaceChildren(...kids); return; }

  kids.push(prose(d.mix.line));
  if (d.mix.inversion && d.mix.lo) {
    kids.push(prose("TEMPERATURE RISES WITH HEIGHT BETWEEN " + d.mix.lo + " AND " + d.mix.hi +
                    " — THAT WARM LID IS WHAT HOLDS SURFACE AIR DOWN."));
  }
  kids.push(note("MIXING DEPTH IS THE MODEL'S OWN BOUNDARY-LAYER HEIGHT — IT IS THE MECHANISM BEHIND THE SMOKE AND HAZE READING ABOVE, NOT A SECOND MEASUREMENT OF IT."));
  for (const n of d.notes) kids.push(note(n));
  host.replaceChildren(...kids);
}

function repaint() {
  const cast = document.getElementById("profileStrip");
  if (cast) renderCastSection(cast);
  const air = document.getElementById("inversionStrip");
  if (air) renderAirSection(air);
}

// ---- public ----------------------------------------------------------------

export function init() {
  try {
    // forecastx.js / airq.js each drop an empty mount point into their board and
    // emit on every repaint, so the section is rebuilt into the fresh node.
    state.on("castboard", (d) => {
      const host = d && d.el && d.el.querySelector("#profileStrip");
      if (!host) return;
      renderCastSection(host);
      ensureFresh(locations.active());
    });
    state.on("airboard", (d) => {
      const host = d && d.el && d.el.querySelector("#inversionStrip");
      if (!host) return;
      renderAirSection(host);
      ensureFresh(locations.active());
    });
    // Stays lazy: only refetch if a mount point already exists, i.e. one of the
    // two boards has actually been opened at some point this session.
    locations.onChange(() => {
      const live = document.getElementById("profileStrip") || document.getElementById("inversionStrip");
      if (!live) return;
      repaint();
      ensureFresh(locations.active());
    });
  } catch { /* a broken profile section must never take boot down */ }
}
