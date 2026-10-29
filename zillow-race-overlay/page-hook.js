// Runs in Zillow's own JavaScript world so it can reach the Google Maps
// instance Zillow creates. It finds that map, adds a canvas overlay, and
// draws ACS race dot density on it. Data requests go out through the
// content script (postMessage) to the extension's background worker.
(function () {
  'use strict';
  if (window.__zroLoaded) return;
  window.__zroLoaded = true;

  const { RACES, LEVELS, REFERENCE_ZOOM, DEFAULT_SETTINGS } = window.ZRO_CONFIG;
  const MAX_DOTS = 350000; // per frame; people-per-dot is raised to stay under this
  const MAX_TILES = 48; // per view; beyond this the level is too fine to fetch
  const DOT_CACHE_LIMIT = 4000;
  const MIN_MAP_SIZE = 200; // px; ignore thumbnail maps

  let settings = { ...DEFAULT_SETTINGS };
  const overlays = new Map(); // google.maps.Map -> DotOverlay

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
      overlays.forEach((o) => o.applySettings());
    } else if (msg.type === 'queryResult') {
      const cb = pending.get(msg.reqId);
      if (cb) {
        pending.delete(msg.reqId);
        cb(msg);
      }
    }
  });
  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    overlays.forEach((o) => o.applySettings());
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
  const tileListeners = new Set();

  function requestTile(level, z, x, y) {
    const key = `${level}/${z}/${x}/${y}`;
    let t = tiles.get(key);
    if (t && t.state !== 'error') return t;
    t = { state: 'loading', ids: [], error: null };
    tiles.set(key, t);
    const reqId = ++reqSeq;
    pending.set(reqId, (res) => {
      if (res.error) {
        t.state = 'error';
        t.error = res.error;
        t.retryAt = Date.now() + 15000;
      } else {
        t.ids = res.features.map((f) => ingest(f).id);
        t.state = 'done';
      }
      tileListeners.forEach((fn) => fn());
    });
    toContent({ type: 'query', reqId, level, tile: { z, x, y } });
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

  // --------------------------------------------------------------- overlay

  let DotOverlay = null;
  function defineOverlay(gm) {
    DotOverlay = class extends gm.OverlayView {
      constructor(map) {
        super();
        this.map = map;
        this.view = null;
        this.visible = [];
        this.status = '';
        this.dotValue = 0;
        this.level = '';
        this.frame = 0;
        this.listeners = [];
        this.onTiles = () => this.schedule(true);
        tileListeners.add(this.onTiles);
        this.buildLegend();
        this.setMap(map);
      }

      onAdd() {
        this.root = document.createElement('div');
        this.root.style.cssText = 'position:absolute;pointer-events:none;';
        this.dim = document.createElement('div');
        this.dim.style.cssText = 'position:absolute;inset:0;background:rgb(12,16,28);';
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
        this.root.append(this.dim, this.canvas);
        this.getPanes().overlayLayer.appendChild(this.root);
        const gm = window.google.maps;
        this.listeners.push(
          this.map.addListener('idle', () => this.schedule(true)),
          this.map.addListener('mousemove', (e) => this.hover(e)),
          this.map.addListener('mouseout', () => this.hover(null))
        );
        this.gm = gm;
        this.applySettings();
      }

      onRemove() {
        this.listeners.forEach((l) => l.remove());
        this.listeners = [];
        if (this.root) this.root.remove();
        this.root = null;
      }

      destroy() {
        tileListeners.delete(this.onTiles);
        if (this.legend) this.legend.remove();
        this.setMap(null);
      }

      draw() {
        this.schedule(false);
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
            this.setStatus('Overlay error: ' + err.message);
          }
        });
      }

      applySettings() {
        if (this.root) {
          this.root.style.display = settings.enabled ? '' : 'none';
          this.canvas.style.opacity = String(settings.opacity);
          this.dim.style.opacity = String(settings.dim);
        }
        this.updateLegend();
        this.schedule(true);
      }

      // Where the visible map sits in div-pixel and world coordinates.
      computeView() {
        const proj = this.getProjection();
        const bounds = this.map.getBounds && this.map.getBounds();
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
        const m = 0.2; // draw a margin so short pans don't show bare edges
        const left = pSW.x - w * m, top = pNE.y - h * m;
        const cw = w * (1 + 2 * m), ch = h * (1 + 2 * m);
        return {
          scale, offX, offY, left, top, cw, ch,
          zoom: Math.log2(scale),
          minWX: (left - offX) / scale,
          maxWX: (left + cw - offX) / scale,
          minWY: (top - offY) / scale,
          maxWY: (top + ch - offY) / scale,
        };
      }

      pickLevel(v) {
        const fits = (lvl) => tilesFor(lvl, v.minWX, v.minWY, v.maxWX, v.maxWY).length <= MAX_TILES;
        if (settings.level !== 'auto' && LEVELS[settings.level]) {
          if (fits(settings.level)) return { level: settings.level, note: '' };
          const auto = this.autoLevel(v.zoom);
          return { level: auto, note: `Zoom in to see ${LEVELS[settings.level].label.toLowerCase()}s` };
        }
        return { level: this.autoLevel(v.zoom), note: '' };
      }

      autoLevel(zoom) {
        if (zoom >= LEVELS.tract.minZoom - 0.5) return 'tract';
        if (zoom >= LEVELS.county.minZoom - 0.5) return 'county';
        return 'state';
      }

      render(fetch) {
        if (!this.root || !settings.enabled) return;
        const v = this.computeView();
        if (!v) return;
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
        this.visible = visible;
        this.level = level;
        if (this.infoEl && !visible.some((f) => f.id === this.infoFor)) this.hover(null);

        // People per dot: the web map's value at the reference zoom, halved
        // per zoom level in, unless the user set one. Raised if needed so a
        // frame never has to draw more than MAX_DOTS.
        let dotValue = settings.dotValue > 0
          ? settings.dotValue
          : Math.max(1, Math.round(LEVELS[level].dotValue * 2 ** (REFERENCE_ZOOM - Math.round(v.zoom))));
        const people = visible.reduce((s, f) => s + f.total, 0);
        while (people / dotValue > MAX_DOTS) dotValue *= 2;
        this.dotValue = dotValue;

        // Size the overlay to the visible map plus margin.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = Math.max(1, Math.min(4096, Math.round(v.cw * dpr)));
        const H = Math.max(1, Math.min(4096, Math.round(v.ch * dpr)));
        Object.assign(this.root.style, {
          left: v.left + 'px', top: v.top + 'px', width: v.cw + 'px', height: v.ch + 'px',
        });
        if (this.canvas.width !== W) this.canvas.width = W;
        if (this.canvas.height !== H) this.canvas.height = H;
        const sx = W / v.cw, sy = H / v.ch;
        const ctx = this.canvas.getContext('2d');
        const img = ctx.createImageData(W, H);
        const buf = new Uint32Array(img.data.buffer);

        const size = Math.max(1, Math.round((settings.dotSize > 0 ? settings.dotSize : this.autoDotSize(v.zoom)) * dpr));
        const packed = RACES.map((r) => (255 << 24) | (r.color[2] << 16) | (r.color[1] << 8) | r.color[0]);
        const hidden = RACES.map((r) => settings.hidden.includes(r.field));
        const ax = v.scale * sx, bx = (v.offX - v.left) * sx;
        const ay = v.scale * sy, by = (v.offY - v.top) * sy;
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
          ctx.lineWidth = Math.max(0.75, 0.75 * dpr);
          ctx.strokeStyle = 'rgba(200,200,200,0.35)';
          ctx.stroke();
        }

        let status = '';
        if (loading) status = `Loading ${LEVELS[level].label.toLowerCase()} data… (${loading} area${loading > 1 ? 's' : ''} left)`;
        else if (errors) status = `Couldn't load some data: ${lastError}`;
        else if (note) status = note;
        else if (!visible.length) status = 'No ACS data in this view.';
        this.drawn = drawn;
        this.setStatus(status);
        this.updateLegend();
      }

      autoDotSize(zoom) {
        if (zoom >= 15) return 3;
        if (zoom >= 12) return 2;
        return 1;
      }

      hover(e) {
        if (!this.infoEl) return;
        if (!e || !e.latLng || !settings.enabled) {
          this.infoEl.textContent = '';
          this.infoEl.style.display = 'none';
          return;
        }
        const x = worldX(e.latLng.lng()), y = worldY(e.latLng.lat());
        const f = this.visible.find(
          (g) => x >= g.minX && x <= g.maxX && y >= g.minY && y <= g.maxY && contains(g, x, y)
        );
        if (!f) {
          this.infoEl.style.display = 'none';
          return;
        }
        if (this.infoFor === f.id && this.infoEl.style.display !== 'none') return;
        this.infoFor = f.id;
        const total = f.total || RACES.reduce((s, r) => s + f.counts[r.field], 0);
        const rows = RACES.map((r) => ({ r, n: f.counts[r.field] }))
          .filter((o) => o.n > 0)
          .sort((a, b) => b.n - a.n);
        this.infoEl.replaceChildren();
        const title = document.createElement('div');
        title.className = 'zro-info-title';
        title.textContent = f.name;
        const sub = document.createElement('div');
        sub.className = 'zro-info-sub';
        sub.textContent = `Population ${total.toLocaleString()}`;
        this.infoEl.append(title, sub);
        for (const { r, n } of rows) {
          const row = document.createElement('div');
          row.className = 'zro-info-row';
          const sw = document.createElement('span');
          sw.className = 'zro-sw';
          sw.style.background = `rgb(${r.color})`;
          const lab = document.createElement('span');
          lab.className = 'zro-info-label';
          lab.textContent = r.label;
          const val = document.createElement('span');
          val.className = 'zro-info-val';
          val.textContent = `${total ? Math.round((n / total) * 100) : 0}%`;
          row.append(sw, lab, val);
          this.infoEl.append(row);
        }
        this.infoEl.style.display = '';
      }

      // ----------------------------------------------------------- legend

      buildLegend() {
        injectStyles();
        const el = document.createElement('div');
        el.className = 'zro-legend';
        for (const t of ['mousedown', 'pointerdown', 'touchstart', 'click', 'dblclick', 'wheel', 'contextmenu']) {
          el.addEventListener(t, (ev) => ev.stopPropagation());
        }
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
        collapse.addEventListener('click', () => {
          el.classList.toggle('zro-collapsed');
          collapse.textContent = el.classList.contains('zro-collapsed') ? '+' : '–';
        });
        collapse.textContent = '–';
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
        const info = document.createElement('div');
        info.className = 'zro-info';
        info.style.display = 'none';
        const src = document.createElement('div');
        src.className = 'zro-src';
        src.textContent = 'Source: U.S. Census ACS 5-yr (B03002) via Esri Living Atlas. Dots are placed randomly within each area.';
        body.append(meta, list, status, info, src);
        el.append(head, body);

        this.legend = el;
        this.toggleEl = toggle;
        this.metaEl = meta;
        this.statusEl = status;
        this.infoEl = info;
        this.mountLegend();
      }

      mountLegend() {
        const div = this.map.getDiv();
        if (div && this.legend.parentNode !== div) div.appendChild(this.legend);
      }

      setStatus(s) {
        if (this.status === s) return;
        this.status = s;
        if (this.statusEl) {
          this.statusEl.textContent = s;
          this.statusEl.style.display = s ? '' : 'none';
        }
      }

      updateLegend() {
        if (!this.legend) return;
        this.mountLegend();
        this.legend.style.display = settings.legend ? '' : 'none';
        this.legend.classList.toggle('zro-off', !settings.enabled);
        this.toggleEl.checked = !!settings.enabled;
        this.raceBoxes.forEach((cb, i) => (cb.checked = !settings.hidden.includes(RACES[i].field)));
        this.metaEl.textContent = settings.enabled && this.level
          ? `${LEVELS[this.level].label} level · 1 dot = ${this.dotValue.toLocaleString()} ${this.dotValue === 1 ? 'person' : 'people'}`
          : 'Overlay off';
      }
    };
  }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
.zro-legend{position:absolute;left:10px;bottom:28px;z-index:1000;width:236px;max-height:calc(100% - 60px);overflow:auto;
  background:rgba(255,255,255,.96);color:#1f2328;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);
  font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}
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
.zro-off .zro-list,.zro-off .zro-info{opacity:.45;}
.zro-status{margin-top:6px;color:#9a3412;}
.zro-info{margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb;}
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
    if (overlays.has(map) || !DotOverlay) return;
    overlays.set(map, null);
    setTimeout(() => {
      const div = map.getDiv && map.getDiv();
      if (!div) return overlays.delete(map);
      overlays.set(map, new DotOverlay(map));
    }, 0);
  }

  function hookMaps() {
    const gm = window.google && window.google.maps;
    if (!gm || typeof gm.Map !== 'function' || typeof gm.MVCObject !== 'function' || typeof gm.OverlayView !== 'function') {
      return false;
    }
    if (gm.Map.prototype.__zroHooked) return true;
    defineOverlay(gm);
    const MapCtor = gm.Map;
    for (const proto of [MapCtor.prototype, gm.MVCObject.prototype]) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || typeof desc.value !== 'function' || !desc.writable) continue;
        const orig = desc.value;
        const wrapped = function () {
          if (this instanceof MapCtor && !overlays.has(this)) capture(this);
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

  // Overlays on maps that Zillow has thrown away (SPA navigation) or that are
  // too small to be the search map get cleaned up / skipped here.
  function sweep() {
    overlays.forEach((o, map) => {
      if (!o) return;
      const div = map.getDiv();
      if (!div || !div.isConnected) {
        o.destroy();
        overlays.delete(map);
        return;
      }
      const small = div.clientWidth < MIN_MAP_SIZE || div.clientHeight < MIN_MAP_SIZE;
      if (o.legend) o.legend.hidden = small;
      if (o.root) o.root.hidden = small;
    });
  }

  const poll = setInterval(() => {
    if (hookMaps()) {
      clearInterval(poll);
      setInterval(sweep, 2000);
    }
  }, 150);

  toContent({ type: 'ready' });
  window.__zroDebug = { overlays, features, tiles, get settings() { return settings; } };
})();
