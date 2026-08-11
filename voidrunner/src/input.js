// One-thumb steering.
//
// Default is RELATIVE drag: put a thumb anywhere and the ship tracks how far
// you move it, so your hand never covers the ship and you can re-grip without
// the ship jumping. DIRECT mode maps the screen to the corridor instead.
// A second finger anywhere fires overdrive.

import { TUBE_R, SHIP_R } from './config.js';
import { clamp } from './util.js';

const LIM = TUBE_R - SHIP_R - 0.12;

// The corridor runs toward +Z and the camera looks down it, which mirrors the
// horizontal axis: the tube frame's +x lands on the LEFT of the screen. Every
// input therefore has to be mapped through this sign, or steering comes out
// backwards. (+y needs no such flip - it is genuinely up.)
const SCREEN_X = -1;

export class Input {
  constructor(el) {
    this.el = el;
    this.tx = 0; this.ty = 0;
    this.mode = 'relative';
    this.sens = 1;
    this.boostRequested = false;
    this.active = false;
    this.pointerId = null;
    this.extra = new Set();
    this.keys = new Set();
    this.lastX = 0; this.lastY = 0;
    this.enabled = false;
    this._bind();
  }

  _bind() {
    const el = this.el;
    this.onDown = (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.pointerId === null) {
        this.pointerId = e.pointerId;
        this.active = true;
        this.lastX = e.clientX; this.lastY = e.clientY;
        if (this.mode === 'direct') this._direct(e.clientX, e.clientY);
        el.setPointerCapture?.(e.pointerId);
      } else {
        this.extra.add(e.pointerId);
        this.boostRequested = true;
      }
      e.preventDefault();
    };
    this.onMove = (e) => {
      if (!this.enabled || e.pointerId !== this.pointerId) return;
      if (this.mode === 'direct') {
        this._direct(e.clientX, e.clientY);
      } else {
        const k = this._unitsPerPx();
        this.tx += SCREEN_X * (e.clientX - this.lastX) * k;
        this.ty -= (e.clientY - this.lastY) * k;
        this._clamp();
      }
      this.lastX = e.clientX; this.lastY = e.clientY;
      e.preventDefault();
    };
    this.onUp = (e) => {
      if (e.pointerId === this.pointerId) {
        this.pointerId = null;
        this.active = false;
        el.releasePointerCapture?.(e.pointerId);
      } else this.extra.delete(e.pointerId);
    };

    el.addEventListener('pointerdown', this.onDown, { passive: false });
    el.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);

    this.onKeyDown = (e) => {
      if (!this.enabled) return;
      const k = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's', ' '].includes(k)) e.preventDefault();
      if (k === ' ') this.boostRequested = true;
      this.keys.add(k);
    };
    this.onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
  }

  _unitsPerPx() {
    const span = Math.min(window.innerWidth, window.innerHeight) * 0.52;
    return (LIM * 2 * this.sens) / Math.max(120, span);
  }

  _direct(px, py) {
    const w = window.innerWidth, h = window.innerHeight;
    const s = Math.min(w, h) * 0.46 * this.sens;
    this.tx = clamp(SCREEN_X * ((px - w / 2) / s) * LIM, -LIM * 1.6, LIM * 1.6);
    this.ty = clamp((-(py - h * 0.52) / s) * LIM, -LIM * 1.6, LIM * 1.6);
    this._clamp();
  }

  _clamp() {
    const r = Math.hypot(this.tx, this.ty);
    if (r > LIM) { this.tx *= LIM / r; this.ty *= LIM / r; }
  }

  reset(x = 0, y = 0) {
    this.tx = x; this.ty = y;
    this.boostRequested = false;
    this.pointerId = null;
    this.active = false;
    this.extra.clear();
    this.keys.clear();
  }

  /** Keyboard nudge, applied every frame. */
  tick(dt) {
    if (!this.keys.size) return;
    const v = LIM * 2.6 * dt;
    if (this.keys.has('arrowleft') || this.keys.has('a')) this.tx -= SCREEN_X * v;
    if (this.keys.has('arrowright') || this.keys.has('d')) this.tx += SCREEN_X * v;
    if (this.keys.has('arrowup') || this.keys.has('w')) this.ty += v;
    if (this.keys.has('arrowdown') || this.keys.has('s')) this.ty -= v;
    this._clamp();
  }

  consumeBoost() {
    const b = this.boostRequested;
    this.boostRequested = false;
    return b;
  }
}
