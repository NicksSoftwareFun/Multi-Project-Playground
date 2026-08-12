// Boot smoke: the app loads with zero uncaught errors against fully stubbed
// feeds, shows the main screen, and renders the fixture's current conditions.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

test("app boots cleanly with stubbed feeds", async ({ page }) => {
  await routeAll(page);
  const { errors } = await boot(page);

  await expect(page.locator("#screen")).toBeVisible();

  // om-forecast.json has current.temperature_2m = 72.5 → rendered "73°F"
  // (#wxTemp lives inside a container that is display:none until data lands,
  // so assert on its text, then on the container becoming visible)
  await expect(page.locator("#wxTemp")).toHaveText("73°F", { timeout: 15_000 });
  await expect(page.locator("#wxTemp")).toBeVisible();
  const temp = await page.locator("#wxTemp").textContent();
  expect(temp).toMatch(/^-?\d+°F$/);

  // source badge is populated
  const badge = (await page.locator("#srcBadge").textContent()) || "";
  expect(badge.trim().length).toBeGreaterThan(0);

  // no uncaught exceptions during boot + first render
  expect(errors).toEqual([]);
});
