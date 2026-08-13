// ALMANAC board: today's high ranked inside the ERA5 reanalysis distribution.
//
// The assertions here are weighted toward HONESTY rather than layout. This board
// is the easiest place in the app to mislead someone — reanalysis is not the
// official station record, and a rank computed from a partial backfill is a
// weaker claim than one from 86 years. Both disclaimers are asserted on the
// success path AND on the failure path, because a caveat that disappears when
// something breaks is worse than no caveat at all.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

const board = (page) => page.locator("#board-almanac");

async function openAlmanac(page) {
  await page.locator("#wxPanel").click();
  await expect.poll(() =>
    page.evaluate(() => document.getElementById("screen").getAttribute("data-view"))
  ).toBe("board");
  await page.locator("#boardDots .dot", { hasText: "ALMANAC" }).click();
  await expect(board(page)).toHaveClass(/active/);
}

test("ranks today against the archive and says what the archive is", async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await openAlmanac(page);

  await expect(board(page).locator(".bigcond")).toHaveText(
    /WARMEST|COLDEST|NEAR NORMAL|ON TRACK/, { timeout: 20_000 });

  // the rank must name its own denominator — "8th warmest" of what?
  await expect(board(page)).toContainText(/\d+(ST|ND|RD|TH) WARMEST OF \d+/);

  // and must never let ERA5 pass for a station record
  await expect(board(page).locator(".srcnote").filter({ hasText: /NOT AN OFFICIAL/i }))
    .toHaveCount(1, { timeout: 20_000 });
  await expect(board(page).locator(".srcnote").filter({ hasText: "ERA5" }).first())
    .toBeVisible();
});

test("a dead archive says so plainly instead of rendering a number", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await routeAll(page);
  await page.route("**://archive-api.open-meteo.com/**", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "boom" }));

  await boot(page);
  await openAlmanac(page);

  await expect(board(page).locator(".bigmsg")).toHaveText(/CLIMATE ARCHIVE UNAVAILABLE/, { timeout: 20_000 });
  expect(await board(page).locator(".bigtemp").count()).toBe(0);   // no number invented from nothing
  expect(errors).toEqual([]);
});

test("the station-record caveat survives the failure path", async ({ page }) => {
  await routeAll(page);
  await page.route("**://archive-api.open-meteo.com/**", (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "boom" }));

  await boot(page);
  await openAlmanac(page);

  // A RETRYING assertion on the caveat itself. Two earlier versions of this
  // test read the notes once after waiting for something else to appear, and
  // both flaked: the wait could be satisfied by a transient loading state that
  // has a .bigmsg but no .srcnote yet, so the read came back empty. Waiting for
  // the exact thing under test removes the race by construction — it can only
  // fail if the caveat never arrives, which is the claim.
  await expect(board(page).locator(".srcnote").filter({ hasText: /NOT AN OFFICIAL/i }))
    .toHaveCount(1, { timeout: 20_000 });
});

test("a partial backfill is labelled as partial", async ({ page }) => {
  await routeAll(page);
  // let the newest decade through, fail everything older
  let served = 0;
  await page.route("**://archive-api.open-meteo.com/**", async (route) => {
    served += 1;
    if (served > 1) return route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
    return route.fallback();
  });

  await boot(page);
  await openAlmanac(page);

  await expect(board(page)).toContainText(/PARTIAL RECORD \d+ YRS/, { timeout: 20_000 });
});
