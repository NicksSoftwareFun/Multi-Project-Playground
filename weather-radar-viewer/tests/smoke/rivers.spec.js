// River gauge smoke (M7): the NEARBY RIVER GAUGES section on the SEVERE board
// and the optional RIVER GAUGES map layer.
//
// The stubs behind this file REFUSE malformed requests (see _setup.js):
//   - the OGC discovery API 400s a bad bbox, an out-of-range limit, and any
//     query parameter it does not know (as OGC API - Features requires);
//   - the classic waterservices IV endpoint 400s a missing format/parameterCd,
//     404s unknown site ids, and answers the bBox= form with the 504 timeout
//     that made it unusable for discovery in the first place — so a regression
//     back to bbox discovery fails the suite instead of shipping a board that
//     hangs for 45 seconds;
//   - NWPS 400s a partial bbox or a wrong srid and 404s an unknown gauge id.
// Every "it rendered" assertion below therefore also asserts the app asked
// correctly.
//
// Fixture geography (around the default Ankeny, IA location):
//   Fourmile Creek 05484800  1.1 mi  -> NWPS ANKI4, which defines NO categories
//   Des Moines R.  05485500  4.2 mi  -> NWPS SAYI4, action/minor/moderate/major
//                                       20/24/26/30 ft, stage 11.2 ft
//   Beaver Creek   05481950 10.1 mi  -> no NWPS gauge within the match radius
//   plus one groundwater WELL, which must never be listed as a river gauge.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot, HOSTILE, USGS_OGC_SITES, NWPS_GAUGES_BBOX,
        NWPS_GAUGE_FLOW_ONLY } = require("./_setup");

const BOARD = "#board-severe";
const STRIP = BOARD + " #riverStrip";
const ROWS = STRIP + " .gaugerow";
const PINS = "#lmap .leaflet-swRivers-pane path";
const CORS = { "access-control-allow-origin": "*" };

async function openSevere(page) {
  await page.locator("#wxPanel").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await page.locator("#boardDots .dot", { hasText: "SEVERE" }).click();
  await expect(page.locator(BOARD)).toHaveClass(/\bactive\b/);
}

function jsonRoute(body) {
  return (route) => route.fulfill({ status: 200, contentType: "application/json",
                                    headers: CORS, body });
}

function row(page, label) {
  return page.locator("#layerRows .layerrow", { hasText: label });
}

// A hand-built IV response, for the cases the shared stub's healthy fixture
// cannot express: a site reporting discharge but no gauge height, and a stage
// whose observation time is hours old. Same shape the stub emits.
function ivBody(entries) {
  const stamp = (ms) => new Date(ms).toISOString().replace("Z", "-00:00");
  const timeSeries = [];
  for (const e of entries) {
    const add = (code, unit, value) => timeSeries.push({
      sourceInfo: { siteName: e.name, siteCode: [{ value: e.site, agencyCode: "USGS" }] },
      variable: { variableCode: [{ value: code }], unit: { unitCode: unit } },
      values: [{ value: [{ value: String(value), qualifiers: ["P"],
                           dateTime: stamp(e.when == null ? Date.now() : e.when) }] }],
    });
    if (e.stage != null) add("00065", "ft", e.stage);
    if (e.flow != null) add("00060", "ft3/s", e.flow);
  }
  return JSON.stringify({ value: { timeSeries } });
}

const FOURMILE = { site: "05484800", name: "Fourmile Creek at Ankeny, IA", stage: 5.4 };
const BEAVER = { site: "05481950", name: "Beaver Creek near Grimes, IA", stage: 3.1, flow: 210 };

async function openRiverLayer(page) {
  await page.locator("#layersBtn").click();
  const rivers = row(page, "RIVER GAUGES");
  await expect(rivers).toBeVisible({ timeout: 15_000 });
  await rivers.click();
  await expect(rivers).toHaveClass(/\bon\b/);
  await expect.poll(() => page.locator(PINS).count(), { timeout: 15_000 }).toBe(3);
  await page.keyboard.press("Escape");
}

function pinStyles(page) {
  return page.locator(PINS).evaluateAll((nodes) => nodes.map((n) => ({
    stroke: n.getAttribute("stroke"),
    fillOpacity: n.getAttribute("fill-opacity"),
    dash: n.getAttribute("stroke-dasharray"),
  })));
}

// ---------------------------------------------------------------------------

test("the SEVERE board lists nearby stream gauges, nearest first, wells excluded", async ({ page }) => {
  await routeAll(page);
  const { errors } = await boot(page);
  await openSevere(page);

  await expect(page.locator(STRIP + " .sect")).toHaveText("NEARBY RIVER GAUGES", { timeout: 15_000 });
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const names = await page.locator(ROWS + " .name").allTextContents();
  expect(names[0]).toContain("Fourmile Creek at Ankeny, IA · USGS 05484800");
  expect(names[1]).toContain("Des Moines River near Saylorville, IA · USGS 05485500");
  expect(names[2]).toContain("Beaver Creek near Grimes, IA · USGS 05481950");
  for (const n of names) expect(n).toMatch(/\d+(\.\d)? MI AWAY/);
  // a groundwater well has a "level" too; reporting it as a river stage would
  // be worse than showing nothing
  expect(names.join(" ")).not.toContain("Observation Well");

  // the datum trap is on EVERY row, without exception
  const caveats = await page.locator(ROWS + " .srcnote").allTextContents();
  const datum = caveats.filter((c) => c.includes("RELATIVE TO THIS GAUGE'S OWN DATUM"));
  expect(datum.length).toBe(3);

  await expect(page.locator(STRIP)).toContainText("USGS WATERSERVICES · NOAA/NWS NATIONAL WATER PREDICTION SERVICE");
  expect(errors).toEqual([]);
});

test("a stage is never shown alone: it is placed against its own flood stages", async ({ page }) => {
  await routeAll(page);
  const { errors } = await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const dsm = page.locator(ROWS).nth(1);
  await expect(dsm.locator(".stage")).toHaveText("11.2 FT");
  await expect(dsm.locator(".gaugebar")).toHaveCount(1);
  await expect(dsm.locator(".gaugebar .now")).toHaveCount(1);
  // 20 ft action stage, 11.2 ft now
  await expect(dsm.locator(".rel")).toHaveText("8.8 FT BELOW ACTION STAGE (20 FT)");
  // discharge rides along as a secondary row
  await expect(dsm.locator(".grid .k")).toHaveText("FLOW");
  await expect(dsm.locator(".grid .v")).toHaveText("4,820 CFS");

  // NWPS writes -9999 into a category's flow to mean "not applicable". Read as
  // a number it is a threshold every gauge exceeds, so it must never surface.
  const text = await page.locator(STRIP).textContent();
  expect(text).not.toContain("-9999");
  expect(text).not.toContain("9999");
  expect(errors).toEqual([]);
});

test("a gauge with no NWPS match says it has no flood context and draws no bar", async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const beaver = page.locator(ROWS).nth(2);
  await expect(beaver.locator(".stage")).toHaveText("3.1 FT");
  await expect(beaver.locator(".rel")).toHaveText("NO FLOOD STAGE CONTEXT — NO NEARBY NWS FLOOD GAUGE FOUND");
  await expect(beaver.locator(".gaugebar")).toHaveCount(0);
  // the reading still shows — one missing source never blanks the other
  await expect(beaver.locator(".grid .v")).toHaveText("210 CFS");
});

test("a matched NWPS gauge that defines no categories says exactly that", async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const fourmile = page.locator(ROWS).nth(0);
  await expect(fourmile.locator(".stage")).toHaveText("5.4 FT");
  await expect(fourmile.locator(".rel"))
    .toHaveText("NEARBY NWS GAUGE ANKI4 DEFINES NO FLOOD CATEGORIES FOR THIS SITE");
  await expect(fourmile.locator(".gaugebar")).toHaveCount(0);
});

test("categories defined by discharge are named, never compared against a stage", async ({ page }) => {
  await routeAll(page);
  // ANKI4 with stage:-9999 on every category and real flow thresholds — the
  // shape that would mis-classify every gauge if -9999 were read as a number.
  await page.route("**/nwps/v1/gauges/ANKI4", jsonRoute(NWPS_GAUGE_FLOW_ONLY));
  await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const fourmile = page.locator(ROWS).nth(0);
  await expect(fourmile.locator(".rel")).toHaveText(
    "NEARBY NWS GAUGE ANKI4 DEFINES ITS FLOOD CATEGORIES BY DISCHARGE, NOT STAGE — NOT COMPARED HERE");
  await expect(fourmile.locator(".gaugebar")).toHaveCount(0);
  expect(await page.locator(STRIP).textContent()).not.toContain("9999");
});

test("discovery goes to the OGC API and readings go by explicit site id", async ({ page }) => {
  const urls = [];
  await routeAll(page);
  page.on("request", (r) => urls.push(r.url()));
  await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const ogc = urls.filter((u) => u.includes("api.waterdata.usgs.gov"));
  expect(ogc.length).toBeGreaterThan(0);
  const d = new URL(ogc[0]);
  expect(d.pathname).toContain("/collections/monitoring-locations/items");
  expect(d.searchParams.get("bbox").split(",")).toHaveLength(4);
  expect(Number(d.searchParams.get("limit"))).toBeGreaterThan(0);

  const iv = urls.filter((u) => u.includes("waterservices.usgs.gov"));
  expect(iv.length).toBeGreaterThan(0);
  for (const u of iv) {
    const q = new URL(u).searchParams;
    // the bbox form is the one that does not answer; it must never be used here
    expect(q.get("bBox")).toBeNull();
    expect(q.get("sites")).toBeTruthy();
    expect(q.get("format")).toBe("json");
    expect(q.get("parameterCd")).toBe("00065,00060");
  }

  const nwps = urls.filter((u) => u.includes("api.water.noaa.gov"));
  expect(nwps.some((u) => u.includes("bbox.xmin") && u.includes("srid=EPSG_4326"))).toBe(true);
});

test("an NWPS listing with no coordinates still joins, via the gauge detail", async ({ page }) => {
  await routeAll(page);
  // Strategy B: the bbox listing carries only ids and names, so the join has to
  // read each candidate's coordinates from its own detail response. Name
  // similarity is never used — that is how a gauge gets the wrong flood stages.
  const stripped = JSON.parse(NWPS_GAUGES_BBOX);
  for (const g of stripped.gauges) { delete g.latitude; delete g.longitude; }
  await page.route("**/nwps/v1/gauges?**", jsonRoute(JSON.stringify(stripped)));
  await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const dsm = page.locator(ROWS).nth(1);
  await expect(dsm.locator(".gaugebar")).toHaveCount(1);
  await expect(dsm.locator(".rel")).toHaveText("8.8 FT BELOW ACTION STAGE (20 FT)");
});

test("no gauge anywhere near says so, in miles, rather than rendering nothing", async ({ page }) => {
  await routeAll(page, { rivers: "empty" });
  const { errors } = await boot(page);
  await openSevere(page);

  // The radius is the SHORTER half-width of the search box: 0.25 deg of
  // longitude is 12.9 mi at 41.7N against 17.3 mi of latitude, so "~17 mi" was
  // an absolute claim about ground the query never covered east-west.
  await expect(page.locator(STRIP)).toContainText("NO USGS RIVER GAUGE WITHIN ~13 MI", { timeout: 15_000 });
  await expect(page.locator(ROWS)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a dead discovery endpoint degrades to a sentence, never to the slow bbox call", async ({ page }) => {
  const urls = [];
  await routeAll(page);
  page.on("request", (r) => urls.push(r.url()));
  await page.route("**://api.waterdata.usgs.gov/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", headers: CORS, body: "{}" }));
  const { errors } = await boot(page);
  await openSevere(page);

  await expect(page.locator(STRIP)).toContainText("RIVER GAUGES UNAVAILABLE — HTTP 503", { timeout: 15_000 });
  // and it must NOT have fallen back to the classic bbox form, which does not
  // answer at all for a small box
  expect(urls.filter((u) => u.includes("waterservices.usgs.gov") && /bBox=/i.test(u))).toEqual([]);
  // the rest of the SEVERE board is untouched
  await expect(page.locator(BOARD + " .alertcard").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the RIVER GAUGES layer drops a pin per gauge and its popup repeats the caveat", async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();

  await page.locator("#layersBtn").click();
  const rivers = row(page, "RIVER GAUGES");
  await expect(rivers).toBeVisible({ timeout: 15_000 });
  await expect(rivers).not.toHaveClass(/\bon\b/);           // defaults off: nothing fetched at boot
  expect(await page.locator(PINS).count()).toBe(0);

  await rivers.click();
  await expect(rivers).toHaveClass(/\bon\b/);
  await expect.poll(() => page.locator(PINS).count(), { timeout: 15_000 }).toBe(3);

  await page.keyboard.press("Escape");
  await page.locator(PINS).first().click();
  const popup = page.locator(".leaflet-popup-content");
  await expect(popup).toBeVisible({ timeout: 15_000 });
  await expect(popup).toContainText("USGS 05484800");
  await expect(popup).toContainText("OWN DATUM");

  await page.locator("#layersBtn").click();
  await row(page, "RIVER GAUGES").click();
  await expect.poll(() => page.locator(PINS).count(), { timeout: 5_000 }).toBe(0);
});

test("a gauge that cannot be assessed is never painted as one that is fine", async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  await openRiverLayer(page);

  // Beaver Creek reads 3.1 FT but has no NWPS match, so nothing places that
  // number against anything. The Des Moines River pin IS assessed and is 8.8 FT
  // below action stage. On a glanceable map those two must not look alike.
  const styles = await pinStyles(page);
  expect(styles).toHaveLength(3);
  const [fourmile, dsm, beaver] = styles;
  expect(dsm.fillOpacity).toBe("0.45");
  expect(dsm.dash).toBeNull();
  for (const unknown of [fourmile, beaver]) {
    expect(unknown.stroke).not.toBe(dsm.stroke);       // its own token, not --ok
    expect(unknown.fillOpacity).toBe("0");             // hollow, not filled
    expect(unknown.dash).toBeTruthy();                 // and dashed
  }
});

test("the popup never denies flood stages the matched gauge actually defines", async ({ page }) => {
  await routeAll(page);
  // The Des Moines River site reports discharge but no gauge height right now —
  // a dead 00065 instrument, or a discharge-only site. SAYI4 still defines
  // action/minor/moderate/major at 20/24/26/30 ft.
  await page.route("**://waterservices.usgs.gov/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: CORS,
      body: ivBody([FOURMILE, BEAVER,
                    { site: "05485500", name: "Des Moines River near Saylorville, IA", flow: 4820 }]) }));
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();

  // the map layer lives on the radar view, so the pin is read before entering
  // the deck — the layers button is behind the board once it is open
  await openRiverLayer(page);
  await page.locator(PINS).nth(1).click();
  const popup = page.locator(".leaflet-popup-content");
  await expect(popup).toBeVisible({ timeout: 15_000 });
  await expect(popup).toContainText("USGS 05485500");
  // the popup used to answer "NO FLOOD CATEGORIES DEFINED FOR SAYI4" here,
  // contradicting the row and denying data the gauge publishes
  await expect(popup).not.toContainText("NO FLOOD CATEGORIES DEFINED");
  await expect(popup).toContainText("FLOOD STAGES ARE DEFINED FOR THIS SITE");

  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });
  await expect(page.locator(ROWS).nth(1).locator(".rel")).toHaveText(
    "FLOOD STAGES ARE DEFINED FOR THIS SITE, BUT THERE IS NO CURRENT STAGE TO COMPARE THEM TO");
});

test("a stage hours old is dated and not compared to flood stage", async ({ page }) => {
  await routeAll(page);
  const old = Date.now() - 6 * 3600 * 1000;
  await page.route("**://waterservices.usgs.gov/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: CORS,
      body: ivBody([FOURMILE, BEAVER,
                    { site: "05485500", name: "Des Moines River near Saylorville, IA",
                      stage: 11.2, flow: 4820, when: old }]) }));
  await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const dsm = page.locator(ROWS).nth(1);
  await expect(dsm.locator(".stage")).toHaveText("11.2 FT");
  // the river can move a long way in six hours, so "8.8 FT BELOW ACTION STAGE"
  // is not a present-tense fact about it
  await expect(dsm.locator(".rel")).toContainText("THIS READING IS 6 H OLD");
  await expect(dsm.locator(".rel")).not.toContainText("BELOW ACTION STAGE");
  await expect(dsm.locator(".gaugebar")).toHaveCount(0);
  // and a fresh reading still says when it was taken
  await expect(page.locator(ROWS).nth(0)).toContainText("READING AS OF");
});

test("one NWPS gauge's flood stages are given to one site, not to both", async ({ page }) => {
  await routeAll(page);
  // A tributary site 0.05 mi from the Des Moines River site, both inside the
  // match radius of the single mainstem forecast point SAYI4 — the geometry at
  // any confluence or bridge. Only the closer site may claim it.
  const sites = JSON.parse(USGS_OGC_SITES);
  sites.features.push({
    id: "USGS-05485499", type: "Feature",
    geometry: { type: "Point", coordinates: [-93.681, 41.7206] },
    properties: {
      agency_code: "USGS", monitoring_location_number: "05485499",
      monitoring_location_name: "Tributary at Saylorville, IA",
      site_type_code: "ST", site_type: "Stream",
    },
  });
  await page.route("**://api.waterdata.usgs.gov/**", jsonRoute(JSON.stringify(sites)));
  await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(4, { timeout: 15_000 });

  const strip = page.locator(STRIP);
  // exactly one row is read against SAYI4's 20 FT action stage
  expect((await strip.textContent()).match(/BELOW ACTION STAGE \(20 FT\)/g)).toHaveLength(1);
  const trib = page.locator(ROWS, { hasText: "USGS 05485499" });
  await expect(trib.locator(".rel")).toHaveText("NO FLOOD STAGE CONTEXT — NO NEARBY NWS FLOOD GAUGE FOUND");
  // and the row that does use them says whose they are
  const dsm = page.locator(ROWS, { hasText: "USGS 05485500" });
  await expect(dsm).toContainText("FLOOD CATEGORIES FROM NWS GAUGE SAYI4");
});

test("a hostile gauge name renders as inert text in the row and the popup", async ({ page }) => {
  await routeAll(page);
  const sites = JSON.parse(USGS_OGC_SITES);
  sites.features[1].properties.monitoring_location_name = HOSTILE.placeName;
  await page.route("**://api.waterdata.usgs.gov/**", jsonRoute(JSON.stringify(sites)));

  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  const { errors } = await boot(page);
  await openSevere(page);
  await expect(page.locator(ROWS)).toHaveCount(3, { timeout: 15_000 });

  const name = page.locator(ROWS + " .name").first();
  expect(await name.textContent()).toContain(HOSTILE.placeName);
  expect(await page.locator(STRIP + " img").count()).toBe(0);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(dialogs).toEqual([]);
  const flags = await page.evaluate(() => ({ img: window.__xss_img, place: window.__xss_place }));
  expect(flags).toEqual({ img: undefined, place: undefined });
  expect(errors).toEqual([]);
});
