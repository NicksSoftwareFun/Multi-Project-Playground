// Smoke test: loads the prototype and the wallpaper build headlessly,
// simulates a few minutes (including a rain downpour) and fails on page
// errors, non-finite creature positions or an empty ecosystem.
//
//   cd rain-world-desktop/tests && npm install && npm test
//   (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error('FAIL ' + msg);
};

async function simulate(page, label, minutes) {
  const r = await page.evaluate((mins) => {
    const e = window.RW_APP.engine;
    e.cfg.rain.cycleMinutes = Math.max(1, mins - 0.5);
    let maxN = 0;
    let bad = 0;
    for (let i = 0; i < mins * 3600; i++) {
      e.tick(1 / 60);
      if (i % 600 === 0) {
        maxN = Math.max(maxN, e.eco.creatures.length);
        for (const c of e.eco.creatures) if (!isFinite(c.x) || !isFinite(c.y)) bad++;
      }
    }
    e.render();
    return { maxN, bad, stats: e.eco.stats, species: [...new Set(e.eco.creatures.map((c) => c.species))] };
  }, minutes);
  console.log(`${label}: peak ${r.maxN} creatures, born ${r.stats.born}, eaten ${r.stats.eaten}, sheltered/left ${r.stats.left}`);
  if (r.bad) fail(`${label}: ${r.bad} non-finite creature positions`);
  if (r.maxN < 5) fail(`${label}: ecosystem never populated`);
}

const browser = await chromium.launch(launchOpts);
try {
  // 1. Browser prototype with the mock desktop
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?paused=1&seed=7');
    await page.waitForFunction(() => window.RW_APP);
    await simulate(page, 'prototype', 4);
    // drag a window and make sure the world follows
    const before = await page.evaluate(() => window.RW_APP.engine.world.version);
    const bar = page.locator('.win-bar').first();
    const box = await bar.boundingBox();
    await page.mouse.move(box.x + 80, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 120, { steps: 5 });
    await page.mouse.up();
    await page.evaluate(() => window.RW_APP.step(5));
    const after = await page.evaluate(() => window.RW_APP.engine.world.version);
    if (after === before) fail('prototype: dragging a window did not update the world');
    if (errors.length) fail('prototype page errors:\n  ' + errors.join('\n  '));
    await page.close();
  }

  // 2. Wallpaper build against the fake helper
  {
    const port = 47399;
    const helper = spawn(process.execPath, [path.join(here, 'fake-helper.mjs'), String(port)], { stdio: 'pipe' });
    await new Promise((res) => helper.stdout.once('data', res));
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // Wallpaper builds look for the helper on the page's own origin.
      await page.goto(`http://localhost:${port}/`);
      await page.waitForFunction(() => window.RW_APP && window.RW_APP.provider.connected, null, { timeout: 10000 });
      const solids = await page.evaluate(() => window.RW_APP.engine.world.dynamicSolids.length);
      if (solids < 3) fail(`wallpaper: expected helper geometry, got ${solids} rects`);
      await page.evaluate(() => window.RW_APP.engine.stop());
      await simulate(page, 'wallpaper', 2);
      if (errors.length) fail('wallpaper page errors:\n  ' + errors.join('\n  '));
    } finally {
      helper.kill();
    }
  }
} finally {
  await browser.close();
}

if (failed) process.exit(1);
console.log('smoke OK');
