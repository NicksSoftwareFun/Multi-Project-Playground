// The basemap is fetched one zoom level deeper than the map is displaying, so
// coastlines and inland water keep their shape at regional zooms instead of
// being generalised into land. Labels stay at native zoom — shrinking those
// would make the map harder to read, not easier.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

function zoomsFrom(urls, layer) {
  const out = [];
  for (const u of urls) {
    const m = new URL(u).pathname.match(new RegExp("/" + layer + "/(\\d+)/"));
    if (m) out.push(Number(m[1]));
  }
  return out;
}

test("geography tiles come from one zoom deeper than the labels", async ({ page }) => {
  const urls = [];
  page.on("request", (r) => {
    if (r.url().includes("basemaps.cartocdn.com")) urls.push(r.url());
  });

  await routeAll(page);
  await boot(page);
  await expect(page.locator("#lmap .leaflet-tile-pane")).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(2500);

  const geo = zoomsFrom(urls, "dark_nolabels");
  const lab = zoomsFrom(urls, "dark_only_labels");
  expect(geo.length).toBeGreaterThan(0);
  expect(lab.length).toBeGreaterThan(0);

  // both layers track the same map, so compare their maxima
  expect(Math.max(...geo)).toBe(Math.max(...lab) + 1);
});
