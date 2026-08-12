// View state, pub/sub bus, overlay stack, and the history sentinel that makes
// Escape and the Android Back button walk backwards through the UI.

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
const overlays = [];          // e.g. ["settings"] — topmost last

export function getView() { return view; }
export function getBoard() { return board; }
export function overlayOpen(name) { return name ? overlays.includes(name) : overlays.length > 0; }

export function init(screen) {
  screenEl = screen;
  screenEl.dataset.view = view;
  history.replaceState({ sw: "root" }, "");
  window.addEventListener("popstate", onPop);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (overlays.length || view !== View.RADAR)) {
      e.preventDefault();
      goBack();
    }
  });
}

export function setView(v, b) {
  const wasRoot = view === View.RADAR && overlays.length === 0;
  view = v;
  if (b) board = b;
  screenEl.dataset.view = view;
  if (view === View.BOARD) screenEl.dataset.board = board;
  else delete screenEl.dataset.board;
  if (view !== View.RADAR && wasRoot) history.pushState({ sw: "view" }, "");
  emit("view", { view, board });
}

export function openOverlay(name) {
  if (overlays.includes(name)) return;
  overlays.push(name);
  screenEl.classList.add(name);
  history.pushState({ sw: "overlay" }, "");
  emit("overlay", { name, open: true });
}
export function closeOverlay(name) {
  // programmatic close — collapse the history entry it pushed
  if (overlays.includes(name)) history.back();
}

export function goBack() { history.back(); }

function onPop() {
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
  // at root: let the platform handle it (Android exits, browser navigates away)
}
