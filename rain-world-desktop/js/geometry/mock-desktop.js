// Mock Windows desktop for prototyping in a browser: draggable/resizable
// windows, movable desktop icons and a taskbar. Every element marked
// .rw-solid is reported to the engine as geometry, exactly the way the real
// Windows helper will report window, icon and taskbar rectangles.
(function () {
  'use strict';
  const RW = window.RW;

  const ICONS = {
    pc: '<svg viewBox="0 0 48 48"><rect x="6" y="9" width="36" height="24" rx="2" fill="#3b8fe6"/><rect x="9" y="12" width="30" height="18" fill="#9fd3ff"/><rect x="19" y="34" width="10" height="4" fill="#5a6b7c"/><rect x="13" y="38" width="22" height="3" rx="1" fill="#7c8da0"/></svg>',
    bin: '<svg viewBox="0 0 48 48"><path d="M13 14h22l-2.5 28h-17z" fill="#cfe3f3" stroke="#7fa4c2" stroke-width="1.5"/><rect x="11" y="10" width="26" height="4" rx="1" fill="#9fbad1"/><path d="M19 19v18M24 19v18M29 19v18" stroke="#7fa4c2" stroke-width="1.5"/></svg>',
    folder: '<svg viewBox="0 0 48 48"><path d="M5 12h14l4 4h20v22H5z" fill="#e8b33c"/><path d="M5 18h38v20H5z" fill="#f7cd5a"/></svg>',
    xlsx: '<svg viewBox="0 0 48 48"><path d="M11 5h19l9 9v29H11z" fill="#fff" stroke="#9aa" stroke-width="1"/><rect x="6" y="18" width="20" height="18" rx="2" fill="#1d7a46"/><path d="M11 22l10 10M21 22L11 32" stroke="#fff" stroke-width="2.5"/></svg>',
    pdf: '<svg viewBox="0 0 48 48"><path d="M11 5h19l9 9v29H11z" fill="#fff" stroke="#9aa" stroke-width="1"/><rect x="6" y="20" width="24" height="13" rx="2" fill="#c8302a"/><text x="18" y="30" font-size="8" font-family="Segoe UI,Arial" fill="#fff" text-anchor="middle" font-weight="bold">PDF</text></svg>',
    slug: '<svg viewBox="0 0 48 48"><rect x="4" y="4" width="40" height="40" rx="8" fill="#20262a"/><circle cx="24" cy="21" r="9" fill="#f1f1f4"/><path d="M17 26q7 16 14 0z" fill="#f1f1f4"/><ellipse cx="21" cy="21" rx="1.6" ry="2.8" fill="#111"/><ellipse cx="27" cy="21" rx="1.6" ry="2.8" fill="#111"/></svg>',
  };

  const DESKTOP_ICONS = [
    ['This PC', 'pc'],
    ['Recycle Bin', 'bin'],
    ['Documents', 'folder'],
    ['Budget.xlsx', 'xlsx'],
    ['Manual.pdf', 'pdf'],
    ['Rain World', 'slug'],
  ];

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html; /* static markup only */
    return e;
  }

  class MockDesktop {
    constructor(root) {
      this.root = root;
      this.cursor = { x: -9999, y: -9999, inside: false };
      this.clicks = [];
      this.z = 10;
      this.windows = [];
      this.build();
      this.bindPointer();
    }

    build() {
      const root = this.root;
      // Icons
      const icons = el('div', 'icons');
      DESKTOP_ICONS.forEach(([label, kind], i) => {
        const ic = el('div', 'icon rw-solid', `<div class="icon-img">${ICONS[kind]}</div><div class="icon-label">${label}</div>`);
        ic.dataset.solidId = 'icon-' + i;
        ic.dataset.kind = 'icon';
        ic.style.left = '10px';
        ic.style.top = 8 + i * 96 + 'px';
        this.makeDraggable(ic, ic);
        icons.appendChild(ic);
      });
      root.appendChild(icons);

      // Windows
      const W = window.innerWidth;
      const H = window.innerHeight;
      this.addWindow('explorer', 'Documents', this.explorerHtml(), W * 0.16, H * 0.1, Math.min(640, W * 0.4), Math.min(400, H * 0.42));
      this.addWindow('notepad', 'readme.txt — Notepad', this.notepadHtml(), W * 0.6, H * 0.18, Math.min(470, W * 0.3), Math.min(300, H * 0.34));
      this.addWindow('tasks', 'Task Manager', this.tasksHtml(), W * 0.36, H * 0.6, Math.min(420, W * 0.26), Math.min(210, H * 0.24));

      // Taskbar
      const tb = el('div', 'taskbar rw-solid');
      tb.dataset.solidId = 'taskbar';
      tb.dataset.kind = 'taskbar';
      const mid = el('div', 'tb-mid');
      mid.appendChild(el('div', 'tb-btn tb-start', '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="9" height="9" fill="#4cc2ff"/><rect x="13" y="2" width="9" height="9" fill="#4cc2ff"/><rect x="2" y="13" width="9" height="9" fill="#4cc2ff"/><rect x="13" y="13" width="9" height="9" fill="#4cc2ff"/></svg>'));
      for (const w of this.windows) {
        const b = el('div', 'tb-btn tb-app on', w.icon);
        b.title = w.title;
        b.addEventListener('click', () => this.toggleWindow(w, b));
        w.tbBtn = b;
        mid.appendChild(b);
      }
      tb.appendChild(mid);
      const clock = el('div', 'tb-clock');
      tb.appendChild(clock);
      const tick = () => {
        const d = new Date();
        clock.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '\n' + d.toLocaleDateString();
      };
      tick();
      setInterval(tick, 10000);
      root.appendChild(tb);
    }

    addWindow(id, title, body, x, y, w, h) {
      const icon = id === 'explorer' ? ICONS.folder : id === 'notepad' ? ICONS.xlsx.replace('#1d7a46', '#3b6ea8') : ICONS.pc;
      const win = el('div', 'win rw-solid');
      win.dataset.solidId = 'win-' + id;
      win.dataset.kind = 'window';
      win.style.left = Math.round(x) + 'px';
      win.style.top = Math.round(y) + 'px';
      win.style.width = Math.round(w) + 'px';
      win.style.height = Math.round(h) + 'px';
      win.style.zIndex = ++this.z;
      const bar = el('div', 'win-bar', `<span class="win-ico">${icon}</span><span class="win-title">${title}</span>`);
      const ctrls = el('div', 'win-ctrls');
      const min = el('div', 'win-c', '&#x2013;');
      const max = el('div', 'win-c', '&#x25A1;');
      const close = el('div', 'win-c win-x', '&#x2715;');
      ctrls.append(min, max, close);
      bar.appendChild(ctrls);
      win.appendChild(bar);
      win.appendChild(el('div', 'win-body', body));
      const grip = el('div', 'win-resize');
      win.appendChild(grip);
      this.root.appendChild(win);
      const rec = { id, title, el: win, icon };
      this.windows.push(rec);
      win.addEventListener('pointerdown', () => (win.style.zIndex = ++this.z));
      this.makeDraggable(win, bar);
      this.makeResizable(win, grip);
      min.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleWindow(rec, rec.tbBtn, false);
      });
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleWindow(rec, rec.tbBtn, false);
      });
      max.addEventListener('click', (e) => {
        e.stopPropagation();
        if (rec.restore) {
          Object.assign(win.style, rec.restore);
          rec.restore = null;
        } else {
          rec.restore = { left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height };
          Object.assign(win.style, { left: '0px', top: '0px', width: window.innerWidth + 'px', height: window.innerHeight - 48 + 'px' });
        }
      });
      return rec;
    }

    toggleWindow(w, btn, force) {
      const show = force === undefined ? w.el.style.display === 'none' : force;
      w.el.style.display = show ? '' : 'none';
      if (btn) btn.classList.toggle('on', show);
      if (show) w.el.style.zIndex = ++this.z;
    }

    makeDraggable(target, handle) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.win-c')) return;
        e.preventDefault();
        const sx = e.clientX;
        const sy = e.clientY;
        const ox = target.offsetLeft;
        const oy = target.offsetTop;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          target.style.left = ox + ev.clientX - sx + 'px';
          target.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }

    makeResizable(win, grip) {
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX;
        const sy = e.clientY;
        const ow = win.offsetWidth;
        const oh = win.offsetHeight;
        grip.setPointerCapture(e.pointerId);
        const move = (ev) => {
          win.style.width = Math.max(200, ow + ev.clientX - sx) + 'px';
          win.style.height = Math.max(120, oh + ev.clientY - sy) + 'px';
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
      });
    }

    bindPointer() {
      window.addEventListener('pointermove', (e) => {
        this.cursor.x = e.clientX;
        this.cursor.y = e.clientY;
        this.cursor.inside = true;
      });
      document.addEventListener('pointerleave', () => (this.cursor.inside = false));
      window.addEventListener('blur', () => (this.cursor.inside = false));
      window.addEventListener('pointerdown', (e) => {
        // Clicking bare wallpaper (not a window, icon, taskbar or panel) drops food.
        if (e.target.id === 'wallpaper' || e.target === this.root) this.clicks.push({ x: e.clientX, y: e.clientY });
      });
    }

    // Engine interface
    poll() {
      const rects = [];
      for (const e of this.root.querySelectorAll('.rw-solid')) {
        if (e.style.display === 'none' || !e.offsetParent) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        rects.push({ id: e.dataset.solidId, kind: e.dataset.kind, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
      }
      const clicks = this.clicks;
      this.clicks = [];
      return { rects, cursor: this.cursor, clicks };
    }

    explorerHtml() {
      const rows = [
        ['Photos', 'folder', '9/28/2026'],
        ['Music', 'folder', '9/30/2026'],
        ['Projects', 'folder', '10/1/2026'],
        ['Budget.xlsx', 'xlsx', '10/2/2026'],
        ['Manual.pdf', 'pdf', '9/22/2026'],
        ['Recipes.xlsx', 'xlsx', '9/19/2026'],
        ['Field Guide to Lizards.pdf', 'pdf', '9/12/2026'],
      ];
      return (
        '<div class="ex-side"><div>Home</div><div>Desktop</div><div class="sel">Documents</div><div>Downloads</div><div>This PC</div></div>' +
        '<div class="ex-main"><div class="ex-head"><span>Name</span><span>Date modified</span></div>' +
        rows.map((r) => `<div class="ex-row"><span><i>${ICONS[r[1]]}</i>${r[0]}</span><span>${r[2]}</span></div>`).join('') +
        '</div>'
      );
    }

    notepadHtml() {
      return (
        '<pre class="np">rain world desktop — prototype\n\n' +
        '· drag these windows around: they are\n  ledges and walls for the creatures\n' +
        '· click bare wallpaper to drop a fruit\n' +
        '· rest the cursor near a lizard...\n' +
        '· press ` (backtick) for the ecosystem\n  panel: spawn weights, caps, rain\n\n' +
        'the rain comes at the end of each cycle.\n' +
        'everything takes shelter.</pre>'
      );
    }

    tasksHtml() {
      return (
        '<div class="tm"><div class="tm-row tm-h"><span>Name</span><span>CPU</span></div>' +
        '<div class="tm-row"><span>Rain World Desktop</span><span>2.1%</span></div>' +
        '<div class="tm-row"><span>Web Browser</span><span>6.4%</span></div>' +
        '<div class="tm-row"><span>Music Player</span><span>1.2%</span></div>' +
        '<div class="tm-row"><span>Photos</span><span>0.8%</span></div></div>'
      );
    }
  }

  RW.MockDesktop = MockDesktop;
})();
