// CAST board smoke (M3): the extended forecast board — meteogram, 7-day
// strip, model-agreement comparison, and the ensemble confidence band.
// forecastx.js registers the board lazily: nothing is fetched until the
// board is opened for the first time (see main.js's boot-order comment).
//
// Feeds: tests/fixtures/om-cast.json (base meteogram: hourly + minutely_15 +
// daily), om-models.json (multi-model compare), om-ensemble.json (percentile
// band) — see smoke/_setup.js for how their time arrays are re-anchored to
// straddle the real Date.now() on every request.
//
// Two assertions below lean on conventions the contract doesn't pin down
// exactly (see the comments at each site): the 7-day row class name, and the
// DOM proximity between a section's .chiplegend and its .chart. Both are
// documented as assumptions in the task report.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

const BOARD = "#board-cast";

async function setup(page) {
  await routeAll(page);
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  // wait for the async board registrations to have landed before opening the deck
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  return { errors };
}

async function openCast(page) {
  await page.locator("#wxPanel").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await page.locator("#boardDots .dot", { hasText: "FCAST" }).click();
  await expect(page.locator(BOARD)).toHaveClass(/\bactive\b/);
}

test("opening CAST shows the board active and #screen data-board=cast", async ({ page }) => {
  await setup(page);
  await openCast(page);
  await expect(page.locator("#screen")).toHaveAttribute("data-board", "cast");
  await expect(page.locator(BOARD)).toBeVisible();
});

test("the meteogram renders an svg with at least one path", async ({ page }) => {
  await setup(page);
  await openCast(page);
  const svgEl = page.locator(BOARD + " .chart .plot svg").first();
  await expect(svgEl).toBeAttached({ timeout: 15_000 });
  expect(await svgEl.locator("path").count()).toBeGreaterThan(0);
});

test("a .nowline and a .future rect appear since NOW is inside the fixture range", async ({ page }) => {
  await setup(page);
  await openCast(page);
  await expect(page.locator(BOARD + " .chart .plot svg").first()).toBeAttached({ timeout: 15_000 });
  // NOW (Date.now(), re-anchored into every fixture — see _setup.js) sits well
  // inside the meteogram's 7-day window, so both marks must be present somewhere
  // on the board (a multi-day chart may draw more than one nowline/future rect
  // if more than one series shares the x axis).
  await expect(page.locator(BOARD + " .nowline").first()).toBeAttached();
  await expect(page.locator(BOARD + " rect.future").first()).toBeAttached();
});

test("the 7-day section renders 7 day entries", async ({ page }) => {
  await setup(page);
  await openCast(page);
  // No class name for a day row is fixed by the contract. ".castday" mirrors
  // this codebase's own convention for a day-of-outlook row (spc.js's SPC
  // strip uses ".spcday" the same way — see severe.spec.js). If forecastx.js
  // ships a different name this assertion is the one to update.
  const dayRows = page.locator(BOARD + " .castday");
  await expect(dayRows.first()).toBeAttached({ timeout: 15_000 });
  await expect(dayRows).toHaveCount(7);
});

test("model-agreement renders one .lchip per COMPARE_MODELS entry and multiple paths", async ({ page }) => {
  await setup(page);
  await openCast(page);
  // Identify the model-compare legend by a label unique to it (config.js's
  // COMPARE_MODELS includes HRRR; the ensemble section's legend, if any,
  // wouldn't use that label) rather than assuming a specific section wrapper
  // class, since the contract only fixes the shared board classes.
  const modelLegend = page.locator(BOARD + " .chiplegend").filter({ hasText: "HRRR" });
  await expect(modelLegend).toHaveCount(1, { timeout: 15_000 });
  await expect(modelLegend.locator(".lchip")).toHaveCount(5); // config.COMPARE_MODELS.length

  // find the chart nearest the legend in the DOM (proximity, not a fixed
  // class, since the contract doesn't specify how the legend and chart are
  // wrapped together) and confirm it draws more than one model's line
  const pathCount = await page.evaluate(() => {
    const board = document.querySelector("#board-cast");
    const legend = Array.from(board.querySelectorAll(".chiplegend")).find((l) => l.textContent.includes("HRRR"));
    if (!legend) return -1;
    let node = legend;
    for (let hops = 0; hops < 6 && node && node !== board; hops++, node = node.parentElement) {
      const svgEl = node.querySelector(".chart .plot svg");
      if (svgEl) return svgEl.querySelectorAll("path").length;
    }
    return -1;
  });
  expect(pathCount).toBeGreaterThan(1);
});

test("the ensemble section renders at least one filled band path", async ({ page }) => {
  await setup(page);
  await openCast(page);
  // chart.js sets fill-opacity only on type:"band" series; CAST's only band
  // series is the ensemble confidence band, so this attribute selector
  // uniquely finds it regardless of section wrapper markup.
  const bandPaths = page.locator(BOARD + " .chart .plot svg path[fill-opacity]");
  await expect(bandPaths.first()).toBeAttached({ timeout: 15_000 });
  expect(await bandPaths.count()).toBeGreaterThan(0);
});

test("no pageerrors while opening and rendering CAST", async ({ page }) => {
  const { errors } = await setup(page);
  await openCast(page);
  await expect(page.locator(BOARD + " .chart .plot svg").first()).toBeAttached({ timeout: 15_000 });
  // give the model-agreement and ensemble sub-fetches a moment to land too
  await expect(page.locator(BOARD + " .chiplegend .lchip").first()).toBeAttached({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

// The 7-day used to be one run-on sentence per day; it is now a table whose
// columns line up, and every day carries its numeric date under the weekday.
test("the 7-day is a column table with dates under the weekdays", async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await page.locator("#wxPanel").click();
  await page.locator("#boardDots .dot", { hasText: "FCAST" }).click();

  const rows = page.locator("#board-cast .castdays .castday");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  expect(await rows.count()).toBeGreaterThanOrEqual(5);

  const first = rows.first();
  await expect(first.locator(".when .dow")).toHaveText(/^(SUN|MON|TUE|WED|THU|FRI|SAT)$/);
  await expect(first.locator(".when .date")).toHaveText(/^\d{1,2}\/\d{1,2}$/);
  await expect(first.locator(".hi")).toHaveText(/^-?\d+°$/);
  await expect(first.locator(".lo")).toHaveText(/^-?\d+°$/);
});

// Day boundaries on a time axis carry the date beneath the weekday, so a
// reader never has to count forward from today to place a feature.
test("day ticks on the meteogram print the date under the weekday", async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await page.locator("#wxPanel").click();
  await page.locator("#boardDots .dot", { hasText: "FCAST" }).click();

  const svg = page.locator("#board-cast .chart .plot svg").first();
  await expect(svg).toBeVisible({ timeout: 15_000 });

  const subs = await svg.locator("tspan.datesub").allTextContents();
  expect(subs.length).toBeGreaterThan(0);
  for (const t of subs) expect(t).toMatch(/^\d{1,2}\/\d{1,2}$/);

  // and the weekday still sits above it, in the same text node
  const pairs = await svg.locator("text:has(tspan.datesub)").allTextContents();
  expect(pairs[0]).toMatch(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\d{1,2}\/\d{1,2}$/);
});

// A 7-day chart on a narrow plot used to label every OTHER day, which reads as
// a chart with missing days. Every day boundary in range gets its own tick.
test("multi-day charts label every day, not every other day", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });   // the narrow case that used to skip
  await routeAll(page);
  await boot(page);
  await page.locator("#wxPanel").click();
  await page.locator("#boardDots .dot", { hasText: "FCAST" }).click();

  const ens = page.locator("#board-cast .chart").filter({ has: page.locator("path") }).last();
  await expect(ens.locator(".plot svg")).toBeVisible({ timeout: 15_000 });

  const dates = await ens.locator("tspan.datesub").allTextContents();
  expect(dates.length).toBeGreaterThanOrEqual(3);

  // consecutive calendar days: no gaps
  const days = dates.map((d) => Number(d.split("/")[1]));
  for (let i = 1; i < days.length; i++) {
    const gap = days[i] - days[i - 1];
    expect(gap === 1 || gap < 0).toBe(true);   // +1 day, or a month rollover
  }
});
