// View switching smoke: radar ↔ satellite, settings open/close.
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

test("settings opens from the gear button and closes again", async ({ page }) => {
  const settings = page.locator("#settings");
  await expect(settings).toBeHidden();

  await page.locator("#settingsBtn").click();
  await expect(settings).toBeVisible();
  await expect(page.locator("#zipInput")).toBeVisible();

  // Escape closes it (refactor); pre-refactor: CANCEL button
  await escapeOr(
    page,
    () => page.locator("#cancelBtn").click(),
    () => settings.isHidden()
  );
  await expect(settings).toBeHidden();
});
