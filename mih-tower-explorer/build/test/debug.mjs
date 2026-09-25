import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => console.log('console.' + m.type() + ':', m.text().slice(0, 500)));
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('requestfailed', (r) => console.log('reqfailed:', r.url(), r.failure()?.errorText));
await page.goto('http://127.0.0.1:8765/?debug', { waitUntil: 'load' });
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const m = window.__mih;
  const cs = (id) => { const el = document.getElementById(id); if (!el) return null; const s = getComputedStyle(el); return { disp: s.display, vis: s.visibility, op: s.opacity, hidden: el.hidden, cls: el.className }; };
  return {
    hasHook: !!m, ready: m && m.S.ready, view: m && m.S.view, cam: m && m.S.cam, intro: m && m.S.intro,
    canvas: [document.getElementById('gl').width, document.getElementById('gl').height],
    loader: cs('loader'), fatal: cs('fatal'), app: cs('app'), title: document.getElementById('title').innerHTML.slice(0, 80),
    text: document.body.innerText.slice(0, 300),
    webgl2: !!document.createElement('canvas').getContext('webgl2'),
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'build/test/shots/debug.png' });
await browser.close();
