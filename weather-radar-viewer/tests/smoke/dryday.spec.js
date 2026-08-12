// A dry day makes every precipitation value 0. The chart engine used to widen a
// flat series by a fixed +/-1 to give it a span, so the rainfall axis opened at
// -1 IN — an impossible quantity presented as data.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot, OM_CAST } = require("./_setup");

test("a dry day's precipitation axis never goes below zero", async ({ page }) => {
  await routeAll(page);

  // same fixture, every precipitation value zeroed — the dry-day case
  await page.route("**://api.open-meteo.com/**", (route) => {
    const url = route.request().url();
    if (!url.includes("minutely_15") && !url.includes("forecast_days=7")) return route.fallback();
    const body = JSON.parse(OM_CAST());
    if (body.minutely_15 && body.minutely_15.precipitation) {
      body.minutely_15.precipitation = body.minutely_15.precipitation.map(() => 0);
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    });
  });

  await boot(page);
  await page.locator("#wxPanel").click();
  await page.locator("#boardDots .dot", { hasText: "FCAST" }).click();

  const strip = page.locator("#board-cast .col", { hasText: "NEXT 2 HOURS" });
  await expect(strip.locator(".chart svg")).toBeAttached({ timeout: 15_000 });

  // every y-axis label on that chart must be a real rainfall amount
  const labels = await strip.locator(".chart svg text").allTextContents();
  const numeric = labels.map((t) => Number(t)).filter((t) => t !== "" && !isNaN(t));
  expect(numeric.length).toBeGreaterThan(0);
  for (const n of numeric) expect(n).toBeGreaterThanOrEqual(0);
});
