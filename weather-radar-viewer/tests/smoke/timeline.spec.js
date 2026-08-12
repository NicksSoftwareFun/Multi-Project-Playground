// Timeline smoke: play/pause glyph, scrubbing, NOW alignment, prediction mode.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

function thumbPct(page) {
  return page.evaluate(() => {
    const tb = document.getElementById("trackbox").getBoundingClientRect();
    const th = document.getElementById("thumb").getBoundingClientRect();
    return ((th.left + th.width / 2) - tb.left) / tb.width * 100;
  });
}

// NOW position on the track, as a percentage. Post-refactor the app exposes
// it as the --now-pct custom property on #screen; pre-refactor we fall back
// to the center of the .nowmark tick (both resolve to ~23.3%).
function nowPct(page) {
  return page.evaluate(() => {
    const screen = document.getElementById("screen");
    const raw = getComputedStyle(screen).getPropertyValue("--now-pct").trim();
    if (raw) {
      const v = parseFloat(raw);
      if (!Number.isNaN(v)) return { pct: v, source: "--now-pct" };
    }
    const tb = document.getElementById("trackbox").getBoundingClientRect();
    const nm = document.querySelector(".nowmark").getBoundingClientRect();
    return {
      pct: ((nm.left + nm.width / 2) - tb.left) / tb.width * 100,
      source: "nowmark",
    };
  });
}

async function pointerDownAt(page, fraction) {
  await expect(page.locator("#trackbox")).toBeVisible();
  const box = await page.locator("#trackbox").boundingBox();
  await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

async function goToNow(page) {
  // Home key on the slider jumps to NOW and pauses playback — deterministic
  await page.locator("#trackbox").focus();
  await page.keyboard.press("Home");
}

test.beforeEach(async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
});

test("play button toggles its glyph", async ({ page }) => {
  const playBtn = page.locator("#playBtn");
  const initial = (await playBtn.textContent()).trim();
  expect(initial.length).toBeGreaterThan(0);
  await playBtn.click();
  const toggled = (await playBtn.textContent()).trim();
  expect(toggled).not.toBe(initial);
  await playBtn.click();
  expect((await playBtn.textContent()).trim()).toBe(initial);
});

test("scrubbing the left region moves the thumb left of NOW", async ({ page }) => {
  await goToNow(page);
  const now = await nowPct(page);
  await pointerDownAt(page, 0.05);
  const pct = await thumbPct(page);
  expect(pct).toBeLessThan(now.pct - 3);
});

test("thumb position at NOW matches the NOW marker / --now-pct", async ({ page }) => {
  await goToNow(page);
  const now = await nowPct(page);
  const pct = await thumbPct(page);
  expect(Math.abs(pct - now.pct)).toBeLessThan(1.5);
});

test("scrubbing right of NOW shows the PREDICTION frame", async ({ page }) => {
  await goToNow(page);
  await expect(page.locator("#predFrame")).toBeHidden();
  await pointerDownAt(page, 0.8);
  await expect(page.locator("#predFrame")).toBeVisible();
  const isPred = await page.evaluate(() => {
    const s = document.getElementById("screen");
    return s.classList.contains("pred") || s.getAttribute("data-view") === "pred";
  });
  expect(isPred).toBe(true);
  // scrub back into history — prediction chrome goes away
  await pointerDownAt(page, 0.1);
  await expect(page.locator("#predFrame")).toBeHidden();
});
