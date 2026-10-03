// The world is a set of axis-aligned solid rectangles (desktop windows, icons,
// taskbar, wallpaper ledges, screen edges) plus climbable poles. Physics uses
// the exact rectangles; AI navigation uses a coarse grid, like Rain World's
// 20px tiles.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  const SOLID = 1;
  const POLE = 2;

  class World {
    constructor(cellSize) {
      this.cell = cellSize || 20;
      this.w = 0;
      this.h = 0;
      this.staticSolids = [];
      this.dynamicSolids = [];
      this.poles = [];
      this.borders = [];
      this.solids = [];
      this.version = 0;
      this.dirty = true;
    }

    resize(w, h) {
      w = Math.max(64, Math.floor(w));
      h = Math.max(64, Math.floor(h));
      if (w === this.w && h === this.h) return;
      this.w = w;
      this.h = h;
      this.cols = Math.ceil(w / this.cell);
      this.rows = Math.ceil(h / this.cell);
      this.grid = new Uint8Array(this.cols * this.rows);
      this.distField = new Uint8Array(this.cols * this.rows);
      const B = 400;
      this.borders = [
        { id: 'edge-left', kind: 'edge', x: -B, y: -B, w: B, h: h + 2 * B },
        { id: 'edge-right', kind: 'edge', x: w, y: -B, w: B, h: h + 2 * B },
        { id: 'edge-top', kind: 'edge', x: -B, y: -B, w: w + 2 * B, h: B },
        { id: 'edge-bottom', kind: 'edge', x: -B, y: h, w: w + 2 * B, h: B },
      ];
      this.dirty = true;
    }

    setStatic(solids, poles) {
      this.staticSolids = solids.map((s) => Object.assign({}, s));
      this.poles = poles.map((p) => Object.assign({}, p));
      this.dirty = true;
    }

    // rects: [{id, kind, x, y, w, h}] from the geometry provider (windows,
    // icons, taskbar). Returns a list of moves so creatures standing on a
    // window can ride along when it is dragged.
    setDynamic(rects) {
      const prev = new Map();
      for (const r of this.dynamicSolids) prev.set(r.id, r);
      let changed = rects.length !== this.dynamicSolids.length;
      const moves = [];
      for (const r of rects) {
        const p = prev.get(r.id);
        if (!p) {
          changed = true;
          continue;
        }
        if (p.x !== r.x || p.y !== r.y || p.w !== r.w || p.h !== r.h) {
          changed = true;
          if (p.x !== r.x || p.y !== r.y) moves.push({ id: r.id, dx: r.x - p.x, dy: r.y - p.y });
        }
      }
      if (changed) {
        this.dynamicSolids = rects.map((r) => ({ id: r.id, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h }));
        this.dirty = true;
      }
      return moves;
    }

    rebuild() {
      if (!this.dirty) return false;
      this.dirty = false;
      this.solids = this.borders.concat(this.staticSolids, this.dynamicSolids);
      const { cols, rows, cell, grid } = this;
      grid.fill(0);
      for (const s of this.solids) {
        let cx0 = Math.ceil((s.x - cell / 2) / cell);
        let cx1 = Math.ceil((s.x + s.w - cell / 2) / cell) - 1;
        let cy0 = Math.ceil((s.y - cell / 2) / cell);
        let cy1 = Math.ceil((s.y + s.h - cell / 2) / cell) - 1;
        // Thin rects that straddle no cell centre still block their middle cell.
        if (cx0 > cx1) cx0 = cx1 = Math.floor((s.x + s.w / 2) / cell);
        if (cy0 > cy1) cy0 = cy1 = Math.floor((s.y + s.h / 2) / cell);
        cx0 = Math.max(0, cx0);
        cy0 = Math.max(0, cy0);
        cx1 = Math.min(cols - 1, cx1);
        cy1 = Math.min(rows - 1, cy1);
        for (let cy = cy0; cy <= cy1; cy++) {
          const row = cy * cols;
          for (let cx = cx0; cx <= cx1; cx++) grid[row + cx] = SOLID;
        }
      }
      for (const p of this.poles) {
        const cx = Math.floor(p.x / cell);
        if (cx < 0 || cx >= cols) continue;
        const cy0 = Math.max(0, Math.floor(p.y1 / cell));
        const cy1 = Math.min(rows - 1, Math.floor(p.y2 / cell));
        for (let cy = cy0; cy <= cy1; cy++) {
          const i = cy * cols + cx;
          if (!(grid[i] & SOLID)) grid[i] |= POLE;
        }
      }
      this.buildDistField();
      this.version++;
      return true;
    }

    // Cell distance to the nearest solid (8-connected BFS), capped at 255.
    buildDistField() {
      const { cols, rows, grid } = this;
      const df = this.distField;
      df.fill(255);
      const q = new Int32Array(cols * rows);
      let head = 0;
      let tail = 0;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] & SOLID) {
          df[i] = 0;
          q[tail++] = i;
        }
      }
      // Screen edges count as solid neighbours.
      for (let cx = 0; cx < cols; cx++) {
        for (const cy of [0, rows - 1]) {
          const i = cy * cols + cx;
          if (df[i] > 1) {
            df[i] = 1;
            q[tail++] = i;
          }
        }
      }
      for (let cy = 0; cy < rows; cy++) {
        for (const cx of [0, cols - 1]) {
          const i = cy * cols + cx;
          if (df[i] > 1) {
            df[i] = 1;
            q[tail++] = i;
          }
        }
      }
      while (head < tail) {
        const i = q[head++];
        const cx = i % cols;
        const cy = (i / cols) | 0;
        const nd = df[i] + 1;
        if (nd >= 255) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const j = ny * cols + nx;
            if (df[j] > nd) {
              df[j] = nd;
              q[tail++] = j;
            }
          }
        }
      }
    }

    // ---- grid queries ---------------------------------------------------
    inBounds(cx, cy) {
      return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
    }
    solid(cx, cy) {
      if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return true;
      return (this.grid[cy * this.cols + cx] & SOLID) !== 0;
    }
    pole(cx, cy) {
      if (!this.inBounds(cx, cy)) return false;
      return (this.grid[cy * this.cols + cx] & POLE) !== 0;
    }
    surfDist(cx, cy) {
      if (!this.inBounds(cx, cy)) return 0;
      return this.distField[cy * this.cols + cx];
    }
    cellX(x) {
      return Math.floor(x / this.cell);
    }
    cellY(y) {
      return Math.floor(y / this.cell);
    }
    centerX(cx) {
      return cx * this.cell + this.cell / 2;
    }
    centerY(cy) {
      return cy * this.cell + this.cell / 2;
    }

    // ---- precise queries ------------------------------------------------
    isSolidPt(x, y) {
      const S = this.solids;
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) return true;
      }
      return false;
    }

    solidById(id) {
      for (const s of this.solids) if (s.id === id) return s;
      return null;
    }

    // Push a point {x, y} out of every solid by radius r. Returns the contact
    // that best supports the point (the most "floor-like"), or null.
    collideCircle(p, r) {
      let contact = null;
      const S = this.solids;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < S.length; i++) {
          const s = S[i];
          if (p.x < s.x - r || p.x > s.x + s.w + r || p.y < s.y - r || p.y > s.y + s.h + r) continue;
          const qx = U.clamp(p.x, s.x, s.x + s.w);
          const qy = U.clamp(p.y, s.y, s.y + s.h);
          const dx = p.x - qx;
          const dy = p.y - qy;
          const d2 = dx * dx + dy * dy;
          let nx;
          let ny;
          if (d2 === 0) {
            const l = p.x - s.x;
            const rr = s.x + s.w - p.x;
            const t = p.y - s.y;
            const b = s.y + s.h - p.y;
            const m = Math.min(l, rr, t, b);
            if (m === t) {
              p.y = s.y - r;
              nx = 0;
              ny = -1;
            } else if (m === b) {
              p.y = s.y + s.h + r;
              nx = 0;
              ny = 1;
            } else if (m === l) {
              p.x = s.x - r;
              nx = -1;
              ny = 0;
            } else {
              p.x = s.x + s.w + r;
              nx = 1;
              ny = 0;
            }
          } else if (d2 < r * r) {
            const d = Math.sqrt(d2);
            nx = dx / d;
            ny = dy / d;
            p.x = qx + nx * r;
            p.y = qy + ny * r;
          } else {
            continue;
          }
          if (!contact || ny < contact.ny) contact = { nx, ny, id: s.id };
        }
      }
      return contact;
    }

    // Closest exposed surface point within maxD. mask selects which surfaces
    // count: {floor, walls, ceil, poles}. Corners count as floor/ceiling.
    // d is signed: negative when (x, y) is inside a solid.
    nearestSurface(x, y, maxD, mask) {
      mask = mask || ALL;
      let best = null;
      let bd = maxD;
      const S = this.solids;
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        if (x < s.x - bd || x > s.x + s.w + bd || y < s.y - bd || y > s.y + s.h + bd) continue;
        let qx = U.clamp(x, s.x, s.x + s.w);
        let qy = U.clamp(y, s.y, s.y + s.h);
        const dx = x - qx;
        const dy = y - qy;
        let d = Math.hypot(dx, dy);
        let nx;
        let ny;
        if (d < 1e-6) {
          // Inside: the nearest surface is the closest edge; d goes negative.
          const l = x - s.x;
          const r = s.x + s.w - x;
          const t = y - s.y;
          const b = s.y + s.h - y;
          const m = Math.min(l, r, t, b);
          if (m >= bd) continue;
          if (m === t) { qy = s.y; nx = 0; ny = -1; }
          else if (m === b) { qy = s.y + s.h; nx = 0; ny = 1; }
          else if (m === l) { qx = s.x; nx = -1; ny = 0; }
          else { qx = s.x + s.w; nx = 1; ny = 0; }
          d = -m;
        } else {
          if (d >= bd) continue;
          nx = dx / d;
          ny = dy / d;
        }
        const type = ny < -0.5 ? 'floor' : ny > 0.5 ? 'ceil' : 'walls';
        if (!mask[type]) continue;
        if (this.isSolidPt(qx + nx * 1.5, qy + ny * 1.5)) continue; // covered by another solid
        bd = Math.abs(d);
        best = { x: qx, y: qy, nx, ny, d, id: s.id, type };
      }
      if (mask.poles) {
        for (const p of this.poles) {
          const qy = U.clamp(y, p.y1, p.y2);
          const dx = x - p.x;
          const dy = y - qy;
          const d = Math.hypot(dx, dy);
          if (d >= bd) continue;
          if (this.isSolidPt(p.x, qy)) continue;
          bd = d;
          const nx = d > 1e-6 ? dx / d : -1;
          const ny = d > 1e-6 ? dy / d : 0;
          best = { x: p.x, y: qy, nx, ny, d, id: p.id, type: 'poles' };
        }
      }
      return best;
    }

    // Segment cast against all solids. Returns the first hit or null.
    raycast(x0, y0, x1, y1) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      let bt = 1;
      let best = null;
      const S = this.solids;
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        if (x0 >= s.x && x0 < s.x + s.w && y0 >= s.y && y0 < s.y + s.h) continue;
        let tEnter = 0;
        let tExit = bt;
        let nx = 0;
        let ny = 0;
        if (Math.abs(dx) < 1e-9) {
          if (x0 < s.x || x0 > s.x + s.w) continue;
        } else {
          let t1 = (s.x - x0) / dx;
          let t2 = (s.x + s.w - x0) / dx;
          let n = -1;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
            n = 1;
          }
          if (t1 > tEnter) {
            tEnter = t1;
            nx = n;
            ny = 0;
          }
          if (t2 < tExit) tExit = t2;
          if (tEnter > tExit) continue;
        }
        if (Math.abs(dy) < 1e-9) {
          if (y0 < s.y || y0 > s.y + s.h) continue;
        } else {
          let t1 = (s.y - y0) / dy;
          let t2 = (s.y + s.h - y0) / dy;
          let n = -1;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
            n = 1;
          }
          if (t1 > tEnter) {
            tEnter = t1;
            nx = 0;
            ny = n;
          }
          if (t2 < tExit) tExit = t2;
          if (tEnter > tExit) continue;
        }
        if (tEnter > 0 && tEnter < bt) {
          bt = tEnter;
          best = { t: tEnter, x: x0 + dx * tEnter, y: y0 + dy * tEnter, nx, ny, id: s.id };
        }
      }
      return best;
    }

    lineClear(x0, y0, x1, y1) {
      return !this.raycast(x0, y0, x1, y1);
    }
  }

  const ALL = { floor: true, walls: true, ceil: true, poles: true };
  World.SOLID = SOLID;
  World.POLE = POLE;
  RW.World = World;
})();
