import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://127.0.0.1:8765/?debug#L2', { waitUntil: 'load' });
await page.waitForSelector('#loader.done', { timeout: 120000 });
await page.waitForTimeout(3000);
await page.evaluate(() => { const m = window.__mih; m.applyState('room', 2, m.BYTAG.get('T2501')); m.S.selT0 = 1e15; });
await page.waitForTimeout(3500);                     // camera settled, flash held off
for (const [i, t] of [0.15, 0.3, 0.5, 0.75, 0.95, 1.6].entries()) {
  await page.evaluate((t) => { window.__mih.S.selT0 = performance.now() - t * 1000; window.__mih.S.freezeSel = true; }, t);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `build/test/shots/f${i}.png`, clip: { x: 200, y: 180, width: 560, height: 440 } });
}
console.log('errors:', errs.length ? errs.join('\n') : 'none');
await browser.close();
