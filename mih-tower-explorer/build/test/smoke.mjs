// Headless smoke test: stack -> floor -> room -> search -> back, desktop + phone.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || 'playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8765/';
const OUT = process.env.OUT || 'build/test/shots';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function run(name, viewport, fn) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${name}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  await page.goto(BASE + '?debug', { waitUntil: 'load' });
  await page.waitForSelector('#loader.done', { timeout: 120000 });
  await fn(page);
  await ctx.close();
}
const settle = (page, ms = 2200) => page.waitForTimeout(ms);
const shot = (page, f) => page.screenshot({ path: `${OUT}/${f}.png` });
const roomXY = (page, tag) => page.evaluate((tag) => { const r = window.__mih.BYTAG.get(tag); const q = window.__mih.project(r.anchor[0], r.anchor[1], 0); return [q[0], q[1]]; }, tag);

await run('desktop', { width: 1440, height: 900 }, async (page) => {
  await settle(page, 3000);
  await shot(page, 'd1_stack');
  await page.click('.stack-label:nth-child(3)', { force: true });          // LEVEL 02 (labels are PH, 03, 02, 01)
  await settle(page, 2600);
  await shot(page, 'd2_floor2');
  const [x, y] = await roomXY(page, 'T2501');
  await page.mouse.move(x, y); await page.waitForTimeout(400);
  await shot(page, 'd3_hover');
  await page.mouse.click(x, y);
  await settle(page, 2400);
  await shot(page, 'd4_room');
  const panel = await page.$eval('#panel', (el) => el.hidden ? 'HIDDEN' : el.innerText.slice(0, 400));
  console.log('PANEL:', panel.replace(/\n+/g, ' | '));
  await page.fill('#q', 'icu 8');
  await page.waitForTimeout(300);
  const res = await page.$eval('#results', (el) => el.innerText.replace(/\n+/g, ' | ').slice(0, 200));
  console.log('SEARCH:', res);
  await page.keyboard.press('Enter');
  await settle(page, 2800);
  await shot(page, 'd5_search_icu8');
  const view = await page.evaluate(() => [window.__mih.S.view, window.__mih.S.level, window.__mih.S.room && window.__mih.S.room.tag]);
  console.log('AFTER SEARCH:', view.join(' '));
  await page.click('#levels button[data-level="4"]');
  await settle(page, 2800);
  await shot(page, 'd6_penthouse');
  await page.keyboard.press('Escape');
  await settle(page, 2600);
  await shot(page, 'd7_back_stack');
  console.log('FINAL VIEW:', await page.evaluate(() => window.__mih.S.view));
});

await run('phone', { width: 390, height: 844 }, async (page) => {
  await settle(page, 3000);
  await shot(page, 'm1_stack');
  await page.click('.stack-label:nth-child(2)', { force: true });          // LEVEL 03
  await settle(page, 2600);
  await shot(page, 'm2_floor3');
  const [x, y] = await roomXY(page, 'T3118');
  await page.mouse.click(x, y);
  await settle(page, 2600);
  await shot(page, 'm3_room');
});
await browser.close();
console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
