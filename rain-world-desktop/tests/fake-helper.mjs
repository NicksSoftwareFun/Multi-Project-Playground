// A stand-in for windows/rw-helper.ps1 that runs anywhere Node does. It
// serves the wallpaper and the same /api/geometry + /api/config endpoints,
// reporting a few fake windows on a 2880x1620 "physical" screen (150% DPI
// scaling) that slowly drift, so the wallpaper build can be developed and
// tested without Windows.
//
//   node tests/fake-helper.mjs [port]
//   then open http://localhost:47315/  (or ?panel=1)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = +(process.argv[2] || process.env.PORT || 47315);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let config = '{}';
const t0 = Date.now();
const screen = { id: 'screen', x: 0, y: 0, w: 2880, h: 1620 };
let fullscreen = false;
let cursor = { x: 1500, y: 800 };

function geometry() {
  const t = (Date.now() - t0) / 1000;
  const windows = fullscreen
    ? [{ id: 'wfull', x: 0, y: 0, w: 2880, h: 1560 }]
    : [
        { id: 'w1', x: Math.round(500 + Math.sin(t / 6) * 200), y: 260, w: 1000, h: 640 },
        { id: 'w2', x: 1800, y: Math.round(420 + Math.sin(t / 4) * 120), w: 700, h: 460 },
      ];
  const icons = [0, 1, 2, 3].map((i) => ({ id: 'i' + i, x: 12, y: 12 + i * 150, w: 112, h: 130 }));
  const taskbars = [{ id: 't0', x: 0, y: 1548, w: 2880, h: 72 }];
  return { screen, cursor, windows, icons, taskbars };
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin === 'null') res.setHeader('Access-Control-Allow-Origin', 'null');
    if (url.pathname === '/api/geometry') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(geometry()));
    }
    if (url.pathname === '/api/config') {
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://localhost:${port}`) || !String(req.headers['content-type']).startsWith('application/json')) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            JSON.parse(body);
            config = body;
            res.end('{"ok":true}');
          } catch (e) {
            res.statusCode = 400;
            res.end('bad config');
          }
        });
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      return res.end(config);
    }
    // test controls
    if (url.pathname === '/test/fullscreen') {
      fullscreen = url.searchParams.get('on') === '1';
      return res.end('ok');
    }
    if (url.pathname === '/test/cursor') {
      cursor = { x: +url.searchParams.get('x'), y: +url.searchParams.get('y') };
      return res.end('ok');
    }
    let rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'wallpaper.html';
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep) || rel.startsWith('windows') || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('Content-Type', types[path.extname(full)] || 'application/octet-stream');
    fs.createReadStream(full).pipe(res);
  })
  .listen(port, 'localhost', () => console.log(`fake helper on http://localhost:${port}/`));
