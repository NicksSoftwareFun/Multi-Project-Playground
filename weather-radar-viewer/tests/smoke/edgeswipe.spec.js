// Edge swipe: CAST is mostly charts, and charts own horizontal drags for cursor
// scrubbing, so the deck reserves a narrow zone at each screen edge for its own
// swipe. Both behaviours must survive together — that is the whole point.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

function viewState(page) {
  return page.evaluate(() => document.getElementById("screen").getAttribute("data-view"));
}
const activeDot = (page) => page.locator("#boardDots .dot.on");

async function openCast(page) {
  await page.locator("#wxPanel").click();
  await expect.poll(() => viewState(page)).toBe("board");
  await page.locator("#boardDots .dot", { hasText: "FCAST" }).click();
  await expect(page.locator("#board-cast .chart .plot svg").first()).toBeAttached({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
});

test("an edge drag over a chart switches boards and leaves the cursor alone", async ({ page }) => {
  await openCast(page);
  expect(await activeDot(page).textContent()).toBe("FCAST");

  const chart = page.locator("#board-cast .chart").first();
  const box = await chart.boundingBox();
  const y = box.y + box.height / 2;                 // vertically inside a chart

  // start at the very left edge, drag right — inside the chart's band the whole way
  await page.mouse.move(4, y);
  await page.mouse.down();
  await page.mouse.move(160, y, { steps: 8 });
  await page.mouse.up();

  await expect(activeDot(page)).not.toHaveText("FCAST");
  expect(await viewState(page)).toBe("board");      // switched boards, did not exit the deck

  // The chart declined the gesture, so its cursor is still parked at NOW rather
  // than dragged to the release point. Both values are read in ONE evaluate:
  // the idle cursor tracks NOW, which advances in real time, so a re-render
  // landing between two separate reads makes them disagree by a few units for
  // reasons that have nothing to do with this feature.
  const gap = await page.locator("#board-cast .chart").first().evaluate((c) => {
    const cur = c.querySelector(".cursorline"), now = c.querySelector(".nowline");
    return Math.abs(Number(cur.getAttribute("x1")) - Number(now.getAttribute("x1")));
  });
  expect(gap).toBeLessThan(5);
});

test("a mid-screen drag over a chart still scrubs and does not switch boards", async ({ page }) => {
  await openCast(page);
  const chart = page.locator("#board-cast .chart").first();
  const box = await chart.boundingBox();
  const y = box.y + box.height / 2;
  const nowX = Number(await chart.locator(".nowline").getAttribute("x1"));

  await page.mouse.move(box.x + box.width * 0.35, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 });
  const dragged = Number(await chart.locator(".cursorline").getAttribute("x1"));
  await page.mouse.up();

  expect(Math.abs(dragged - nowX)).toBeGreaterThan(5);   // it scrubbed
  expect(await activeDot(page).textContent()).toBe("FCAST");  // and stayed put
});
