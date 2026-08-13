// ALMANAC board (M5, climatology half): "how unusual is today?" answered by
// ranking today's forecast high inside the ERA5 reanalysis distribution for
// this exact calendar day at this ~28 km (0.25°) grid cell — plus the 30-year
// normal and the day's warmest/coldest years on record. History comes from
// Open-Meteo's ERA5 archive (keyless, CORS-open, confirmed live: earliest
// accepted start_date is exactly 1940-01-01, zero data lag through today),
// backfilled newest-first in ALMANAC_CHUNK_YEARS chunks, at most
// ALMANAC_CHUNKS_PER_VISIT per board visit, strictly sequential (the archive
// is free and the heaviest request this app makes — nine parallel decade
// requests per client is exactly the traffic pattern that gets an origin
// throttled). Cached forever in the IndexedDB "normals" store store.js
// already creates — no DB version bump, no new object store. The cache is
// keyed by 0.25° GRID CELL rather than location id, so neighbouring ZIPs
// share one download and switching between them costs nothing.
//
// Three statistics, kept rigorously distinct because conflating them is the
// fastest way to mislead someone about "how unusual" a day is:
//   NORMAL     — mean over a ±ALMANAC_NORMAL_HALF_WINDOW-day window across a
//                named 30-year period. Smoothed on purpose: one calendar day
//                x 30 years has a standard error of ~1.8°F (sigma~8-12°F /
//                sqrt(30)); a ±7-day window (15 dates, ~3-day synoptic
//                decorrelation -> ~150 effective samples) cuts that to
//                ~0.8°F for ~0.06°F of bias from the annual cycle's
//                curvature (1 - sin(x)/x at x=(2*pi/365)*7). Wider windows
//                buy little more precision and start blending a genuinely
//                different part of the season into a number labelled with
//                one day's name.
//   PERCENTILE — exact calendar day only, every cached year. The phrasing
//                names the day ("of AUG 12"), so the sample must too — a
//                windowed pool would let an Aug 5 value inflate an "Aug 12"
//                claim.
//   RECORD     — exact calendar day only, never windowed, with its year.
//
// THE HONESTY LINE this board exists to hold: ERA5 is a grid-cell reanalysis,
// not an NWS station record, and a partial backfill (<ALMANAC_MIN_YEARS_PCT
// years) is a strictly weaker claim than a complete one — it gets an ordinal
// rank ("3RD WARMEST OF 22"), never a percentage it can't support. See
// phraseFor() and the permanent caveat rendered on every paint.
//
// daily.time is read by STRING SLICE, never new Date(iso) — new Date() parses
// an ISO date as UTC midnight, and .getMonth()/.getDate() in a negative-offset
// zone would silently file the value under the previous calendar day, shifting
// every record by one. Every date this module builds from a network response
// goes through Date.UTC() + getUTC*() arithmetic instead (see parseChunk() and
// buildIndex()); the only bare `new Date(y, m, d, ...)` local-time
// constructions are for CURRENT-year chart x-positions, a different and safe
// use (constructing a date, not parsing one off the wire).
//
// Lazy like AIR/CAST/SKY: nothing is fetched until this board is opened.

import {
  OM_ARCHIVE, OM_FORECAST, ALMANAC_CACHE_VER, ALMANAC_EPOCH_YEAR, ALMANAC_CHUNK_YEARS,
  ALMANAC_CHUNKS_PER_VISIT, ALMANAC_CHUNK_GAP_MS, ALMANAC_CHUNK_FETCH_MS, ALMANAC_TAIL_TTL_MS,
  ALMANAC_TODAY_TTL_MS, ALMANAC_GRID_DEG, ALMANAC_NORMAL_HALF_WINDOW, ALMANAC_NORMAL_PERIOD,
  ALMANAC_MIN_YEARS_PCT, ALMANAC_MIN_YEARS_BAND, ALMANAC_MIN_YEARS_CHART, ALMANAC_NEAR_BAND
} from "./config.js";
import { el, pad, clamp } from "./util.js";
import { fetchT, okJson, setHealth } from "./net.js";
import { chart } from "./charts.js";
import * as store from "./store.js";
import * as locations from "./locations.js";
import * as boards from "./boards.js";
import * as wx from "./wx.js";

let boardEl = null;
let chartInst = null;

// cellKey -> cell state (persists for the life of the tab, so switching back
// to a location already visited this session is free)
const cells = new Map();
let activeCellKey = null;      // the cell the board is CURRENTLY showing (guards the zero-network same-cell switch)
let today = null;              // { hi, lo, src, at } | null — this location's forecast leg, in memory only
let seq = 0;                   // supersede guard: bumped on every location change / board exit
let sweptOldVersion = false;   // once-per-session bounded reclaim of the previous cache version
const todayFallbackCache = new Map();   // loc.id -> { at, val } — only used when wx has nothing yet

function newCellState(cell) {
  return {
    lat: cell.lat, lon: cell.lon,
    meta: { v: ALMANAC_CACHE_VER, chunks: {}, chunkYears: ALMANAC_CHUNK_YEARS },
    chunks: new Map(),                 // startYear -> chunk record
    index: { byDate: new Map(), firstYear: null, lastYear: null, yearsWithData: 0 },
    loadedFromIdb: false,
    backfill: { running: false, failed: false, err: null }
  };
}

// ---- cell + IDB keys -------------------------------------------------------
// ERA5's native grid is 0.25° with cell centres on exact multiples, so
// rounding to the nearest multiple names the cell that CONTAINS the point.
// The quantized coordinates are what gets sent in the request, so every
// location inside one cell produces a byte-identical URL and shares one cache.
function cellFor(loc) {
  const lat = Math.round(loc.lat / ALMANAC_GRID_DEG) * ALMANAC_GRID_DEG;
  const lon = Math.round(loc.lon / ALMANAC_GRID_DEG) * ALMANAC_GRID_DEG;
  return { lat, lon, key: lat.toFixed(2) + "," + lon.toFixed(2) };
}
function cellPrefix(cell, ver) { return "alm/v" + ver + "/" + cell.key + "/tmaxmin_F"; }
function metaKey(cell, ver) { return cellPrefix(cell, ver) + "/meta"; }
function chunkKey(cell, y0, ver) { return cellPrefix(cell, ver) + "/c" + y0; }

// ---- IDB layer --------------------------------------------------------------
// store.js exposes ONLY idbGet/idbPut/idbDel by exact key — no cursor, no
// getAll — so the meta record IS the index of which chunks exist; nothing
// here may range-scan the store.
async function loadMeta(cell) {
  const m = await store.idbGet("normals", metaKey(cell, ALMANAC_CACHE_VER));
  return (m && m.v === ALMANAC_CACHE_VER) ? m : null;
}
function saveMeta(cell, meta) { return store.idbPut("normals", metaKey(cell, ALMANAC_CACHE_VER), meta); }
function loadChunk(cell, y0) { return store.idbGet("normals", chunkKey(cell, y0, ALMANAC_CACHE_VER)); }
function saveChunk(cell, y0, chunk) { return store.idbPut("normals", chunkKey(cell, y0, ALMANAC_CACHE_VER), chunk); }

// Bounded reclaim, once per session: a version bump without this would orphan
// ~250 KB per grid cell forever, since there is no cursor to enumerate keys.
async function sweepOldVersion(cell) {
  if (sweptOldVersion) return;
  sweptOldVersion = true;
  if (ALMANAC_CACHE_VER <= 1) return;   // nothing older can exist
  const oldVer = ALMANAC_CACHE_VER - 1;
  const oldMeta = await store.idbGet("normals", metaKey(cell, oldVer));
  if (!oldMeta) return;
  for (const k of Object.keys(oldMeta.chunks || {})) await store.idbDel("normals", chunkKey(cell, Number(k), oldVer));
  await store.idbDel("normals", metaKey(cell, oldVer));
}

// Used by rebuild(): "forever cache" is a promise the user can revoke.
async function dropCell(cell, cs) {
  const meta = (cs && cs.meta) || (await loadMeta(cell));
  if (meta && meta.chunks) {
    for (const k of Object.keys(meta.chunks)) await store.idbDel("normals", chunkKey(cell, Number(k), ALMANAC_CACHE_VER));
  }
  await store.idbDel("normals", metaKey(cell, ALMANAC_CACHE_VER));
}

// ---- small pure helpers ------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function msg(e) { return (e && e.message) ? String(e.message) : "ERROR"; }
function numOrNull(v) { return v == null || isNaN(v) ? null : v; }
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysInYear(y) { return isLeap(y) ? 366 : 365; }
function expectedDayCount(y0, y1) { let n = 0; for (let y = y0; y <= y1; y++) n += daysInYear(y); return n; }
function decadeStart(y) {
  return ALMANAC_EPOCH_YEAR + Math.floor((y - ALMANAC_EPOCH_YEAR) / ALMANAC_CHUNK_YEARS) * ALMANAC_CHUNK_YEARS;
}

// ---- network: backfill -------------------------------------------------------

// Newest-first: the 1991-2020 normal and a usable percentile are reachable
// after 4 chunks instead of 9, and recent decades are the most relevant to
// "how unusual is today".
function plannedChunks(chunkYears, nowYear) {
  const out = [];
  for (let y0 = ALMANAC_EPOCH_YEAR; y0 <= nowYear; y0 += chunkYears) out.push([y0, y0 + chunkYears - 1]);
  return out.reverse();
}

function chunkUrl(cell, y0, y1) {
  // NO timeformat=unixtime — daily.time must come back as ISO date strings
  // ("1940-08-12") so the local calendar date is read by string slice.
  return OM_ARCHIVE + "?latitude=" + cell.lat + "&longitude=" + cell.lon +
    "&start_date=" + y0 + "-01-01&end_date=" + y1 + "-12-31" +
    "&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto";
}

// Structured clone stores typed arrays natively — ~29 KB per decade as
// Float32Array pairs vs ~90 KB of JSON text. contiguous:true drops the time
// array entirely (the index is start + i days); a gapped or truncated
// response (e.g. the tail decade, which reaches into the future and gets
// fewer real days back than requested) falls back to explicit day offsets
// derived from each ISO date string — never new Date(iso).
function parseChunk(j, y0, y1) {
  if (!j || !j.daily || !Array.isArray(j.daily.time)) throw new Error("BAD PAYLOAD");
  const times = j.daily.time;
  const tmaxArr = j.daily.temperature_2m_max || [];
  const tminArr = j.daily.temperature_2m_min || [];
  const n = times.length;
  const expected = expectedDayCount(y0, y1);
  const contiguous = n === expected && times[0] === (y0 + "-01-01");

  const tmax = new Float32Array(n), tmin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const hv = tmaxArr[i], lv = tminArr[i];
    tmax[i] = (hv == null || isNaN(hv)) ? NaN : hv;
    tmin[i] = (lv == null || isNaN(lv)) ? NaN : lv;
  }

  let offsets = null;
  if (!contiguous) {
    offsets = new Int32Array(n);
    const startMs = Date.UTC(y0, 0, 1);
    for (let i = 0; i < n; i++) {
      const t = times[i];
      const y = Number(t.slice(0, 4)), mo = Number(t.slice(5, 7)), d = Number(t.slice(8, 10));
      offsets[i] = Math.round((Date.UTC(y, mo - 1, d) - startMs) / 86400000);
    }
  }

  const echoed = (j.latitude != null && j.longitude != null) ? { lat: j.latitude, lon: j.longitude } : null;
  return { y0, y1, contiguous, offsets, tmax, tmin, echoed, fetchedAt: Date.now() };
}

function coveredYears(meta) {
  const set = new Set();
  for (const k of Object.keys(meta.chunks || {})) {
    const c = meta.chunks[k];
    if (!c.ok) continue;
    for (let y = c.y0; y <= c.y1; y++) set.add(y);
  }
  return set;
}
function spanFullyCovered(covered, y0, y1) {
  for (let y = y0; y <= y1; y++) if (!covered.has(y)) return false;
  return true;
}
function spanAge(meta, y0, y1) {
  let latest = null;
  for (const k of Object.keys(meta.chunks || {})) {
    const c = meta.chunks[k];
    if (!c.ok || c.y1 < y0 || c.y0 > y1) continue;
    if (latest == null || c.fetchedAt > latest) latest = c.fetchedAt;
  }
  return latest == null ? null : Date.now() - latest;
}
function isTailSpan(y1, nowYear) { return y1 >= nowYear; }

// Strictly sequential and capped at ALMANAC_CHUNKS_PER_VISIT: aborts early if
// the board is left, the location leaves the cell, or seq is superseded. On a
// chunk failure it stops the drip for THIS visit rather than burning the rest
// of the budget on a source that's down; the next board entry retries.
async function ensureBackfill(cell, mySeq) {
  const cs = cells.get(cell.key);
  if (!cs || cs.backfill.running) return;
  cs.backfill.running = true;
  let did = 0;
  const nowYear = new Date().getFullYear();

  while (did < ALMANAC_CHUNKS_PER_VISIT) {
    if (seq !== mySeq) break;
    if (boards.current() !== "almanac") break;
    const loc = locations.active();
    if (!loc || cellFor(loc).key !== cell.key) break;

    const chunkYears = cs.meta.chunkYears || ALMANAC_CHUNK_YEARS;
    const candidates = plannedChunks(chunkYears, nowYear);
    const covered = coveredYears(cs.meta);
    let target = null;
    for (const [y0, y1] of candidates) {
      if (!spanFullyCovered(covered, y0, y1)) { target = [y0, y1]; break; }
      // Immutable once cached, EXCEPT the tail (contains the current year,
      // still filling): refetch it once it's older than ALMANAC_TAIL_TTL_MS.
      if (isTailSpan(y1, nowYear)) {
        const age = spanAge(cs.meta, y0, y1);
        if (age == null || age >= ALMANAC_TAIL_TTL_MS) { target = [y0, y1]; break; }
      }
    }
    if (!target) break;   // nothing left to fetch this visit

    const [y0, y1] = target;
    let chunk = null, ok = true, errText = null;
    try {
      const r = await fetchT(chunkUrl(cell, y0, y1), ALMANAC_CHUNK_FETCH_MS);
      const j = await okJson(r);
      chunk = parseChunk(j, y0, y1);
    } catch (e) { ok = false; errText = msg(e); }

    if (seq !== mySeq) break;   // superseded mid-fetch

    if (ok) {
      // Quantization-mismatch guard: if Open-Meteo echoes a lat/lon more than
      // half a grid step from what we asked for, the cell it actually used
      // isn't the one the URL named — keep the data (it's still real), but
      // remember the ACTUAL cell so the on-screen coordinates never lie.
      if (chunk.echoed) {
        const dLat = Math.abs(chunk.echoed.lat - cell.lat), dLon = Math.abs(chunk.echoed.lon - cell.lon);
        if (dLat > ALMANAC_GRID_DEG / 2 || dLon > ALMANAC_GRID_DEG / 2) {
          cs.meta.cellMismatch = true;
          cs.meta.echoed = chunk.echoed;
        }
      }
      await saveChunk(cell, y0, chunk);
      cs.meta.chunks[y0] = { ok: true, y0, y1, fetchedAt: Date.now(), contiguous: chunk.contiguous };
      if (cs.meta.timeouts) delete cs.meta.timeouts[decadeStart(y0)];
      cs.chunks.set(y0, chunk);
      cs.backfill.failed = false;
      cs.backfill.err = null;
      setHealth("almanac", "ALMANAC", true, cs.chunks.size + " chunks");
    } else {
      cs.meta.chunks[y0] = { ok: false, err: errText, triedAt: Date.now() };
      // Adaptive halving: the SAME (epoch-aligned) decade timing out twice
      // means a decade-sized request is too slow for this connection.
      if (errText === "TIMEOUT") {
        const dec = decadeStart(y0);
        cs.meta.timeouts = cs.meta.timeouts || {};
        cs.meta.timeouts[dec] = (cs.meta.timeouts[dec] || 0) + 1;
        const halved = Math.max(1, Math.floor(ALMANAC_CHUNK_YEARS / 2));
        if (cs.meta.timeouts[dec] >= 2 && cs.meta.chunkYears !== halved) {
          cs.meta.chunkYears = halved;
          delete cs.meta.timeouts[dec];
        }
      }
      cs.backfill.failed = true;
      cs.backfill.err = errText;
      setHealth("almanac", "ALMANAC", false, errText || "down");
    }
    await saveMeta(cell, cs.meta);
    did++;

    if (seq !== mySeq) break;
    cs.index = buildIndex(cs.chunks);
    if (boards.current() === "almanac") render();

    if (!ok) break;
    if (did < ALMANAC_CHUNKS_PER_VISIT) await sleep(ALMANAC_CHUNK_GAP_MS);
  }

  cs.backfill.running = false;
}

// ---- network: today's leg ----------------------------------------------------
// Primary source is wx.getLastWx() — wx.js already polls conditions every
// WX_REFRESH_MS for the active location and exports the normalized record
// whose .daily is { hi, lo, pp } for today, with .src being "OPEN-METEO" or
// "NWS". Using it costs zero extra requests and guarantees the headline is
// the SAME number the NOW board shows. It's safe across a location switch:
// wx.js's own locations.onChange handler resolves the new location's snapshot
// (or null) before anything else runs, so this never reads the old location's
// value — and wx.init() runs before almanac.init() in main.js, so wx's
// onChange handler always fires first on any given location change.
function todayHiLo(loc) {
  const last = wx.getLastWx();
  if (last && last.daily && (last.daily.hi != null || last.daily.lo != null)) {
    return Promise.resolve({ hi: numOrNull(last.daily.hi), lo: numOrNull(last.daily.lo), src: last.src || "OPEN-METEO", at: Date.now() });
  }
  const cached = todayFallbackCache.get(loc.id);
  if (cached && (Date.now() - cached.at) < ALMANAC_TODAY_TTL_MS) return Promise.resolve(cached.val);

  const url = OM_FORECAST + "?latitude=" + loc.lat + "&longitude=" + loc.lon +
    "&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&temperature_unit=fahrenheit&timezone=auto&timeformat=unixtime";
  return fetchT(url).then(okJson).then((j) => {
    const d = j.daily || {};
    const val = {
      hi: numOrNull(d.temperature_2m_max ? d.temperature_2m_max[0] : null),
      lo: numOrNull(d.temperature_2m_min ? d.temperature_2m_min[0] : null),
      src: "OPEN-METEO", at: Date.now()
    };
    todayFallbackCache.set(loc.id, { at: Date.now(), val });
    return val;
  }).catch(() => ({ hi: null, lo: null, src: null, at: Date.now() }));
}

// ---- index --------------------------------------------------------------------
// Walks every cached day once, buckets by "MM-DD". ~31k days for 1940-2025,
// ~1ms to build; rebuilt only when a chunk lands. All date arithmetic here is
// Date.UTC()/getUTC*() on integers already derived from string-sliced ISO
// dates (or day offsets computed the same way) — never new Date(iso).
function buildIndex(chunksMap) {
  const byDate = new Map();
  let firstYear = Infinity, lastYear = -Infinity;
  const yearsSeen = new Set();
  for (const [y0, chunk] of chunksMap) {
    const n = chunk.tmax.length;
    const base = Date.UTC(y0, 0, 1);
    for (let i = 0; i < n; i++) {
      const dayMs = base + (chunk.contiguous ? i : chunk.offsets[i]) * 86400000;
      const dt = new Date(dayMs);
      const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
      const key = pad(mo, 2) + "-" + pad(d, 2);
      let bucket = byDate.get(key);
      if (!bucket) { bucket = { years: [], tmax: [], tmin: [] }; byDate.set(key, bucket); }
      bucket.years.push(y); bucket.tmax.push(chunk.tmax[i]); bucket.tmin.push(chunk.tmin[i]);
      yearsSeen.add(y);
      if (y < firstYear) firstYear = y;
      if (y > lastYear) lastYear = y;
    }
  }
  for (const bucket of byDate.values()) {
    bucket.years = Int16Array.from(bucket.years);
    bucket.tmax = Float32Array.from(bucket.tmax);
    bucket.tmin = Float32Array.from(bucket.tmin);
  }
  return {
    byDate,
    firstYear: isFinite(firstYear) ? firstYear : null,
    lastYear: isFinite(lastYear) ? lastYear : null,
    yearsWithData: yearsSeen.size
  };
}

function cachedYearsFor(index, mm, dd) {
  const b = index.byDate.get(pad(mm, 2) + "-" + pad(dd, 2));
  if (!b) return [];
  return Array.from(new Set(Array.from(b.years))).sort((a, c) => a - c);
}

// Walks real UTC Date objects anchored on the CURRENT year, so DST never
// shifts the window and Feb 29 appears in windows near it exactly when the
// current year is a leap year.
function windowDates(mm, dd, half) {
  const y = new Date().getUTCFullYear();
  const anchor = Date.UTC(y, mm - 1, dd);
  const out = [];
  for (let k = -half; k <= half; k++) {
    const dt = new Date(anchor + k * 86400000);
    out.push(pad(dt.getUTCMonth() + 1, 2) + "-" + pad(dt.getUTCDate(), 2));
  }
  return out;
}

// ---- statistics -----------------------------------------------------------

// Five-line linear-interpolation percentile — the same estimator forecastx.js
// uses privately for its ensemble bands (percentile(), forecastx.js). Not
// exported there, so this is a deliberate local copy rather than a
// cross-module reach.
function pctl(sortedAsc, p) {
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function selectNormalPeriod(cachedYears) {
  const [pStart, pEnd] = ALMANAC_NORMAL_PERIOD;
  const set = new Set(cachedYears);
  let full = true;
  for (let y = pStart; y <= pEnd; y++) if (!set.has(y)) { full = false; break; }
  if (full) return [pStart, pEnd];
  if (cachedYears.length < ALMANAC_MIN_YEARS_PCT) return null;
  const recent = cachedYears.slice(-ALMANAC_MIN_YEARS_PCT);
  return [recent[0], recent[recent.length - 1]];
}

// Mean over a +/-ALMANAC_NORMAL_HALF_WINDOW-day window across a named 30-year
// period — smoothed on purpose (see the file header for the bias/variance
// trade). Below ALMANAC_MIN_YEARS_PCT years of usable data this returns null;
// the board then reads "--" with a badge naming what it needs instead of a
// noisier number pretending to be a normal.
function normalFor(index, mm, dd) {
  const cachedYears = cachedYearsFor(index, mm, dd);
  const period = selectNormalPeriod(cachedYears);
  if (!period) return null;
  const [y0, y1] = period;
  const dates = windowDates(mm, dd, ALMANAC_NORMAL_HALF_WINDOW);
  let sumHi = 0, nHi = 0, sumLo = 0, nLo = 0;
  const yearsUsed = new Set();
  for (const key of dates) {
    const b = index.byDate.get(key);
    if (!b) continue;
    for (let i = 0; i < b.years.length; i++) {
      const y = b.years[i];
      if (y < y0 || y > y1) continue;
      yearsUsed.add(y);
      const hv = b.tmax[i], lv = b.tmin[i];
      if (!isNaN(hv)) { sumHi += hv; nHi++; }
      if (!isNaN(lv)) { sumLo += lv; nLo++; }
    }
  }
  if (yearsUsed.size < ALMANAC_MIN_YEARS_PCT) return null;
  return {
    hi: nHi ? Math.round(sumHi / nHi) : null,
    lo: nLo ? Math.round(sumLo / nLo) : null,
    period: [y0, y1], nYears: yearsUsed.size, nSamples: nHi
  };
}

// EXACT calendar day only — no window, ever. A record is a thing that
// happened on this date; windowing it would report a nearby day's value as
// this day's record. Ties (within 0.1°F): report the earliest year.
function extremeOf(values, years, mode) {
  let best = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNaN(v)) continue;
    if (best == null || (mode === "max" ? v > best : v < best)) best = v;
  }
  if (best == null) return null;
  let year = null, tiedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNaN(v) || Math.abs(v - best) > 0.1) continue;
    tiedCount++;
    if (year == null || years[i] < year) year = years[i];
  }
  return { value: best, year, tied: tiedCount > 1 };
}
function dayExtremes(index, mm, dd) {
  const b = index.byDate.get(pad(mm, 2) + "-" + pad(dd, 2));
  if (!b || !b.years.length) return null;
  const hi = extremeOf(b.tmax, b.years, "max");
  const lo = extremeOf(b.tmin, b.years, "min");
  if (!hi && !lo) return null;
  return { hi, lo };
}

// EXACT calendar day only, because the phrasing names the day and a reader
// can verify "3rd warmest of 86". Hazen plotting position for the exceedance
// fraction — the standard unbiased-ish estimator from a finite sample.
function rankToday(index, mm, dd, todayHi) {
  if (todayHi == null || isNaN(todayHi)) return null;
  const b = index.byDate.get(pad(mm, 2) + "-" + pad(dd, 2));
  if (!b || !b.years.length) return null;
  let n = 0, exceed = 0, tie = 0, firstYear = Infinity;
  for (let i = 0; i < b.years.length; i++) {
    const v = b.tmax[i];
    if (isNaN(v)) continue;
    n++;
    if (b.years[i] < firstYear) firstYear = b.years[i];
    if (v > todayHi + 0.05) exceed++;
    else if (Math.abs(v - todayHi) <= 0.05) tie++;
  }
  if (n === 0) return null;
  const rank = exceed + (tie + 1) / 2;              // 1 = warmest
  const exceedFrac = (rank - 0.5) / n;
  return { n, firstYear, rank, exceedFrac };
}

function ordinal(n) {
  const r = n % 100;
  if (r >= 11 && r <= 13) return n + "TH";
  if (n % 10 === 1) return n + "ST";
  if (n % 10 === 2) return n + "ND";
  if (n % 10 === 3) return n + "RD";
  return n + "TH";
}

// The period label is ALWAYS "SINCE " + firstYear actually IN the sample,
// never the configured epoch — a half-built cache says "SINCE 1990", not
// "SINCE 1940". Below ALMANAC_MIN_YEARS_PCT years this deliberately prints no
// percentage: a percentage from 22 samples implies precision the sample
// doesn't have, so it gets an ordinal instead ("3RD WARMEST OF 22").
function phraseFor(rr, dateLabel) {
  if (!rr) return { text: "NO ERA5 DATA FOR " + dateLabel + " AT THIS GRID CELL", cls: "none" };
  const since = "SINCE " + rr.firstYear;
  if (rr.exceedFrac <= 0) return { text: "ON TRACK TO TOP EVERY " + dateLabel + " " + since, cls: "record" };
  if (rr.exceedFrac >= 1) return { text: "ON TRACK TO UNDERCUT EVERY " + dateLabel + " " + since, cls: "record" };

  if (rr.n < ALMANAC_MIN_YEARS_PCT) {
    const roundedRank = Math.round(rr.rank);
    const coldRank = rr.n - roundedRank + 1;
    const nearWarm = roundedRank <= coldRank;
    const word = nearWarm ? "WARMEST" : "COLDEST";
    return { text: ordinal(nearWarm ? roundedRank : coldRank) + " " + word + " OF " + rr.n + " " + dateLabel + "s ON RECORD",
             cls: nearWarm ? "hot" : "cold" };
  }

  const nearLo = 0.5 - ALMANAC_NEAR_BAND, nearHi = 0.5 + ALMANAC_NEAR_BAND;
  const capPct = Math.round(nearLo * 100);
  if (rr.exceedFrac < nearLo) {
    return { text: "WARMEST " + clamp(Math.round(rr.exceedFrac * 100), 1, capPct) + "% OF " + dateLabel + " " + since, cls: "hot" };
  }
  if (rr.exceedFrac > nearHi) {
    return { text: "COLDEST " + clamp(Math.round((1 - rr.exceedFrac) * 100), 1, capPct) + "% OF " + dateLabel + " " + since, cls: "cold" };
  }
  return { text: "NEAR NORMAL FOR " + dateLabel, cls: "near" };   // a "warmest 47%" headline is noise dressed as a statistic
}

function hasUsableDay(index, mm, dd) {
  const b = index.byDate.get(pad(mm, 2) + "-" + pad(dd, 2));
  if (!b) return false;
  for (let i = 0; i < b.tmax.length; i++) if (!isNaN(b.tmax[i])) return true;
  return false;
}

// Resolves which of the two independent "no data" states applies: no ERA5
// sample exists for this calendar day at all (a null run in the reanalysis),
// vs. ERA5 is fine but today's own forecast leg is unavailable. Conflating
// these would make a dead forecast feed look like a broken archive.
function headlinePhrase(index, mm, dd, todayHi, dateLabel) {
  if (!hasUsableDay(index, mm, dd)) return { text: "NO ERA5 DATA FOR " + dateLabel + " AT THIS GRID CELL", cls: "none" };
  if (todayHi == null || isNaN(todayHi)) return { text: "TODAY'S HIGH UNAVAILABLE — CANNOT RANK", cls: "none" };
  return phraseFor(rankToday(index, mm, dd, todayHi), dateLabel);
}

// ---- climatology chart series -----------------------------------------------
// Each x is local noon of that calendar date IN THE CURRENT YEAR (a
// construction, not a parse of a network ISO string, so the local Date
// constructor is safe here). Band lo/hi are nulled TOGETHER whenever a date's
// sample is incomplete — charts.js filters a band's lo/hi arrays
// independently, so a date missing from only one would skew the closing
// polygon.
function localWindowDates(mm, dd, half) {
  const now = new Date();
  const anchor = new Date(now.getFullYear(), mm - 1, dd, 12, 0, 0).getTime();
  const out = [];
  for (let k = -half; k <= half; k++) {
    const dt = new Date(anchor + k * 86400000);
    out.push({ mm: dt.getMonth() + 1, dd: dt.getDate(), year: dt.getFullYear(), t: dt.getTime() });
  }
  return out;
}

function climatologySeries(index, mm0, dd0) {
  const dates = localWindowDates(mm0, dd0, ALMANAC_NORMAL_HALF_WINDOW);
  const coldest = [], warmest = [], p10 = [], p90 = [], normHi = [], normLo = [];
  for (const dt of dates) {
    const b = index.byDate.get(pad(dt.mm, 2) + "-" + pad(dt.dd, 2));
    const tmaxVals = [];
    if (b) for (let i = 0; i < b.tmax.length; i++) if (!isNaN(b.tmax[i])) tmaxVals.push(b.tmax[i]);
    tmaxVals.sort((a, c) => a - c);
    if (tmaxVals.length >= 1) {
      coldest.push([dt.t, tmaxVals[0]]);
      warmest.push([dt.t, tmaxVals[tmaxVals.length - 1]]);
    } else { coldest.push([dt.t, null]); warmest.push([dt.t, null]); }
    if (tmaxVals.length >= ALMANAC_MIN_YEARS_BAND) {
      p10.push([dt.t, pctl(tmaxVals, 10)]);
      p90.push([dt.t, pctl(tmaxVals, 90)]);
    } else { p10.push([dt.t, null]); p90.push([dt.t, null]); }
    const norm = normalFor(index, dt.mm, dt.dd);
    normHi.push([dt.t, norm ? norm.hi : null]);
    normLo.push([dt.t, norm ? norm.lo : null]);
  }
  return { dates, coldest, warmest, p10, p90, normHi, normLo };
}

// ---- formatters -------------------------------------------------------------
// This board never prints "°F" — every temperature reads as a bare "94°"
// (matches the uiSpec verbatim); util.degF()'s "°F" suffix is the NOW board's
// own convention, not reused here.
function degSign(x) { return x == null || isNaN(x) ? "--" : Math.round(x) + "°"; }
function signed(n) { return (n > 0 ? "+" : "") + n; }
function dateAbbr(y, mm, dd) {
  return new Date(y, mm - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase();
}
function coordLabel(pt) {
  return Math.abs(pt.lat).toFixed(2) + (pt.lat < 0 ? "S" : "N") + " " +
         Math.abs(pt.lon).toFixed(2) + (pt.lon < 0 ? "W" : "E");
}

// ---- rendering ----------------------------------------------------------------
// All DOM via el() from util.js — no raw HTML strings anywhere. (Deliberately
// not naming the forbidden property here: the CI gate greps for it and cannot
// tell prose from a sink, which is the right trade for a security check.)
// Colors are CSS
// class toggles (boards.css maps .hot/.cold/.near/.record/.none to tokens);
// this module never assigns a hex value.

function row(k, v) { return [el("span", { class: "k" }, k), el("span", { class: "v" }, v)]; }
function rowBadge(k, v, badgeText) {
  const vEl = el("span", { class: "v" }, v);
  if (badgeText) vEl.append(el("span", { class: "srcbadge" }, badgeText));
  return [el("span", { class: "k" }, k), vEl];
}
function placeLine(loc) { return loc.name + (loc.state ? ", " + loc.state : "") + " · ALMANAC"; }

function effectivePoint(cs, cell) {
  return (cs.meta.cellMismatch && cs.meta.echoed) ? cs.meta.echoed : cell;
}
function headlineSrcNote(todaySrc, cs, cell) {
  const range = (cs.index.firstYear != null) ? (cs.index.firstYear + "–" + cs.index.lastYear) : "--";
  const src = todaySrc === "NWS" ? "NWS FORECAST" : "OPEN-METEO FORECAST";
  return "TODAY'S HIGH: " + src + " · RANKED AGAINST ERA5 " + range + " AT " + coordLabel(effectivePoint(cs, cell));
}

function backfillProgress(cs, nowYear) {
  const decades = plannedChunks(ALMANAC_CHUNK_YEARS, nowYear);
  const covered = coveredYears(cs.meta);
  let done = 0;
  for (const [y0, y1] of decades) if (spanFullyCovered(covered, y0, y1)) done++;
  return { done, total: decades.length };
}
// Shown only while the local record is incomplete — disappears once every
// reachable decade is cached, independent of the (separate) 30-year
// threshold that gates the percentage/normal statistics themselves.
function partialNoteText(cs, nowYear) {
  const yearsWithData = cs.index.yearsWithData;
  if (yearsWithData === 0) return null;
  const chunkYears = cs.meta.chunkYears || ALMANAC_CHUNK_YEARS;
  if (chunkYears !== ALMANAC_CHUNK_YEARS) {
    const chunks = plannedChunks(chunkYears, nowYear);
    const covered = coveredYears(cs.meta);
    let done = 0;
    for (const [y0, y1] of chunks) if (spanFullyCovered(covered, y0, y1)) done++;
    if (done >= chunks.length) return null;
    return "PARTIAL RECORD " + yearsWithData + " YRS · BACKFILLING " + done + "/" + chunks.length + " CHUNKS (" + chunkYears + "-YR)";
  }
  const { done, total } = backfillProgress(cs, nowYear);
  if (done >= total) return null;
  if (cs.backfill.failed) {
    return "PARTIAL RECORD " + yearsWithData + " YRS · BACKFILL PAUSED — " + (cs.backfill.err || "ERROR") + " · REOPEN TO RETRY";
  }
  return "PARTIAL RECORD " + yearsWithData + " YRS · BACKFILLING " + done + "/" + total + " DECADES";
}

function departureText(hi, lo, normal) {
  if (!normal || normal.hi == null || normal.lo == null || hi == null || lo == null) return "--";
  return signed(Math.round(hi - normal.hi)) + "° HIGH / " + signed(Math.round(lo - normal.lo)) + "° LOW";
}
function normalBadge(normal, yearsWithData) {
  return normal ? "ERA5 " + normal.period[0] + "–" + normal.period[1] : "NEEDS " + ALMANAC_MIN_YEARS_PCT + " YRS — HAVE " + yearsWithData;
}
function todayVsNormalSection(cs, normal) {
  const badge = normalBadge(normal, cs.index.yearsWithData);
  const src = today && today.src;
  const rows = [
    ...rowBadge("TODAY HIGH (FCST)", degSign(today && today.hi), src),
    ...rowBadge("TODAY LOW (FCST)", degSign(today && today.lo), src),
    ...rowBadge("NORMAL HIGH", normal ? Math.round(normal.hi) + "°" : "--", badge),
    ...rowBadge("NORMAL LOW", normal ? Math.round(normal.lo) + "°" : "--", badge),
    ...row("DEPARTURE", departureText(today && today.hi, today && today.lo, normal))
  ];
  return el("div", null, el("div", { class: "sect" }, "TODAY VS NORMAL"), el("div", { class: "grid" }, ...rows));
}

function rankRowText(rr) { return rr ? ordinal(Math.round(rr.rank)) + " WARMEST OF " + rr.n : "--"; }
function extremeRowText(e) { return e ? Math.round(e.value) + "° (" + e.year + (e.tied ? ", TIED" : "") + ")" : "--"; }
function recordSpanText(cs) {
  return cs.index.firstYear ? (cs.index.firstYear + "–" + cs.index.lastYear + " · " + cs.index.yearsWithData + " YRS") : "--";
}
// First tap arms a 4s confirm window ("TAP AGAIN TO REBUILD"); a second tap
// inside that window calls rebuild(). Exists so "forever cache" is a promise
// the user can revoke, guarded against a stray mis-tap discarding real work.
function recordSpanRow(cs) {
  const vEl = el("span", { class: "v rebuildable" }, recordSpanText(cs));
  let armed = false;
  vEl.addEventListener("click", () => {
    if (armed) {
      armed = false;
      vEl.textContent = "REBUILDING…";
      rebuild();
      return;
    }
    armed = true;
    vEl.textContent = "TAP AGAIN TO REBUILD";
    setTimeout(() => { if (armed) { armed = false; vEl.textContent = recordSpanText(cs); } }, 4000);
  });
  return [el("span", { class: "k" }, "RECORD SPAN"), vEl];
}
function recordSection(cs, rr, extremes, dateLabel) {
  const rows = [
    ...row("RANK TODAY", rankRowText(rr)),
    ...row("WARMEST " + dateLabel, extremeRowText(extremes && extremes.hi)),
    ...row("COLDEST " + dateLabel, extremeRowText(extremes && extremes.lo)),
    ...recordSpanRow(cs)
  ];
  return el("div", null, el("div", { class: "sect" }, dateLabel + " IN THE ERA5 RECORD"), el("div", { class: "grid" }, ...rows));
}

function climatologySection(cs, mm, dd) {
  const yrs = cs.index.yearsWithData;
  if (yrs < ALMANAC_MIN_YEARS_CHART) {
    return el("div", null,
      el("div", { class: "sect" }, "CLIMATOLOGY"),
      el("div", { class: "srcnote" }, "CLIMATOLOGY CHART NEEDS " + ALMANAC_MIN_YEARS_CHART + "+ YRS — HAVE " + yrs));
  }
  const s = climatologySeries(cs.index, mm, dd);
  const hasBand = yrs >= ALMANAC_MIN_YEARS_BAND;
  const chartSeries = [
    { type: "band", lo: s.coldest, hi: s.warmest, token: "--sub", alpha: 0.10 }
  ];
  if (hasBand) chartSeries.push({ type: "band", lo: s.p10, hi: s.p90, token: "--pred", alpha: 0.18 });
  chartSeries.push({ type: "line", data: s.normHi, token: "--pred-soft", width: 1.5, label: "NORM HI" });
  chartSeries.push({ type: "line", data: s.normLo, token: "--info", width: 1.5, label: "NORM LO" });
  if (today && (today.hi != null || today.lo != null)) {
    const center = s.dates[Math.floor(s.dates.length / 2)];
    if (center) chartSeries.push({ type: "line", data: [[center.t, today.hi], [center.t, today.lo]], token: "--sev-watch", width: 3 });
  }

  const host = el("div");
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  chartInst = chart(host, {
    height: 190, now: Date.now(),
    x: { min: s.dates[0].t, max: s.dates[s.dates.length - 1].t },
    y: { unit: "°" },   // no floor declared: a daily high in Fahrenheit CAN go negative, unlike AQI/precip
    series: chartSeries
  });

  const first = s.dates[0], last = s.dates[s.dates.length - 1];
  const rangeLabel = dateAbbr(first.year, first.mm, first.dd) + " – " + dateAbbr(last.year, last.mm, last.dd);
  const noteText = hasBand
    ? rangeLabel + " · BAND = 10–90% OF YEARS · OUTER = WARMEST/COLDEST EVER · LINES = NORMAL HIGH/LOW · BAR = TODAY'S FORECAST RANGE"
    : rangeLabel + " · OUTER = WARMEST/COLDEST IN " + yrs + " YRS · BAR = TODAY'S FORECAST RANGE";
  return el("div", null, el("div", { class: "sect" }, "CLIMATOLOGY"), host, el("div", { class: "srcnote" }, noteText));
}

function caveatNote() {
  return el("div", { class: "srcnote" },
    "ERA5 REANALYSIS AT A 0.25° GRID CELL (~28 KM), NOT AN OFFICIAL NWS STATION RECORD. AREA AVERAGES SMOOTH EXTREMES — " +
    "A GRID CELL'S HOTTEST DAY IS TYPICALLY LESS EXTREME THAN THE NEAREST THERMOMETER'S.");
}
function attribLine() {
  return el("div", { class: "attrib" },
    "HISTORICAL DATA BY ",
    el("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noopener" }, "OPEN-METEO.COM"),
    " · ERA5 REANALYSIS (COPERNICUS CLIMATE CHANGE SERVICE / ECMWF)");
}

function paintMsg(text) {
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  boardEl.replaceChildren(el("div", { class: "bigmsg" }, text));
}
// The permanent caveat still renders under a failure message — losing it on
// exactly the path where the archive is unreachable would be a bug in the
// one place this board's honesty matters most.
function paintMsgWithCaveat(text) {
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  boardEl.replaceChildren(el("div", { class: "bigmsg" }, text), caveatNote());
}

function paintBoard(cs, loc, cell) {
  const now = new Date();
  const mm = now.getMonth() + 1, dd = now.getDate();
  const dateLabel = dateAbbr(now.getFullYear(), mm, dd);
  const nowYear = now.getFullYear();

  const todayHi = today ? today.hi : null;

  const phrase = headlinePhrase(cs.index, mm, dd, todayHi, dateLabel);
  const normal = normalFor(cs.index, mm, dd);
  const rr = rankToday(cs.index, mm, dd, todayHi);
  const extremes = dayExtremes(cs.index, mm, dd);

  const kids = [
    el("div", { class: "place" }, placeLine(loc)),
    el("div", { class: "bigtemp" }, degSign(todayHi)),
    el("div", { class: "bigcond " + phrase.cls }, phrase.text),
    el("div", { class: "srcnote" }, headlineSrcNote(today && today.src, cs, cell))
  ];
  const partial = partialNoteText(cs, nowYear);
  if (partial) kids.push(el("div", { class: "srcnote" }, partial));

  kids.push(todayVsNormalSection(cs, normal));
  kids.push(recordSection(cs, rr, extremes, dateLabel));
  kids.push(climatologySection(cs, mm, dd));
  kids.push(caveatNote());
  kids.push(attribLine());

  boardEl.replaceChildren(...kids);
}

function render() {
  if (!boardEl) return;
  const loc = locations.active();
  if (!loc) { paintMsg("SET A LOCATION — TAP THE CONDITIONS PANEL"); return; }
  const cell = cellFor(loc);
  const cs = cells.get(cell.key);
  if (!cs || !cs.loadedFromIdb) { paintMsg("BUILDING LOCAL CLIMATE RECORD…"); return; }
  if (cs.index.yearsWithData === 0) {
    if (cs.backfill.failed) { paintMsgWithCaveat("CLIMATE ARCHIVE UNAVAILABLE — " + (cs.backfill.err || "ERROR")); return; }
    paintMsg("BUILDING LOCAL CLIMATE RECORD…");
    return;
  }
  paintBoard(cs, loc, cell);
}

// ---- lifecycle -----------------------------------------------------------

async function enterCell(cell, mySeq) {
  let cs = cells.get(cell.key);
  if (!cs) { cs = newCellState(cell); cells.set(cell.key, cs); }

  if (!cs.loadedFromIdb) {
    await sweepOldVersion(cell);
    if (seq !== mySeq) return;
    const meta = await loadMeta(cell);
    if (seq !== mySeq) return;
    if (meta) {
      cs.meta = meta;
      for (const k of Object.keys(meta.chunks || {})) {
        if (!meta.chunks[k].ok) continue;
        const chunk = await loadChunk(cell, Number(k));
        if (seq !== mySeq) return;
        if (chunk) cs.chunks.set(Number(k), chunk);
      }
      cs.index = buildIndex(cs.chunks);
    }
    cs.loadedFromIdb = true;
  }
  if (seq !== mySeq) return;

  render();

  const loc = locations.active();
  if (loc) todayHiLo(loc).then((t) => { if (seq === mySeq) { today = t; render(); } });

  ensureBackfill(cell, mySeq);
}

function onEnter() {
  seq++;
  const mySeq = seq;
  const loc = locations.active();
  if (!loc) { activeCellKey = null; render(); return; }
  const cell = cellFor(loc);
  activeCellKey = cell.key;
  enterCell(cell, mySeq);
}

function onLocationChange(loc) {
  seq++;
  const mySeq = seq;
  today = null;
  if (!loc) { activeCellKey = null; if (boards.current() === "almanac") render(); return; }
  if (boards.current() !== "almanac") return;   // stay lazy off-screen

  const cell = cellFor(loc);
  if (cell.key === activeCellKey) {
    // same grid cell — only the .place line (and possibly today's leg)
    // changes, zero archive network, which is the whole point of cell-keying
    render();
    todayHiLo(loc).then((t) => { if (seq === mySeq) { today = t; render(); } });
    return;
  }
  activeCellKey = cell.key;
  enterCell(cell, mySeq);
}

// ---- public -----------------------------------------------------------------

export function init() {
  boardEl = document.getElementById("board-almanac");
  if (!boardEl) return;
  boards.register({ id: "almanac", label: "ALMANAC", el: boardEl, render, onEnter });
  locations.onChange(onLocationChange);
}

// Drops the in-memory today-leg + repaints + resumes the backfill drip. Does
// NOT touch the IndexedDB history — that's rebuild()'s job.
export function refresh() {
  seq++;
  const mySeq = seq;
  today = null;
  const loc = locations.active();
  if (!loc) { render(); return; }
  const cell = cellFor(loc);
  const cs = cells.get(cell.key);
  if (cs) { cs.backfill.failed = false; cs.backfill.err = null; }
  render();
  if (boards.current() === "almanac") {
    todayHiLo(loc).then((t) => { if (seq === mySeq) { today = t; render(); } });
    ensureBackfill(cell, mySeq);
  }
}

// Wired to the double-tap confirm on the RECORD SPAN row: drops every cached
// chunk + the meta record for the active cell and restarts the backfill from
// decade 0. "Forever cache" is a promise the user can revoke.
export function rebuild() {
  const loc = locations.active();
  if (!loc) return;
  const cell = cellFor(loc);
  const cs = cells.get(cell.key);
  seq++;
  const mySeq = seq;
  cells.delete(cell.key);
  activeCellKey = null;
  render();   // falls back to the BUILDING state immediately
  dropCell(cell, cs).then(() => {
    if (seq !== mySeq) return;
    activeCellKey = cell.key;
    if (boards.current() === "almanac") enterCell(cell, mySeq);
  });
}
