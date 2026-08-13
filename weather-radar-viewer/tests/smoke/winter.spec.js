// Winter hazards smoke (M6): the FCAST board's snow/ice strip, the NOHRSC
// snow-depth raster, and the WPC Day-1 winter guidance layer.
//
// The fixtures behind this file deliberately REFUSE malformed requests
// (see _setup.js): the NOHRSC service is only reachable by walking the snow/
// folder, the ArcGIS /export stub 400s a bad bbox or size, the /query stub
// returns an {error} body without f=geojson, and api.weather.gov 404s a
// malformed gridpoint path. Every "it worked" assertion below is therefore
// also an assertion that the app asked correctly.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot, NWS_GRIDPOINTS, NWS_GRIDPOINTS_NONE } = require("./_setup");

const BOARD = "#board-cast";
const STRIP = BOARD + " #winterStrip";

async function setup(page, opts) {
  await routeAll(page, opts);
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  return { errors };
}

async function openCast(page) {
  await page.locator("#wxPanel").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await page.locator("#boardDots .dot", { hasText: "FCAST" }).click();
  await expect(page.locator(BOARD)).toHaveClass(/\bactive\b/);
}

function row(page, label) {
  return page.locator("#layerRows .layerrow", { hasText: label });
}

async function openDrawer(page) {
  await page.locator("#layersBtn").click();
  await expect(page.locator("#layersdrawer")).toBeVisible();
}

// Requests the page actually made, so a test can prove the shape of a URL and
// not merely that something rendered.
function watchRequests(page) {
  const urls = [];
  page.on("request", (r) => urls.push(r.url()));
  return urls;
}

// ---------------------------------------------------------------------------
// FCAST winter strip

test("a non-zero mm forecast renders inches, converted and disclosed", async ({ page }) => {
  await setup(page, { gridpoints: NWS_GRIDPOINTS });
  await openCast(page);

  const snow = page.locator(STRIP + " .winterrow.snow");
  await expect(snow).toBeVisible({ timeout: 15_000 });
  // fixture snow: 25.4 + 50.8 + 25.4 mm = 101.6 mm = exactly 4.0 in
  await expect(snow).toContainText("SNOW:");
  await expect(snow.locator(".v")).toContainText("4.0 IN");

  // fixture ice: 2.54 + 5.08 mm = 7.62 mm = exactly 0.3 in
  const ice = page.locator(STRIP + " .winterrow.ice");
  await expect(ice).toBeVisible();
  await expect(ice.locator(".v")).toContainText("0.3 IN");

  // the conversion is stated on screen, not silently applied
  await expect(page.locator(STRIP + " .srcnote"))
    .toContainText("VALUES CONVERTED FROM MM TO INCHES");
  await expect(page.locator(STRIP + " .srcnote")).toContainText("DMX 73,49");
});

test("per-period rows list only the intervals that carry snow", async ({ page }) => {
  await setup(page, { gridpoints: NWS_GRIDPOINTS });
  await openCast(page);
  const pers = page.locator(STRIP + " .winterper");
  await expect(pers.first()).toBeVisible({ timeout: 15_000 });
  // 3 of the fixture's 10 six-hour intervals are non-zero
  await expect(pers).toHaveCount(3);
  // and they add up to the headline total rather than double-counting it
  const sum = await page.evaluate(() => {
    const rows = document.querySelectorAll("#winterStrip .winterper .v");
    return Array.from(rows).reduce((a, e) => a + parseFloat(e.textContent), 0);
  });
  expect(Math.abs(sum - 4.0)).toBeLessThan(0.001);
});

test("a confirmed all-zero forecast renders an empty strip, not zeroes", async ({ page }) => {
  await setup(page, { gridpoints: NWS_GRIDPOINTS_NONE });
  await openCast(page);
  // the 7-day section proves the board itself painted
  await expect(page.locator(BOARD + " .castday").first()).toBeAttached({ timeout: 15_000 });
  const strip = page.locator(STRIP);
  await expect(strip).toHaveCount(1);
  // The gridpoint fetch must actually have SUCCEEDED — an empty strip would
  // otherwise pass this test just as happily when nothing was ever fetched,
  // which is exactly the "fixture always says yes" failure in mirror image.
  await expect.poll(async () => page.locator("#status").textContent(), { timeout: 15_000 })
    .toContain("gridpoint ok");
  // 30 non-null zeroes is a real answer: nothing to say, so nothing is said
  await expect.poll(async () => strip.evaluate((e) => e.childElementCount)).toBe(0);
  await expect(strip).toBeHidden();          // :empty collapses it entirely
});

// The mirror image of the test above: an all-zero grid and an UNREADABLE grid
// must not look the same. Zero renders nothing; unreadable says why, and the
// status dot goes red — otherwise a WFO switching units (or NWS renaming the
// field) hides a foot of snow behind an empty strip and a green dot.
test("a field in an unconvertible unit says so instead of rendering as nothing", async ({ page }) => {
  const grid = JSON.parse(NWS_GRIDPOINTS);
  grid.properties.snowfallAmount.uom = "wmoUnit:mm s-1";
  grid.properties.iceAccumulation.uom = "wmoUnit:mm s-1";
  await routeAll(page);
  await page.route("**/gridpoints/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/geo+json",
                headers: { "access-control-allow-origin": "*" },
                body: JSON.stringify(grid) }));
  await boot(page);
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  await openCast(page);

  const note = page.locator(STRIP + " .srcnote").first();
  await expect(note).toBeVisible({ timeout: 15_000 });
  await expect(note).toContainText("WINTER HAZARDS UNAVAILABLE");
  await expect(note).toContainText("UNRECOGNISED UNIT WMOUNIT:MM S-1");
  // and the health signal agrees — HTTP 200 is not the same as "a value parsed"
  await expect(page.locator("#status .off", { hasText: "snow unreadable" }))
    .toHaveCount(1, { timeout: 15_000 });
});

test("a 404 on the gridpoint path shows a sentence, never a blank box", async ({ page }) => {
  await routeAll(page);
  // the malformed-request rejection the fixture already implements, reached by
  // taking the well-formed path away from the app
  await page.route("**/gridpoints/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json",
                headers: { "access-control-allow-origin": "*" },
                body: JSON.stringify({ title: "Not Found", status: 404 }) }));
  await boot(page);
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  await openCast(page);
  await expect(page.locator(STRIP + " .srcnote"))
    .toContainText("WINTER HAZARDS UNAVAILABLE", { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// NOHRSC snow depth layer

test("the NOHRSC row is registered, off by default, and toggles on", async ({ page }) => {
  await setup(page);
  await openDrawer(page);
  const nohrsc = row(page, "SNOW DEPTH (NOHRSC)");
  await expect(nohrsc).toHaveCount(1, { timeout: 15_000 });
  await expect(nohrsc).not.toHaveClass(/\bon\b/);      // never date-gated, never default-on

  await nohrsc.click();
  await expect(nohrsc).toHaveClass(/\bon\b/);
  await expect(nohrsc.locator(".hdot")).toHaveClass(/\bok\b/, { timeout: 15_000 });
  await expect(nohrsc.locator(".lstate")).toHaveText("ON");
});

test("NOHRSC is found by walking the snow/ folder and exports Snow Depth, not SWE", async ({ page }) => {
  await setup(page);
  const urls = watchRequests(page);
  await openDrawer(page);
  await row(page, "SNOW DEPTH (NOHRSC)").click();
  await expect(page.locator("#lmap img.leaflet-image-layer").first())
    .toBeAttached({ timeout: 15_000 });

  // the root listing carries no snow service at all — reaching the service
  // means the folder walk happened
  expect(urls.some((u) => /\/raster\/rest\/services\/snow\?f=json/.test(u))).toBe(true);
  const exp = urls.filter((u) => u.includes("/MapServer/export"));
  expect(exp.length).toBeGreaterThan(0);
  const q = new URL(exp[0]).searchParams;
  // Group 0 is "Snow Depth" and wraps 1 Boundary / 2 Footprint / 3 Image;
  // group 4 is Snow Water Equivalent (5,6,7), a different measurement that must
  // never be drawn under this label. A group carries no pixels and ArcGIS does
  // not expand one in layers=show, so the export has to name the raster child —
  // and only ids from the Snow Depth group may appear at all.
  const shown = (q.get("layers") || "").replace(/^show:/, "").split(",").filter(Boolean);
  expect(shown).toContain("3");
  expect(shown.every((id) => ["0", "1", "2", "3"].includes(id))).toBe(true);
  // and the export request is the shape the stub accepts: 4-number bbox, SR, size
  expect(q.get("bbox").split(",").length).toBe(4);
  expect(q.get("bboxSR")).toBe("4326");
  // the map is EPSG:3857 and L.imageOverlay does not reproject, so the IMAGE
  // must come back in the map's projection or every interior row is drawn at
  // the wrong latitude
  expect(q.get("imageSR")).toBe("3857");
  expect(q.get("size")).toMatch(/^\d+,\d+$/);
});

test("the snow-depth raster is painted under the radar frames, not over them", async ({ page }) => {
  await setup(page);
  await openDrawer(page);
  await row(page, "SNOW DEPTH (NOHRSC)").click();
  const img = page.locator("#lmap img.leaflet-image-layer").first();
  await expect(img).toBeVisible({ timeout: 15_000 });

  // Leaflet's tilePane is itself positioned at z 200 and so opens its own
  // stacking context: the radar frames' zIndex 400 never escapes it, and a
  // sibling pane at any z would paint OVER the radar however low the number
  // looks. The only way under the radar is to be inside tilePane with it.
  const z = await page.evaluate(() => {
    const el = document.querySelector("#lmap img.leaflet-image-layer");
    const radar = Array.from(
      document.querySelectorAll("#lmap .leaflet-tile-pane .leaflet-layer"))
      .map((e) => Number(getComputedStyle(e).zIndex))
      .filter((n) => Number.isFinite(n));
    return {
      inTilePane: Boolean(el.closest(".leaflet-tile-pane")),
      img: Number(getComputedStyle(el).zIndex),
      radarTop: radar.length ? Math.max(...radar) : null
    };
  });
  expect(z.inTilePane).toBe(true);
  expect(z.radarTop, "map.js must have attached a radar frame by now").not.toBeNull();
  expect(z.img).toBeLessThan(z.radarTop);
});

test("a SWE-only catalog leaves the layer unavailable rather than mislabelled", async ({ page }) => {
  await routeAll(page);
  // Same service, but the Snow Depth product has gone. The honest outcome is
  // an export of the hint id — never a silent switch to Snow Water Equivalent.
  await page.route("**/MapServer/layers**", (r) => {
    if (!r.request().url().includes("/raster/")) return r.fallback();
    return r.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ layers: [{ id: 4, name: "Snow Water Equivalent" }] }) });
  });
  const urls = watchRequests(page);
  await boot(page);
  await openDrawer(page);
  await row(page, "SNOW DEPTH (NOHRSC)").click();
  await expect.poll(() => urls.filter((u) => u.includes("/MapServer/export")).length,
    { timeout: 15_000 }).toBeGreaterThan(0);
  const exp = urls.find((u) => u.includes("/MapServer/export"));
  expect(exp).not.toContain("layers=show:4");
});

test("a dead NOHRSC service directory degrades to N/A, not a silent blank", async ({ page }) => {
  await routeAll(page);
  await page.route("**/raster/**", (r) =>
    r.fulfill({ status: 500, contentType: "application/json",
                headers: { "access-control-allow-origin": "*" },
                body: JSON.stringify({ error: { code: 500 } }) }));
  await boot(page);
  await openDrawer(page);
  const nohrsc = row(page, "SNOW DEPTH (NOHRSC)");
  await nohrsc.click();
  // the config hint keeps the layer trying, and the export 500s in turn, so the
  // drawer must end up saying so out loud
  await expect(nohrsc.locator(".lstate")).toHaveText("N/A", { timeout: 20_000 });
});

// ---------------------------------------------------------------------------
// WPC probabilistic winter guidance

test("WPC winter guidance draws Day-1 polygons and ignores the ice-chart decoys", async ({ page }) => {
  await setup(page);
  const urls = watchRequests(page);
  await openDrawer(page);
  const wpc = row(page, "WPC WINTER GUIDANCE (DAY 1)");
  await expect(wpc).toHaveCount(1, { timeout: 15_000 });
  await expect(wpc).not.toHaveClass(/\bon\b/);
  await wpc.click();

  await expect(wpc.locator(".hdot")).toHaveClass(/\bok\b/, { timeout: 15_000 });
  await expect(wpc.locator(".lstate")).toHaveText("ON");

  const queried = urls.filter((u) => u.includes("/query"));
  const wpcQuery = queried.find((u) => u.includes("wpc_prob_winter_precip"));
  expect(wpcQuery, "the prob-winter service must win the tie-break").toBeTruthy();
  // the decoys live in the same fixture catalog and must never be queried
  expect(queried.some((u) => /wpc_wssi|asip_ice_chart|greatlakes_ice_chart/.test(u))).toBe(false);
  // "Day 1 Snow and Ice Accumulation" is id 0 of 15 — resolved by name
  expect(wpcQuery).toContain("/MapServer/0/query");
  expect(wpcQuery).toContain("f=geojson");

  // two polygons in the fixture, drawn in the module's own pane
  await expect(page.locator("#lmap .leaflet-swWpcWinter-pane path").first())
    .toBeAttached({ timeout: 15_000 });
  expect(await page.locator("#lmap .leaflet-swWpcWinter-pane path").count()).toBe(2);
});

test("WPC with no matching service shows N/A instead of drawing something else", async ({ page }) => {
  await routeAll(page);
  // every folder answers, but nothing in the catalog is winter guidance
  await page.route("**/vector/rest/services**", (r) => {
    const u = new URL(r.request().url());
    if (!/^\/vector\/rest\/services(\/[^/]+)?\/?$/.test(u.pathname)) return r.fallback();
    return r.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ folders: ["obs"], services: [{ name: "obs/asip_ice_chart", type: "MapServer" }] }) });
  });
  await boot(page);
  await openDrawer(page);
  const wpc = row(page, "WPC WINTER GUIDANCE (DAY 1)");
  await wpc.click();
  await expect(wpc.locator(".lstate")).toHaveText("N/A", { timeout: 20_000 });
  await expect(wpc.locator(".hdot")).toHaveClass(/\bbad\b/);
});

test("no pageerrors while the winter strip and both layers are exercised", async ({ page }) => {
  const { errors } = await setup(page);
  await openCast(page);
  await expect(page.locator(STRIP + " .winterrow.snow")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await openDrawer(page);
  await row(page, "SNOW DEPTH (NOHRSC)").click();
  await row(page, "WPC WINTER GUIDANCE (DAY 1)").click();
  await expect(page.locator("#lmap .leaflet-swWpcWinter-pane path").first())
    .toBeAttached({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
