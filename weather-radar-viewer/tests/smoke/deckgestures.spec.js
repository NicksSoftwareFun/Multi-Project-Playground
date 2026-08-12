// Deck gesture regressions, both user-reported.
//
// 1. Tapping a dot at the bottom of a board sometimes dropped you back to the
//    radar. Cause: the swipe tracker kept `tracking` set with stale start
//    coordinates whenever a previous gesture ended off-element or started on a
//    control, so a tap near the bottom measured itself against a start point
//    far above and read as a long downward swipe.
// 2. Scrolling a long board downward is the same gesture as swipe-to-dismiss,
//    so reading the CAST board could throw you out of the deck.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

function viewState(page) {
  return page.evaluate(() => document.getElementById("screen").getAttribute("data-view"));
}

async function openDeck(page) {
  await page.locator("#wxPanel").click();
  await expect.poll(() => viewState(page)).toBe("board");
  await expect(page.locator("#boardDots .dot").first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
});

test("a drag that ends on a dot is a tap, not a downward swipe", async ({ page }) => {
  await openDeck(page);
  const dot = page.locator("#boardDots .dot").nth(2);
  const box = await dot.boundingBox();

  // press well above the dots, release on one — the exact shape that used to
  // register as dy > 80 and call goBack()
  await page.mouse.move(box.x + box.width / 2, box.y - 260);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();

  expect(await viewState(page)).toBe("board");
});

test("scrolling a long board downward does not dismiss the deck", async ({ page }) => {
  // a short viewport guarantees CAST overflows and can actually scroll
  await page.setViewportSize({ width: 390, height: 500 });
  await openDeck(page);
  await page.locator("#boardDots .dot", { hasText: "CAST" }).click();
  const board = page.locator("#board-cast");
  await expect(board).toBeVisible();
  await expect(board.locator(".castday").first()).toBeVisible({ timeout: 15_000 });

  const scrolled = await board.evaluate((b) => { b.scrollTop = 150; return b.scrollTop; });
  expect(scrolled).toBeGreaterThan(0);      // the premise of this test

  // Drag downward from a 7-day row — plain text, NOT a chart, so the chart
  // guard cannot be what saves us. This is exactly a scroll gesture.
  const row = await board.locator(".castday").first().boundingBox();
  await page.mouse.move(row.x + row.width / 2, row.y);
  await page.mouse.down();
  await page.mouse.move(row.x + row.width / 2, row.y + 200, { steps: 8 });
  await page.mouse.up();

  expect(await viewState(page)).toBe("board");
});
