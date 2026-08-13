// GOES channel strip smoke (M6). The SAT view is deliberately HYBRID:
// GEOCOLOR is a fixed full-CONUS STAR frame (there is no GeoColor tile layer
// to switch to), CH13/CH02 are real IEM tile layers on the shared map. These
// specs assert that the difference is visible on screen rather than left for
// the user to discover by finding the zoom inert.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

const CH_KEY = "skywatch_sat_channel";

async function setup(page, opts) {
  await routeAll(page, opts);
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  return { errors };
}

async function openSat(page) {
  await page.locator("#satBtn").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "sat");
  await expect(page.locator("#satview")).toBeVisible();
}

function chBtn(page, label) {
  return page.locator("#satChannels .satchbtn", { hasText: label });
}

function tilePaneImgs(page) {
  return page.locator("#lmap .leaflet-swGoes-pane img.leaflet-tile");
}

test("the channel strip lists every configured channel, GEOCOLOR first", async ({ page }) => {
  await setup(page);
  await openSat(page);
  const btns = page.locator("#satChannels .satchbtn");
  await expect(btns).toHaveCount(3);
  await expect(btns.nth(0)).toHaveText("GEOCOLOR");
  await expect(btns.nth(1)).toHaveText("CH13 IR");
  await expect(btns.nth(2)).toHaveText("CH02 VIS");
  await expect(chBtn(page, "GEOCOLOR")).toHaveClass(/\bon\b/);
});

test("GEOCOLOR shows the fixed frame and says the view does not pan", async ({ page }) => {
  await setup(page);
  await openSat(page);
  await expect(page.locator("#satimg")).toBeVisible();
  await expect(page.locator("#satNote")).toHaveText("FIXED FULL-CONUS FRAME — ZOOM/PAN INACTIVE");
  await expect(page.locator("#satview")).not.toHaveClass(/\btiles\b/);
  await expect(page.locator("#srcBadge")).toHaveText("GOES-EAST GEOCOLOR · CONUS");
});

test("CH13 hides the frame, attaches a tile layer under the alerts pane, and pans", async ({ page }) => {
  await setup(page);
  await openSat(page);
  await chBtn(page, "CH13 IR").click();

  await expect(chBtn(page, "CH13 IR")).toHaveClass(/\bon\b/, { timeout: 15_000 });
  await expect(page.locator("#satview")).toHaveClass(/\btiles\b/);
  await expect(page.locator("#satimg")).toBeHidden();
  await expect(tilePaneImgs(page).first()).toBeAttached({ timeout: 15_000 });
  await expect(page.locator("#satNote")).toHaveText("PAN AND ZOOM ACTIVE");
  await expect(page.locator("#srcBadge")).toHaveText("GOES-EAST CH13 IR · CONUS");

  // The tile layer must sit UNDER the alert polygons (alerts.js's own pane) and
  // under the place labels. The imagery is opaque and #satview is
  // pointer-events:none here, so a channel drawn over the polygons would paint
  // them out while leaving them clickable — a tap on a cloud top would open an
  // alert sheet for something the user cannot see.
  const z = await page.evaluate(() => {
    const zi = (sel) => {
      const e = document.querySelector("#lmap " + sel);
      return e ? Number(getComputedStyle(e).zIndex) : null;
    };
    return { goes: zi(".leaflet-swGoes-pane"), alerts: zi(".leaflet-alerts-pane"),
             labels: zi(".leaflet-labels-pane") };
  });
  expect(z.alerts, "alerts.js must have created its pane by now").not.toBeNull();
  expect(z.goes).toBeLessThan(z.alerts);
  expect(z.goes).toBeLessThan(z.labels);

  // the FETCHED time in the topbar has to track the tile channel, not stay
  // parked on the STAR frame's clock
  await expect(page.locator("#frameTime")).toHaveText(/^FETCHED \d\d:\d\d$/, { timeout: 15_000 });

  // #satview must not be swallowing the drags that make the channel pannable
  const pe = await page.evaluate(() =>
    getComputedStyle(document.getElementById("satview")).pointerEvents);
  expect(pe).toBe("none");
  // ...while the channel buttons themselves stay clickable
  const bpe = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#satChannels")).pointerEvents);
  expect(bpe).toBe("auto");
});

test("the tile URL is the confirmed IEM channel layer, not a GeoColor guess", async ({ page }) => {
  const urls = [];
  await routeAll(page);
  page.on("request", (r) => urls.push(r.url()));
  await boot(page);
  await openSat(page);
  await chBtn(page, "CH02 VIS").click();
  await expect(tilePaneImgs(page).first()).toBeAttached({ timeout: 15_000 });

  const goes = urls.filter((u) => u.includes("goes_east_conus"));
  expect(goes.some((u) => u.includes("goes_east_conus_ch02"))).toBe(true);
  // GEOCOLOR does not exist as an IEM tile layer — the app must never ask
  expect(goes.some((u) => /geocolor|truecolor/i.test(u))).toBe(false);
  // the legacy alias is a fallback for an exact miss, and this was a hit
  expect(urls.some((u) => u.includes("goes-east-vis-1km"))).toBe(false);
});

test("switching back to GEOCOLOR removes the tiles and restores the frame", async ({ page }) => {
  await setup(page);
  await openSat(page);
  await chBtn(page, "CH13 IR").click();
  await expect(tilePaneImgs(page).first()).toBeAttached({ timeout: 15_000 });

  await chBtn(page, "GEOCOLOR").click();
  await expect(page.locator("#satview")).not.toHaveClass(/\btiles\b/);
  await expect(page.locator("#satimg")).toBeVisible();
  await expect(tilePaneImgs(page)).toHaveCount(0);
});

test("leaving SAT detaches the tiles so radar is never drawn under satellite", async ({ page }) => {
  await setup(page);
  await openSat(page);
  await chBtn(page, "CH13 IR").click();
  await expect(tilePaneImgs(page).first()).toBeAttached({ timeout: 15_000 });

  await page.keyboard.press("Escape");
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "radar");
  await expect(tilePaneImgs(page)).toHaveCount(0);
});

test("a blocked tile host says which channel failed, and does not blank the map", async ({ page }) => {
  await routeAll(page);
  await page.route("**mesonet.agron.iastate.edu/**", (r) => r.abort("failed"));
  await boot(page);
  await openSat(page);
  await chBtn(page, "CH13 IR").click();
  await expect(page.locator("#satMsg"))
    .toHaveText("CH13 IR IMAGERY UNAVAILABLE — CHECK CONNECTION", { timeout: 20_000 });
  await expect(page.locator("#satview")).toHaveClass(/\berr\b/);
});

// The canary probe is the only fetch() this app makes against IEM; every other
// use loads tiles as <img>, which needs no CORS headers at all. A host that
// serves images but refuses cross-origin fetch would fail every probe while the
// tiles themselves render perfectly, so an inconclusive probe must not be
// allowed to veto the layer. Simulated by resource type, which is exactly the
// asymmetry a missing Access-Control-Allow-Origin produces in the browser.
test("a host that refuses fetch() but serves tiles still gets its layer", async ({ page }) => {
  await routeAll(page);
  await page.route("**mesonet.agron.iastate.edu/**", (r) => {
    const kind = r.request().resourceType();
    return kind === "fetch" || kind === "xhr" ? r.abort("failed") : r.fallback();
  });
  await boot(page);
  await openSat(page);
  await chBtn(page, "CH13 IR").click();

  await expect(tilePaneImgs(page).first()).toBeAttached({ timeout: 15_000 });
  await expect(page.locator("#satNote")).toHaveText("PAN AND ZOOM ACTIVE");
  await expect(page.locator("#satMsg")).toHaveText("");
  await expect(page.locator("#satview")).not.toHaveClass(/\berr\b/);
});

test("a blocked STAR CDN names GEOCOLOR specifically, not the generic channel", async ({ page }) => {
  await routeAll(page);
  await page.route("**cdn.star.nesdis.noaa.gov/**", (r) => r.abort("failed"));
  await boot(page);
  await openSat(page);
  await expect(page.locator("#satMsg"))
    .toHaveText("GEOCOLOR IMAGERY UNAVAILABLE — CHECK CONNECTION", { timeout: 20_000 });
  await expect(page.locator("#satview")).toHaveClass(/\berr\b/);
  await expect(page.locator("#satimg")).toBeHidden();
});

test("the chosen channel survives a reload", async ({ page }) => {
  await setup(page);
  await openSat(page);
  await chBtn(page, "CH13 IR").click();
  await expect(tilePaneImgs(page).first()).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), CH_KEY)).toBe("ch13");

  await page.reload();
  await expect(page.locator("#screen")).toBeVisible();
  await openSat(page);
  await expect(chBtn(page, "CH13 IR")).toHaveClass(/\bon\b/);
  await expect(page.locator("#satview")).toHaveClass(/\btiles\b/, { timeout: 15_000 });
  await expect(page.locator("#srcBadge")).toHaveText("GOES-EAST CH13 IR · CONUS");
});

test("the channel strip is scoped to the SAT view", async ({ page }) => {
  await setup(page);
  await expect(page.locator("#satChannels")).toBeHidden();
  await openSat(page);
  await expect(page.locator("#satChannels")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#satChannels")).toBeHidden();
});

test("no pageerrors across every channel", async ({ page }) => {
  const { errors } = await setup(page);
  await openSat(page);
  for (const label of ["CH13 IR", "CH02 VIS", "GEOCOLOR"]) {
    await chBtn(page, label).click();
    await expect(chBtn(page, label)).toHaveClass(/\bon\b/, { timeout: 15_000 });
  }
  expect(errors).toEqual([]);
});
