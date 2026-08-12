#!/usr/bin/env node
// Live endpoint health checks for the SKYWATCH data sources.
// Plain Node >= 20 (global fetch), no dependencies, no Playwright.
//
// Every check is advisory: failures are recorded, a summary table is printed,
// endpoint-results.json is written, and the process always exits 0.
// Run: node integration/endpoint-checks.mjs   (or `npm run endpoints`)

const ORIGIN = "https://nickssoftwarefun.github.io";
const results = [];

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${id}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function check(id, fn) {
  try {
    const detail = await fn();
    record(id, true, detail ?? "");
  } catch (e) {
    record(id, false, String(e && e.message ? e.message : e));
  }
}

function acao(res) {
  return res.headers.get("access-control-allow-origin");
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------

// 1. SPC convective outlooks MapServer — CORS + layer catalog
await check("spc-outlooks-layers", async () => {
  const res = await fetch(
    "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer/layers?f=json",
    { headers: { Origin: ORIGIN } }
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(acao(res), "no access-control-allow-origin header");
  const j = await res.json();
  assert(Array.isArray(j.layers), "no layers array in response");
  const layerMap = {};
  for (const l of j.layers) layerMap[l.id] = l.name;
  return { acao: acao(res), layerCount: j.layers.length, layers: layerMap };
});

// 2. NHC tropical weather summary MapServer — CORS + service metadata
await check("nhc-tropical-summary-mapserver", async () => {
  const res = await fetch(
    "https://mapservices.weather.noaa.gov/vector/rest/services/tropical/NHC_tropical_weather_summary/MapServer?f=json",
    { headers: { Origin: ORIGIN } }
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(acao(res), "no access-control-allow-origin header");
  const j = await res.json();
  assert(!j.error, `service error: ${JSON.stringify(j.error)}`);
  return { acao: acao(res), mapName: j.mapName, layerCount: (j.layers || []).length };
});

// 3. NWS active alerts by point — no custom User-Agent, CORS, geometry census
await check("nws-alerts-active-point", async () => {
  const res = await fetch("https://api.weather.gov/alerts/active?point=41.7300,-93.6000", {
    headers: { Origin: ORIGIN },
  });
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(acao(res), "no access-control-allow-origin header");
  const j = await res.json();
  assert(Array.isArray(j.features), "no features array");
  const sample = j.features.slice(0, 20);
  const nullGeom = sample.filter((f) => f.geometry == null).length;
  const detail = {
    acao: acao(res),
    features: j.features.length,
    sampled: sample.length,
    nullGeometryFraction: sample.length ? +(nullGeom / sample.length).toFixed(2) : null,
  };
  const withZones = sample.find(
    (f) => f.properties && Array.isArray(f.properties.affectedZones) && f.properties.affectedZones.length
  );
  if (withZones) {
    const zres = await fetch(withZones.properties.affectedZones[0], { headers: { Origin: ORIGIN } });
    assert(zres.status === 200, `zone fetch HTTP ${zres.status}`);
    const z = await zres.json();
    assert(z.geometry != null, "zone response has no geometry");
    detail.zoneGeometry = z.geometry.type;
  } else {
    detail.zoneGeometry = "no alerts with affectedZones to sample";
  }
  return detail;
});

// 4. NHC CurrentStorms.json — record CORS posture (absence expected, not a failure)
await check("nhc-current-storms-cors", async () => {
  const res = await fetch("https://nhc.noaa.gov/CurrentStorms.json", {
    headers: { Origin: ORIGIN },
    redirect: "follow",
  });
  return {
    status: res.status,
    acaoPresent: Boolean(acao(res)),
    acao: acao(res) || "(absent — expected; needs a proxy or server-side fetch)",
  };
});

// 5. Open-Meteo ensemble (GFS 0.25°) — availability + payload size
await check("open-meteo-ensemble-gfs025", async () => {
  const res = await fetch(
    "https://ensemble-api.open-meteo.com/v1/ensemble?latitude=41.73&longitude=-93.6&hourly=temperature_2m&models=gfs025&forecast_days=7"
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = buf.byteLength;
  const warn = bytes > 3 * 1024 * 1024;
  if (warn) console.warn(`  warning: ensemble payload is ${(bytes / 1048576).toFixed(1)} MB (>3MB)`);
  return { bytes, megabytes: +(bytes / 1048576).toFixed(2), over3MB: warn };
});

// 6. Open-Meteo air quality pollen — are CONUS values all null?
await check("open-meteo-pollen-conus", async () => {
  const points = [
    { name: "Ankeny IA", lat: 41.73, lon: -93.6 },
    { name: "Denver CO", lat: 39.74, lon: -104.99 },
    { name: "Atlanta GA", lat: 33.75, lon: -84.39 },
  ];
  const perPoint = {};
  let anyValue = false;
  for (const p of points) {
    const res = await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat}&longitude=${p.lon}&hourly=birch_pollen,grass_pollen,ragweed_pollen`
    );
    assert(res.status === 200, `${p.name}: HTTP ${res.status}`);
    const j = await res.json();
    const h = j.hourly || {};
    const vals = [
      ...(h.birch_pollen || []),
      ...(h.grass_pollen || []),
      ...(h.ragweed_pollen || []),
    ];
    const nonNull = vals.filter((v) => v != null).length;
    if (nonNull > 0) anyValue = true;
    perPoint[p.name] = { values: vals.length, nonNull };
  }
  return { allValuesNull: !anyValue, perPoint };
});

// 7. NOHRSC snow analysis export — must return an image
await check("nohrsc-snow-export-image", async () => {
  const res = await fetch(
    "https://mapservices.weather.noaa.gov/raster/rest/services/obs/NOHRSC_Snow_Analysis/MapServer/export" +
      "?f=image&bbox=-94.0,41.4,-93.2,42.0&bboxSR=4326&imageSR=4326&size=128,96&format=png&transparent=true",
    { headers: { Origin: ORIGIN } }
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  assert(ct.startsWith("image/"), `content-type is ${ct}, expected image/*`);
  const buf = await res.arrayBuffer();
  return { contentType: ct, bytes: buf.byteLength, acaoPresent: Boolean(acao(res)) };
});

// 8. NWPS gauges API — record CORS posture on a known gauge
await check("nwps-gauge-desi4-cors", async () => {
  const res = await fetch("https://api.water.noaa.gov/nwps/v1/gauges/DESI4", {
    headers: { Origin: ORIGIN },
  });
  return {
    status: res.status,
    acaoPresent: Boolean(acao(res)),
    acao: acao(res) || "(absent)",
  };
});

// 9. USGS instantaneous values — 200 + CORS
await check("usgs-iv-gauge-height", async () => {
  const res = await fetch(
    "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=05481950&parameterCd=00065&siteStatus=all",
    { headers: { Origin: ORIGIN } }
  );
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(acao(res), "no access-control-allow-origin header");
  const j = await res.json();
  const series = j.value && Array.isArray(j.value.timeSeries) ? j.value.timeSeries.length : 0;
  return { acao: acao(res), timeSeries: series };
});

// 10. Open-Meteo NBM model — accepted (200) or rejected (400)?
await check("open-meteo-nbm-model", async () => {
  const res = await fetch(
    "https://api.open-meteo.com/v1/forecast?latitude=41.73&longitude=-93.6&hourly=temperature_2m&models=ncep_nbm_conus"
  );
  const body = await res.text();
  let reason = "";
  if (res.status !== 200) {
    try { reason = JSON.parse(body).reason || ""; } catch { /* ignore */ }
  }
  return { status: res.status, nbmAccepted: res.status === 200, reason };
});

// ---------------------------------------------------------------------------
// summary

const pad = (s, n) => String(s).padEnd(n);
const wId = Math.max(...results.map((r) => r.id.length), 2) + 2;
console.log("\n" + pad("CHECK", wId) + pad("OK", 6) + "DETAIL");
console.log("-".repeat(wId + 6 + 60));
for (const r of results) {
  const detail = typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail);
  console.log(pad(r.id, wId) + pad(r.ok ? "yes" : "NO", 6) + detail.slice(0, 160));
}
const failures = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failures}/${results.length} checks ok (advisory — exit 0 regardless)`);

const { writeFileSync } = await import("node:fs");
writeFileSync(
  "endpoint-results.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), origin: ORIGIN, results }, null, 2) + "\n"
);
console.log("wrote endpoint-results.json");

process.exit(0);
