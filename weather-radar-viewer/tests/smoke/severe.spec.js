// Severe weather smoke (M2): the topbar alert chip, the SEVERE board, and the
// SPC risk strip that spc.js fills inside it.
//
// Feeds come from tests/fixtures/alerts-active.json (a Tornado Warning with a
// polygon, a Severe Thunderstorm Watch with geometry:null, and a Heat
// Advisory) plus the SPC MapServer fixtures — see smoke/_setup.js. Every alert
// in the fixture expires in 2099, so cards are always live and the chip is
// never suppressed as stale.
"use strict";
const { test, expect } = require("@playwright/test");
const { routeAll, boot, ALERTS_EMPTY } = require("./_setup");

const CHIP = "#alertChip";
const BOARD = "#board-severe";

function viewState(page) {
  return page.getAttribute("#screen", "data-view");
}

// Open the SEVERE board through the deck — the path that still works when
// there are no alerts and therefore no chip to click.
async function openSevereViaDeck(page) {
  await page.locator("#wxPanel").click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await page.locator("#boardDots .dot", { hasText: "SEVERE" }).click();
  await expect(page.locator(BOARD)).toHaveClass(/\bactive\b/);
}

test("alert chip shows the highest severity and opens the SEVERE board", async ({ page }) => {
  await routeAll(page);
  const { errors } = await boot(page);

  const chip = page.locator(CHIP);
  await expect(chip).toBeVisible({ timeout: 15_000 });
  // Tornado Warning outranks the watch and the advisory
  await expect(chip).toHaveText(/TOR\s+WARNING/);
  await expect(chip).toHaveClass(/\bwarning\b/);
  expect((await chip.getAttribute("class")).split(/\s+/)).toEqual(
    expect.arrayContaining(["badge", "alertchip", "warning"])
  );
  // and never carries a lesser severity class at the same time
  await expect(chip).not.toHaveClass(/\b(watch|advisory|statement)\b/);

  await chip.click();
  await expect(page.locator("#screen")).toHaveAttribute("data-view", "board");
  await expect(page.locator("#screen")).toHaveAttribute("data-board", "severe");
  await expect(page.locator(BOARD)).toHaveClass(/\bactive\b/);
  await expect(page.locator(BOARD)).toBeVisible();

  expect(errors).toEqual([]);
});

test("SEVERE board lists every alert, warning first, with an AS OF time", async ({ page }) => {
  await routeAll(page);
  const { errors } = await boot(page);

  await page.locator(CHIP).click();
  const cards = page.locator(BOARD + " .alertcard");
  await expect(cards).toHaveCount(3, { timeout: 15_000 });

  // sorted by severity class: warning -> watch -> advisory
  await expect(cards.nth(0).locator(".ev")).toHaveText(/TORNADO/i);
  await expect(cards.nth(0)).toHaveClass(/\bwarning\b/);
  await expect(cards.nth(1)).toHaveClass(/\bwatch\b/);
  await expect(cards.nth(2)).toHaveClass(/\badvisory\b/);

  // every card carries the contract's parts
  await expect(cards.nth(0).locator(".meta")).not.toBeEmpty();
  await expect(cards.nth(0).locator(".area")).toContainText("Polk");

  await expect(page.locator(BOARD + " .hdr")).toContainText("SEVERE WEATHER");
  await expect(page.locator(BOARD + " .asof")).toHaveText(/AS OF \d{2}:\d{2}/);
  // the board's own source note (the strip has its own .srcnote while loading)
  await expect(page.locator(BOARD + " > .srcnote")).toContainText("NWS");

  expect(errors).toEqual([]);
});

test("tapping an alert card toggles its body open and closed", async ({ page }) => {
  await routeAll(page);
  const { errors } = await boot(page);

  await page.locator(CHIP).click();
  const card = page.locator(BOARD + " .alertcard").first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  const body = card.locator(".body");
  await expect(card).not.toHaveClass(/\bopen\b/);
  await expect(body).toBeHidden();

  await card.click();
  await expect(card).toHaveClass(/\bopen\b/);
  await expect(body).toBeVisible();
  // the body carries description (falling back to instruction), per the contract
  await expect(body).toContainText("capable of producing a tornado");

  await card.click();
  await expect(card).not.toHaveClass(/\bopen\b/);
  await expect(body).toBeHidden();

  expect(errors).toEqual([]);
});

test("SPC strip renders inside #spcStrip with the day rows for this location", async ({ page }) => {
  await routeAll(page);
  const { errors } = await boot(page);

  await page.locator(CHIP).click();
  const strip = page.locator(BOARD + " #spcStrip");
  await expect(strip).toBeAttached({ timeout: 15_000 });

  // the outlook fixture puts 41.73,-93.6 inside a SLGT polygon
  const days = strip.locator(".spcday");
  await expect(days.first()).toBeVisible({ timeout: 15_000 });
  expect(await days.count()).toBeGreaterThanOrEqual(1);
  await expect(strip).toContainText("SLGT");
  // Day 1 is labelled with today's actual date, not "DAY 1"
  const today = await page.evaluate(() => {
    const d = new Date();
    const dow = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getDay()];
    const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                 "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getMonth()];
    return dow + " " + mon + " " + d.getDate();
  });
  await expect(days.first().locator(".d")).toHaveText(today);

  expect(errors).toEqual([]);
});

test("with no active alerts the chip stays hidden and the board says so", async ({ page }) => {
  await routeAll(page, { alerts: ALERTS_EMPTY });
  const { errors } = await boot(page);

  await expect(page.locator("#wxTemp")).toHaveText("73°F", { timeout: 15_000 });
  await expect(page.locator(CHIP)).toBeHidden();

  await openSevereViaDeck(page);
  await expect(page.locator(BOARD + " .bigmsg")).toHaveText("NO ACTIVE ALERTS", { timeout: 15_000 });
  await expect(page.locator(BOARD + " .alertcard")).toHaveCount(0);
  // an empty feed is still a successful fetch, so the header is timestamped
  await expect(page.locator(BOARD + " .asof")).toHaveText(/AS OF \d{2}:\d{2}/);
  await expect(page.locator(CHIP)).toBeHidden();

  expect(errors).toEqual([]);
  expect(await viewState(page)).toBe("board");
});
