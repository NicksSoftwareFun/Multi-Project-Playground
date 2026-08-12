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

  // Gesture handling: horizontal swipe steps between boards, downward swipe
  // leaves the deck. Two rules keep it from firing when the user meant
  // something else, both learned from real misfires:
  //
  // 1. EVERY exit path must clear `tracking`. It used to be left set whenever
  //    pointerdown landed on a control, and whenever a gesture ended somewhere
  //    other than the deck (finger lifted off-element, pointer cancelled by a
  //    scroll). A stale `tracking` kept stale start coordinates alive, so the
  //    next tap on a dot — which sits at the BOTTOM of the screen — measured
  //    itself against a start point far above, read as a long downward swipe,
  //    and dropped the user back to the radar. That is the "sometimes tapping
  //    the bottom buttons goes back" bug.
  // 2. Downward swipe only dismisses from the top of the board. Otherwise the
  //    ordinary gesture for scrolling a long board *is* the dismiss gesture.
  let sx = 0, sy = 0, sTop = 0, pid = null, tracking = false;
  const stop = () => { tracking = false; pid = null; };
  const onControl = (t) => !!(t && t.closest && (t.closest("button") || t.closest("a") || t.closest(".chart")));

  deckEl.addEventListener("pointerdown", (e) => {
    if (onControl(e.target)) { stop(); return; }
    tracking = true;
    pid = e.pointerId;
    sx = e.clientX; sy = e.clientY;
    const b = deckEl.querySelector(".board.active");
    sTop = b ? b.scrollTop : 0;
  });
  deckEl.addEventListener("pointerup", (e) => {
    if (!tracking || e.pointerId !== pid) { stop(); return; }
    stop();
    if (onControl(e.target)) return;      // released on a control: a tap, never a swipe
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { step(dx < 0 ? 1 : -1); return; }
    if (dy > 80 && Math.abs(dy) > Math.abs(dx) && sTop === 0) state.goBack();
  });
  deckEl.addEventListener("pointercancel", stop);
  // Bubbles after the deck's own handler, so a gesture that ends anywhere else
  // — off the element, over another layer — can never leave `tracking` set.
  window.addEventListener("pointerup", stop);

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
