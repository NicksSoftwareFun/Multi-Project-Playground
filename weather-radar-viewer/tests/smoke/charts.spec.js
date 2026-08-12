// Chart cursor smoke coverage (touch-drag crosshair bug fix in charts.js).
//
// Reported bug: on a real Android phone, dragging a finger across a
// temperature chart made the crosshair line snap back to the far left
// mid-drag. Root cause: the hit rect had no touch-action:none, so the
// browser (the board is an overflow-y:auto surface) claimed the gesture for
// page scrolling partway through the touch and fired pointerleave /
// pointercancel on the hit rect, running the old clear() — which parked the
// line off-screen at x=-10. The fix captures the pointer on pointerdown,
// blocks the browser's scroll-claim via CSS touch-action:none, and treats
// "no pointer interacting" as parked-at-now instead of hidden.
//
// Entry into the board deck: #wxPanel opens the deck (into the "now" board);
// the CAST board itself is reached via #boardDots, per the in-flight
// boards.js/index.html refactor — NOT via #boardsBtn (that button is being
// removed elsewhere, tracked separately from this chart fix).
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

const BOARD = "#board-cast";

async function setup(page) {
  await routeAll(page);
  const { errors } = await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
  return { errors };
}

async function openCast(page) {
  await page.locator("#wxPanel").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await page.locator("#boardDots .dot", { hasText: "FCAST" }).click();
  await expect(page.locator(BOARD)).toHaveClass(/\bactive\b/);
}

// The meteogram ("48-HOUR OUTLOOK") is the first .chart forecastx.js renders
// into #board-cast — same convention cast.spec.js relies on.
function meteogram(page) {
  return page.locator(BOARD + " .chart").first();
}

test("idle: cursorline parks at the nowline x on first render, readout non-empty", async ({ page }) => {
  await setup(page);
  await openCast(page);
  const chartEl = meteogram(page);
  await expect(chartEl.locator(".plot svg")).toBeAttached({ timeout: 15_000 });
  await expect(chartEl.locator(".nowline")).toBeAttached();

  // One evaluate, not two reads: a re-render between them moves the nowline
  // (NOW advances in real time) and the comparison fails for no good reason.
  const { cursorX, gap } = await chartEl.evaluate((c) => {
    const cur = Number(c.querySelector(".cursorline").getAttribute("x1"));
    const now = Number(c.querySelector(".nowline").getAttribute("x1"));
    return { cursorX: cur, gap: Math.abs(cur - now) };
  });
  expect(cursorX).not.toBe(-10);
  expect(gap).toBeLessThan(5);

  const readoutText = (await chartEl.locator(".readout").textContent()) || "";
  expect(readoutText.trim().length).toBeGreaterThan(0);
});

test("pointer drag moves the cursorline and updates the readout", async ({ page }) => {
  await setup(page);
  await openCast(page);
  const chartEl = meteogram(page);
  await expect(chartEl.locator(".plot svg")).toBeAttached({ timeout: 15_000 });

  const hit = chartEl.locator(".hitarea");
  await expect(hit).toBeVisible();          // attached != laid out; boundingBox() is null until it is
  const box = await hit.boundingBox();
  const nowX = Number(await chartEl.locator(".nowline").getAttribute("x1"));

  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 });

  const draggedX = Number(await chartEl.locator(".cursorline").getAttribute("x1"));
  expect(Math.abs(draggedX - nowX)).toBeGreaterThan(5); // moved meaningfully away from the idle position

  const readoutText = (await chartEl.locator(".readout").textContent()) || "";
  expect(readoutText.trim().length).toBeGreaterThan(0);

  await page.mouse.up();
});

test("after pointerup the cursorline returns to the nowline x", async ({ page }) => {
  await setup(page);
  await openCast(page);
  const chartEl = meteogram(page);
  await expect(chartEl.locator(".plot svg")).toBeAttached({ timeout: 15_000 });

  const hit = chartEl.locator(".hitarea");
  await expect(hit).toBeVisible();          // attached != laid out; boundingBox() is null until it is
  const box = await hit.boundingBox();
  const nowX = Number(await chartEl.locator(".nowline").getAttribute("x1"));

  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 });
  const draggedX = Number(await chartEl.locator(".cursorline").getAttribute("x1"));
  expect(Math.abs(draggedX - nowX)).toBeGreaterThan(5);

  await page.mouse.up();

  // Compare the cursor to the nowline as it stands NOW, in one evaluate: the
  // idle cursor tracks NOW, which advances in real time, so asserting against a
  // value captured before the drag fails for reasons unrelated to the feature.
  const gap = await chartEl.evaluate((c) => {
    const cur = c.querySelector(".cursorline"), now = c.querySelector(".nowline");
    return Math.abs(Number(cur.getAttribute("x1")) - Number(now.getAttribute("x1")));
  });
  expect(gap).toBeLessThan(5);
});

// This is the exact reported bug: a touch-drag that the browser claims for
// scrolling fires pointercancel mid-gesture. Before the fix that ran the old
// clear() and snapped the line to x=-10; after the fix it must park at NOW,
// same as the idle state.
test("pointercancel mid-drag returns to now, not x=-10 (reported bug)", async ({ page }) => {
  await setup(page);
  await openCast(page);
  const chartEl = meteogram(page);
  await expect(chartEl.locator(".plot svg")).toBeAttached({ timeout: 15_000 });

  await page.evaluate(() => {
    window.__lastPointerId = null;
    document.addEventListener("pointerdown", (e) => { window.__lastPointerId = e.pointerId; }, true);
  });

  const hit = chartEl.locator(".hitarea");
  await expect(hit).toBeVisible();          // attached != laid out; boundingBox() is null until it is
  const box = await hit.boundingBox();
  const nowX = Number(await chartEl.locator(".nowline").getAttribute("x1"));

  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 });

  const draggedX = Number(await chartEl.locator(".cursorline").getAttribute("x1"));
  expect(Math.abs(draggedX - nowX)).toBeGreaterThan(5); // sanity: really mid-drag

  const pid = await page.evaluate(() => window.__lastPointerId);
  await hit.evaluate((el, id) => {
    el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, bubbles: true, cancelable: true }));
  }, pid);

  const afterCancelX = Number(await chartEl.locator(".cursorline").getAttribute("x1"));
  expect(afterCancelX).not.toBe(-10);      // the bug parked it off the left edge
  const cancelGap = await chartEl.evaluate((c) => {
    const cur = c.querySelector(".cursorline"), now = c.querySelector(".nowline");
    return Math.abs(Number(cur.getAttribute("x1")) - Number(now.getAttribute("x1")));
  });
  expect(cancelGap).toBeLessThan(5);

  await page.mouse.up(); // release the real mouse button so it doesn't leak into later tests
});

// The regression that survived the first fix: touch-action was set on the SVG
// <rect> hit area, and touch-action has no effect on elements that generate no
// CSS layout box — inner SVG elements are exactly that. The browser ignored it,
// took the drag for scrolling once it passed the touch-slop threshold, and the
// line snapped back to NOW a few pixels in. It must live on the wrapper div and
// the <svg> root, both of which do generate boxes.
test("touch-action:none sits on elements that can actually honor it", async ({ page }) => {
  await setup(page);
  await openCast(page);
  const chartEl = meteogram(page);
  await expect(chartEl.locator(".plot svg")).toBeAttached({ timeout: 15_000 });

  const plot = await chartEl.locator(".plot").evaluate((el) => getComputedStyle(el).touchAction);
  const root = await chartEl.locator(".plot svg").evaluate((el) => getComputedStyle(el).touchAction);
  expect(plot).toBe("none");
  expect(root).toBe("none");
});
