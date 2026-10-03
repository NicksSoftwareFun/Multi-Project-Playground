// Grid A* with per-species movement capabilities, in the spirit of Rain
// World's creature AI: a lizard that can't climb walls sees a different map
// from one that can.
//
// caps: {
//   fly        - any open cell is fine (batflies, Daddy Long Legs)
//   walls      - can cling to walls
//   ceil       - can cling to ceilings
//   poles      - can climb poles
//   fall       - may deliberately drop off ledges
//   jumpX, jumpUp - jump range in cells (0 = can't jump)
//   wallCost, ceilCost, poleCost - preference multipliers
//   surfacePenalty - (fliers) extra cost per cell further than this from a surface
// }
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  const WALK = 0;
  const FALL = 1;
  const JUMP = 2;
  const MAX_FALL = 80;

  let gs = null;
  let from = null;
  let etype = null;
  let openStamp = null;
  let closedStamp = null;
  let stamp = 0;
  let heapIdx = new Int32Array(4096);
  let heapF = new Float32Array(4096);
  let heapN = 0;

  const jumpCache = new Map(); // capsKey -> Map(cellIndex -> [idx, cost, idx, cost...])
  let jumpCacheVersion = -1;

  function ensure(size) {
    if (!gs || gs.length !== size) {
      gs = new Float32Array(size);
      from = new Int32Array(size);
      etype = new Uint8Array(size);
      openStamp = new Uint32Array(size);
      closedStamp = new Uint32Array(size);
      stamp = 0;
    }
  }

  function heapPush(i, f) {
    if (heapN >= heapIdx.length) {
      const ni = new Int32Array(heapIdx.length * 2);
      const nf = new Float32Array(heapF.length * 2);
      ni.set(heapIdx);
      nf.set(heapF);
      heapIdx = ni;
      heapF = nf;
    }
    let k = heapN++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapF[p] <= f) break;
      heapIdx[k] = heapIdx[p];
      heapF[k] = heapF[p];
      k = p;
    }
    heapIdx[k] = i;
    heapF[k] = f;
  }

  function heapPop() {
    const top = heapIdx[0];
    const li = heapIdx[--heapN];
    const lf = heapF[heapN];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= heapN) break;
      if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= lf) break;
      heapIdx[k] = heapIdx[c];
      heapF[k] = heapF[c];
      k = c;
    }
    heapIdx[k] = li;
    heapF[k] = lf;
    return top;
  }

  function valid(W, cx, cy, c) {
    if (W.solid(cx, cy)) return false;
    if (c.fly) return true;
    if (W.solid(cx, cy + 1)) return true;
    if (c.poles && W.pole(cx, cy)) return true;
    if (c.walls) {
      if (W.solid(cx - 1, cy) || W.solid(cx + 1, cy)) return true;
      if (W.solid(cx - 1, cy + 1) || W.solid(cx + 1, cy + 1)) return true;
      if (c.ceil && (W.solid(cx - 1, cy - 1) || W.solid(cx + 1, cy - 1))) return true;
    }
    if (c.ceil && W.solid(cx, cy - 1)) return true;
    return false;
  }

  function standable(W, cx, cy, c) {
    return !W.solid(cx, cy) && (W.solid(cx, cy + 1) || (c.poles && W.pole(cx, cy)));
  }

  function arcClear(W, x0, y0, x1, y1) {
    const cell = W.cell;
    const apex = Math.min(y0, y1) - cell * 1.3;
    const yc = 2 * apex - (y0 + y1) / 2;
    const xc = (x0 + x1) / 2;
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const d = t * t;
      const px = a * x0 + b * xc + d * x1;
      const py = a * y0 + b * yc + d * y1;
      // the body is ~13px wide and the head rides ~11px above the hip
      // (grid lookups: this runs for every jump candidate after a window moves)
      const sc = (x, y) => W.solid(Math.floor(x / cell), Math.floor(y / cell));
      if (sc(px, py) || sc(px - 6, py) || sc(px + 6, py)) return false;
      if (sc(px, py - 11) || sc(px - 6, py - 9) || sc(px + 6, py - 9) || sc(px, py - cell * 0.6)) return false;
    }
    return true;
  }

  function jumpEdges(W, cx, cy, c) {
    if (jumpCacheVersion !== W.version) {
      jumpCache.clear();
      jumpCacheVersion = W.version;
    }
    let m = jumpCache.get(c.key);
    if (!m) {
      m = new Map();
      jumpCache.set(c.key, m);
    }
    const ci = cy * W.cols + cx;
    let list = m.get(ci);
    if (list) return list;
    list = [];
    if (standable(W, cx, cy, c)) {
      const jx = c.jumpX;
      const ju = c.jumpUp;
      const x0 = W.centerX(cx);
      const y0 = W.centerY(cy);
      for (let ty = -ju; ty <= 4; ty++) {
        for (let tx = -jx; tx <= jx; tx++) {
          if (Math.abs(tx) <= 1 && Math.abs(ty) <= 1) continue;
          const tcx = cx + tx;
          const tcy = cy + ty;
          if (!W.inBounds(tcx, tcy) || !standable(W, tcx, tcy, c)) continue;
          if (ty < 0 && (tx * tx) / (jx * jx) + (ty * ty) / (ju * ju) > 1.05) continue;
          if (ty >= 0) {
            // Only jump across or down when there's actually a gap to clear.
            let gap = false;
            const s = Math.sign(tx);
            for (let k = 1; k < Math.abs(tx); k++) {
              if (!W.solid(cx + s * k, cy + 1)) {
                gap = true;
                break;
              }
            }
            if (!gap) continue;
          }
          if (!arcClear(W, x0, y0, W.centerX(tcx), W.centerY(tcy))) continue;
          list.push(tcy * W.cols + tcx, Math.hypot(tx, ty) * 1.3 + 4);
        }
      }
    }
    m.set(ci, list);
    return list;
  }

  function nearestValid(W, x, y, c, maxR) {
    const cx = W.cellX(x);
    const cy = W.cellY(y);
    for (let r = 0; r <= maxR; r++) {
      let best = null;
      let bd = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!W.inBounds(nx, ny) || !valid(W, nx, ny, c)) continue;
          const d = U.dist2(x, y, W.centerX(nx), W.centerY(ny));
          if (d < bd) {
            bd = d;
            best = { cx: nx, cy: ny };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // Returns {nodes, complete} or null. nodes excludes the start cell; each
  // node's type says how to get there from the previous one (WALK/FALL/JUMP).
  function findPath(W, sx, sy, gx, gy, c, maxNodes) {
    maxNodes = maxNodes || 5000;
    const size = W.cols * W.rows;
    ensure(size);
    const start = nearestValid(W, sx, sy, c, 2);
    if (!start) return null;
    let goal = nearestValid(W, gx, gy, c, 4);
    const gcx = goal ? goal.cx : U.clamp(W.cellX(gx), 0, W.cols - 1);
    const gcy = goal ? goal.cy : U.clamp(W.cellY(gy), 0, W.rows - 1);
    const cols = W.cols;
    const si = start.cy * cols + start.cx;
    const gi = gcy * cols + gcx;

    stamp++;
    if (stamp > 4e9) {
      openStamp.fill(0);
      closedStamp.fill(0);
      stamp = 1;
    }
    heapN = 0;
    gs[si] = 0;
    from[si] = -1;
    etype[si] = WALK;
    openStamp[si] = stamp;
    const h = (i) => Math.hypot((i % cols) - gcx, ((i / cols) | 0) - gcy);
    heapPush(si, h(si));
    let bestI = si;
    let bestH = h(si);
    let expanded = 0;
    let found = false;

    while (heapN > 0) {
      const ci = heapPop();
      if (closedStamp[ci] === stamp) continue;
      closedStamp[ci] = stamp;
      if (ci === gi) {
        found = true;
        bestI = ci;
        break;
      }
      const hh = h(ci);
      if (hh < bestH) {
        bestH = hh;
        bestI = ci;
      }
      if (++expanded > maxNodes) break;
      const cx = ci % cols;
      const cy = (ci / cols) | 0;
      const g0 = gs[ci];

      const relax = (ni, cost, type) => {
        if (closedStamp[ni] === stamp) return;
        const ng = g0 + cost;
        if (openStamp[ni] === stamp && gs[ni] <= ng) return;
        openStamp[ni] = stamp;
        gs[ni] = ng;
        from[ni] = ci;
        etype[ni] = type;
        heapPush(ni, ng + h(ni));
      };

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!W.inBounds(nx, ny) || !valid(W, nx, ny, c)) continue;
          if (dx && dy && W.solid(cx + dx, cy) && W.solid(cx, cy + dy)) continue;
          let cost = dx && dy ? 1.414 : 1;
          if (!c.fly) {
            if (!W.solid(nx, ny + 1)) {
              if (c.poles && W.pole(nx, ny)) cost *= c.poleCost || 1.2;
              else if (W.solid(nx, ny - 1) && !W.solid(nx - 1, ny) && !W.solid(nx + 1, ny)) cost *= c.ceilCost || 2;
              else cost *= c.wallCost || 1.4;
            }
          } else if (c.surfacePenalty) {
            const sd = W.surfDist(nx, ny);
            if (sd > c.surfacePenalty) cost += (sd - c.surfacePenalty) * 2;
          }
          relax(ny * cols + nx, cost, WALK);
        }
      }

      if (!c.fly && c.fall) {
        for (let side = -1; side <= 1; side++) {
          const sx2 = cx + side;
          const sy2 = side === 0 ? cy + 1 : cy;
          if (!W.inBounds(sx2, sy2) || W.solid(sx2, sy2) || valid(W, sx2, sy2, c)) continue;
          let y = sy2;
          let land = -1;
          for (let k = 0; k < MAX_FALL && y < W.rows; k++, y++) {
            if (W.solid(sx2, y + 1)) {
              land = y;
              break;
            }
            if (k > 1 && valid(W, sx2, y, c)) {
              land = y;
              break;
            }
          }
          if (land > cy) relax(land * cols + sx2, (2 + (land - sy2) * 0.3) * (c.fallCost || 1), FALL);
        }
      }

      if (c.jumpX > 0) {
        const list = jumpEdges(W, cx, cy, c);
        for (let k = 0; k < list.length; k += 2) relax(list[k], list[k + 1], JUMP);
      }
    }

    // Reconstruct to the goal, or to the closest point we could reach.
    const nodes = [];
    let i = bestI;
    let guard = 0;
    while (i !== si && i >= 0 && guard++ < 10000) {
      const cx = i % cols;
      const cy = (i / cols) | 0;
      nodes.push({ cx, cy, x: W.centerX(cx), y: W.centerY(cy), type: etype[i] });
      i = from[i];
    }
    nodes.reverse();
    return { nodes, complete: found, start };
  }

  // A random valid cell near (x, y). `filter(cx, cy)` can reject candidates.
  function randomValid(W, c, x, y, radius, filter, tries) {
    tries = tries || 40;
    for (let t = 0; t < tries; t++) {
      const a = Math.random() * U.TAU;
      const r = Math.sqrt(Math.random()) * radius;
      const px = U.clamp(x + Math.cos(a) * r, 0, W.w - 1);
      const py = U.clamp(y + Math.sin(a) * r, 0, W.h - 1);
      const n = nearestValid(W, px, py, c, 3);
      if (!n) continue;
      if (filter && !filter(n.cx, n.cy)) continue;
      return { cx: n.cx, cy: n.cy, x: W.centerX(n.cx), y: W.centerY(n.cy) };
    }
    return null;
  }

  function capsKey(c) {
    return [c.fly ? 1 : 0, c.walls ? 1 : 0, c.ceil ? 1 : 0, c.poles ? 1 : 0, c.fall ? 1 : 0, c.jumpX | 0, c.jumpUp | 0].join('');
  }

  // Every cell a creature with these caps can be in (and the standable ones),
  // cached per world version: used to pick destinations anywhere on the map.
  function validCells(W, c) {
    const key = c.key || capsKey(c);
    const cache = (W._validCells = W._validCells || {});
    const hit = cache[key];
    if (hit && hit.version === W.version) return hit;
    const all = [];
    const stand = [];
    for (let cy = 0; cy < W.rows; cy++) {
      for (let cx = 0; cx < W.cols; cx++) {
        if (!valid(W, cx, cy, c)) continue;
        all.push(cx, cy);
        if (W.solid(cx, cy + 1)) stand.push(cx, cy);
      }
    }
    return (cache[key] = { version: W.version, all, stand });
  }

  RW.Nav = { WALK, FALL, JUMP, findPath, nearestValid, randomValid, valid, standable, capsKey, validCells };
})();
