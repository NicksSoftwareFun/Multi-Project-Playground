// Board deck: full-screen data boards (NOW, SEVERE, …) that swipe left/right.
// Modules register a board and own its rendering; the deck owns navigation.

import { el } from "./util.js";
import * as state from "./state.js";
import { View } from "./state.js";

const boards = [];        // [{ id, label, el, render, onEnter }]
let deckEl, dotsEl;
let currentId = null;

export function register(board) {
  if (boards.some((b) => b.id === board.id)) return;
  boards.push(board);
  if (deckEl) renderDots();
}

export function ids() { return boards.map((b) => b.id); }
export function current() { return currentId; }

export function show(id) {
  const b = boards.find((x) => x.id === id) || boards[0];
  if (!b) return;
  currentId = b.id;
  for (const other of boards) other.el.classList.toggle("active", other.id === b.id);
  renderDots();
  state.setView(View.BOARD, b.id);
  if (b.render) b.render();
  if (b.onEnter) b.onEnter();
}

export function step(delta) {
  const i = boards.findIndex((b) => b.id === currentId);
  const nx = boards[(i + delta + boards.length) % boards.length];
  if (nx) show(nx.id);
}

export function init() {
  deckEl = document.getElementById("boards");
  dotsEl = document.getElementById("boardDots");

  // The deck is entered by tapping the conditions panel (wx.js); the side rail
   // now carries the locations button instead. Kept as an exported call so any
   // other entry point — the alert chip, a future kiosk mode — still works.

  // A horizontal drag inside a chart is a cursor scrub, not a board swipe, and
  // a vertical drag inside one must not dismiss the deck either.

  // horizontal swipe between boards; vertical swipe down leaves the deck
  let sx = 0, sy = 0, tracking = false;
  deckEl.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || e.target.closest("a")) return;
    if (e.target.closest(".chart")) return;
    tracking = true; sx = e.clientX; sy = e.clientY;
  });
  deckEl.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) state.goBack();
  });

  window.addEventListener("keydown", (e) => {
    if (state.getView() !== View.BOARD || state.overlayOpen()) return;
    if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  });

  // keep deck state in sync when the view changes from elsewhere (auto mode, Back)
  state.on("view", ({ view, board }) => {
    if (view !== View.BOARD) return;
    if (board && board !== currentId) show(board);
  });

  renderDots();
}

function renderDots() {
  if (!dotsEl) return;
  dotsEl.replaceChildren(...boards.map((b) => {
    const dot = el("button", {
      class: "dot" + (b.id === currentId ? " on" : ""),
      "aria-label": b.label
    }, b.label);
    dot.addEventListener("click", () => show(b.id));
    return dot;
  }));
}
