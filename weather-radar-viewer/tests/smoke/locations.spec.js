// Multi-location + GPS (M1): legacy migration, sheet add/switch/delete,
// snapshot instant paint, GPS-denied path.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot, DEFAULT_LOC } = require("./_setup");

test.beforeEach(async ({ page }) => { await routeAll(page); });

test("legacy skywatch_loc migrates to the v2 list", async ({ page }) => {
  const { errors } = await boot(page);   // seeds only the legacy key
  await page.waitForSelector("#wxTemp");
  const v2 = await page.evaluate(() => JSON.parse(localStorage.getItem("skywatch_locs")));
  expect(v2.v).toBe(2);
  expect(v2.activeId).toBe("z" + DEFAULT_LOC.zip);
  expect(v2.list).toHaveLength(1);
  expect(v2.list[0].name).toBe(DEFAULT_LOC.name);
  expect(errors).toHaveLength(0);
});

test("wx panel opens the location sheet; ZIP add switches active", async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(600);
  await page.click("#wxPanel");
  await expect(page.locator("#locsheet")).toBeVisible();
  // one existing row from migration
  await expect(page.locator("#locsheet .locrow")).toHaveCount(1);

  // add a ZIP (zippopotam fixture answers regardless of the number)
  await page.fill("#locZip", "90210");
  await page.click("#locAdd");
  await expect(page.locator("#locsheet")).toBeHidden();
  const v2 = await page.evaluate(() => JSON.parse(localStorage.getItem("skywatch_locs")));
  expect(v2.list).toHaveLength(2);
  expect(v2.activeId).toBe("z90210");
});

test("switching rows repaints instantly from snapshot; delete removes", async ({ page }) => {
  // seed a two-location v2 store plus a snapshot for the second location
  const v2 = {
    v: 2, activeId: "z" + DEFAULT_LOC.zip,
    list: [
      { id: "z" + DEFAULT_LOC.zip, kind: "zip", zip: DEFAULT_LOC.zip, lat: DEFAULT_LOC.lat, lon: DEFAULT_LOC.lon, name: DEFAULT_LOC.name, state: DEFAULT_LOC.state },
      { id: "z10001", kind: "zip", zip: "10001", lat: 40.75, lon: -73.99, name: "New York", state: "NY" }
    ]
  };
  const snap = {
    src: "OPEN-METEO", temp: 61.2, feels: 60.1, rh: 55, dew: 45,
    windTxt: "N 5 MPH", gust: "9 MPH", pres: "29.92 inHg", precip: "0.00 IN/HR",
    cond: "CLEAR", hours: [], daily: null
  };
  await boot(page, { localStorage: {
    skywatch_locs: JSON.stringify(v2),
    skywatch_snap_z10001: JSON.stringify(snap)
  }});
  await page.waitForTimeout(600);

  await page.click("#wxPanel");
  const rows = page.locator("#locsheet .locrow");
  await expect(rows).toHaveCount(2);
  // snapshot temp chip is shown in the list
  await expect(rows.nth(1).locator(".tmp")).toHaveText("61°F");

  // switch to New York — panel paints the snapshot immediately
  await rows.nth(1).click();
  await expect(page.locator("#locsheet")).toBeHidden();
  await expect(page.locator("#wxPlace")).toContainText("New York");

  // delete the now-inactive Ankeny row
  await page.click("#wxPanel");
  await page.locator("#locsheet .locrow", { hasText: "Ankeny" }).locator(".del").click();
  await expect(page.locator("#locsheet .locrow")).toHaveCount(1);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("skywatch_locs")));
  expect(after.list).toHaveLength(1);
  expect(after.activeId).toBe("z10001");
});

test("GPS denial shows retry message and does not break the app", async ({ page, context }) => {
  // explicitly deny geolocation → getCurrentPosition rejects immediately
  await context.grantPermissions([]);
  await boot(page);
  await page.waitForTimeout(600);
  await page.click("#wxPanel");
  await page.click("#gpsBtn");
  await expect(page.locator("#locMsg")).toHaveText(/LOCATION OFF/, { timeout: 15000 });
  // existing ZIP location still active and functional
  const v2 = await page.evaluate(() => JSON.parse(localStorage.getItem("skywatch_locs")));
  expect(v2.activeId).toBe("z" + DEFAULT_LOC.zip);
});

test("GPS grant adds a current-location entry named via NWS", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 41.6, longitude: -93.6 });
  await boot(page);
  await page.waitForTimeout(600);
  await page.click("#wxPanel");
  await page.click("#gpsBtn");
  await expect(page.locator("#locsheet")).toBeHidden({ timeout: 5000 });
  const v2 = await page.evaluate(() => JSON.parse(localStorage.getItem("skywatch_locs")));
  expect(v2.activeId).toBe("gps");
  const gps = v2.list.find((l) => l.id === "gps");
  expect(gps).toBeTruthy();
  expect(gps.lat).toBeCloseTo(41.6, 1);
});
