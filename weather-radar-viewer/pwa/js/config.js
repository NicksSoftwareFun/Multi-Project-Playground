// Constants and endpoints. Everything remote the app touches is defined here.

export const IEM = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/";
export const GOES_DIR = "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/GEOCOLOR/";
export const GOES_PRIMARY = GOES_DIR + "GOES19-ABI-CONUS-GEOCOLOR-2500x1500.jpg";
export const GOES_FALLBACK = GOES_DIR + "latest.jpg";
// Basemap split in two: geography underneath the radar, place labels on a pane
// above it. A wide swath of 60 dBZ returns used to bury every city name in the
// state, which is exactly when you most want to know what is under the storm.
export const BASEMAP = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
export const BASEMAP_LABELS = "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png";
export const BASEMAP_ATTRIB = "&copy; OSM &copy; CARTO · IEM/NOAA · NOAA STAR";
export const OM_FORECAST = "https://api.open-meteo.com/v1/forecast";
export const NWS_POINTS = "https://api.weather.gov/points/";
export const ZIPPO = "https://api.zippopotam.us/us/";

// --- severe weather (M2) ---
// NOTE: never send a custom User-Agent to api.weather.gov — it triggers a CORS
// preflight the server rejects, and the browser default UA is explicitly fine.
export const NWS_ALERTS = "https://api.weather.gov/alerts/active";
export const NWS_ZONES = "https://api.weather.gov/zones/";
export const ARCGIS_VECTOR = "https://mapservices.weather.noaa.gov/vector/rest/services/";
export const ARCGIS_TROPICAL_ROOT = "https://mapservices.weather.noaa.gov/tropical/rest/services";
export const SPC_OUTLOOKS = ARCGIS_VECTOR + "outlooks/SPC_wx_outlks/MapServer";
export const SPC_MD = ARCGIS_VECTOR + "outlooks/spc_mesoscale_discussion/MapServer";

// Layer ids verified live in CI (endpoint-checks run 31618327989). Treated as
// hints only: spc.js re-discovers ids from /MapServer/layers?f=json and falls
// back to these if discovery fails, because NOAA renumbers periodically.
export const SPC_LAYER_HINTS = { d1: 1, d2: 9, d3: 17 };

// --- alert notifications (Android shell) ---
// Category catalog for the notifications menu. Array order is both display
// order and match priority — the first category with a keyword hit wins, so
// WINTER sits before WIND to make "Wind Chill Watch" land in WINTER, and
// TROPICAL before WIND for "Hurricane Force Wind Warning". Anything with no
// hit falls through to OTHER. The Android shell does the actual background
// matching with the same table in Alerts.java — keep the two in sync.
export const NOTIFY_CATS = [
  { id: "tornado",  label: "TORNADO",   match: ["tornado"] },
  { id: "tstorm",   label: "T-STORM",   match: ["thunderstorm"] },
  { id: "flood",    label: "FLOOD",     match: ["flood", "hydrologic"] },
  { id: "tropical", label: "TROPICAL",  match: ["hurricane", "tropical", "storm surge", "typhoon"] },
  { id: "winter",   label: "WINTER",    match: ["winter", "blizzard", "ice", "snow", "freez",
                                                "frost", "chill", "cold", "avalanche"] },
  { id: "heat",     label: "HEAT",      match: ["heat"] },
  { id: "wind",     label: "WIND",      match: ["wind", "gale"] },
  { id: "fire",     label: "FIRE",      match: ["fire", "red flag"] },
  { id: "airfog",   label: "FOG / AIR", match: ["fog", "air quality", "smoke", "dust",
                                                "air stagnation", "ashfall"] },
  { id: "other",    label: "OTHER",     match: [] }
];

export const ALERT_POLL_QUIET_MS = 10 * 60 * 1000;
export const ALERT_POLL_ACTIVE_MS = 60 * 1000;
export const ALERT_STALE_MS = 15 * 60 * 1000;   // hide the chip rather than show maybe-expired warnings
export const SPC_REFRESH_MS = 30 * 60 * 1000;
export const ZONE_CACHE_VER = 1;

// Alert severity classes drive color + sort order everywhere (chip, polygons, board).
export const SEV = {
  warning:  { rank: 0, token: "--sev-warn",  label: "WARNING" },
  watch:    { rank: 1, token: "--sev-watch", label: "WATCH" },
  advisory: { rank: 2, token: "--sev-adv",   label: "ADVISORY" },
  statement:{ rank: 3, token: "--sev-stmt",  label: "STATEMENT" }
};
export function alertClass(event) {
  const e = String(event || "").toLowerCase();
  if (e.includes("warning")) return "warning";
  if (e.includes("watch")) return "watch";
  if (e.includes("advisory")) return "advisory";
  return "statement";
}
// Short chip text: "Tornado Warning" -> "TOR WARNING"
export const EVENT_ABBR = {
  tornado: "TOR", "severe thunderstorm": "SVR", "flash flood": "FFW", flood: "FLD",
  "winter storm": "WSW", blizzard: "BLZ", "ice storm": "ICE", "high wind": "WND",
  "excessive heat": "HEAT", heat: "HEAT", "red flag": "FIRE", "dense fog": "FOG",
  "special weather statement": "SPS", "hurricane": "HUR", "tropical storm": "TRO",
  "storm surge": "SURGE", "wind chill": "CHILL", "freeze": "FRZ", "frost": "FROST"
};

// --- forecast depth (M3) ---
export const OM_ENSEMBLE = "https://ensemble-api.open-meteo.com/v1/ensemble";
export const CAST_TTL_MS = 30 * 60 * 1000;      // on-demand board data, cached between opens
export const ENSEMBLE_TTL_MS = 60 * 60 * 1000;

// Deterministic models for the disagreement view. HRRR only reaches ~48h, so it
// simply ends early on the chart — an honest gap, not an error.
export const COMPARE_MODELS = [
  { id: "best_match", label: "BEST", token: "--accent" },
  { id: "ncep_hrrr_conus", label: "HRRR", token: "--ok" },
  { id: "ncep_nbm_conus", label: "NBM", token: "--pred-soft" },
  { id: "gfs_seamless", label: "GFS", token: "--info" },
  { id: "ecmwf_ifs025", label: "ECMWF", token: "--sev-watch" }
];
// Ensemble members give the confidence band (verified 31 KB for 7 days of one variable).
export const ENSEMBLE_MODELS = [
  { id: "gfs025", label: "GEFS", members: 31 },
  { id: "ecmwf_ifs025", label: "ECMWF ENS", members: 51 }
];

// --- air quality (M4) ---
export const OM_AIR = "https://air-quality-api.open-meteo.com/v1/air-quality";
export const AIR_REFRESH_MS = 60 * 60 * 1000;
// US EPA AQI breakpoints (official category colors)
export const AQI_CATS = [
  { max: 50,  label: "GOOD", color: "#00E400" },
  { max: 100, label: "MODERATE", color: "#FFFF00" },
  { max: 150, label: "UNHEALTHY — SENSITIVE GROUPS", color: "#FF7E00" },
  { max: 200, label: "UNHEALTHY", color: "#FF0000" },
  { max: 300, label: "VERY UNHEALTHY", color: "#8F3F97" },
  { max: Infinity, label: "HAZARDOUS", color: "#7E0023" }
];
export function aqiCat(v) {
  if (v == null || isNaN(v)) return null;
  return AQI_CATS.find((c) => v <= c.max);
}
// Open-Meteo's pollen fields come from CAMS Europe and are null across CONUS
// (verified over 3 points in CI) — the AIR board omits pollen rather than
// printing a column of "--".
export const POLLEN_AVAILABLE_US = false;

// SPC categorical outlook fill colors (official SPC palette)
export const SPC_CAT_COLORS = {
  TSTM: "#C1E9C1", MRGL: "#66A366", SLGT: "#FFE066", ENH: "#E6A23C",
  MDT: "#E06666", HIGH: "#EE99EE"
};

// --- astronomy (M5) ---
// A horizontal drag starting this close to a screen edge belongs to the board
// deck, not to whatever it lands on. It is how the deck stays swipeable across
// CAST, where charts legitimately own horizontal drags for cursor scrubbing.
// Read by BOTH boards.js (claims the gesture) and charts.js (declines it) —
// they must never disagree about the size of this zone.
export const EDGE_SWIPE_PX = 28;

export const SKY_TICK_MS = 30 * 1000;         // countdown refresh while the board is on screen
export const SKY_SAMPLE_MIN = 5;               // altitude-track sampling interval: 289 points/body over 24h, ~1ms for both
export const SKY_TZ_WARN_H = 3;                // device-vs-longitude gap that triggers the timezone note; 3 rather than 2 so wide legitimate zones (e.g. Indiana on EDT) don't false-positive
export const SKY_PHASE_UNCERTAINTY_H = 5;      // rendered in the phase-accuracy caveat, held here so the constant and the sentence cannot drift apart

// --- almanac (M5, climatology half) ---
export const OM_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
export const ALMANAC_CACHE_VER = 1;
// Confirmed live: archive-api.open-meteo.com/v1/archive accepts start_date
// 1940-01-01 exactly and rejects 1939-01-01 ("out of allowed range").
export const ALMANAC_EPOCH_YEAR = 1940;
export const ALMANAC_CHUNK_YEARS = 10;
export const ALMANAC_CHUNKS_PER_VISIT = 3;
export const ALMANAC_CHUNK_GAP_MS = 1500;
export const ALMANAC_CHUNK_FETCH_MS = 30000;   // fetchT's 8s default cannot carry a decade of daily data
export const ALMANAC_TAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // only the decade containing the current year is ever refetched
export const ALMANAC_TODAY_TTL_MS = 30 * 60 * 1000;
export const ALMANAC_GRID_DEG = 0.25;   // ERA5 native grid
export const ALMANAC_NORMAL_HALF_WINDOW = 7;
export const ALMANAC_NORMAL_PERIOD = [1991, 2020];   // WMO current standard normals period
export const ALMANAC_MIN_YEARS_PCT = 30;
export const ALMANAC_MIN_YEARS_BAND = 10;
export const ALMANAC_MIN_YEARS_CHART = 5;
export const ALMANAC_NEAR_BAND = 0.10;   // 0.40-0.60 exceedance reads NEAR NORMAL

// --- winter hazards (M6) ---
export const ARCGIS_RASTER_ROOT = "https://mapservices.weather.noaa.gov/raster";
// Confirmed live by the M6 discovery probe. The service folder moved obs/ ->
// snow/ without notice, and the old path still answers HTTP 200 with an
// {"error":...} body rather than a 404 — which is exactly why winter.js walks
// the service directory instead of trusting a path. Last-resort fallback only.
// layerIdHint is the "Snow Depth" GROUP layer in the recorded catalog; its
// pixels live in the mosaic's Image child (rasterIdHint), because an ArcGIS
// export does not expand a group id in layers=show. Both are last-resort
// values used only when /layers cannot be read, and winter.js says "hinted"
// in the layer's health note whenever it falls back to them.
export const NOHRSC_SERVICE_HINT = {
  name: "snow/NOHRSC_Snow_Analysis", type: "MapServer",
  layerNameHint: "Snow Depth", layerIdHint: 0, rasterIdHint: 3
};
export const WINTER_REFRESH_MS = 15 * 60 * 1000;
export const NOHRSC_REFRESH_MS = 60 * 60 * 1000;   // conservative: NOHRSC's real cadence is unconfirmed

// WPC probabilistic winter guidance — confirmed live at
// precip/wpc_prob_winter_precip, 15 layers (Day 1-3 x {accumulation, >=4in,
// >=8in, >=12in snow, icing >0.25in}). No id hint is kept on purpose:
// wpcDay1LayerId() always resolves by name, and the service is too new to this
// app to earn a hardcoded fallback.
export const WPC_WINTER_REFRESH_MS = 30 * 60 * 1000;

// mm/cm/m/in -> inches. Confirmed: the live gridpoint probe returned
// "wmoUnit:mm" for both snowfallAmount and iceAccumulation. The other rows
// exist so a WFO reporting a different unit family converts correctly rather
// than being rendered with a guessed factor.
export const UOM_TO_IN = {
  "wmoUnit:mm": 1 / 25.4, "wmoUnit:cm": 1 / 2.54, "wmoUnit:m": 1000 / 25.4, "wmoUnit:in": 1
};

// --- GOES satellite channels (M6) ---
// Confirmed live: CH13/CH02 are real IEM tile layers (52 KB / 67 KB PNGs).
// GEOCOLOR is NOT an IEM tile layer — goes_east_conus_geocolor and
// _truecolor both 503 live and 404 archived — so GEOCOLOR keeps the existing
// NOAA STAR full-frame mechanism (GOES_PRIMARY/GOES_FALLBACK above) and only
// CH13/CH02 use tiles. Never label a legacy visible composite as GeoColor.
export const IEM_GOES_ARCHIVE = "https://mesonet.agron.iastate.edu/c/tile.py/1.0.0/";
export const GOES_CHANNELS = [
  { id: "geocolor", label: "GEOCOLOR", mech: "image" },
  { id: "ch13", label: "CH13 IR", mech: "tile",
    layers: ["goes_east_conus_ch13"], aliasLayers: ["goes-east-ir-4km"],
    aliasNote: "LEGACY 4KM IR COMPOSITE" },
  { id: "ch02", label: "CH02 VIS", mech: "tile",
    layers: ["goes_east_conus_ch02"], aliasLayers: ["goes-east-vis-1km"],
    aliasNote: "LEGACY 1KM VISIBLE COMPOSITE" }
];

// --- atmospheric profile (M7) ---
// Confirmed live on a real runner: the 6-level x 5-variable hourly request is
// accepted (HTTP 200, 30/30 variables returned, ~9.8 KB for one day) and
// relative_humidity_{p}hPa IS populated — the earlier "RH is null everywhere"
// finding came from a network-blocked sandbox and was a stub artifact.
export const OM_LEVELS = [1000, 925, 850, 700, 500, 300];
export const PROFILE_TTL_MS = 30 * 60 * 1000;      // same cadence as CAST_TTL_MS
export const PROFILE_FETCH_MS = 15000;             // pressure-level payloads run past fetchT's 8s default
// JUDGMENT CALLS, on the same footing as airq.js's DRIVER_TOLERANCE: documented,
// not derived, and biased toward saying "uncertain" rather than printing a number.
export const CLOUD_RH_THRESHOLD = 80;              // % RH at a level that counts as "cloudy"
export const PROFILE_GAP_WARN_M = 2500;            // interpolation gap that earns an "approximate" note
export const PROFILE_INVERSION_MIN_C = 0.1;        // warming-with-height smaller than this is noise, not an inversion
// An inversion only corrupts a freezing level if it happens in air near 0°C. A
// nocturnal inversion in an 18°C airmass is real and irrelevant, and blanking
// the freezing level for it would print "--" on most clear nights.
export const PROFILE_INVERSION_NEAR_C = 3;         // |t| within this of zero makes an inversion disqualifying
// Sensitivity test on the crossing layer: shift both endpoints by this much and
// see how far the interpolated height moves. A near-isothermal layer through
// 0°C moves kilofeet for a fraction of a degree, which the reader must be told.
export const PROFILE_LAPSE_DT_C = 0.5;
export const PROFILE_LAPSE_WARN_M = 300;
// Warmest sampled level at or above this still leaves room for an unsampled
// warm nose between levels, so the all-snow verdict must hedge.
export const PROFILE_NEAR_ZERO_C = -1.5;
// 2 m humidity is NOT a cloud criterion (80-95% at screen height is an ordinary
// humid night). It is reported separately, as possible fog, and only this high.
export const FOG_RH_THRESHOLD = 95;
export const PROFILE_MIX_SHALLOW_M = 500;
export const PROFILE_MIX_DEEP_M = 1500;
// ISA heights, last resort only: geopotential_height is real and populated, so
// this table should essentially never fire. Any line built on it says so.
export const STANDARD_ATM_FT_BY_HPA = {
  1000: 364, 925: 2500, 850: 4781, 700: 9882, 500: 18289, 300: 30065
};


export const HOME_VIEW = { center: [38.5, -86], zoom: 5 };
export const DEFAULT_VIEW_KM = 200;   // boot + home framing around the active location
export const AUTO_CLOSE_KM = 175;     // auto-mode second radar pass

// Timeline frame model: 11 past frames at 5-min steps, 11 future at 15-min.
export const PAST = 11;
export const FUT = 11;
export const NOW_I = PAST - 1;
export const NFRAMES = PAST + FUT;
export function frameT(i) { return i < PAST ? -(PAST - 1 - i) * 5 : (i - PAST + 1) * 15; }
export const T_MIN = frameT(0);
export const T_SPAN = frameT(NFRAMES - 1) - T_MIN;

export const REFRESH_MS = 5 * 60 * 1000;      // radar frame rebuild + GOES reload
export const WX_REFRESH_MS = 10 * 60 * 1000;  // conditions
export const FRAME_MS = 700;                  // animation cadence

// NWS reflectivity legend ramp
export const PAL = ["#04E9E7","#019FF4","#0300F4","#02FD02","#01C501","#008E00","#FDF802",
  "#E5BC00","#FD9500","#FD0000","#D40000","#BC0000","#F800FD","#9854C6","#FDFDFD"];

export const WMO = {
  0: "CLEAR", 1: "MOSTLY CLEAR", 2: "PARTLY CLOUDY", 3: "OVERCAST",
  45: "FOG", 48: "FREEZING FOG",
  51: "LIGHT DRIZZLE", 53: "DRIZZLE", 55: "HEAVY DRIZZLE",
  56: "FRZ DRIZZLE", 57: "FRZ DRIZZLE",
  61: "LIGHT RAIN", 63: "RAIN", 65: "HEAVY RAIN",
  66: "FREEZING RAIN", 67: "FREEZING RAIN",
  71: "LIGHT SNOW", 73: "SNOW", 75: "HEAVY SNOW", 77: "SNOW GRAINS",
  80: "SHOWERS", 81: "SHOWERS", 82: "HEAVY SHOWERS",
  85: "SNOW SHOWERS", 86: "SNOW SHOWERS",
  95: "THUNDERSTORM", 96: "T-STORM + HAIL", 99: "T-STORM + HAIL"
};

export const DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
