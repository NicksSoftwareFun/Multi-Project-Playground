// Board deck smoke (M2): the ▤ button, the dot row, keyboard paging, and the
// Back/Escape exit. Every module that owns a board registers it before
// boards.init(), so the deck must reflect the registry — not a fixed list.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot } = require("./_setup");

function viewState(page) {
  return page.getAttribute("#screen", "data-view");
}
function boardState(page) {
  return page.getAttribute("#screen", "data-board");
}
// id of the single visible board page
function activeBoardId(page) {
  return page.evaluate(() => {
    const b = document.querySelector("#boards .board.active");
    return b ? b.getAttribute("data-board") || b.id : null;
  });
}

test.beforeEach(async ({ page }) => {
  await routeAll(page);
  await boot(page);
  await expect(page.locator("#screen")).toBeVisible();
  // wait for the async board registrations (wx, alerts) to have landed
  await expect(page.locator("#boardDots .dot").nth(1)).toBeAttached({ timeout: 15_000 });
});

test("the conditions panel opens the deck with one dot per registered board", async ({ page }) => {
  expect(await viewState(page)).toBe("radar");

  await page.locator("#wxPanel").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await expect(page.locator("#boards")).toBeVisible();

  const dots = page.locator("#boardDots .dot");
  const nDots = await dots.count();
  expect(nDots).toBeGreaterThanOrEqual(2);          // at least NOW + SEVERE

  // the dot row matches the boards actually in the deck, one for one
  const nBoards = await page.locator("#boards .board").count();
  expect(nDots).toBe(nBoards);

  // exactly one board is visible and its dot is marked
  await expect(page.locator("#boards .board.active")).toHaveCount(1);
  await expect(page.locator("#boardDots .dot.on")).toHaveCount(1);
  await expect(dots.filter({ hasText: "SEVERE" })).toHaveCount(1);
});

test("clicking a dot switches boards", async ({ page }) => {
  await page.locator("#wxPanel").click();
  const first = await activeBoardId(page);
  expect(first).toBeTruthy();

  const severeDot = page.locator("#boardDots .dot", { hasText: "SEVERE" });
  await severeDot.click();
  await expect(page.locator("#screen")).toHaveAttribute("data-board", "severe");
  await expect(page.locator("#board-severe")).toHaveClass(/\bactive\b/);
  expect(await activeBoardId(page)).toBe("severe");
  expect(await activeBoardId(page)).not.toBe(first);
  await expect(severeDot).toHaveClass(/\bon\b/);
  await expect(page.locator("#boards .board.active")).toHaveCount(1);

  // and back to the first board via its own dot
  const firstDot = page.locator("#boardDots .dot").first();
  await firstDot.click();
  expect(await activeBoardId(page)).toBe(first);
  await expect(page.locator("#screen")).toHaveAttribute("data-board", first);
});

test("ArrowRight / ArrowLeft step between boards", async ({ page }) => {
  await page.locator("#wxPanel").click();
  const n = await page.locator("#boardDots .dot").count();
  const start = await activeBoardId(page);

  await page.keyboard.press("ArrowRight");
  const next = await activeBoardId(page);
  expect(next).not.toBe(start);
  await expect(page.locator("#screen")).toHaveAttribute("data-board", next);

  await page.keyboard.press("ArrowLeft");
  expect(await activeBoardId(page)).toBe(start);

  // stepping right all the way round wraps back to where it started
  for (let i = 0; i < n; i++) await page.keyboard.press("ArrowRight");
  expect(await activeBoardId(page)).toBe(start);
  expect(await viewState(page)).toBe("board");
});

test("Escape leaves the deck and returns to the radar view", async ({ page }) => {
  await page.locator("#wxPanel").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");

  await page.keyboard.press("Escape");
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "radar");
  await expect(page.locator("#boards")).toBeHidden();
  expect(await boardState(page)).toBeNull();
});
