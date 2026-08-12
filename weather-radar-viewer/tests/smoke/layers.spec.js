// Map layers drawer smoke (M2): the ≡ button, the registered rows, toggle
// persistence across a reload, and the Escape exit.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

const LAYER_KEY = "skywatch_layers";

function drawerOpen(page) {
  return page.evaluate(() => document.getElementById("screen").classList.contains("layers"));
}
function layerPrefs(page) {
  return page.evaluate((k) => {
    try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; }
  }, LAYER_KEY);
}
function row(page, label) {
  return page.locator("#layerRows .layerrow", { hasText: label });
}

test.beforeEach(async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
});

test("≡ opens the drawer and lists the registered layers", async ({ page }) => {
  await expect(page.locator("#layersdrawer")).toBeHidden();
  expect(await drawerOpen(page)).toBe(false);

  await page.locator("#layersBtn").click();
  expect(await drawerOpen(page)).toBe(true);
  await expect(page.locator("#layersdrawer")).toBeVisible();

  const rows = page.locator("#layerRows .layerrow");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  expect(await rows.count()).toBeGreaterThanOrEqual(2);

  await expect(row(page, "ALERT POLYGONS")).toHaveCount(1);
  await expect(row(page, "SPC OUTLOOK")).toHaveCount(1);

  // alert polygons ship on by default
  await expect(row(page, "ALERT POLYGONS")).toHaveClass(/\bon\b/);
  await expect(row(page, "SPC OUTLOOK")).not.toHaveClass(/\bon\b/);
});

test("toggling a row flips it and survives a reload", async ({ page }) => {
  await page.locator("#layersBtn").click();
  const spc = row(page, "SPC OUTLOOK");
  const alerts = row(page, "ALERT POLYGONS");
  await expect(spc).toBeVisible({ timeout: 15_000 });

  // off -> on
  await spc.click();
  await expect(spc).toHaveClass(/\bon\b/);
  await expect(spc.locator(".lstate")).toHaveText("ON");

  // on -> off
  await alerts.click();
  await expect(alerts).not.toHaveClass(/\bon\b/);
  await expect(alerts.locator(".lstate")).toHaveText("OFF");

  await expect.poll(() => layerPrefs(page)).toMatchObject({ spc: true, alerts: false });

  // reload: prefs are re-applied before the rows render
  await page.reload();
  await expect(page.locator("#screen")).toBeVisible();
  await page.locator("#layersBtn").click();
  await expect(row(page, "SPC OUTLOOK")).toHaveClass(/\bon\b/, { timeout: 15_000 });
  await expect(row(page, "ALERT POLYGONS")).not.toHaveClass(/\bon\b/);
  expect(await layerPrefs(page)).toMatchObject({ spc: true, alerts: false });
});

test("Escape closes the drawer", async ({ page }) => {
  await page.locator("#layersBtn").click();
  await expect(page.locator("#layersdrawer")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#layersdrawer")).toBeHidden();
  expect(await drawerOpen(page)).toBe(false);
  // closing an overlay must not knock the app off the radar view
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "radar");
});
