// Runs in Zillow's own JavaScript world so it can reach the Google Maps
// instance Zillow creates. For each map it adds three canvas layers (ACS race
// dot density, DC Metrorail, and the road-distance tool) plus an on-map
// panel. Data requests go out through the content script (postMessage) to
// the extension's background worker.
(function () {
  'use strict';
  if (window.__zroLoaded) return;
  window.__zroLoaded = true;

  const { RACES, LEVELS, REFERENCE_ZOOM, DEFAULT_SETTINGS, METRO } = window.ZRO_CONFIG;
  const MAX_DOTS = 350000; // per frame; people-per-dot is raised to stay under this
  const MAX_TILES = 48; // per view; beyond this the level is too fine to fetch
  const DOT_CACHE_LIMIT = 4000;
  const MIN_MAP_SIZE = 200; // px; ignore thumbnail maps
  const METERS_PER_MILE = 1609.344;

  let settings = { ...DEFAULT_SETTINGS };
  const controllers = new Map(); // google.maps.Map -> MapController

  // ---------------------------------------------------------------- bridge

  let reqSeq = 0;
  const pending = new Map();
  function toContent(msg) {
    window.postMessage({ source: 'zro-page', ...msg }, location.origin);
  }
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'zro-content') return;
    const msg = ev.data;
    if (msg.type === 'settings') {
      settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      controllers.forEach((c) => c && c.applySettings());
    } else if (msg.type === 'rpcResult') {
      const p = pending.get(msg.reqId);
      if (p) {
        pending.delete(msg.reqId);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    }
  });
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const reqId = ++reqSeq;
      pending.set(reqId, { resolve, reject });
      toContent({ type: 'rpc', reqId, method, params });
    });
  }
  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    controllers.forEach((c) => c && c.applySettings());
    toContent({ type: 'saveSettings', patch });
  }

  // ------------------------------------------------------------- geometry

  function worldX(lng) {
    return ((lng + 180) / 360) * 256;
  }
  function worldY(lat) {
    const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256;
  }
  function milesBetween(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return (2 * R * Math.asin(Math.sqrt(h))) / METERS_PER_MILE;
  }

  // Polygons arrive as GeoJSON-style [[ring of [lng,lat]], ...] lists; store
  // each ring as a flat Float64Array of world coordinates (zoom-0 pixels).
  const features = new Map(); // id -> feature
  function ingest(f) {
    if (features.has(f.id)) return features.get(f.id);
    const rings = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of f.polygons) {
      for (const ring of poly) {
        const a = new Float64Array(ring.length * 2);
        for (let i = 0; i < ring.length; i++) {
          const x = worldX(ring[i][0]);
          const y = worldY(ring[i][1]);
          a[i * 2] = x;
          a[i * 2 + 1] = y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        rings.push(a);
      }
    }
    const feat = { id: f.id, name: f.name, total: f.total, counts: f.counts, rings, minX, minY, maxX, maxY };
    features.set(f.id, feat);
    return feat;
  }

  // Even-odd test across all rings, which handles holes and multipolygons.
  function contains(feat, x, y) {
    let inside = false;
    for (const r of feat.rings) {
      const n = r.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const yi = r[i + 1], yj = r[j + 1];
        if (yi > y !== yj > y && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) inside = !inside;
      }
    }
    return inside;
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Random dots inside the polygon, one per `dotValue` people, colors
  // shuffled so no race is always drawn on top. Seeded, so the same view
  // always shows the same dots.
  const dotCache = new Map();
  function dotsFor(feat, dotValue) {
    const key = feat.id + '|' + dotValue;
    let d = dotCache.get(key);
    if (d) {
      dotCache.delete(key);
      dotCache.set(key, d);
      return d;
    }
    const rand = rng(hash(key));
    const colors = [];
    RACES.forEach((r, ri) => {
      const exact = feat.counts[r.field] / dotValue;
      let n = Math.floor(exact);
      if (rand() < exact - n) n++;
      for (let k = 0; k < n; k++) colors.push(ri);
    });
    for (let i = colors.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = colors[i];
      colors[i] = colors[j];
      colors[j] = t;
    }
    const xs = new Float32Array(colors.length);
    const ys = new Float32Array(colors.length);
    const cs = new Uint8Array(colors.length);
    const w = feat.maxX - feat.minX, h = feat.maxY - feat.minY;
    let placed = 0;
    let tries = colors.length * 40 + 100;
    while (placed < colors.length && tries-- > 0) {
      const x = feat.minX + rand() * w;
      const y = feat.minY + rand() * h;
      if (contains(feat, x, y)) {
        xs[placed] = x;
        ys[placed] = y;
        cs[placed] = colors[placed];
        placed++;
      }
    }
    d = { xs, ys, cs, n: placed };
    dotCache.set(key, d);
    while (dotCache.size > DOT_CACHE_LIMIT) dotCache.delete(dotCache.keys().next().value);
    return d;
  }

  // ------------------------------------------------------------ data tiles

  const tiles = new Map(); // key -> { state: 'loading'|'done'|'error', ids: [] }
  const dataListeners = new Set(); // called when tiles or Metro data arrive
  const notify = () => dataListeners.forEach((fn) => fn());

  function requestTile(level, z, x, y) {
    const key = `${level}/${z}/${x}/${y}`;
    let t = tiles.get(key);
    if (t && t.state !== 'error') return t;
    t = { state: 'loading', ids: [], error: null };
    tiles.set(key, t);
    rpc('tile', { level, tile: { z, x, y } }).then(
      (res) => {
        t.ids = res.features.map((f) => ingest(f).id);
        t.state = 'done';
        notify();
      },
      (err) => {
        t.state = 'error';
        t.error = err.message;
        t.retryAt = Date.now() + 15000;
        notify();
      }
    );
    return t;
  }

  function tilesFor(level, minWX, minWY, maxWX, maxWY) {
    const z = LEVELS[level].queryZoom;
    const n = 2 ** z;
    const k = n / 256;
    const x0 = Math.floor(minWX * k), x1 = Math.floor(maxWX * k);
    const y0 = Math.max(0, Math.floor(minWY * k)), y1 = Math.min(n - 1, Math.floor(maxWY * k));
    const out = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x: ((x % n) + n) % n, y });
    return out;
  }

  // ------------------------------------------------------------ Metro data

  const metro = { state: 'idle', lines: [], stations: [], error: '' };
  function loadMetro() {
    if (metro.state === 'loading' || metro.state === 'done') return;
    if (metro.state === 'error' && Date.now() < metro.retryAt) return;
    metro.state = 'loading';
    rpc('metro').then(
      (data) => {
        const style = new Map(METRO.LINES.map((l) => [l.name, l]));
        metro.lines = data.lines
          .filter((l) => style.has(l.name))
          .map((l) => {
            const n = l.path.length;
            const wx = new Float64Array(n), wy = new Float64Array(n);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < n; i++) {
              wx[i] = worldX(l.path[i][0]);
              wy[i] = worldY(l.path[i][1]);
              minX = Math.min(minX, wx[i]);
              maxX = Math.max(maxX, wx[i]);
              minY = Math.min(minY, wy[i]);
              maxY = Math.max(maxY, wy[i]);
            }
            return { ...style.get(l.name), wx, wy, minX, minY, maxX, maxY };
          });
        metro.stations = data.stations.map((s) => ({
          name: s.name,
          lines: s.lines
            .split(/[,\s]+/)
            .map((n) => style.get(n))
            .filter(Boolean),
          wx: worldX(s.lng),
          wy: worldY(s.lat),
        }));
        metro.state = 'done';
        notify();
      },
      (err) => {
        metro.state = 'error';
        metro.error = err.message;
        metro.retryAt = Date.now() + 30000;
        notify();
      }
    );
  }

  // ------------------------------------------------------------------ view

  // Where the visible map (plus a margin, so short pans don't show bare
  // edges) sits in div-pixel and world coordinates.
  function computeView(proj, map, margin) {
    const bounds = map.getBounds && map.getBounds();
    if (!proj || !bounds) return null;
    const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
    const pNE = proj.fromLatLngToDivPixel(ne), pSW = proj.fromLatLngToDivPixel(sw);
    let wx0 = worldX(sw.lng()), wx1 = worldX(ne.lng());
    if (wx1 <= wx0) wx1 += 256;
    const scale = (pNE.x - pSW.x) / (wx1 - wx0);
    if (!isFinite(scale) || scale <= 0) return null;
    const offX = pSW.x - wx0 * scale;
    const offY = pNE.y - worldY(ne.lat()) * scale;
    const w = pNE.x - pSW.x, h = pSW.y - pNE.y;
    const left = pSW.x - w * margin, top = pNE.y - h * margin;
    const cw = w * (1 + 2 * margin), ch = h * (1 + 2 * margin);
    return {
      scale, offX, offY, left, top, cw, ch,
      zoom: Math.log2(scale),
      minWX: (left - offX) / scale,
      maxWX: (left + cw - offX) / scale,
      minWY: (top - offY) / scale,
      maxWY: (top + ch - offY) / scale,
    };
  }

  // Lines that share track are drawn side by side: shift each vertex along
  // its (mitred) left-hand normal by `d` pixels. xs/ys are canvas pixels.
  function offsetPath(xs, ys, d) {
    const n = xs.length;
    if (!d || n < 2) return [xs, ys];
    const ox = new Float64Array(n), oy = new Float64Array(n);
    const nx = new Float64Array(n - 1), ny = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i];
      const len = Math.hypot(dx, dy) || 1;
      nx[i] = dy / len;
      ny[i] = -dx / len;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 2, i);
      let mx = nx[a] + nx[b], my = ny[a] + ny[b];
      const len = Math.hypot(mx, my);
      if (len < 1e-6) {
        mx = nx[b];
        my = ny[b];
      } else {
        mx /= len;
        my /= len;
      }
      const cos = mx * nx[b] + my * ny[b];
      const miter = Math.min(2, 1 / Math.max(cos, 0.5));
      ox[i] = xs[i] + mx * d * miter;
      oy[i] = ys[i] + my * d * miter;
    }
    return [ox, oy];
  }

  // ----------------------------------------------------------------- layers

  let MapController = null;
  function defineLayers(gm) {
    // A canvas that covers the visible map and is redrawn on pan/zoom.
    class CanvasLayer extends gm.OverlayView {
      constructor(ctrl, pane, zIndex) {
        super();
        this.ctrl = ctrl;
        this.pane = pane;
        this.zIndex = zIndex;
        this.frame = 0;
        this.needFetch = false;
        this.root = null;
        this.setMap(ctrl.map);
      }
      onAdd() {
        this.root = document.createElement('div');
        this.root.style.cssText = `position:absolute;pointer-events:none;z-index:${this.zIndex};`;
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
        this.decorate(this.root);
        this.root.append(this.canvas);
        this.getPanes()[this.pane].appendChild(this.root);
        this.applySettings();
      }
      decorate() {}
      onRemove() {
        if (this.root) this.root.remove();
        this.root = null;
      }
      draw() {
        this.schedule(false);
      }
      isOn() {
        return true;
      }
      applySettings() {
        this.schedule(true);
      }
      schedule(fetch) {
        this.needFetch = this.needFetch || fetch;
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          const f = this.needFetch;
          this.needFetch = false;
          try {
            this.render(f);
          } catch (err) {
            this.ctrl.setStatus('Overlay error: ' + err.message);
          }
        });
      }
      render(fetch) {
        if (!this.root) return;
        const on = this.isOn() && !this.ctrl.small;
        this.root.style.display = on ? '' : 'none';
        if (!on) return;
        const v = computeView(this.getProjection(), this.ctrl.map, 0.2);
        if (!v) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = Math.max(1, Math.min(4096, Math.round(v.cw * dpr)));
        const H = Math.max(1, Math.min(4096, Math.round(v.ch * dpr)));
        Object.assign(this.root.style, {
          left: v.left + 'px', top: v.top + 'px', width: v.cw + 'px', height: v.ch + 'px',
        });
        if (this.canvas.width !== W) this.canvas.width = W;
        if (this.canvas.height !== H) this.canvas.height = H;
        const sx = W / v.cw, sy = H / v.ch;
        // world coords -> canvas pixels: x * ax + bx, y * ay + by
        v.ax = v.scale * sx;
        v.bx = (v.offX - v.left) * sx;
        v.ay = v.scale * sy;
        v.by = (v.offY - v.top) * sy;
        v.W = W;
        v.H = H;
        v.dpr = dpr;
        const ctx = this.canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        this.paint(ctx, v, fetch);
      }
    }

    class DotLayer extends CanvasLayer {
      decorate(root) {
        this.dim = document.createElement('div');
        this.dim.style.cssText = 'position:absolute;inset:0;background:rgb(12,16,28);';
        root.append(this.dim);
      }
      isOn() {
        return !!settings.enabled;
      }
      applySettings() {
        if (this.root) {
          this.canvas.style.opacity = String(settings.opacity);
          this.dim.style.opacity = String(settings.dim);
        }
        this.schedule(true);
      }
      pickLevel(v) {
        const fits = (lvl) => tilesFor(lvl, v.minWX, v.minWY, v.maxWX, v.maxWY).length <= MAX_TILES;
        if (settings.level !== 'auto' && LEVELS[settings.level]) {
          if (fits(settings.level)) return { level: settings.level, note: '' };
          return { level: autoLevel(v.zoom), note: `Zoom in to see ${LEVELS[settings.level].label.toLowerCase()}s` };
        }
        return { level: autoLevel(v.zoom), note: '' };
      }
      paint(ctx, v, fetch) {
        const ctrl = this.ctrl;
        const { level, note } = this.pickLevel(v);
        const tileList = tilesFor(level, v.minWX, v.minWY, v.maxWX, v.maxWY);
        let loading = 0, errors = 0, lastError = '';
        const seen = new Set();
        const visible = [];
        for (const tl of tileList) {
          const key = `${level}/${tl.z}/${tl.x}/${tl.y}`;
          let t = tiles.get(key);
          if (fetch && (!t || (t.state === 'error' && Date.now() > t.retryAt))) {
            t = requestTile(level, tl.z, tl.x, tl.y);
          }
          if (!t) continue;
          if (t.state === 'loading') loading++;
          if (t.state === 'error') {
            errors++;
            lastError = t.error;
          }
          for (const id of t.ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            const f = features.get(id);
            if (f.maxX < v.minWX || f.minX > v.maxWX || f.maxY < v.minWY || f.minY > v.maxWY) continue;
            visible.push(f);
          }
        }
        ctrl.visible = visible;
        ctrl.level = level;

        // People per dot: the web map's value at the reference zoom, halved
        // per zoom level in, unless the user set one. Raised if needed so a
        // frame never has to draw more than MAX_DOTS.
        let dotValue = settings.dotValue > 0
          ? settings.dotValue
          : Math.max(1, Math.round(LEVELS[level].dotValue * 2 ** (REFERENCE_ZOOM - Math.round(v.zoom))));
        const people = visible.reduce((s, f) => s + f.total, 0);
        while (people / dotValue > MAX_DOTS) dotValue *= 2;
        ctrl.dotValue = dotValue;

        const { W, H, ax, bx, ay, by } = v;
        const img = ctx.createImageData(W, H);
        const buf = new Uint32Array(img.data.buffer);
        const size = Math.max(1, Math.round((settings.dotSize > 0 ? settings.dotSize : autoDotSize(v.zoom)) * v.dpr));
        const packed = RACES.map((r) => (255 << 24) | (r.color[2] << 16) | (r.color[1] << 8) | r.color[0]);
        const hidden = RACES.map((r) => settings.hidden.includes(r.field));
        let drawn = 0;
        for (const f of visible) {
          const d = dotsFor(f, dotValue);
          for (let i = 0; i < d.n; i++) {
            const c = d.cs[i];
            if (hidden[c]) continue;
            const px = (d.xs[i] * ax + bx) | 0;
            const py = (d.ys[i] * ay + by) | 0;
            if (px < 0 || py < 0 || px + size > W || py + size > H) continue;
            const col = packed[c];
            for (let yy = 0; yy < size; yy++) {
              const row = (py + yy) * W + px;
              for (let xx = 0; xx < size; xx++) buf[row + xx] = col;
            }
            drawn++;
          }
        }
        ctx.putImageData(img, 0, 0);

        if (settings.outlines) {
          ctx.save();
          ctx.setTransform(ax, 0, 0, ay, bx, by);
          ctx.beginPath();
          for (const f of visible) {
            for (const r of f.rings) {
              ctx.moveTo(r[0], r[1]);
              for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]);
              ctx.closePath();
            }
          }
          ctx.restore();
          ctx.lineWidth = Math.max(0.75, 0.75 * v.dpr);
          ctx.strokeStyle = 'rgba(200,200,200,0.35)';
          ctx.stroke();
        }

        let status = '';
        if (loading) status = `Loading ${LEVELS[level].label.toLowerCase()} data… (${loading} area${loading > 1 ? 's' : ''} left)`;
        else if (errors) status = `Couldn't load some data: ${lastError}`;
        else if (note) status = note;
        else if (!visible.length) status = 'No ACS data in this view.';
        ctrl.drawn = drawn;
        ctrl.setStatus(status);
        ctrl.updateLegend();
        ctrl.refreshHover();
      }
    }

    class MetroLayer extends CanvasLayer {
      isOn() {
        return !!settings.metro;
      }
      paint(ctx, v, fetch) {
        if (fetch) loadMetro();
        if (metro.state !== 'done') return;
        const { ax, bx, ay, by, dpr, zoom } = v;
        const lw = (zoom < 10 ? 2.5 : zoom < 12 ? 3.5 : zoom < 14 ? 4.5 : 6) * dpr;
        const minStep = 1.5 * dpr; // drop vertices closer than this, in px
        const paths = [];
        for (const l of metro.lines) {
          if (l.maxX < v.minWX || l.minX > v.maxWX || l.maxY < v.minWY || l.minY > v.maxWY) continue;
          const xs = [], ys = [];
          for (let i = 0; i < l.wx.length; i++) {
            const x = l.wx[i] * ax + bx, y = l.wy[i] * ay + by;
            const k = xs.length;
            if (k && i < l.wx.length - 1 && Math.abs(x - xs[k - 1]) + Math.abs(y - ys[k - 1]) < minStep) continue;
            xs.push(x);
            ys.push(y);
          }
          const [ox, oy] = offsetPath(xs, ys, l.slot * lw);
          paths.push({ l, ox, oy });
        }
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const stroke = (ox, oy) => {
          ctx.beginPath();
          ctx.moveTo(ox[0], oy[0]);
          for (let i = 1; i < ox.length; i++) ctx.lineTo(ox[i], oy[i]);
          ctx.stroke();
        };
        // White casing under every line first, so parallel lines don't
        // cover each other's colour.
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = lw + 2 * dpr;
        for (const p of paths) stroke(p.ox, p.oy);
        for (const p of paths) {
          ctx.strokeStyle = p.l.color;
          ctx.lineWidth = lw;
          stroke(p.ox, p.oy);
        }

        if (zoom < 10.5) return;
        const r = Math.max(3 * dpr, lw * 0.85);
        const labels = zoom >= 13;
        ctx.font = `600 ${11 * dpr}px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif`;
        ctx.textBaseline = 'middle';
        const onScreen = metro.stations
          .map((s) => ({ s, x: s.wx * ax + bx, y: s.wy * ay + by }))
          .filter(({ x, y }) => x > -50 && y > -50 && x < v.W + 50 && y < v.H + 50);
        for (const { x, y } of onScreen) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = 1.5 * dpr;
          ctx.strokeStyle = '#333';
          ctx.stroke();
        }
        if (!labels) return;
        // Label right of the dot, else left; skip a label that would
        // overlap one already drawn (downtown stations are close together).
        const placed = [];
        const h = 13 * dpr, gap = r + 4 * dpr;
        const free = (b) => !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
        for (const { s, x, y } of onScreen) {
          const w = ctx.measureText(s.name).width;
          const right = { x0: x + gap, x1: x + gap + w, y0: y - h / 2, y1: y + h / 2 };
          const left = { x0: x - gap - w, x1: x - gap, y0: y - h / 2, y1: y + h / 2 };
          const box = free(right) ? right : free(left) ? left : null;
          if (!box) continue;
          placed.push(box);
          ctx.lineWidth = 3 * dpr;
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.strokeText(s.name, box.x0, y);
          ctx.fillStyle = '#1f2328';
          ctx.fillText(s.name, box.x0, y);
        }
      }
    }

    class MeasureLayer extends CanvasLayer {
      isOn() {
        const m = this.ctrl.measure;
        return !!(m.a || m.b);
      }
      paint(ctx, v) {
        const m = this.ctrl.measure;
        const { ax, bx, ay, by, dpr } = v;
        const px = (ll) => [worldX(ll.lng) * ax + bx, worldY(ll.lat) * ay + by];
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (m.route) {
          const pts = m.route.path.map(([lng, lat]) => px({ lng, lat }));
          const trace = () => {
            ctx.beginPath();
            pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.stroke();
          };
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 8 * dpr;
          trace();
          ctx.strokeStyle = '#111827';
          ctx.lineWidth = 4.5 * dpr;
          trace();
        } else if (m.a && m.b) {
          const [x1, y1] = px(m.a), [x2, y2] = px(m.b);
          ctx.setLineDash([6 * dpr, 6 * dpr]);
          ctx.strokeStyle = '#111827';
          ctx.lineWidth = 2.5 * dpr;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.font = `700 ${12 * dpr}px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const [ll, letter] of [[m.a, 'A'], [m.b, 'B']]) {
          if (!ll) continue;
          const [x, y] = px(ll);
          ctx.beginPath();
          ctx.arc(x, y, 10 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = '#111827';
          ctx.fill();
          ctx.lineWidth = 2.5 * dpr;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.fillText(letter, x, y + 0.5 * dpr);
        }
        if (m.route && m.b) {
          const [x, y] = px(m.b);
          const text = `${formatMiles(m.route.meters / METERS_PER_MILE)} mi`;
          ctx.font = `700 ${13 * dpr}px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif`;
          const w = ctx.measureText(text).width + 14 * dpr, h = 22 * dpr;
          const lx = x + 14 * dpr, ly = y - h / 2;
          ctx.fillStyle = '#111827';
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(lx, ly, w, h, 5 * dpr);
          else ctx.rect(lx, ly, w, h);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(text, lx + 7 * dpr, y + 0.5 * dpr);
        }
      }
    }

    // Everything the extension adds to one Zillow map.
    MapController = class {
      constructor(map) {
        this.map = map;
        this.visible = [];
        this.level = '';
        this.dotValue = 0;
        this.drawn = 0;
        this.status = '';
        this.small = false;
        this.measure = { active: false, a: null, b: null, route: null, loading: false, error: '' };
        this.hoverLatLng = null;
        this.buildPanel();
        this.layers = [new DotLayer(this, 'overlayLayer', 0), new MetroLayer(this, 'overlayLayer', 1)];
        this.measureLayer = new MeasureLayer(this, 'floatPane', 0);
        this.layers.push(this.measureLayer);
        this.onData = () => this.layers.forEach((l) => l.schedule(false));
        dataListeners.add(this.onData);
        this.listeners = [
          map.addListener('idle', () => this.layers.forEach((l) => l.schedule(true))),
          map.addListener('mousemove', (e) => this.hover(e && e.latLng)),
          map.addListener('mouseout', () => this.hover(null)),
          map.addListener('click', (e) => this.onClick(e)),
        ];
        this.onKey = (e) => {
          if (e.key === 'Escape' && this.measure.active) this.setMeasuring(false);
        };
        document.addEventListener('keydown', this.onKey, true);
        this.applySettings();
      }

      destroy() {
        dataListeners.delete(this.onData);
        this.listeners.forEach((l) => l.remove());
        document.removeEventListener('keydown', this.onKey, true);
        this.layers.forEach((l) => l.setMap(null));
        this.panel.remove();
      }

      setSmall(small) {
        if (small === this.small) return;
        this.small = small;
        this.panel.hidden = small;
        this.layers.forEach((l) => l.schedule(true));
      }

      applySettings() {
        this.layers.forEach((l) => l.applySettings());
        this.updateLegend();
      }

      setStatus(s) {
        if (this.status === s) return;
        this.status = s;
        this.statusEl.textContent = s;
        this.statusEl.style.display = s ? '' : 'none';
      }

      // ------------------------------------------------- distance tool

      setMeasuring(on) {
        const m = this.measure;
        m.active = on;
        if (!on) {
          m.a = m.b = m.route = null;
          m.loading = false;
          m.error = '';
        }
        try {
          this.map.setOptions({ draggableCursor: on ? 'crosshair' : null });
        } catch (_) {
          /* ignore */
        }
        this.measureLayer.schedule(false);
        this.updateMeasure();
      }

      onClick(e) {
        const m = this.measure;
        if (!m.active || !e || !e.latLng) return;
        const ll = { lat: e.latLng.lat(), lng: e.latLng.lng() };
        if (!m.a || m.b) {
          m.a = ll;
          m.b = null;
          m.route = null;
          m.error = '';
        } else {
          m.b = ll;
          m.loading = true;
          const job = (this.routeJob = {});
          rpc('route', { from: [m.a.lng, m.a.lat], to: [m.b.lng, m.b.lat] }).then(
            (route) => {
              if (this.routeJob !== job) return;
              m.route = route;
              m.loading = false;
              this.measureLayer.schedule(false);
              this.updateMeasure();
            },
            (err) => {
              if (this.routeJob !== job) return;
              m.loading = false;
              m.error = err.message;
              this.updateMeasure();
            }
          );
        }
        this.measureLayer.schedule(false);
        this.updateMeasure();
      }

      updateMeasure() {
        const m = this.measure;
        this.measureBtn.setAttribute('aria-pressed', String(m.active));
        this.measureBtn.textContent = m.active ? 'Done measuring' : 'Measure distance';
        const box = this.measureEl;
        box.replaceChildren();
        box.style.display = m.active ? '' : 'none';
        if (!m.active) return;
        const line = (text, cls) => {
          const d = document.createElement('div');
          if (cls) d.className = cls;
          d.textContent = text;
          box.append(d);
        };
        if (!m.a) line('Click the map to set point A.');
        else if (!m.b) line('Now click point B.');
        else {
          const straight = milesBetween(m.a, m.b);
          if (m.loading) line('Finding road route…');
          else if (m.error) line(`Couldn't get a road route: ${m.error}`, 'zro-warn');
          else if (m.route) {
            line(`${formatMiles(m.route.meters / METERS_PER_MILE)} mi by road`, 'zro-big');
            line(`About ${formatDuration(m.route.seconds)} driving, without traffic`);
          }
          line(`${formatMiles(straight)} mi straight line`, 'zro-dim');
          line('Click again to start a new measurement.', 'zro-dim');
        }
      }

      // ------------------------------------------------------- hover

      hover(latLng) {
        this.hoverLatLng = latLng ? { lat: latLng.lat(), lng: latLng.lng() } : null;
        this.refreshHover();
      }

      refreshHover() {
        const info = this.infoEl;
        const ll = this.hoverLatLng;
        if (!ll || this.measure.active) {
          info.style.display = 'none';
          this.infoFor = null;
          return;
        }
        const x = worldX(ll.lng), y = worldY(ll.lat);
        const station = settings.metro ? this.stationNear(x, y) : null;
        if (station) {
          if (this.infoFor === station) return;
          this.infoFor = station;
          info.replaceChildren();
          const title = document.createElement('div');
          title.className = 'zro-info-title';
          title.textContent = `${station.name} Metro`;
          info.append(title);
          for (const l of station.lines) info.append(infoRow(l.color, `${l.label} Line`, ''));
          info.style.display = '';
          return;
        }
        const f = settings.enabled
          ? this.visible.find((g) => x >= g.minX && x <= g.maxX && y >= g.minY && y <= g.maxY && contains(g, x, y))
          : null;
        if (!f) {
          info.style.display = 'none';
          this.infoFor = null;
          return;
        }
        if (this.infoFor === f) return;
        this.infoFor = f;
        const total = f.total || RACES.reduce((s, r) => s + f.counts[r.field], 0);
        info.replaceChildren();
        const title = document.createElement('div');
        title.className = 'zro-info-title';
        title.textContent = f.name;
        const sub = document.createElement('div');
        sub.className = 'zro-info-sub';
        sub.textContent = `Population ${total.toLocaleString()}`;
        info.append(title, sub);
        RACES.map((r) => ({ r, n: f.counts[r.field] }))
          .filter((o) => o.n > 0)
          .sort((a, b) => b.n - a.n)
          .forEach(({ r, n }) =>
            info.append(infoRow(`rgb(${r.color})`, r.label, `${total ? Math.round((n / total) * 100) : 0}%`))
          );
        info.style.display = '';
      }

      // Nearest station within ~10 screen pixels of the cursor.
      stationNear(x, y) {
        if (metro.state !== 'done') return null;
        const zoom = this.map.getZoom ? this.map.getZoom() : 12;
        if (zoom < 10.5) return null;
        const tol = 10 / 2 ** zoom; // 10px in world units
        let best = null, bd = tol * tol;
        for (const s of metro.stations) {
          const d = (s.wx - x) ** 2 + (s.wy - y) ** 2;
          if (d < bd) {
            bd = d;
            best = s;
          }
        }
        return best;
      }

      // ------------------------------------------------------- panel

      buildPanel() {
        injectStyles();
        const el = document.createElement('div');
        el.className = 'zro-legend';
        for (const t of ['mousedown', 'pointerdown', 'touchstart', 'click', 'dblclick', 'wheel', 'contextmenu']) {
          el.addEventListener(t, (ev) => ev.stopPropagation());
        }

        const tools = document.createElement('div');
        tools.className = 'zro-tools';
        const metroLabel = document.createElement('label');
        metroLabel.className = 'zro-tool-check';
        const metroBox = document.createElement('input');
        metroBox.type = 'checkbox';
        metroBox.addEventListener('change', () => saveSettings({ metro: metroBox.checked }));
        const metroText = document.createElement('span');
        metroText.textContent = 'Metro lines';
        metroLabel.append(metroBox, metroText);
        const measureBtn = document.createElement('button');
        measureBtn.type = 'button';
        measureBtn.className = 'zro-btn';
        measureBtn.addEventListener('click', () => this.setMeasuring(!this.measure.active));
        tools.append(metroLabel, measureBtn);
        const measure = document.createElement('div');
        measure.className = 'zro-measure';

        const head = document.createElement('div');
        head.className = 'zro-head';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.title = 'Show race dot density';
        toggle.addEventListener('change', () => saveSettings({ enabled: toggle.checked }));
        const title = document.createElement('span');
        title.className = 'zro-title';
        title.textContent = 'Race & ethnicity';
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'zro-collapse';
        collapse.title = 'Collapse';
        collapse.textContent = '–';
        collapse.addEventListener('click', () => {
          el.classList.toggle('zro-collapsed');
          collapse.textContent = el.classList.contains('zro-collapsed') ? '+' : '–';
        });
        head.append(toggle, title, collapse);

        const body = document.createElement('div');
        body.className = 'zro-body';
        const meta = document.createElement('div');
        meta.className = 'zro-meta';
        const list = document.createElement('div');
        list.className = 'zro-list';
        this.raceBoxes = RACES.map((r) => {
          const row = document.createElement('label');
          row.className = 'zro-row';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.addEventListener('change', () => {
            const hidden = new Set(settings.hidden);
            if (cb.checked) hidden.delete(r.field);
            else hidden.add(r.field);
            saveSettings({ hidden: [...hidden] });
          });
          const sw = document.createElement('span');
          sw.className = 'zro-sw';
          sw.style.background = `rgb(${r.color})`;
          const lab = document.createElement('span');
          lab.textContent = r.label;
          row.append(cb, sw, lab);
          list.append(row);
          return cb;
        });
        const status = document.createElement('div');
        status.className = 'zro-status';
        status.style.display = 'none';
        const src = document.createElement('div');
        src.className = 'zro-src';
        src.textContent =
          'Source: U.S. Census ACS 5-yr (B03002) via Esri Living Atlas. Dots are placed randomly within each area.';
        body.append(meta, list, status, src);

        const info = document.createElement('div');
        info.className = 'zro-info';
        info.style.display = 'none';

        el.append(tools, measure, info, head, body);
        this.panel = el;
        this.toggleEl = toggle;
        this.metroBox = metroBox;
        this.measureBtn = measureBtn;
        this.measureEl = measure;
        this.metaEl = meta;
        this.statusEl = status;
        this.infoEl = info;
        this.mountPanel();
        this.updateMeasure();
      }

      mountPanel() {
        const div = this.map.getDiv();
        if (div && this.panel.parentNode !== div) div.appendChild(this.panel);
      }

      updateLegend() {
        this.mountPanel();
        this.panel.style.display = settings.legend ? '' : 'none';
        this.panel.classList.toggle('zro-off', !settings.enabled);
        this.toggleEl.checked = !!settings.enabled;
        this.metroBox.checked = !!settings.metro;
        this.raceBoxes.forEach((cb, i) => (cb.checked = !settings.hidden.includes(RACES[i].field)));
        this.metaEl.textContent = settings.enabled && this.level
          ? `${LEVELS[this.level].label} level · 1 dot = ${this.dotValue.toLocaleString()} ${this.dotValue === 1 ? 'person' : 'people'}`
          : 'Dots off';
        if (settings.metro && metro.state === 'error') this.setStatus(`Couldn't load Metro lines: ${metro.error}`);
      }
    };
  }

  function autoLevel(zoom) {
    if (zoom >= LEVELS.tract.minZoom - 0.5) return 'tract';
    if (zoom >= LEVELS.county.minZoom - 0.5) return 'county';
    return 'state';
  }
  function autoDotSize(zoom) {
    if (zoom >= 15) return 3;
    if (zoom >= 12) return 2;
    return 1;
  }
  function formatMiles(mi) {
    return mi < 10 ? mi.toFixed(2) : mi.toFixed(1);
  }
  function formatDuration(seconds) {
    const min = Math.max(1, Math.round(seconds / 60));
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  }
  function infoRow(color, label, value) {
    const row = document.createElement('div');
    row.className = 'zro-info-row';
    const sw = document.createElement('span');
    sw.className = 'zro-sw';
    sw.style.background = color;
    const lab = document.createElement('span');
    lab.className = 'zro-info-label';
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'zro-info-val';
    val.textContent = value;
    row.append(sw, lab, val);
    return row;
  }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
.zro-legend{position:absolute;left:10px;bottom:28px;z-index:1000;width:244px;max-height:calc(100% - 60px);overflow:auto;
  background:rgba(255,255,255,.96);color:#1f2328;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);
  font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}
.zro-tools{display:flex;align-items:center;gap:8px;padding:7px 8px;border-bottom:1px solid #e5e7eb;}
.zro-tool-check{display:flex;align-items:center;gap:5px;cursor:pointer;flex:1;font-weight:600;}
.zro-tool-check input{margin:0;}
.zro-btn{font:inherit;font-weight:600;border:1px solid #c9ced6;background:#f6f7f9;color:#1f2328;border-radius:6px;padding:3px 8px;cursor:pointer;}
.zro-btn[aria-pressed="true"]{background:#111827;color:#fff;border-color:#111827;}
.zro-measure{padding:7px 8px;border-bottom:1px solid #e5e7eb;background:#f8fafc;}
.zro-big{font-size:15px;font-weight:700;}
.zro-dim{color:#666;}
.zro-warn{color:#9a3412;}
.zro-head{display:flex;align-items:center;gap:6px;padding:7px 8px;border-bottom:1px solid #e5e7eb;}
.zro-title{font-weight:600;flex:1;}
.zro-collapse{border:0;background:none;font-size:16px;line-height:1;cursor:pointer;color:#555;padding:0 4px;}
.zro-body{padding:6px 8px 8px;}
.zro-collapsed .zro-body{display:none;}
.zro-collapsed .zro-head{border-bottom:0;}
.zro-meta{color:#555;margin-bottom:4px;}
.zro-row{display:flex;align-items:center;gap:6px;padding:1px 0;cursor:pointer;}
.zro-row input{margin:0;}
.zro-sw{display:inline-block;width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.25);}
.zro-off .zro-list{opacity:.45;}
.zro-status{margin-top:6px;color:#9a3412;}
.zro-info{padding:7px 8px;border-bottom:1px solid #e5e7eb;}
.zro-info-title{font-weight:600;}
.zro-info-sub{color:#555;margin-bottom:2px;}
.zro-info-row{display:flex;align-items:center;gap:6px;}
.zro-info-label{flex:1;}
.zro-info-val{font-variant-numeric:tabular-nums;}
.zro-src{margin-top:6px;color:#777;font-size:10.5px;}`;
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // ----------------------------------------------------------- map capture

  // Zillow creates its google.maps.Map inside its own bundle, so there is no
  // handle to it. Instead, wrap the Map / MVCObject prototype methods: the
  // first time any of them runs on a Map instance (Zillow and the Maps API
  // both call get/getBounds/addListener constantly), that instance is ours.
  function capture(map) {
    if (controllers.has(map) || !MapController) return;
    controllers.set(map, null);
    setTimeout(() => {
      const div = map.getDiv && map.getDiv();
      if (!div) return controllers.delete(map);
      controllers.set(map, new MapController(map));
    }, 0);
  }

  function hookMaps() {
    const gm = window.google && window.google.maps;
    if (!gm || typeof gm.Map !== 'function' || typeof gm.MVCObject !== 'function' || typeof gm.OverlayView !== 'function') {
      return false;
    }
    if (gm.Map.prototype.__zroHooked) return true;
    defineLayers(gm);
    const MapCtor = gm.Map;
    for (const proto of [MapCtor.prototype, gm.MVCObject.prototype]) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || typeof desc.value !== 'function' || !desc.writable) continue;
        const orig = desc.value;
        const wrapped = function () {
          if (this instanceof MapCtor && !controllers.has(this)) capture(this);
          return orig.apply(this, arguments);
        };
        try {
          Object.defineProperty(proto, name, { ...desc, value: wrapped });
        } catch (_) {
          /* non-configurable; skip */
        }
      }
    }
    Object.defineProperty(MapCtor.prototype, '__zroHooked', { value: true });
    return true;
  }

  // Controllers on maps that Zillow has thrown away (SPA navigation) are
  // removed; maps too small to be the search map are left bare.
  function sweep() {
    controllers.forEach((c, map) => {
      if (!c) return;
      const div = map.getDiv();
      if (!div || !div.isConnected) {
        c.destroy();
        controllers.delete(map);
        return;
      }
      c.setSmall(div.clientWidth < MIN_MAP_SIZE || div.clientHeight < MIN_MAP_SIZE);
    });
  }

  const poll = setInterval(() => {
    if (hookMaps()) {
      clearInterval(poll);
      setInterval(sweep, 2000);
    }
  }, 150);

  toContent({ type: 'ready' });
  window.__zroDebug = { controllers, features, tiles, metro, get settings() { return settings; } };
})();
