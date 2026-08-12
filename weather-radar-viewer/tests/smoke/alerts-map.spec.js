// MAP alerts smoke: the HEAT/COLD + ADVISORIES layer toggles that filter the
// viewport polygons drawn by alerts.js's syncLayer(), and the tap-a-polygon
// alert detail sheet.
//
// Feeds: tests/fixtures/wwa-query.json (a Tornado Warning polygon + an
// Excessive Heat Warning polygon, both over the default Ankeny, IA viewport)
// via the WWA MapServer stub in _setup.js, plus the point-query alerts
// fixture (alerts-active.json) that answers the tap's NWS_ALERTS?point= call.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

const POLY = "#lmap .leaflet-alerts-pane path";
const SHEET = "#alertsheet";

function row(page, label) {
  return page.locator("#layerRows .layerrow", { hasText: label });
}
function hdot(page, label) {
  return row(page, label).locator(".hdot");
}

test.beforeEach(async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
});

test("heat/cold alerts are hidden by default and drawn after toggling HEAT/COLD ALERTS on", async ({ page }) => {
  // Tornado Warning is drawable by default; the Excessive Heat Warning is
  // heat-family and the HEAT/COLD ALERTS row defaults off, so only 1 polygon.
  await expect.poll(() => page.locator(POLY).count(), { timeout: 15_000 }).toBe(1);

  await page.locator("#layersBtn").click();
  await expect(row(page, "HEAT / COLD ALERTS")).toBeVisible({ timeout: 15_000 });
  await expect(row(page, "HEAT / COLD ALERTS")).not.toHaveClass(/\bon\b/);

  await row(page, "HEAT / COLD ALERTS").click();
  await expect(row(page, "HEAT / COLD ALERTS")).toHaveClass(/\bon\b/);
  // toggling never re-fetches — this is a pure redraw of already-cached data
  await expect.poll(() => page.locator(POLY).count(), { timeout: 5_000 }).toBe(2);

  // toggling back off removes it again
  await row(page, "HEAT / COLD ALERTS").click();
  await expect.poll(() => page.locator(POLY).count(), { timeout: 5_000 }).toBe(1);
});

test("the ALERT POLYGONS row reports the shown-of-total count once something is filtered", async ({ page }) => {
  await page.locator("#layersBtn").click();
  await expect(row(page, "ALERT POLYGONS")).toBeVisible({ timeout: 15_000 });

  // 1 of the 2 viewport alerts (the heat warning) is filtered by default
  await expect.poll(() => hdot(page, "ALERT POLYGONS").getAttribute("title"), { timeout: 15_000 })
    .toBe("1 of 2 in view");
  // the HEAT / COLD ALERTS row itself always reports the raw viewport count,
  // regardless of its own on/off state
  await expect(hdot(page, "HEAT / COLD ALERTS")).toHaveAttribute("title", "1 in view");

  await row(page, "HEAT / COLD ALERTS").click();
  await expect(hdot(page, "ALERT POLYGONS")).toHaveAttribute("title", "2 in view");
});

test("tapping an alert polygon opens the alert sheet with the alert text, and Escape closes it", async ({ page }) => {
  await expect.poll(() => page.locator(POLY).count(), { timeout: 15_000 }).toBe(1);

  await expect(page.locator(SHEET)).toBeHidden();
  await page.locator(POLY).first().click();
  await expect(page.locator(SHEET)).toBeVisible();

  const body = page.locator("#alertsheetBody");
  // the point-query fixture's Tornado Warning outranks its own watch/advisory
  await expect(body.locator(".alertcard").first().locator(".ev")).toHaveText(/TORNADO WARNING/i, { timeout: 15_000 });
  await expect(body).toContainText("capable of producing a tornado");
  await expect(body).toContainText("TAKE COVER NOW");

  await page.keyboard.press("Escape");
  await expect(page.locator(SHEET)).toBeHidden();
});
