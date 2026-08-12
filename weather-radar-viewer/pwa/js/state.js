// View state, pub/sub bus, overlay stack, and the history sentinel that makes
// Escape and the Android Back button walk backwards through the UI.
//
// Navigation model: "root" is the radar view with nothing open. Any time the UI
// is away from root we hold exactly ONE history entry. Pressing Back consumes
// it, we unwind one level (topmost overlay, else the view), and if we are still
// away from root we re-arm. One entry rather than one-per-level keeps the stack
// honest no matter what order views and overlays were opened in — an earlier
// version pushed only on view changes and could strand you on a board with no
// way back once a drawer had been opened first.

export const View = Object.freeze({ RADAR: "radar", SAT: "sat", BOARD: "board" });
export const Board = Object.freeze({
  NOW: "now", CAST: "cast", SEVERE: "severe", AIR: "air", ALMANAC: "almanac", SKY: "sky"
});

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, data) {
  const set = listeners.get(evt);
  if (set) for (const fn of set) fn(data);
}

let screenEl = null;
let view = View.RADAR;
let board = Board.NOW;
const overlays = [];          // e.g. ["layers"] — topmost last
let armed = false;            // true while we hold the history entry

export function getView() { return view; }
export function getBoard() { return board; }
export function overlayOpen(name) { return name ? overlays.includes(name) : overlays.length > 0; }

function atRoot() { return view === View.RADAR && overlays.length === 0; }

function arm() {
  if (!atRoot() && !armed) {
    history.pushState({ sw: 1 }, "");
    armed = true;
  }
}

export function init(screen) {
  screenEl = screen;
  screenEl.dataset.view = view;
  history.replaceState({ sw: "root" }, "");
  window.addEventListener("popstate", onPop);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !atRoot()) {
      e.preventDefault();
      goBack();
    }
  });
}

export function setView(v, b) {
  view = v;
  if (b) board = b;
  screenEl.dataset.view = view;
  if (view === View.BOARD) screenEl.dataset.board = board;
  else delete screenEl.dataset.board;
  // Map-only drawers make no sense over a full-screen view; close them so Back
  // means "leave this view" rather than "close a drawer you can't even see".
  if (view !== View.RADAR && overlays.length) closeAllOverlays();
  arm();
  emit("view", { view, board });
}

export function openOverlay(name) {
  if (overlays.includes(name)) return;
  overlays.push(name);
  screenEl.classList.add(name);
  arm();
  emit("overlay", { name, open: true });
}

export function closeOverlay(name) {
  const i = overlays.indexOf(name);
  if (i < 0) return;
  overlays.splice(i, 1);
  screenEl.classList.remove(name);
  emit("overlay", { name, open: false });
  if (atRoot() && armed) history.back();   // give the entry back
}

function closeAllOverlays() {
  while (overlays.length) {
    const name = overlays.pop();
    screenEl.classList.remove(name);
    emit("overlay", { name, open: false });
  }
}

export function goBack() {
  if (armed) history.back();               // unwinds through onPop
  else unwindOne();
}

function unwindOne() {
  if (overlays.length) {
    const name = overlays.pop();
    screenEl.classList.remove(name);
    emit("overlay", { name, open: false });
    return;
  }
  if (view !== View.RADAR) {
    view = View.RADAR;
    screenEl.dataset.view = view;
    delete screenEl.dataset.board;
    emit("view", { view, board });
  }
}

function onPop() {
  armed = false;        // the entry we held is gone
  unwindOne();
  arm();                // still away from root? take another
}
