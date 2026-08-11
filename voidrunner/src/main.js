// Boot, screens and the frame loop.

import { Game, STATE } from './game.js';
import { Save } from './save.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { SHIPS, shipById } from './ships.js';
import { fmtInt, fmtDist, clamp } from './util.js';

const $ = (s) => document.querySelector(s);
const SCREENS = ['menu', 'hangar', 'settings', 'help', 'pause', 'over', 'boot'];

const canvas = $('#gl');
let game, save, audio, input, hud;
let current = 'boot';
let lastNonHud = 'menu';

/* ----------------------------- screen stack ---------------------------- */

function show(name) {
  for (const s of SCREENS) $('#' + s).classList.toggle('hidden', s !== name);
  $('#hud').classList.toggle('hidden', name !== null);
  $('#hud').setAttribute('aria-hidden', name !== null);
  current = name;
  if (name && name !== 'pause' && name !== 'over' && name !== 'boot') lastNonHud = name;
}

/* -------------------------------- boot --------------------------------- */

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

function boot() {
  if (!hasWebGL()) {
    $('#bootMsg').textContent = 'This device or browser has no WebGL. VOIDRUNNER needs it to render the corridor.';
    $('.loading').style.display = 'none';
    return;
  }

  save = new Save();
  audio = new Audio();
  input = new Input(canvas);
  hud = new HUD($('#hud'));

  try {
    game = new Game({ canvas, audio, save, hud, input });
  } catch (err) {
    console.error(err);
    $('#bootMsg').textContent = 'Could not start the renderer: ' + (err && err.message ? err.message : err);
    $('.loading').style.display = 'none';
    return;
  }

  game.applySettings();
  game.onDeath = onDeath;
  game.onPalette = onPalette;
  window.__vr = game;   // debug handle: inspect the live run from the console

  wireUI();
  refreshMenu();
  game.enterMenu(currentShip());
  show(save.data.seen ? 'menu' : 'help');
  save.data.seen = true;
  save.flush();

  window.addEventListener('resize', () => game.onResize());
  window.addEventListener('orientationchange', () => setTimeout(() => game.onResize(), 250));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.state === STATE.PLAY) doPause();
      audio.suspend();
    } else audio.resume();
  });
  window.addEventListener('blur', () => { if (game.state === STATE.PLAY) doPause(); });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    $('#bootMsg').textContent = 'Graphics context lost. Reload to continue.';
    $('.loading').style.display = 'none';
    show('boot');
  });

  const unlock = () => { audio.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  requestAnimationFrame(frame);
}

/* ------------------------------ frame loop ----------------------------- */

let last = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!last) last = now;
  const dtMs = now - last;
  last = now;
  if (dtMs > 900) return;             // returned from background - skip the gap
  game.update(clamp(dtMs, 1, 50) / 1000);
  game.render();
  game.measure(dtMs);
}

/* --------------------------------- UI ---------------------------------- */

function currentShip() {
  const s = shipById(save.data.ship);
  return save.isUnlocked(s.id) ? s : SHIPS[0];
}

function onPalette(p) {
  const r = document.documentElement.style;
  r.setProperty('--accent', '#' + p.ring.getHexString());
  r.setProperty('--accent2', '#' + p.accent.getHexString());
}

function wireUI() {
  $('#playBtn').onclick = () => startRun();
  $('#retryBtn').onclick = () => startRun();
  $('#menuBtn').onclick = () => { audio.ui(false); toMenu(); };
  $('#hangarBtn').onclick = () => { audio.ui(); renderHangar(); show('hangar'); };
  $('#setBtn').onclick = () => { audio.ui(); renderSettings(); show('settings'); };
  $('#helpBtn').onclick = () => { audio.ui(); show('help'); };
  $('#helpGo').onclick = () => { audio.ui(); show('menu'); };
  $('#pauseBtn').onclick = () => doPause();
  $('#resumeBtn').onclick = () => { audio.ui(); show(null); game.resume(); };
  $('#quitBtn').onclick = () => { audio.ui(false); toMenu(); };
  $('#odBtn').onclick = () => game.requestOverdrive();
  for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => { audio.ui(false); show('menu'); refreshMenu(); };

  $('#wipeBtn').onclick = () => {
    if (!confirm('Erase local save? Cells, unlocks and records are all stored on this device only.')) return;
    save.wipe();
    game.applySettings();
    renderSettings();
    refreshMenu();
  };

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'p' || k === 'escape') {
      if (game.state === STATE.PLAY) doPause();
      else if (game.state === STATE.PAUSE) { show(null); game.resume(); }
    }
    if (k === 'enter' && (current === 'menu' || current === 'over')) startRun();
  });
}

function doPause() {
  if (game.state !== STATE.PLAY) return;
  game.pause();
  show('pause');
}

function startRun() {
  audio.unlock();
  audio.ui();
  show(null);
  game.startRun(currentShip());
}

function toMenu() {
  game.enterMenu(currentShip());
  refreshMenu();
  show('menu');
}

function refreshMenu() {
  const d = save.data;
  $('#mBest').textContent = fmtInt(d.best.score);
  $('#mDist').textContent = fmtDist(d.best.dist);
  $('#mSector').textContent = String(d.best.sector).padStart(2, '0');
  $('#cellBank').textContent = fmtInt(d.cells) + ' cells';
  $('#hangarBank').textContent = fmtInt(d.cells) + ' cells';
  renderContracts($('#contracts'), d.contracts, false);

  const canBuy = SHIPS.some((s) => !save.isUnlocked(s.id) && d.cells >= s.cost);
  $('#hangarBtn').textContent = canBuy ? 'HANGAR •' : 'HANGAR';
}

function renderContracts(el, list, done) {
  el.innerHTML = '';
  if (!list || !list.length) { el.innerHTML = '<div class="contract"><span>All clear.</span></div>'; return; }
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'contract' + (c.done ? ' done' : '');
    row.innerHTML = `<i></i><span></span><b>+${c.reward}</b>`;
    row.querySelector('span').textContent = c.text;
    el.appendChild(row);
  }
  void done;
}

function renderHangar() {
  const list = $('#shipList');
  list.innerHTML = '';
  const d = save.data;
  for (const s of SHIPS) {
    const unlocked = save.isUnlocked(s.id);
    const sel = currentShip().id === s.id;
    const card = document.createElement('div');
    card.className = 'ship' + (sel ? ' sel' : '') + (unlocked ? '' : ' locked');
    const bar = (label, v, max) => `<div class="bar">${label}<u><b style="width:${Math.round(clamp(v / max, 0, 1) * 100)}%"></b></u></div>`;
    card.innerHTML = `
      <div class="ship-top"><h3></h3><em>${unlocked ? (sel ? 'ACTIVE' : 'READY') : fmtInt(s.cost) + ' CELLS'}</em></div>
      <p></p>
      <div class="bars">
        ${bar('TURN', s.stats.handling, 1.4)}
        ${bar('HULL', s.stats.shields, 5)}
        ${bar('PULL', s.stats.magnet, 2)}
        ${bar('GAIN', s.stats.score, 1.3)}
      </div>`;
    card.querySelector('h3').textContent = s.name;
    card.querySelector('p').textContent = s.blurb;

    if (!unlocked) {
      const b = document.createElement('button');
      b.className = 'btn' + (d.cells >= s.cost ? ' primary' : '');
      b.textContent = d.cells >= s.cost ? 'UNLOCK' : `NEED ${fmtInt(s.cost - d.cells)} MORE`;
      b.disabled = d.cells < s.cost;
      b.onclick = (e) => {
        e.stopPropagation();
        if (!save.spend(s.cost)) return;
        save.unlock(s.id);
        save.data.ship = s.id;
        save.flush();
        audio.multUp(4);
        renderHangar();
        refreshMenu();
        game.enterMenu(currentShip());
      };
      card.appendChild(b);
    } else {
      card.onclick = () => {
        save.data.ship = s.id;
        save.flush();
        audio.ui();
        renderHangar();
        game.enterMenu(currentShip());
      };
    }
    list.appendChild(card);
  }
}

function renderSettings() {
  const s = save.settings;
  const bind = (id, key) => {
    const el = $(id);
    el.checked = !!s[key];
    el.onchange = () => { save.setSetting(key, el.checked); game.applySettings(); audio.ui(el.checked); };
  };
  bind('#setMusic', 'music');
  bind('#setSfx', 'sfx');
  bind('#setHaptics', 'haptics');
  bind('#setRoll', 'roll');

  const seg = (id, key, cast = (v) => v) => {
    const wrap = $(id);
    for (const b of wrap.children) {
      const val = cast(b.dataset.v);
      b.classList.toggle('on', String(s[key]) === String(val));
      b.onclick = () => {
        save.setSetting(key, val);
        game.applySettings();
        audio.ui();
        renderSettings();
      };
    }
  };
  seg('#setMode', 'mode');
  seg('#setSens', 'sens', Number);
  seg('#setQuality', 'quality');
}

/* ------------------------------ game over ------------------------------ */

function onDeath(run) {
  const res = save.commitRun(run);
  $('#ovScore').textContent = fmtInt(run.score);
  $('#ovDist').textContent = fmtDist(run.dist);
  $('#ovCells').textContent = fmtInt(run.cells);
  $('#ovGraze').textContent = fmtInt(run.grazes);
  $('#ovMult').textContent = 'x' + run.bestMult;
  $('#ovSector').textContent = String(run.sector).padStart(2, '0');
  $('#ovOd').textContent = run.overdrives;
  $('#newBest').classList.toggle('hidden', !res.newBest);

  const cw = $('#ovContracts');
  if (res.completed.length) {
    cw.classList.remove('hidden');
    renderContracts(cw, res.completed.map((c) => ({ ...c, done: true })), true);
  } else cw.classList.add('hidden');

  save.rollContracts();
  refreshMenu();

  // Let the death animation breathe before the panel lands.
  setTimeout(() => { if (game.state === STATE.DEAD) show('over'); }, 950);
}

/* ------------------------------ service worker -------------------------- */

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is a bonus, not a requirement */ });
  });
}

boot();
