// Notifications menu (Android shell). The shell exposes a SkywatchShell JS
// bridge; the web side shows the bell + sheet only when it exists, persists
// the checkbox state, and pushes the full config (toggles, categories, ZIP
// locations) to the bridge on boot and on every change.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

// A fake bridge injected before the app boots. Calls land in window.__notify
// so assertions can read them back.
function installBridge(page, opts) {
  return page.addInitScript((o) => {
    window.__notify = { configs: [], permissionAsked: 0 };
    window.SkywatchShell = {
      setNotifyConfig: (json) => window.__notify.configs.push(JSON.parse(json)),
      requestNotificationPermission: () => { window.__notify.permissionAsked++; },
      areNotificationsEnabled: () => !o.blocked,
    };
  }, opts || { blocked: false });
}

function lastConfig(page) {
  return page.evaluate(() => window.__notify.configs[window.__notify.configs.length - 1]);
}

test("without the shell bridge the bell button stays hidden", async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#notifBtn")).toBeHidden();
  expect(await page.locator("#notifsheet").count()).toBe(0);
});

test("boot pushes the saved ZIP locations and defaults to the bridge", async ({ page }) => {
  await routeAll(page);
  await installBridge(page);
  const { errors } = await boot(page);

  await expect(page.locator("#notifBtn")).toBeVisible();
  const cfg = await lastConfig(page);
  expect(cfg.enabled).toBe(false);              // off until the user opts in
  expect(cfg.warnings).toBe(true);
  expect(cfg.watches).toBe(true);
  expect(cfg.cats.tornado).toBe(true);          // categories default on
  expect(cfg.cats.other).toBe(true);
  // the default seeded location (Ankeny, IA) rides along with coordinates
  expect(cfg.locations.length).toBe(1);
  expect(cfg.locations[0].zip).toBe("50021");
  expect(cfg.locations[0].name).toContain("Ankeny");
  expect(typeof cfg.locations[0].lat).toBe("number");
  expect(typeof cfg.locations[0].lon).toBe("number");
  expect(errors).toEqual([]);
});

test("enabling notifications asks for permission and pushes the change", async ({ page }) => {
  await routeAll(page);
  await installBridge(page);
  await boot(page);

  await page.locator("#notifBtn").click();
  await expect(page.locator("#notifsheet")).toBeVisible();

  await page.locator("label[for=nc_master]").click();
  expect(await page.locator("#nc_master").isChecked()).toBe(true);

  const cfg = await lastConfig(page);
  expect(cfg.enabled).toBe(true);
  expect(await page.evaluate(() => window.__notify.permissionAsked)).toBe(1);
});

test("category and type checkboxes persist and reach the bridge", async ({ page }) => {
  await routeAll(page);
  await installBridge(page);
  await boot(page);

  await page.locator("#notifBtn").click();
  await page.locator("label[for=nc_flood]").click();     // FLOOD off
  await page.locator("label[for=nc_watch]").click();     // watches off

  let cfg = await lastConfig(page);
  expect(cfg.cats.flood).toBe(false);
  expect(cfg.cats.tornado).toBe(true);                   // others untouched
  expect(cfg.watches).toBe(false);
  expect(cfg.warnings).toBe(true);

  // survives a reload: same state restored from localStorage and re-pushed
  await page.reload();
  await expect(page.locator("#notifBtn")).toBeVisible();
  cfg = await lastConfig(page);
  expect(cfg.cats.flood).toBe(false);
  expect(cfg.watches).toBe(false);
  await page.locator("#notifBtn").click();
  expect(await page.locator("#nc_flood").isChecked()).toBe(false);
  expect(await page.locator("#nc_watch").isChecked()).toBe(false);
  expect(await page.locator("#nc_tornado").isChecked()).toBe(true);
});

test("adding a ZIP re-pushes the location list", async ({ page }) => {
  await routeAll(page);
  await installBridge(page);
  await boot(page);

  await page.locator("#locsBtn").click();
  await page.locator("#locZip").fill("52240");
  await page.locator("#locAdd").click();
  await expect(page.locator("#locsheet")).toBeHidden();

  const cfg = await lastConfig(page);
  const zips = cfg.locations.map((l) => l.zip).sort();
  expect(zips).toEqual(["50021", "52240"]);
});

test("blocked system notifications surface a warning in the sheet", async ({ page }) => {
  await routeAll(page);
  await installBridge(page, { blocked: true });
  await boot(page, {
    localStorage: {
      skywatch_notify: JSON.stringify({ enabled: true, warnings: true, watches: true, cats: {} }),
    },
  });

  await page.locator("#notifBtn").click();
  await expect(page.locator("#notifPerm")).toHaveText(/BLOCKED/);
});
