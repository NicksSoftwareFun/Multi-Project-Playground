// In-run HUD. Plain DOM on top of the canvas - crisper than 3D text, free to
// animate, and it costs the renderer nothing.

import { fmtInt, clamp } from './util.js';

export class HUD {
  constructor(root) {
    this.el = root;
    this.dist = document.querySelector('#hudDist');
    this.score = document.querySelector('#hudScore');
    this.cells = document.querySelector('#hudCells');
    this.mult = document.querySelector('#hudMult');
    this.heat = document.querySelector('#hudHeat');
    this.multWrap = document.querySelector('#hudMultWrap');
    this.shields = document.querySelector('#hudShields');
    this.odBtn = document.querySelector('#odBtn');
    this.odFill = document.querySelector('#odFill');
    this.odLabel = document.querySelector('#odLabel');
    this.banner = document.querySelector('#banner');
    this.bannerMain = document.querySelector('#bannerMain');
    this.bannerSub = document.querySelector('#bannerSub');
    this.toastWrap = document.querySelector('#toasts');
    this.vignette = document.querySelector('#vignette');
    this.sectorBar = document.querySelector('#sectorFill');
    this.sectorName = document.querySelector('#sectorName');

    this._pips = 0;
    this._mult = -1;
    this._dist = -1;
    this._score = -1;
    this._cells = -1;
    this._od = -1;
    this._ready = null;
    this._bannerT = 0;
    this.toasts = [];
  }

  setShieldMax(n, cur) {
    this.shields.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const d = document.createElement('i');
      this.shields.appendChild(d);
    }
    this._pips = n;
    this.setShields(cur);
  }

  setShields(n) {
    const kids = this.shields.children;
    for (let i = 0; i < kids.length; i++) kids[i].className = i < n ? 'on' : '';
  }

  update(s) {
    const d = Math.floor(s.dist);
    if (d !== this._dist) { this._dist = d; this.dist.textContent = d >= 1000 ? (d / 1000).toFixed(2) + ' km' : d + ' m'; }
    const sc = Math.floor(s.score);
    if (sc !== this._score) { this._score = sc; this.score.textContent = fmtInt(sc); }
    if (s.cells !== this._cells) { this._cells = s.cells; this.cells.textContent = s.cells; }

    const m = Math.floor(s.mult);
    if (m !== this._mult) {
      this._mult = m;
      this.mult.textContent = 'x' + m;
      this.multWrap.classList.toggle('hot', m >= 4);
      this.multWrap.classList.remove('pop');
      void this.multWrap.offsetWidth;
      this.multWrap.classList.add('pop');
    }
    this.heat.style.transform = `scaleX(${clamp(s.heat, 0, 1)})`;

    const od = Math.round(clamp(s.charge, 0, 1) * 100);
    if (od !== this._od) {
      this._od = od;
      this.odFill.style.height = od + '%';
    }
    const ready = s.overdrive ? 'active' : od >= 100 ? 'ready' : 'charging';
    if (ready !== this._ready) {
      this._ready = ready;
      this.odBtn.className = 'od ' + ready;
      this.odLabel.textContent = ready === 'active' ? 'BURN' : ready === 'ready' ? 'GO' : 'OD';
    }

    this.vignette.style.opacity = clamp(s.damage, 0, 1);
    if (this.sectorBar) this.sectorBar.style.transform = `scaleX(${clamp(s.sectorProgress, 0, 1)})`;
  }

  showBanner(main, sub, ms = 2200) {
    this.bannerMain.textContent = main;
    this.bannerSub.textContent = sub;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    clearTimeout(this._bt);
    this._bt = setTimeout(() => this.banner.classList.remove('show'), ms);
  }

  setSector(name) { if (this.sectorName) this.sectorName.textContent = name; }

  toast(text, cls = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.textContent = text;
    this.toastWrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 420);
    }, 900);
    while (this.toastWrap.children.length > 5) this.toastWrap.firstChild.remove();
  }

  reset() {
    this._mult = -1; this._dist = -1; this._score = -1; this._cells = -1; this._od = -1; this._ready = null;
    this.toastWrap.innerHTML = '';
    this.banner.classList.remove('show');
    this.vignette.style.opacity = 0;
  }
}
