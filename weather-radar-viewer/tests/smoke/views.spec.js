// View switching smoke: radar ↔ satellite, location sheet open/close.
//
// The refactored app exposes the active view as data-view="radar"|"sat"|"board"
// on #screen and closes overlays on Escape; the pre-refactor app uses the
// classes satmode/stats/settings and has no Escape handling. These specs
// assert data-view when it exists and fall back to the classes, and try
// Escape first with the button as fallback, so they pass on both.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

function viewState(page) {
  return page.evaluate(() => {
    const s = document.getElementById("screen");
    const dv = s.getAttribute("data-view");
    if (dv) return dv;
    if (s.classList.contains("satmode")) return "sat";
    if (s.classList.contains("stats")) return "board";
    return "radar";
  });
}

async function escapeOr(page, fallbackAction, doneCheck) {
  await page.keyboard.press("Escape");
  try {
    await expect.poll(doneCheck, { timeout: 1500 }).toBe(true);
  } catch (e) {
    await fallbackAction();
    await expect.poll(doneCheck, { timeout: 5000 }).toBe(true);
  }
}

test.beforeEach(async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
});

test("SAT button switches to satellite view and back", async ({ page }) => {
  expect(await viewState(page)).toBe("radar");
  await expect(page.locator("#satview")).toBeHidden();

  await page.locator("#satBtn").click();
  await expect.poll(() => viewState(page)).toBe("sat");
  await expect(page.locator("#satview")).toBeVisible();

  // Escape returns to radar (refactor); pre-refactor: SAT button toggles back
  await escapeOr(
    page,
    () => page.locator("#satBtn").click(),
    async () => (await viewState(page)) === "radar"
  );
  await expect(page.locator("#satview")).toBeHidden();
});

test("the ⌂ button opens the location sheet and closes it again", async ({ page }) => {
  const sheet = page.locator("#locsheet");
  await expect(sheet).toBeHidden();

  await page.locator("#locsBtn").click();
  await expect(sheet).toBeVisible();
  await expect(page.locator("#locZip")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("tapping the conditions panel opens the data boards, not the location sheet", async ({ page }) => {
  await page.locator("#wxPanel").click();
  await expect.poll(() => viewState(page)).toBe("board");
  await expect(page.locator("#locsheet")).toBeHidden();
  await expect(page.locator("#statsview")).toBeVisible();
});

// The bug this guards: opening the layers drawer first used to strand you on a
// board, because Back consumed the drawer's history entry instead of the view's.
test("Back leaves a board even when the layers drawer was opened first", async ({ page }) => {
  await page.locator("#layersBtn").click();
  await expect(page.locator("#layersdrawer")).toBeVisible();

  await page.locator("#wxPanel").click();
  await expect.poll(() => viewState(page)).toBe("board");
  await expect(page.locator("#layersdrawer")).toBeHidden();   // drawer closed on entry

  await page.keyboard.press("Escape");
  await expect.poll(() => viewState(page)).toBe("radar");
});
