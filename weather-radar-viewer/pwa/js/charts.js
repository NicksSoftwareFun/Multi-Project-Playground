// Minimal SVG chart engine for the data boards.
//
// SVG rather than canvas: the volumes are small (a meteogram is <=168 points,
// an ensemble collapses to five percentile paths), and SVG inherits the app's
// CSS tokens and mono font directly, so charts stay on-theme in one place.
//
//   const c = chart(container, spec);  c.update(spec);  c.destroy();
//
// spec = {
//   height, now,
//   x: { min, max },                       // ms; derived from the data when omitted
//   y: { unit, min, max }, y2: { unit },   // y2 is the optional right axis
//   series: [
//     { type:"line",  data:[[t,v],…], token:"--accent", width, label, axis:"y"|"y2" },
//     { type:"band",  lo:[[t,v],…], hi:[[t,v],…], token:"--pred", alpha },
//     { type:"bars",  data:[[t,v],…], token:"--info", axis:"y2" },
//     { type:"steps", data:[[t,v],…], token:"--sub" },
//   ],
//   cursor: true                           // crosshair + value readout above the plot
// }
//
// A null/undefined value breaks the path — gaps in the data stay visible as
// gaps instead of being interpolated over.

import { EDGE_SWIPE_PX } from "./config.js";

const NS = "http://www.w3.org/2000/svg";

const PAD = { top: 10, right: 12, bottom: 18, left: 38 };

function svg(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback || "#8FA5B7";
}

function extent(series, axis) {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    if ((s.axis || "y") !== axis) continue;
    const lists = s.type === "band" ? [s.lo || [], s.hi || []] : [s.data || []];
    for (const list of lists) {
      for (const [, v] of list) {
        if (v == null || isNaN(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (lo === Infinity) return null;
  // A flat series has no span to scale against. Widening it by a fixed +/-1 was
  // wrong for any quantity that cannot go negative: a dry day makes every
  // precipitation value 0, so the axis opened at -1 IN of rain. Pad
  // proportionally, and let the caller's declared floor clamp it (see yLo).
  if (lo === hi) {
    const pad = Math.abs(lo) > 1 ? Math.abs(lo) * 0.05 : 1;
    lo -= pad;
    hi += pad;
  }
  return [lo, hi];
}

function niceTicks(lo, hi, count) {
  const span = hi - lo;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const start = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

// Time ticks land on clean local hours; the label switches to a weekday at
// midnight so a multi-day chart reads without a separate date axis.
function timeTicks(min, max, width) {
  const hours = (max - min) / 3600000;
  const target = Math.max(2, Math.min(8, Math.round(width / 90)));
  const steps = [1, 2, 3, 6, 12, 24, 48];
  const stepH = steps.find((s) => hours / s <= target) || 48;
  const out = [];
  const d = new Date(min);
  d.setMinutes(0, 0, 0);
  while (d.getHours() % stepH !== 0) d.setHours(d.getHours() + 1);
  for (let t = d.getTime(); t <= max; t += stepH * 3600000) {
    const dt = new Date(t);
    const midnight = dt.getHours() === 0;
    out.push({
      t,
      label: midnight
        ? dt.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()
        : String(dt.getHours()).padStart(2, "0"),
      major: midnight
    });
  }
  return out;
}

function pathFor(points, sx, sy, stepped) {
  let d = "";
  let pen = false;
  let prev = null;
  for (const [t, v] of points) {
    if (v == null || isNaN(v)) { pen = false; prev = null; continue; }   // honest gap
    const x = sx(t), y = sy(v);
    if (!pen) { d += `M${x.toFixed(1)},${y.toFixed(1)}`; pen = true; }
    else if (stepped && prev) d += `L${x.toFixed(1)},${prev.toFixed(1)}L${x.toFixed(1)},${y.toFixed(1)}`;
    else d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    prev = y;
  }
  return d;
}

export function chart(container, spec) {
  container.classList.add("chart");
  let current = spec;
  let ro = null;

  const readout = document.createElement("div");
  readout.className = "readout";
  const holder = document.createElement("div");
  holder.className = "plot";
  container.replaceChildren(readout, holder);

  function render() {
    const s = current;
    const width = Math.max(220, container.clientWidth || 320);
    const height = s.height || 170;
    holder.replaceChildren();

    const series = (s.series || []).filter(Boolean);
    const all = series.flatMap((x) => (x.type === "band" ? [...(x.lo || []), ...(x.hi || [])] : (x.data || [])));
    if (!all.length) {
      const empty = document.createElement("div");
      empty.className = "chartempty";
      empty.textContent = "NO DATA";
      holder.append(empty);
      return;
    }

    const xMin = (s.x && s.x.min) != null ? s.x.min : Math.min(...all.map((p) => p[0]));
    const xMax = (s.x && s.x.max) != null ? s.x.max : Math.max(...all.map((p) => p[0]));
    const hasY2 = series.some((x) => (x.axis || "y") === "y2");
    const padR = hasY2 ? 34 : PAD.right;

    const yE = extent(series, "y") || [0, 1];
    const y2E = extent(series, "y2") || [0, 1];
    // A declared min is a floor, not just a starting value: the 12% headroom
    // below the data must never push the axis through it into impossible
    // territory (negative rainfall, a negative AQI).
    const yFloor = s.y && s.y.min != null ? s.y.min : null;
    let yLo = yFloor != null ? yFloor : yE[0] - (yE[1] - yE[0]) * 0.12;
    let yHi = (s.y && s.y.max) != null ? s.y.max : yE[1] + (yE[1] - yE[0]) * 0.12;
    if (yFloor != null && yHi <= yFloor) yHi = yFloor + 1;   // flat series sitting on the floor
    const y2Lo = (s.y2 && s.y2.min) != null ? s.y2.min : 0;
    const y2Hi = (s.y2 && s.y2.max) != null ? s.y2.max : Math.max(1, y2E[1]);

    const plotW = width - PAD.left - padR;
    const plotH = height - PAD.top - PAD.bottom;
    const sx = (t) => PAD.left + ((t - xMin) / Math.max(1, xMax - xMin)) * plotW;
    const sy = (v) => PAD.top + (1 - (v - yLo) / Math.max(1e-9, yHi - yLo)) * plotH;
    const sy2 = (v) => PAD.top + (1 - (v - y2Lo) / Math.max(1e-9, y2Hi - y2Lo)) * plotH;
    const scaleFor = (ser) => ((ser.axis || "y") === "y2" ? sy2 : sy);

    const root = svg("svg", { width: "100%", height, viewBox: `0 0 ${width} ${height}` });

    // everything right of NOW is a forecast — tint it to rhyme with the radar timeline
    if (s.now != null && s.now < xMax) {
      root.append(svg("rect", {
        class: "future",
        x: sx(Math.max(s.now, xMin)), y: PAD.top,
        width: Math.max(0, sx(xMax) - sx(Math.max(s.now, xMin))), height: plotH
      }));
    }

    const grid = svg("g", { class: "grid" });
    for (const tk of niceTicks(yLo, yHi, 4)) {
      const y = sy(tk);
      if (y < PAD.top - 1 || y > PAD.top + plotH + 1) continue;
      grid.append(svg("line", { x1: PAD.left, y1: y, x2: PAD.left + plotW, y2: y }));
      const lbl = svg("text", { x: PAD.left - 5, y: y + 3, "text-anchor": "end" });
      lbl.textContent = String(tk);
      root.append(lbl);
    }
    for (const tk of timeTicks(xMin, xMax, plotW)) {
      const x = sx(tk.t);
      if (x < PAD.left - 1 || x > PAD.left + plotW + 1) continue;
      grid.append(svg("line", { x1: x, y1: PAD.top, x2: x, y2: PAD.top + plotH }));
      const lbl = svg("text", { x, y: height - 5, "text-anchor": "middle", class: tk.major ? "major" : "" });
      lbl.textContent = tk.label;
      root.append(lbl);
    }
    root.insertBefore(grid, root.firstChild);

    if (hasY2 && s.y2 && s.y2.unit) {
      const u = svg("text", { x: width - 4, y: PAD.top + 4, "text-anchor": "end" });
      u.textContent = s.y2.unit;
      root.append(u);
    }
    if (s.y && s.y.unit) {
      const u = svg("text", { x: 2, y: PAD.top + 4 });
      u.textContent = s.y.unit;
      root.append(u);
    }

    // bands first, then bars, then lines — highest-signal marks on top
    for (const ser of series.filter((x) => x.type === "band")) {
      const scale = scaleFor(ser);
      const hi = (ser.hi || []).filter((p) => p[1] != null);
      const lo = (ser.lo || []).filter((p) => p[1] != null);
      if (!hi.length || !lo.length) continue;
      let d = pathFor(hi, sx, scale, false);
      for (let i = lo.length - 1; i >= 0; i--) d += `L${sx(lo[i][0]).toFixed(1)},${scale(lo[i][1]).toFixed(1)}`;
      root.append(svg("path", {
        d: d + "Z", fill: token(ser.token, "#F5C542"),
        "fill-opacity": ser.alpha == null ? 0.18 : ser.alpha, stroke: "none"
      }));
    }
    for (const ser of series.filter((x) => x.type === "bars")) {
      const scale = scaleFor(ser);
      const pts = (ser.data || []).filter((p) => p[1] != null);
      const bw = Math.max(1.5, (plotW / Math.max(1, pts.length)) * 0.6);
      const base = scale(ser.axis === "y2" ? y2Lo : yLo);
      for (const [t, v] of pts) {
        const y = scale(v);
        root.append(svg("rect", {
          x: sx(t) - bw / 2, y: Math.min(y, base), width: bw,
          height: Math.max(0.5, Math.abs(base - y)),
          fill: token(ser.token, "#8FC7F5"), "fill-opacity": ser.alpha == null ? 0.55 : ser.alpha
        }));
      }
    }
    for (const ser of series.filter((x) => x.type === "line" || x.type === "steps")) {
      const d = pathFor(ser.data || [], sx, scaleFor(ser), ser.type === "steps");
      if (!d) continue;
      root.append(svg("path", {
        d, fill: "none", stroke: token(ser.token, "#53C7F0"),
        "stroke-width": ser.width || 1.5, "stroke-linejoin": "round", "stroke-linecap": "round",
        "stroke-dasharray": ser.dash || ""
      }));
    }

    if (s.now != null && s.now > xMin && s.now < xMax) {
      root.append(svg("line", {
        class: "nowline", x1: sx(s.now), y1: PAD.top, x2: sx(s.now), y2: PAD.top + plotH
      }));
    }

    if (s.cursor !== false) attachCursor(root, s, series, sx, xMin, xMax, plotW, plotH);
    holder.append(root);
  }

  // The chart owns the gesture once a finger goes down on it: pointerdown
  // captures the pointer (so a drag that leaves the hit rect, or a page
  // scroll attempt, doesn't hand the gesture to the board's overflow-y:auto
  // scroller) and touch-action:none (see charts.css) stops the browser from
  // even trying to claim the touch for scrolling in the first place. Before
  // this, a touch-drag got claimed for scrolling mid-gesture, which fired
  // pointerleave/pointercancel on the hit rect and ran the old clear() —
  // that's the reported "line snaps to the far left" bug (clear() parked the
  // line at x=-10).
  //
  // Idle (no pointer interacting) now parks the line at NOW instead of
  // hiding it, both on first render and after every re-render/resize, since
  // render() re-runs attachCursor() from scratch each time and this function
  // ends by parking. setCursor() is the single place that positions the line
  // and fills the readout, so the pointer path and the idle path can never
  // drift apart.
  function attachCursor(root, s, series, sx, xMin, xMax, plotW, plotH) {
    const line = svg("line", { class: "cursorline", y1: PAD.top, y2: PAD.top + plotH, x1: -10, x2: -10 });
    root.append(line);
    // The hit rect only has to be hit-testable; the touch-action that keeps the
    // browser from stealing the drag lives on .plot/svg in charts.css, because
    // touch-action has no effect on inner SVG elements.
    const hit = svg("rect", {
      class: "hitarea", x: PAD.left, y: PAD.top, width: plotW, height: plotH,
      fill: "transparent", style: "cursor:crosshair"
    });

    function setCursor(t) {
      const cx = sx(t);
      line.setAttribute("x1", cx);
      line.setAttribute("x2", cx);
      const when = new Date(t);
      const parts = [document.createTextNode(
        String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0") + "  "
      )];
      for (const ser of series) {
        if (!ser.label) continue;
        const list = ser.type === "band" ? (ser.hi || []) : (ser.data || []);
        const near = nearest(list, t);
        const span = document.createElement("span");
        span.style.color = token(ser.token, "#53C7F0");
        span.textContent = ser.label + " " + (near == null ? "--" : Math.round(near * 10) / 10) + "  ";
        parts.push(span);
      }
      readout.replaceChildren(...parts);
    }

    const clear = () => { line.setAttribute("x1", -10); line.setAttribute("x2", -10); readout.replaceChildren(); };

    // Same visibility rule as the dashed .nowline itself, so the idle cursor
    // always lines up with it (or, when now is off-chart, both stay hidden).
    const parkAtNow = () => {
      if (s.now != null && s.now > xMin && s.now < xMax) setCursor(s.now);
      else clear();
    };

    const timeAt = (clientX) => {
      const box = root.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * (root.viewBox.baseVal.width || box.width);
      return xMin + ((px - PAD.left) / Math.max(1, plotW)) * (xMax - xMin);
    };

    // A drag that starts at a screen edge is the board deck's swipe, not a scrub.
    // Declining it here (rather than letting both run) keeps the cursor from
    // lurching sideways while the user is swiping to the next board.
    const fromEdge = (x) =>
      x <= EDGE_SWIPE_PX || x >= (window.innerWidth || 0) - EDGE_SWIPE_PX;

    let activeId = null;
    let yielded = false;          // true while an edge gesture is in progress
    hit.addEventListener("pointerdown", (e) => {
      if (fromEdge(e.clientX)) { yielded = true; return; }
      yielded = false;
      activeId = e.pointerId;
      hit.setPointerCapture(e.pointerId);
      setCursor(timeAt(e.clientX));           // a tap reads out a value, not just a drag
      e.preventDefault();
    });
    hit.addEventListener("pointermove", (e) => {
      if (yielded) return;                    // the deck owns this gesture
      // Mouse hover (no button down, never captured) tracks continuously,
      // same as before; a captured touch/pen drag keeps updating too.
      setCursor(timeAt(e.clientX));
    });
    const release = (e) => {
      if (yielded) { yielded = false; return; }
      if (activeId != null && e.pointerId !== activeId) return;
      activeId = null;
      parkAtNow();
    };
    hit.addEventListener("pointerup", release);
    hit.addEventListener("pointercancel", release);
    hit.addEventListener("lostpointercapture", release);
    hit.addEventListener("pointerleave", (e) => {
      if (activeId != null) return;   // boundary noise during a captured drag — ignore
      parkAtNow();
    });
    root.append(hit);

    parkAtNow();   // initial state, and restored on every re-render/resize
  }

  function nearest(list, t) {
    let best = null, bestD = Infinity;
    for (const [pt, v] of list) {
      if (v == null) continue;
      const d = Math.abs(pt - t);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  render();
  if (window.ResizeObserver) {
    let w = container.clientWidth;
    ro = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - w) < 8) return;   // ignore sub-pixel churn
      w = container.clientWidth;
      render();
    });
    ro.observe(container);
  }

  return {
    update(next) { current = next; render(); },
    destroy() { if (ro) ro.disconnect(); container.replaceChildren(); }
  };
}
