// XSS smoke: hostile strings in API responses must render as inert text.
// Feeds are re-routed to fixture copies with markup injected into the fields
// the app renders (Open-Meteo current fields, Zippopotam place name), then we
// assert nothing executed and nothing was injected as DOM.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot, HOSTILE, OM_FORECAST, ZIPPO } = require("./_setup");

test("hostile API strings are rendered inert", async ({ page }) => {
  await routeAll(page);

  // hostile Open-Meteo payload: markup in the current-conditions fields that
  // flow into the conditions panel
  const om = JSON.parse(OM_FORECAST);
  om.current.weather_code = HOSTILE.imgOnerror;
  om.current.wind_direction_10m = HOSTILE.scriptBreak;
  om.current.wind_gusts_10m = HOSTILE.quoteBreak;
  await page.route("**://api.open-meteo.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(om),
    })
  );

  // hostile Zippopotam payload: markup in the place name
  const zippo = JSON.parse(ZIPPO);
  zippo.places[0]["place name"] = HOSTILE.placeName;
  await page.route("**://api.zippopotam.us/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(zippo),
    })
  );

  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss().catch(() => {});
  });

  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  await expect(page.locator("#wxTemp")).toHaveText("73°F", { timeout: 15_000 });

  // exercise the live geocode path: saving a ZIP pulls the hostile place name
  await page.locator("#locsBtn").click();
  await expect(page.locator("#locsheet")).toBeVisible();
  await page.locator("#locZip").fill("50021");
  await page.locator("#locAdd").click();

  // the hostile place name must appear as literal, inert text
  await expect(page.locator("#wxPlace")).toContainText("Evil City", { timeout: 15_000 });
  const placeText = await page.locator("#wxPlace").textContent();
  expect(placeText).toContain(HOSTILE.placeName);

  // ...and must not have become real DOM
  expect(await page.locator("#wxPanel img").count()).toBe(0);
  expect(await page.locator("#statsview img").count()).toBe(0);
  expect(await page.locator('img[src="x"]').count()).toBe(0);

  // no script executed: no dialog, none of the fixture's side-effect flags
  expect(dialogs).toEqual([]);
  const flags = await page.evaluate(() => ({
    img: window.__xss_img,
    script: window.__xss_script,
    attr: window.__xss_attr,
    place: window.__xss_place,
  }));
  expect(flags).toEqual({ img: undefined, script: undefined, attr: undefined, place: undefined });

  // the markup, where rendered, is escaped in the serialized DOM
  const panelHtml = await page.locator("#wxPanel").innerHTML();
  expect(panelHtml).not.toContain("<img");
  expect(panelHtml).toContain("&lt;img");

  expect(errors).toEqual([]);
});
