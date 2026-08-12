// AIR board smoke (M4): the air-quality board — AQI headline, pollutant
// rows, a 48h AQI chart, and the pollen-unavailable note for US locations.
// airq.js registers the board lazily: nothing is fetched until the board is
// opened for the first time (see main.js's boot-order comment).
//
// Feed: tests/fixtures/om-air.json — current.us_aqi = 62 (MODERATE band,
// 51-100) plus an hourly series spanning past_days=1 + 2 forecast days. See
// smoke/_setup.js for how its time arrays are re-anchored to straddle the
// real Date.now() on every request.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

const BOARD = "#board-air";

async function setup(page) {
  await routeAll(page);
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  // wait for the async board registrations to have landed before opening the deck
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  return { errors };
}

async function openAir(page) {
  await page.locator("#boardsBtn").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await page.locator("#boardDots .dot", { hasText: "AIR" }).click();
  await expect(page.locator(BOARD)).toHaveClass(/\bactive\b/);
}

// .grid renders label/value pairs as adjacent .k/.v siblings (see wx.js's
// row() helper, which the shared board CSS is built around) — walk the DOM
// rather than assume a specific CSS combinator so this survives markup
// differences in how the pair is wrapped.
function gridValue(page, labelPattern) {
  return page.evaluate((pat) => {
    const board = document.querySelector("#board-air");
    if (!board) return null;
    const re = new RegExp(pat, "i");
    const k = Array.from(board.querySelectorAll(".grid .k")).find((el) => re.test(el.textContent));
    if (!k) return null;
    const v = k.nextElementSibling;
    return v ? v.textContent.trim() : null;
  }, labelPattern);
}

test("opening AIR shows the board active with the AQI headline", async ({ page }) => {
  await setup(page);
  await openAir(page);
  await expect(page.locator("#screen")).toHaveAttribute("data-board", "air");
  await expect(page.locator(BOARD)).toBeVisible();

  // om-air.json's current.us_aqi = 62
  await expect(page.locator(BOARD + " .bigtemp")).toHaveText("62", { timeout: 15_000 });
  await expect(page.locator(BOARD + " .bigcond")).toHaveText(/MODERATE/i);
});

test("pollutant rows include PM2.5 and OZONE with non-placeholder values", async ({ page }) => {
  await setup(page);
  await openAir(page);
  await expect(page.locator(BOARD + " .bigtemp")).toHaveText("62", { timeout: 15_000 });

  const pm25 = await gridValue(page, "PM2\\.5");
  expect(pm25).not.toBeNull();
  expect(pm25).not.toBe("--");

  const ozone = await gridValue(page, "OZONE");
  expect(ozone).not.toBeNull();
  expect(ozone).not.toBe("--");
});

test("the AQI chart renders an svg with a path", async ({ page }) => {
  await setup(page);
  await openAir(page);
  const svgEl = page.locator(BOARD + " .chart .plot svg").first();
  await expect(svgEl).toBeAttached({ timeout: 15_000 });
  expect(await svgEl.locator("path").count()).toBeGreaterThan(0);
});

test("a .srcnote says pollen is unavailable for US locations", async ({ page }) => {
  await setup(page);
  await openAir(page);
  await expect(page.locator(BOARD + " .bigtemp")).toHaveText("62", { timeout: 15_000 });

  const pollenNote = page.locator(BOARD + " .srcnote").filter({ hasText: /pollen/i });
  await expect(pollenNote).toHaveCount(1);

  // and no pollen data rows are rendered at all (POLLEN_AVAILABLE_US is false)
  const pollenRows = page.locator(BOARD + " .grid .k", { hasText: /pollen/i });
  await expect(pollenRows).toHaveCount(0);
});

test("a 500 from the air-quality endpoint shows one failure line and does not throw", async ({ page }) => {
  const { errors } = await setup(page);

  // most-recently-added route handler wins (see xss.spec.js) — this overrides
  // routeAll's 200 response for this host only
  await page.route("**://air-quality-api.open-meteo.com/**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "{}",
    })
  );

  await openAir(page);

  const failureLine = page.locator(BOARD + " .bigmsg, " + BOARD + " .srcnote");
  await expect(failureLine).toHaveCount(1, { timeout: 15_000 });
  await expect(failureLine).toContainText(/unavail|error|fail|down|no data/i);

  // the AQI headline must not show stale/garbage content on failure
  await expect(page.locator(BOARD + " .bigtemp")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("no pageerrors while opening and rendering AIR", async ({ page }) => {
  const { errors } = await setup(page);
  await openAir(page);
  await expect(page.locator(BOARD + " .bigtemp")).toHaveText("62", { timeout: 15_000 });
  await expect(page.locator(BOARD + " .chart .plot svg").first()).toBeAttached({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
