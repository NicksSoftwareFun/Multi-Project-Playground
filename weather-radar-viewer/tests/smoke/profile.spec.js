// Derived atmospheric profile smoke (M7): the PROFILE section on FCAST
// (freezing level, precipitation-type reasoning, cloud bases and tops) and the
// INVERSION / MIXING section on AIR.
//
// The Open-Meteo stub behind this file REFUSES malformed requests (see
// _setup.js): an unknown hourly variable, a pressure level Open-Meteo does not
// publish, a missing coordinate and an out-of-range forecast_days all come back
// as HTTP 400 the way the real API answers them. So every "it rendered"
// assertion below is also an assertion that the app asked correctly.
//
// The whole point of this milestone is the trust gate, so the assertions that
// matter most are the negative ones: an inversion prints NO height, and a warm
// nose never resolves to a bare "SLEET" or "FREEZING RAIN" verdict.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

const CAST = "#board-cast";
const AIR = "#board-air";
const STRIP = CAST + " #profileStrip";
const AIRSTRIP = AIR + " #inversionStrip";

async function setup(page, opts) {
  await routeAll(page, opts);
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  return { errors };
}

async function openBoard(page, label, sel) {
  // the conditions panel is the way INTO the deck; once inside, it is hidden
  // behind the board, so switching boards goes through the dots alone
  if ((await page.getAttribute("#screen", "data-view")) !== "board") {
    await page.locator("#wxPanel").click();
  }
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await page.locator("#boardDots .dot", { hasText: label }).click();
  await expect(page.locator(sel)).toHaveClass(/\bactive\b/);
}

const openCast = (page) => openBoard(page, "FCAST", CAST);
const openAir = (page) => openBoard(page, "AIR", AIR);

function freezeValue(page) {
  return page.locator(STRIP + " .grid .v").first();
}

// ---------------------------------------------------------------------------
// the request itself

test("the profile request asks for heights, humidity and boundary layer, one day", async ({ page }) => {
  const urls = [];
  await routeAll(page);
  page.on("request", (r) => urls.push(r.url()));
  await boot(page);
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  await openCast(page);
  await expect(page.locator(STRIP + " .sect")).toHaveText("PROFILE", { timeout: 15_000 });

  await expect.poll(() => urls.find((u) => u.includes("hPa")), { timeout: 15_000 }).toBeTruthy();
  const u = new URL(urls.find((x) => x.includes("hPa")));
  const hourly = u.searchParams.get("hourly");
  for (const level of [1000, 925, 850, 700, 500, 300]) {
    expect(hourly).toContain("temperature_" + level + "hPa");
    expect(hourly).toContain("relative_humidity_" + level + "hPa");
    expect(hourly).toContain("geopotential_height_" + level + "hPa");
  }
  expect(hourly).toContain("boundary_layer_height");
  expect(u.searchParams.get("forecast_days")).toBe("1");
  expect(u.searchParams.get("temperature_unit")).toBe("celsius");
  expect(u.searchParams.get("timeformat")).toBe("unixtime");
  // the pressure levels ride on &hourly= only — &current= support for them was
  // never confirmed live, so nothing may depend on it
  expect(u.searchParams.get("current")).not.toContain("hPa");
});

// ---------------------------------------------------------------------------
// freezing level

test("a normal profile prints an interpolated freezing level in feet", async ({ page }) => {
  const { errors } = await setup(page, { profile: "base" });
  await openCast(page);

  await expect(page.locator(STRIP + " .grid .k")).toHaveText("FREEZING LEVEL", { timeout: 15_000 });
  // 10°C at 1500 m (850 hPa) over -2°C at 3100 m (700 hPa) crosses 0°C at
  // 2833 m = 9,296 ft, printed to the nearest 100 ft
  await expect(freezeValue(page)).toHaveText("9,300 FT");
  // the 1600 m bracket is inside PROFILE_GAP_WARN_M, so no "approximate" note
  await expect(page.locator(STRIP)).not.toContainText("INTERPOLATED ACROSS");
  expect(errors).toEqual([]);
});

test("a below-freezing surface says AT THE SURFACE and never a height", async ({ page }) => {
  const { errors } = await setup(page, { profile: "snow" });
  await openCast(page);

  await expect(freezeValue(page)).toHaveText("AT THE SURFACE", { timeout: 15_000 });
  await expect(page.locator(STRIP)).toContainText("SURFACE IS ALREADY AT OR BELOW FREEZING");
  expect(errors).toEqual([]);
});

test("an inversion below the crossing refuses to print a freezing level", async ({ page }) => {
  const { errors } = await setup(page, { profile: "inversion" });
  await openCast(page);

  // 1°C at the surface under 4°C at 925 hPa: temperature RISES with height, so
  // a straight-line interpolation to 0°C above it is not trustworthy
  await expect(freezeValue(page)).toHaveText("--", { timeout: 15_000 });
  const strip = page.locator(STRIP);
  await expect(strip).toContainText("FREEZING LEVEL UNCERTAIN — TEMPERATURE INVERSION BETWEEN SURFACE–925 hPa");
  await expect(strip).toContainText("A SIMPLE INTERPOLATION ACROSS AN INVERSION IS UNRELIABLE");
  // and no height sneaks in anywhere near the freezing-level row
  const rowText = await page.locator(STRIP + " .grid").textContent();
  expect(rowText).not.toMatch(/\d[\d,]*\s*FT/);
  expect(errors).toEqual([]);
});

test("an inversion far from freezing does not blank the freezing level", async ({ page }) => {
  const { errors } = await setup(page, { profile: "nocturnal" });
  await openCast(page);

  // A radiationally cooled 2 m temperature under a warmer 925 hPa is warming
  // with height, on most clear nights, in an 18°C airmass 3.7 km below the
  // crossing — it cannot move the crossing, and refusing for it printed "--"
  // for the flagship number nearly every clear night.
  // 7°C at 3100 m over -6°C at 5800 m crosses 0°C at 4554 m = 14,940 ft.
  await expect(freezeValue(page)).toHaveText("14,900 FT", { timeout: 15_000 });
  const strip = page.locator(STRIP);
  await expect(strip).not.toContainText("FREEZING LEVEL UNCERTAIN");
  // the 2700 m bracket still earns its existing gap caveat
  await expect(strip).toContainText("INTERPOLATED ACROSS A 700 hPa–500 hPa GAP");
  expect(errors).toEqual([]);
});

test("a near-isothermal crossing states how far half a degree moves it", async ({ page }) => {
  const { errors } = await setup(page, { profile: "isothermal" });
  await openCast(page);

  // 0.3°C at 1450 m over -0.4°C at 3000 m: the gap is inside PROFILE_GAP_WARN_M
  // so the old thickness-only gate said nothing, but 0.5°C of model error moves
  // this height 1107 m — the number is far softer than "6,900 FT" looks.
  await expect(freezeValue(page)).toHaveText("6,900 FT", { timeout: 15_000 });
  const strip = page.locator(STRIP);
  await expect(strip).toContainText("±3,600 FT");
  await expect(strip).toContainText("NEARLY ISOTHERMAL THROUGH 0°C");
  expect(errors).toEqual([]);
});

test("with no elevation reported, nothing is called the surface", async ({ page }) => {
  const { errors } = await setup(page, { profile: "noelev" });
  await openCast(page);

  const strip = page.locator(STRIP);
  await expect(strip).toContainText("PRECIPITATION TYPE", { timeout: 15_000 });
  // the lowest point is now the 1000 hPa level at 110 m. A freezing-rain column
  // (-2°C there, +2°C at 925 hPa) must not read as RAIN because that level got
  // relabelled "the surface", and the freezing level must not read AT THE
  // SURFACE either.
  await expect(strip).toContainText("PRECIPITATION TYPE — NO SURFACE LEVEL IN THIS PROFILE, CANNOT ASSESS");
  await expect(strip).not.toContainText("RAIN —");
  await expect(strip).not.toContainText("WARM NOSE");
  await expect(freezeValue(page)).toHaveText("--");
  await expect(strip).toContainText("GROUND LEVEL IS NOT IN THIS PROFILE");
  await expect(strip).toContainText("GROUND LEVEL EXCLUDED FROM THE PROFILE");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// precipitation-type reasoning

test("a warm nose states its bounds and refuses to pick sleet or freezing rain", async ({ page }) => {
  const { errors } = await setup(page, { profile: "warmnose" });
  await openCast(page);

  const strip = page.locator(STRIP);
  await expect(strip).toContainText("WARM NOSE ALOFT", { timeout: 15_000 });
  const text = await strip.textContent();

  // The bounds and the peak temperature are stated, not summarised away — and
  // the bounds are the INTERPOLATED 0°C crossings, not the sampled level
  // heights. -3°C at 287 m under +2°C at 800 m crosses 0°C at 595 m = 2,000 ft
  // (so the cold layer is 1,000 ft deep, not the 1,700 ft to the 925 hPa level
  // that is already above freezing), and +1°C at 1500 m over -6°C at 3100 m
  // crosses back at 1729 m = 5,700 ft. Printing the level heights here
  // overstated the sub-freezing layer by 80% and shrank the warm nose to a
  // third, which pushes a freezing-rain profile toward reading as sleet.
  expect(text).toContain("WARM NOSE ALOFT (2,000 FT–5,700 FT, PEAK 2°C)");
  expect(text).toContain("1,000-FT SUB-FREEZING SURFACE LAYER");
  expect(text).toContain("CONSISTENT WITH SLEET OR FREEZING RAIN");
  expect(text).toContain("CANNOT RELIABLY TELL WHICH");

  // NEVER a bare verdict: every mention of either type sits inside the sentence
  // that says the data cannot resolve it.
  const lines = await page.locator(STRIP + " .profline").allTextContents();
  for (const line of lines) {
    if (/SLEET|FREEZING RAIN/.test(line)) {
      expect(line).toContain("CANNOT RELIABLY TELL WHICH");
    }
  }
  expect(errors).toEqual([]);
});

test("a column that stays below freezing reads as snow, with its top stated", async ({ page }) => {
  const { errors } = await setup(page, { profile: "snow" });
  await openCast(page);
  await expect(page.locator(STRIP)).toContainText(
    "SNOW, IF PRECIPITATION FALLS — THE COLUMN STAYS BELOW FREEZING FROM THE SURFACE TO 30,500 FT.",
    { timeout: 15_000 });
  // and it says what it is NOT claiming
  await expect(page.locator(STRIP)).toContainText("NOT WHETHER PRECIPITATION IS ACTUALLY FALLING");
  expect(errors).toEqual([]);
});

test("an all-cold column within a degree of freezing says a thin nose could hide", async ({ page }) => {
  const { errors } = await setup(page, { profile: "nearsnow" });
  await openCast(page);

  const strip = page.locator(STRIP);
  await expect(strip).toContainText("SNOW, IF PRECIPITATION FALLS", { timeout: 15_000 });
  // six levels cannot see a warm layer thinner than the 925-850 spacing, and
  // -0.2°C at 925 hPa is close enough to freezing that one could be there
  await expect(strip).toContainText("THE WARMEST (-0.2°C AT 925 hPa)");
  await expect(strip).toContainText("A THIN WARM LAYER BETWEEN SAMPLED LEVELS CANNOT BE RULED OUT");
  await expect(strip).toContainText("FREEZING RAIN OR SLEET IS STILL POSSIBLE");
  expect(errors).toEqual([]);
});

test("a warm column reads as rain", async ({ page }) => {
  const { errors } = await setup(page, { profile: "base" });
  await openCast(page);
  await expect(page.locator(STRIP)).toContainText("RAIN — THE SURFACE LAYER IS ABOVE FREEZING",
    { timeout: 15_000 });
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// cloud layers

test("cloud bases and tops come from the humidity the model really reports", async ({ page }) => {
  const { errors } = await setup(page, { profile: "base" });
  await openCast(page);

  const strip = page.locator(STRIP);
  await expect(strip).toContainText("CLOUD LAYERS", { timeout: 15_000 });
  // 85% at 1500 m and 88% at 3100 m are the saturated pair
  await expect(strip).toContainText("CLOUDS 4,900 FT–10,200 FT");
  await expect(strip).toContainText("CLEAR ABOVE 10,200 FT");
  // the T/Td spread corroborates the reading rather than driving it
  await expect(strip).toContainText("T/Td SPREAD");
  await expect(strip).toContainText("A THIN LAYER BETWEEN SAMPLED LEVELS CAN BE MISSED ENTIRELY");
  expect(errors).toEqual([]);
});

test("2 m humidity is never read as a cloud base at ground level", async ({ page }) => {
  const { errors } = await setup(page, { profile: "nocturnal" });
  await openCast(page);

  const strip = page.locator(STRIP);
  await expect(strip).toContainText("CLOUD LAYERS", { timeout: 15_000 });
  // 93% at 2 m on a clear night is an ordinary humid night, not a cloud deck
  // starting at the ground, and every pressure level here is under 60% RH
  await expect(strip).toContainText("CLEAR THROUGH 30,500 FT (TOP OF THIS PROFILE)");
  await expect(strip).not.toContainText("CLOUD LAYER NEAR");
  await expect(strip).not.toContainText("CLOUDS ");
  // and the disclosure counts the pressure levels it actually used
  await expect(strip).toContainText("BASED ON A 5-LEVEL PROFILE");
  expect(errors).toEqual([]);
});

test("missing humidity says so instead of rendering a blank box", async ({ page }) => {
  const { errors } = await setup(page, { profile: "norh" });
  await openCast(page);

  const strip = page.locator(STRIP);
  await expect(strip).toContainText(
    "CLOUD LAYERS — RELATIVE HUMIDITY NOT REPORTED FOR THIS LOCATION'S PRESSURE LEVELS",
    { timeout: 15_000 });
  // the rest of the section still works — one dead field is not a dead section
  await expect(freezeValue(page)).toHaveText("9,300 FT");
  await expect(strip).not.toContainText("CLOUDS ");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// AIR board: inversion / mixing

test("AIR explains the mixing depth in one of the fixed sentences", async ({ page }) => {
  const { errors } = await setup(page, { profile: "base" });
  await openAir(page);

  const strip = page.locator(AIRSTRIP);
  await expect(strip.locator(".sect")).toHaveText("INVERSION / MIXING", { timeout: 15_000 });
  // 1200 m boundary layer, no surface inversion
  await expect(strip).toContainText("MODERATE MIXING DEPTH (~3,900 FT)");
  await expect(strip).toContainText("MECHANISM BEHIND THE SMOKE AND HAZE READING");
  expect(errors).toEqual([]);
});

test("a shallow layer under an inversion says the smoke is trapped", async ({ page }) => {
  const { errors } = await setup(page, { profile: "inversion" });
  await openAir(page);

  const strip = page.locator(AIRSTRIP);
  await expect(strip).toContainText("SHALLOW MIXING LAYER (~1,000 FT) WITH A SURFACE-BASED TEMPERATURE INVERSION",
    { timeout: 15_000 });
  await expect(strip).toContainText("TRAPPED CLOSE TO THE GROUND");
  await expect(strip).toContainText("TEMPERATURE RISES WITH HEIGHT BETWEEN SURFACE AND 925 hPa");
  expect(errors).toEqual([]);
});

test("no boundary layer height says unavailable rather than guessing one", async ({ page }) => {
  const { errors } = await setup(page, { profile: "nopbl" });
  await openAir(page);

  const strip = page.locator(AIRSTRIP);
  await expect(strip).toContainText("MIXING DEPTH UNAVAILABLE FOR THIS LOCATION/MODEL", { timeout: 15_000 });
  await expect(strip).not.toContainText("~0 FT");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// degrade + scope

test("a dead pressure-level feed fails inside its own section only", async ({ page }) => {
  await routeAll(page);
  await page.route("**://api.open-meteo.com/**", (route) => {
    const u = new URL(route.request().url());
    if (u.search.includes("hPa")) {
      return route.fulfill({ status: 500, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" }, body: "{}" });
    }
    return route.fallback();
  });
  const { errors } = await boot(page);
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  await openCast(page);

  await expect(page.locator(STRIP)).toContainText("PROFILE UNAVAILABLE — HTTP 500", { timeout: 15_000 });
  // the meteogram and the 7-day strip are untouched by it
  await expect(page.locator(CAST + " .castday").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the profile section is prose, not a chart", async ({ page }) => {
  const { errors } = await setup(page, { profile: "base" });
  await openCast(page);
  await expect(page.locator(STRIP + " .sect")).toHaveText("PROFILE", { timeout: 15_000 });
  // the brief rejected a height-axis sounding plot: nothing here may build one
  expect(await page.locator(STRIP + " .chart").count()).toBe(0);
  expect(await page.locator(STRIP + " svg").count()).toBe(0);
  await openAir(page);
  await expect(page.locator(AIRSTRIP + " .sect")).toBeVisible({ timeout: 15_000 });
  expect(await page.locator(AIRSTRIP + " .chart").count()).toBe(0);
  expect(errors).toEqual([]);
});
