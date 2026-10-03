// Shared bits for the headless tests: launching Chromium and opening the
// prototype page with the simulation paused, so a test drives it tick by tick.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..');

// CHROMIUM_PATH=/path/to/chrome uses a preinstalled browser (in a Claude Code
// cloud session: /opt/pw-browsers/chromium-1194/chrome-linux/chrome).
export function launch() {
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
}

// A fresh page (fresh browser context, so no saved settings) on index.html,
// paused: nothing moves until the test calls engine.tick / RW_APP.step.
// `seed` fixes the generated map; creature behaviour is still random.
export async function openPrototype(browser, opts = {}) {
  const { seed, width = 1920, height = 1080 } = opts;
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?paused=1' + (seed ? '&seed=' + seed : ''));
  await page.waitForFunction(() => window.RW_APP);
  return { page, errors };
}
