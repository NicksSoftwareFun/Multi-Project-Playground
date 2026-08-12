// SKY board smoke (M5, astronomy half): day length + delta, the sun/moon
// altitude chart, twilight/golden-hour rows, moon phase + rise/set, and the
// Invalid-Date discipline that keeps "NaN"/"Invalid Date" off the screen.
//
// astro.js issues zero network requests — every value is a pure function of
// (instant, lat, lon) run on-device against vendor/suncalc.js — so most of
// this spec calls the exported computeSky() directly via page.evaluate
// rather than driving the UI through a fixture. Per the task's guidance this
// spec deliberately never uses page.clock: SunCalc's getMoonTimes() windows
// on the DEVICE's local midnight, so the moon-times assertions need a real
// pinned timezone (test.use below), but freezing the clock would also freeze
// the 30s countdown timer this board runs while on screen, and a test that
// then waited on the countdown to change would hang until timeout.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

// getMoonTimes' rise/set omission is a function of the DEVICE's local
// calendar day, not the location's — pin per-spec rather than touching the
// shared playwright.config.js (which other specs' date-formatting relies on
// staying unpinned).
test.use({ timezoneId: "America/Chicago" });

const BOARD = "#board-sky";
const ANKENY = { lat: 41.73, lon: -93.6 };

async function setup(page) {
  await routeAll(page);
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  return { errors };
}

async function openSky(page) {
  await page.locator("#wxPanel").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await page.locator("#boardDots .dot", { hasText: "SKY" }).click();
  await expect(page.locator(BOARD)).toHaveClass(/\bactive\b/);
}

// Writes the v2 locations shape directly (locations.js's loadLocs() prefers
// v2 over the legacy single-location key unconditionally) so this always
// wins even in a test that already navigated once via setup()/boot() and so
// already has a v2 blob sitting in localStorage from the default seed —
// overwriting the legacy key alone would be silently ignored in that case.
function seedLoc(lat, lon, zip) {
  return {
    skywatch_locs: JSON.stringify({
      v: 2, activeId: "z" + zip,
      list: [{ id: "z" + zip, kind: "zip", zip, lat, lon, name: "Test Point", state: "" }]
    })
  };
}

function computeSky(page, iso, lat, lon) {
  return page.evaluate(
    ([iso, lat, lon]) =>
      import("/js/astro.js").then((m) => m.computeSky(new Date(iso), lat, lon)),
    [iso, lat, lon]
  );
}

test("opening SKY shows the board active with the day-length hero", async ({ page }) => {
  await setup(page);
  await openSky(page);
  await expect(page.locator("#screen")).toHaveAttribute("data-board", "sky");
  await expect(page.locator(BOARD)).toBeVisible();
  await expect(page.locator(BOARD + " .bigtemp")).toHaveText(/^\d+H \d{2}M \d{2}S$/, { timeout: 15_000 });
  await expect(page.locator(BOARD + " .bigcond")).toHaveText(/GAINING|LOSING|UNAVAILABLE/);
});

// The offline claim, asserted rather than asserted-about: every non-localhost
// request is aborted AFTER routeAll registers (last-added handler wins — see
// xss.spec.js / air.spec.js), so this is a true airplane-mode boot.
test("airplane mode: SKY still renders a day-length hero with zero pageerrors", async ({ page }) => {
  await routeAll(page);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.fallback();
    return route.abort("blockedbyclient");
  });
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  await openSky(page);
  await expect(page.locator(BOARD + " .bigtemp")).toHaveText(/^\d+H \d{2}M \d{2}S$/, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("computeSky at Ankeny: sunrise < solarNoon < sunset and dayLengthMs matches the vendored engine", async ({ page }) => {
  await setup(page);
  const r = await computeSky(page, "2026-08-12T18:00:00Z", ANKENY.lat, ANKENY.lon);
  const sunrise = new Date(r.sun.sunrise).getTime();
  const noon = new Date(r.sun.solarNoon).getTime();
  const sunset = new Date(r.sun.sunset).getTime();
  expect(sunrise).toBeLessThan(noon);
  expect(noon).toBeLessThan(sunset);
  // 13h59m41s, produced by running the vendored SunCalc directly (see task report)
  expect(Math.abs(r.dayLengthMs - 50381000)).toBeLessThan(1000);
});

test("no astronomical night above ~48.7N in June: the Invalid-Date trap, pinned at the boundary and at the pixel", async ({ page }) => {
  await setup(page);

  // date-independent half: the pure function, at the exact date the boundary
  // was verified against, never leaks an Invalid Date — nulls only.
  const r = await computeSky(page, "2026-06-21T18:00:00Z", 60, -150);
  expect(r.sun.night).toBeNull();
  expect(r.sun.nightEnd).toBeNull();
  expect(r.twilight.astronomical).toBeNull();

  // 49N is between the two verified boundaries (~48.7N astronomical, ~54.5N
  // nautical) — astronomical is already gone here but nautical twilight
  // isn't yet, so this pins the two thresholds as genuinely different lines
  // rather than one blanket "high latitude" cutoff.
  const r49 = await computeSky(page, "2026-06-21T18:00:00Z", 49, 0);
  expect(r49.twilight.astronomical).toBeNull();
  expect(r49.twilight.nautical).not.toBeNull();

  // rendered half: the same "-18 stays above" condition holds at this
  // latitude for a wide span either side of the solstice (verified through
  // at least May-August at 60N — see the task report), which covers this
  // suite's real run date without needing to freeze the clock.
  await page.addInitScript((seed) => {
    for (const k of Object.keys(seed)) localStorage.setItem(k, seed[k]);
  }, seedLoc(60, -150, "99501"));
  await page.goto("/");
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  await openSky(page);
  await expect(page.locator(BOARD)).toContainText("NONE — SUN STAYS ABOVE −18°", { timeout: 15_000 });
});

test("day-over-day change flips sign around the equinoxes", async ({ page }) => {
  await setup(page);
  const spring = await computeSky(page, "2026-03-20T18:00:00Z", ANKENY.lat, ANKENY.lon);
  const fall = await computeSky(page, "2026-09-22T18:00:00Z", ANKENY.lat, ANKENY.lon);
  expect(spring.dayDeltaMs).toBeGreaterThan(0);
  expect(fall.dayDeltaMs).toBeLessThan(0);

  await openSky(page);
  await expect(page.locator(BOARD + " .bigcond")).toHaveText(/(GAINING|LOSING) \d+M \d{2}S PER DAY/, { timeout: 15_000 });
});

test("the sun/moon altitude chart renders 3 paths and the crosshair readout names both bodies", async ({ page }) => {
  await setup(page);
  await openSky(page);
  const svgEl = page.locator(BOARD + " .chart .plot svg").first();
  await expect(svgEl).toBeAttached({ timeout: 15_000 });
  expect(await svgEl.locator("path").count()).toBeGreaterThanOrEqual(3);   // sun, moon, horizon

  const hit = svgEl.locator(".hitarea");
  await expect(hit).toBeVisible();
  const box = await hit.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  const readoutText = (await page.locator(BOARD + " .readout").textContent()) || "";
  expect(readoutText).toContain("SUN");
  expect(readoutText).toContain("MOON");
  await page.mouse.up();
});

// The task spec's own worked example (2026-08-26 at Ankeny) turned out NOT to
// reproduce a missing-rise day once pinned to America/Chicago (getMoonTimes
// windows on the DEVICE's local midnight, and the local-Chicago window for
// the 26th does contain a rise — see the task report). 2026-08-12 at lon 0
// (still 41.73N) was verified, under this same pinned timezone, to return
// {set} with no `rise` key — and 2026-08-12 is a fixed literal here, not
// "new Date()", so this half of the test is exactly as reproducible on any
// future run as the other computeSky() assertions in this file.
test("no moonrise on the local calendar day renders '--' with the orbital-mechanics note", async ({ page }) => {
  await setup(page);
  const r = await computeSky(page, "2026-08-12T18:00:00Z", 41.73, 0);
  expect(r.moon.rise).toBeNull();
  expect(r.moon.set).not.toBeNull();

  // Rendered half: no clock mocking (see the file-header note on page.clock),
  // so this relies on today's real date still landing near 2026-08-12 —
  // verified true for this suite's run date, same trade-off as the
  // astronomical-twilight render check above.
  await page.addInitScript((seed) => {
    for (const k of Object.keys(seed)) localStorage.setItem(k, seed[k]);
  }, seedLoc(41.73, 0, "00001"));
  await page.goto("/");
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  await openSky(page);

  const moonriseValue = await page.evaluate(() => {
    const board = document.querySelector("#board-sky");
    const k = Array.from(board.querySelectorAll(".grid .k")).find((el) => /MOONRISE/i.test(el.textContent));
    return k && k.nextElementSibling ? k.nextElementSibling.textContent.trim() : null;
  });
  expect(moonriseValue).toBe("--");
  await expect(page.locator(BOARD + " .srcnote").filter({ hasText: /NO MOONRISE/i })).toHaveCount(1);
});

test("no NaN, Invalid Date, or undefined anywhere on the board across a range of latitudes", async ({ page }) => {
  await routeAll(page);
  page.on("pageerror", () => {});
  for (const [lat, lon, zip] of [[41.73, -93.6, "50021"], [60, -150, "99501"], [78, 15, "78000"], [-41, 174, "41000"], [85, 0, "85000"]]) {
    await page.addInitScript((seed) => {
      for (const k of Object.keys(seed)) localStorage.setItem(k, seed[k]);
    }, seedLoc(lat, lon, zip));
    await page.goto("/");
    await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
    await openSky(page);
    await expect(page.locator(BOARD + " .bigtemp")).toBeAttached({ timeout: 15_000 });
    const text = await page.locator(BOARD).textContent();
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/Invalid Date/);
    expect(text).not.toMatch(/undefined/);
  }
});

test("moon illumination renders an integer percent, a valid phase name, and CSS-resolved disc fills", async ({ page }) => {
  await setup(page);
  await openSky(page);
  await expect(page.locator(BOARD + " .skyillum")).toHaveText(/^\d{1,3}%$/, { timeout: 15_000 });
  await expect(page.locator(BOARD + " .skyphase")).toHaveText(
    /(NEW MOON|WAXING CRESCENT|FIRST QUARTER|WAXING GIBBOUS|FULL MOON|WANING GIBBOUS|LAST QUARTER|WANING CRESCENT) · ILLUMINATED/
  );
  await expect(page.locator(BOARD + " svg.moondisc")).toHaveCount(1);

  const fills = await page.evaluate(() => {
    const disc = document.querySelector("#board-sky svg.moondisc");
    return {
      lit: getComputedStyle(disc.querySelector(".lit")).fill,
      dark: getComputedStyle(disc.querySelector(".dark")).fill
    };
  });
  expect(fills.lit).not.toBe("");
  expect(fills.lit).not.toBe("none");
  expect(fills.dark).not.toBe("");
  expect(fills.dark).not.toBe("none");
});

// The guard is real, not aspirational. A plain `delete window.SunCalc` in an
// addInitScript would be immediately undone by vendor/suncalc.js's own
// strict-mode `window.SunCalc = SunCalc` a few milliseconds later, so this
// installs a getter/setter pair that discards the vendor script's write
// (silently, since a setter exists — no strict-mode throw) and always reads
// back undefined, the practical equivalent of the global never existing.
test("window.SunCalc missing renders the honest unavailable message with zero pageerrors", async ({ page }) => {
  await routeAll(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "SunCalc", { get() { return undefined; }, set() {}, configurable: true });
  });
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  await openSky(page);
  await expect(page.locator(BOARD + " .bigmsg")).toHaveText("ASTRONOMY ENGINE UNAVAILABLE — vendor/suncalc.js DID NOT LOAD");
  expect(errors).toEqual([]);
});

// Waiting a bit over a minute guarantees a wall-clock minute boundary is
// crossed no matter which second the test happened to start on, so the
// NEXT row (minute-granularity countdown) is guaranteed to change — without
// asserting anything about exactly how much it changed by.
test("the 30s tick rewrites only the NEXT countdown, never tearing down the chart", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await openSky(page);
  const svgEl = page.locator(BOARD + " .chart .plot svg").first();
  await expect(svgEl).toBeAttached({ timeout: 15_000 });
  await svgEl.evaluate((el) => { el.dataset.skyMark = "same-node"; });

  const nextBefore = await page.evaluate(() => {
    const board = document.querySelector("#board-sky");
    const k = Array.from(board.querySelectorAll(".grid .k")).find((el) => el.textContent.trim() === "NEXT");
    return k.nextElementSibling.textContent;
  });

  await page.waitForTimeout(65_000);

  const nextAfter = await page.evaluate(() => {
    const board = document.querySelector("#board-sky");
    const k = Array.from(board.querySelectorAll(".grid .k")).find((el) => el.textContent.trim() === "NEXT");
    return k.nextElementSibling.textContent;
  });

  await expect(svgEl).toHaveAttribute("data-sky-mark", "same-node");   // same node, not rebuilt
  expect(nextAfter).not.toBe(nextBefore);
});

test("no pageerrors while opening and rendering SKY", async ({ page }) => {
  const { errors } = await setup(page);
  await openSky(page);
  await expect(page.locator(BOARD + " .bigtemp")).toHaveText(/^\d+H \d{2}M \d{2}S$/, { timeout: 15_000 });
  await expect(page.locator(BOARD + " .chart .plot svg").first()).toBeAttached({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
