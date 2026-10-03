// Engine: fixed-timestep simulation + rendering. It knows nothing about
// where geometry comes from — a "geometry provider" supplies the solid
// rectangles (windows, icons, taskbar), the cursor and clicks. The browser
// prototype uses a mock desktop; the Windows port swaps in a provider fed by
// a native helper.
//
// provider.poll() -> { rects: [{id, kind, x, y, w, h}], cursor: {x, y, inside}, clicks: [{x, y}] }
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  const STEP = 1 / 60;

  class Engine {
    constructor(canvas, cfg, provider) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cfg = cfg;
      this.provider = provider;
      this.acc = 0;
      this.last = 0;
      this.running = false;
      this.fps = 60;
      this.frameMs = 0;
      this.bgCanvas = document.createElement('canvas');
      this.seed = 0;
      this.init();
    }

    // Creature scale works by simulating a smaller world and drawing it
    // magnified, so creatures, poles, ledges and physics all scale together.
    poll() {
      const g = this.provider.poll();
      const z = this.zoom;
      if (z === 1) return g;
      const s = (o) => Object.assign({}, o, { x: o.x / z, y: o.y / z });
      return {
        rects: g.rects.map((r) => ({ id: r.id, kind: r.kind, x: r.x / z, y: r.y / z, w: r.w / z, h: r.h / z })),
        cursor: g.cursor ? s(g.cursor) : null,
        clicks: (g.clicks || []).map(s),
        paused: g.paused,
      };
    }

    init(keepSeed) {
      const cfg = this.cfg;
      this.zoom = U.clamp(+cfg.world.creatureScale || 1, 0.5, 3);
      this.W = Math.max(320, window.innerWidth) / this.zoom;
      this.H = Math.max(240, window.innerHeight) / this.zoom;
      this.world = new RW.World(cfg.world.cellSize || 20);
      this.world.resize(this.W, this.H);
      if (!keepSeed || !this.seed) this.seed = cfg.world.seed || Math.floor(Math.random() * 1e9);
      const rnd = U.mulberry32(this.seed);
      this.decor = RW.Background.generateDecor(this.W, this.H, cfg, rnd);
      this.world.setStatic(this.decor.ledges, this.decor.poles);
      const g = this.poll();
      this.world.setDynamic(g.rects);
      this.world.rebuild();
      this.eco = new RW.Ecosystem(cfg, this.world);
      this.weather = this.weather || new RW.Background.Weather();
      this.weather.reset(this.W, this.H);
      this.eco.weather = this.weather;
      this.eco.setDecor(this.decor);
      this.applyPalette();
    }

    applyPalette() {
      this.pal = RW.PALETTES[this.cfg.world.palette] || RW.PALETTES.industrial;
      this.eco.palette = this.pal;
      this.ps = U.clamp(+this.cfg.world.pixelScale || 2, 1, 4);
      this.canvas.width = Math.ceil((this.W * this.zoom) / this.ps);
      this.canvas.height = Math.ceil((this.H * this.zoom) / this.ps);
      RW.Background.paint(this.bgCanvas, this.W, this.H, this.ps / this.zoom, this.pal, this.decor, this.seed % 100000);
    }

    // New background and decor; keeps the creatures that still fit.
    regenerate(newSeed) {
      if (newSeed) this.cfg.world.seed = 0;
      const keep = this.eco ? this.eco.creatures : [];
      const t = this.weather ? this.weather.t : 0;
      const oldZoom = this.zoom;
      this.init(!newSeed);
      this.weather.t = t;
      if (!newSeed && this.zoom === oldZoom) {
        for (const c of keep) {
          if (!this.world.isSolidPt(c.x, c.y)) {
            c.eco = this.eco;
            c.W = this.world;
            if (c.pather) c.pather.version = -1;
            this.eco.creatures.push(c);
          }
        }
        this.eco.populated = true;
      }
    }

    resize() {
      const w = Math.max(320, window.innerWidth) / this.zoom;
      const h = Math.max(240, window.innerHeight) / this.zoom;
      if (Math.abs(w - this.W) < 1 && Math.abs(h - this.H) < 1) return;
      this.regenerate(false);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      const loop = (now) => {
        if (!this.running) return;
        const real = Math.min(0.1, (now - this.last) / 1000);
        this.last = now;
        this.fps += (1 / Math.max(real, 1e-3) - this.fps) * 0.05;
        const t0 = performance.now();
        this.acc += real * U.clamp(+this.cfg.world.timeScale || 1, 0, 4);
        let steps = 0;
        while (this.acc >= STEP && steps < 5) {
          this.tick(STEP);
          this.acc -= STEP;
          steps++;
        }
        if (steps >= 5) this.acc = 0;
        this.render();
        this.frameMs += (performance.now() - t0 - this.frameMs) * 0.05;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    stop() {
      this.running = false;
    }

    // Deterministic stepping for tests and screenshots.
    step(n) {
      for (let i = 0; i < n; i++) this.tick(STEP);
      this.render();
    }

    tick(dt) {
      const g = this.poll();
      if (g.paused) return; // wallpaper hidden behind a fullscreen app
      const moves = this.world.setDynamic(g.rects);
      if (this.world.rebuild()) {
        // nothing else to do: paths notice the version bump themselves
      }
      if (moves.length) this.eco.carry(moves);
      const c = g.cursor || { x: -9999, y: -9999, inside: false };
      this.eco.setCursor(c.x, c.y, !!c.inside, dt);
      if (g.clicks && this.cfg.ecosystem.clickDropsFood) {
        for (const k of g.clicks) this.eco.dropFood(k.x, k.y);
      }
      this.weather.update(dt, this.cfg, this.W, this.H, this.world);
      this.eco.update(dt);
    }

    render() {
      const ctx = this.ctx;
      const cfg = this.cfg;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.bgCanvas, 0, 0);
      const k = this.zoom / this.ps;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      this.weather.drawFog(ctx, this.pal);
      this.weather.drawChains(ctx, this.decor, this.pal, this.eco.t);
      this.eco.draw(ctx);
      this.weather.drawRain(ctx, this.pal);
      if (cfg.rain.enabled && cfg.rain.showCycleHud) this.weather.drawHud(ctx, this.W, this.H, this.pal);
      if (cfg.debug.showGrid) this.drawGrid(ctx);
      if (cfg.debug.showFps) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '12px monospace';
        ctx.fillText(`${this.fps.toFixed(0)} fps  ${this.frameMs.toFixed(1)} ms  ${this.eco.creatures.length} creatures`, 10, 16);
      }
    }

    drawGrid(ctx) {
      const W = this.world;
      const c = W.cell;
      for (let cy = 0; cy < W.rows; cy++) {
        for (let cx = 0; cx < W.cols; cx++) {
          if (W.solid(cx, cy)) {
            ctx.fillStyle = 'rgba(255,60,60,0.18)';
            ctx.fillRect(cx * c, cy * c, c, c);
          } else if (W.pole(cx, cy)) {
            ctx.fillStyle = 'rgba(60,220,255,0.3)';
            ctx.fillRect(cx * c, cy * c, c, c);
          }
        }
      }
      ctx.strokeStyle = 'rgba(255,255,0,0.6)';
      ctx.lineWidth = 2;
      for (const s of W.dynamicSolids) ctx.strokeRect(s.x, s.y, s.w, s.h);
    }
  }

  RW.Engine = Engine;
})();
