// Geometry provider for the real Windows desktop. Polls the local helper
// (windows/rw-helper.ps1) for window, icon and taskbar rectangles plus the
// cursor, and maps them from physical screen pixels into page pixels.
// Without the helper it degrades to just the screen edges.
(function () {
  'use strict';
  const RW = window.RW;

  const DEFAULT_PORT = 47315;

  function helperBase() {
    // Served by the helper itself: same origin. Loaded as a file (packaged
    // Lively wallpaper): talk to the helper on localhost.
    if (location.protocol === 'http:' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return '';
    return 'http://localhost:' + DEFAULT_PORT;
  }

  class RemoteGeometry {
    constructor(opts) {
      opts = opts || {};
      this.base = opts.base !== undefined ? opts.base : helperBase();
      this.interval = opts.interval || 80;
      this.connected = false;
      this.data = null;
      this.lastOk = 0;
      this.failures = 0;
      this.clicks = [];
      this.domCursor = { x: -9999, y: -9999, inside: false, t: 0 };
      this.paused = false;
      this.bindDom();
      this.loop();
    }

    bindDom() {
      window.addEventListener('pointermove', (e) => {
        this.domCursor.x = e.clientX;
        this.domCursor.y = e.clientY;
        this.domCursor.inside = true;
        this.domCursor.t = performance.now();
      });
      document.addEventListener('pointerleave', () => (this.domCursor.inside = false));
      // Lively forwards clicks on bare desktop to the wallpaper when its
      // "wallpaper input" setting is enabled.
      window.addEventListener('pointerdown', (e) => {
        if (e.target.closest && e.target.closest('.rw-panel, .rw-panel-toggle')) return;
        this.clicks.push({ x: e.clientX, y: e.clientY });
      });
    }

    async loop() {
      for (;;) {
        const t0 = performance.now();
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 600);
          const r = await fetch(this.base + '/api/geometry', { cache: 'no-store', signal: ctl.signal });
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          this.data = await r.json();
          this.connected = true;
          this.failures = 0;
          this.lastOk = performance.now();
        } catch (e) {
          this.failures++;
          if (this.failures > 3) this.connected = false;
        }
        // Back off while the helper isn't there.
        const wait = this.connected ? this.interval : Math.min(5000, 500 * this.failures);
        await new Promise((res) => setTimeout(res, Math.max(0, wait - (performance.now() - t0))));
      }
    }

    // Physical screen px -> page px.
    mapper() {
      const s = this.data.screen;
      const kx = window.innerWidth / s.w;
      const ky = window.innerHeight / s.h;
      return (r) => ({ x: (r.x - s.x) * kx, y: (r.y - s.y) * ky, w: (r.w || 0) * kx, h: (r.h || 0) * ky });
    }

    poll() {
      const clicks = this.clicks;
      this.clicks = [];
      if (!this.connected || !this.data) {
        this.paused = false;
        return { rects: [], cursor: this.domCursor, clicks };
      }
      const map = this.mapper();
      const W = window.innerWidth;
      const H = window.innerHeight;
      const rects = [];
      let covered = false;
      const add = (list, kind) => {
        for (const r of list || []) {
          const m = map(r);
          if (m.w < 2 || m.h < 2) continue;
          if (kind === 'window' && m.w * m.h > W * H * 0.9) covered = true;
          rects.push({ id: r.id, kind, x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.w), h: Math.round(m.h) });
        }
      };
      add(this.data.windows, 'window');
      add(this.data.icons, 'icon');
      add(this.data.taskbars, 'taskbar');
      // A maximised or fullscreen app hides the wallpaper: freeze rather than
      // crush every creature into the screen edges.
      this.paused = covered;
      const c = map(this.data.cursor);
      const cursor = { x: c.x, y: c.y, inside: c.x >= 0 && c.y >= 0 && c.x < W && c.y < H };
      return { rects, cursor, clicks, paused: covered };
    }

    status() {
      if (!this.connected) return 'helper: not running (screen edges only)';
      const d = this.data;
      return `helper: connected — ${d.windows.length} windows, ${d.icons.length} icons${this.paused ? ', paused (fullscreen app)' : ''}`;
    }
  }

  // Shared settings stored by the helper, so a normal browser tab can tune
  // the live wallpaper.
  class ConfigSync {
    constructor(cfg, onRemoteChange, base) {
      this.cfg = cfg;
      this.base = base !== undefined ? base : helperBase();
      this.onRemoteChange = onRemoteChange;
      this.last = null;
      this.available = false;
    }
    async load() {
      try {
        const r = await fetch(this.base + '/api/config', { cache: 'no-store' });
        if (!r.ok) return false;
        const text = await r.text();
        this.available = true;
        if (text === this.last) return false;
        this.last = text;
        const obj = JSON.parse(text);
        if (!obj || !Object.keys(obj).length) return false;
        return obj;
      } catch (e) {
        this.available = false;
        return false;
      }
    }
    start(everyMs) {
      const tick = async () => {
        const obj = await this.load();
        if (obj) this.onRemoteChange(obj);
        setTimeout(tick, everyMs || 3000);
      };
      tick();
    }
    async save(cfg) {
      const text = JSON.stringify(cfg);
      this.last = text;
      try {
        await fetch(this.base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      } catch (e) {
        /* helper not running: localStorage still has it */
      }
    }
  }

  RW.RemoteGeometry = RemoteGeometry;
  RW.ConfigSync = ConfigSync;
})();
