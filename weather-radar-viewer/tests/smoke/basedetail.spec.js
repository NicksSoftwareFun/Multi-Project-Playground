// The basemap is fetched one zoom level deeper than the map is displaying, so
// coastlines and inland water keep their shape at regional zooms instead of
// being generalised into land. Labels stay at native zoom — shrinking those
// would make the map harder to read, not easier.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

// Esri tile URLs are .../<service>/MapServer/tile/{z}/{y}/{x} — the zoom is the
// first path segment after /tile/. `service` names the base vs reference layer.
function zoomsFrom(urls, service) {
  const out = [];
  for (const u of urls) {
    if (!u.includes(service)) continue;
    const m = new URL(u).pathname.match(/\/tile\/(\d+)\//);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

test("geography tiles come from one zoom deeper than the labels", async ({ page }) => {
  const urls = [];
  page.on("request", (r) => {
    if (r.url().includes("server.arcgisonline.com")) urls.push(r.url());
  });

  await routeAll(page);
  await boot(page);
  await expect(page.locator("#lmap .leaflet-tile-pane")).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(2500);

  const geo = zoomsFrom(urls, "World_Dark_Gray_Base");
  const lab = zoomsFrom(urls, "World_Dark_Gray_Reference");
  expect(geo.length).toBeGreaterThan(0);
  expect(lab.length).toBeGreaterThan(0);

  // both layers track the same map, so compare their maxima
  expect(Math.max(...geo)).toBe(Math.max(...lab) + 1);
});
