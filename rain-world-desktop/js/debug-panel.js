// Ecosystem panel (toggle with ` or the button): spawn weights, caps and
// world/rain/debug settings. Changes apply live and are saved to localStorage.
(function () {
  'use strict';
  const RW = window.RW;
  const U = RW.U;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    for (const c of kids) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }

  class Panel {
    constructor(engine, mount, opts) {
      opts = opts || {};
      this.engine = engine;
      this.mount = mount;
      this.cfg = engine.cfg;
      this.open = false;
      this.liveEls = [];
      this.noToggleButton = !!opts.noToggleButton;
      this.build();
      setInterval(() => this.refreshLive(), 400);
      window.addEventListener('keydown', (e) => {
        if (e.key === '`' || e.key === '~') this.toggle();
      });
    }

    toggle(force) {
      this.open = force === undefined ? !this.open : force;
      this.el.classList.toggle('open', this.open);
    }

    save() {
      RW.saveConfig(this.cfg);
      if (this.onSave) this.onSave(this.cfg);
    }

    // ---- controls ----------------------------------------------------------
    slider(label, obj, key, min, max, step, onChange) {
      const val = h('span', { class: 'val', text: String(obj[key]) });
      const input = h('input', { type: 'range', min, max, step, value: obj[key] });
      input.addEventListener('input', () => {
        obj[key] = +input.value;
        val.textContent = input.value;
        this.save();
        if (onChange) onChange();
      });
      return h('label', { class: 'row' }, h('span', { class: 'lbl', text: label }), input, val);
    }
    toggleCtl(label, obj, key, onChange) {
      const input = h('input', { type: 'checkbox' });
      input.checked = !!obj[key];
      input.addEventListener('change', () => {
        obj[key] = input.checked;
        this.save();
        if (onChange) onChange();
      });
      return h('label', { class: 'row chk' }, input, h('span', { text: label }));
    }
    select(label, obj, key, options, onChange) {
      const s = h('select');
      for (const o of options) {
        const opt = h('option', { value: o, text: o });
        if (String(obj[key]) === String(o)) opt.selected = true;
        s.appendChild(opt);
      }
      s.addEventListener('change', () => {
        obj[key] = isNaN(+s.value) ? s.value : +s.value;
        this.save();
        if (onChange) onChange();
      });
      return h('label', { class: 'row' }, h('span', { class: 'lbl', text: label }), s);
    }
    census() {
      const n = {};
      for (const c of this.engine.eco.creatures) {
        if (c.dead || c.corpse) continue;
        const k = c.species.startsWith('lizard') ? 'lizards' : c.species.startsWith('centipede') ? 'centipedes' : c.species === 'daddy' ? 'daddy' : c.species === 'batfly' ? 'batflies (free)' : c.species + 's';
        n[k] = (n[k] || 0) + 1;
      }
      return Object.entries(n)
        .map(([k, v]) => `${k} ${v}`)
        .join('  ');
    }
    button(text, fn, cls) {
      return h('button', { class: cls || '', onclick: fn, text });
    }

    build() {
      const cfg = this.cfg;
      const eng = this.engine;
      this.el = h('div', { class: 'rw-panel' });
      this.mount.appendChild(this.el);
      if (!this.noToggleButton) {
        this.mount.appendChild(h('button', { class: 'rw-panel-toggle', title: 'Ecosystem panel (`)', onclick: () => this.toggle(), text: '\u2261' }));
      }

      this.el.appendChild(h('div', { class: 'ph' }, h('b', { text: 'ECOSYSTEM' }), this.button('✕', () => this.toggle(false), 'x')));
      this.stats = h('div', { class: 'stats' });
      this.el.appendChild(this.stats);

      // Species table
      const sp = h('div', { class: 'sec' }, h('div', { class: 'st', text: 'Spawn weights' }));
      const head = h('div', { class: 'sp sp-h' }, h('span'), h('span', { text: 'creature' }), h('span', { text: 'weight' }), h('span', { text: 'max' }), h('span', { text: 'now' }), h('span'));
      sp.appendChild(head);
      for (const key of Object.keys(cfg.species)) {
        const s = cfg.species[key];
        const en = h('input', { type: 'checkbox' });
        en.checked = s.enabled;
        en.addEventListener('change', () => {
          s.enabled = en.checked;
          this.save();
        });
        const wv = h('span', { class: 'val', text: String(s.weight) });
        const w = h('input', { type: 'range', min: 0, max: 10, step: 0.5, value: s.weight });
        w.addEventListener('input', () => {
          s.weight = +w.value;
          wv.textContent = w.value;
          this.save();
        });
        const mx = h('input', { type: 'number', min: 0, max: 60, value: s.max, class: 'num' });
        mx.addEventListener('change', () => {
          s.max = Math.max(0, +mx.value | 0);
          this.save();
        });
        const now = h('span', { class: 'now', text: '0' });
        this.liveEls.push(() => (now.textContent = String(eng.eco.count(key))));
        const add = this.button('+', () => {
          const c = eng.eco.spawn(key);
          if (!c) this.flash('no open den');
        }, 'add');
        add.title = 'Spawn one now (ignores caps)';
        sp.appendChild(h('div', { class: 'sp' }, en, h('span', { class: 'nm', text: s.label || key }), h('span', { class: 'wcell' }, w, wv), mx, now, add));
      }
      this.el.appendChild(sp);

      const E = cfg.ecosystem;
      this.el.appendChild(
        h('div', { class: 'sec' },
          h('div', { class: 'st', text: 'Population' }),
          this.slider('max population', E, 'maxPopulation', 0, 80, 1),
          this.slider('spawns /min', E, 'spawnPerMinute', 0.5, 30, 0.5),
          this.slider('migration /min', E, 'migrationPerMinute', 0, 1, 0.05),
          this.slider('rocks', E, 'rocks', 0, 20, 1),
          this.slider('spears', E, 'spears', 0, 10, 1),
          this.toggleCtl('predators eat prey', E, 'predation'),
          this.toggleCtl('creatures react to cursor', E, 'cursorInteraction'),
          this.toggleCtl('click wallpaper drops fruit', E, 'clickDropsFood'),
          h('div', { class: 'btns' },
            this.button('Clear all', () => {
              for (const c of eng.eco.creatures) c.remove();
            }),
            this.button('Fill now', () => eng.eco.populate()),
            this.button('Drop 5 fruit', () => {
              for (let i = 0; i < 5; i++) eng.eco.dropFood(U.rand(100, eng.W - 100), U.rand(20, 80));
            })
          )
        )
      );

      const R = cfg.rain;
      this.el.appendChild(
        h('div', { class: 'sec' },
          h('div', { class: 'st', text: 'Rain cycle' }),
          this.toggleCtl('rain', R, 'enabled'),
          this.slider('cycle (min)', R, 'cycleMinutes', 1, 30, 0.5),
          this.slider('light rain', R, 'drizzle', 0, 1, 0.01),
          this.slider('drips', R, 'drips', 0, 2, 0.05),
          this.toggleCtl('rain curtains', R, 'curtains'),
          this.toggleCtl('shelter in dens during downpour', R, 'shelterDuringDownpour'),
          this.toggleCtl('cycle timer', R, 'showCycleHud'),
          h('div', { class: 'btns' },
            this.button('Downpour now', () => {
              const cyc = Math.max(0.5, R.cycleMinutes) * 60;
              const w = eng.weather;
              w.t = Math.floor(w.t / cyc) * cyc + cyc * (1 - R.downpourFraction * 0.95);
            }),
            this.button('Clear skies', () => {
              const cyc = Math.max(0.5, R.cycleMinutes) * 60;
              eng.weather.t = Math.ceil(eng.weather.t / cyc) * cyc + 1;
            })
          )
        )
      );

      const Wc = cfg.world;
      this.el.appendChild(
        h('div', { class: 'sec' },
          h('div', { class: 'st', text: 'World' }),
          this.select('palette', Wc, 'palette', Object.keys(RW.PALETTES), () => eng.applyPalette()),
          this.select('pixel scale', Wc, 'pixelScale', [1, 2, 3], () => eng.applyPalette()),
          this.slider('map size', Wc, 'mapSize', 0.7, 3, 0.05, () => {
            // rebuild once the slider settles, not on every pixel of the drag
            clearTimeout(this.mapT);
            this.mapT = setTimeout(() => eng.regenerate(false), 250);
          }),
          this.slider('time scale', Wc, 'timeScale', 0, 3, 0.05),
          this.select('max fps', Wc, 'maxFps', [60, 30]),
          this.slider('ledges', Wc, 'decorLedges', 0, 14, 1),
          this.slider('poles', Wc, 'decorPoles', 0, 16, 1),
          this.slider('ledge poles', Wc, 'ledgePoles', 0, 1, 0.05),
          this.slider('fruit plants', Wc, 'fruitPlants', 0, 14, 1),
          h('div', { class: 'btns' }, this.button('New background', () => eng.regenerate(true)), this.button('Rebuild decor', () => eng.regenerate(false)))
        )
      );

      const D = cfg.debug;
      this.el.appendChild(
        h('div', { class: 'sec' },
          h('div', { class: 'st', text: 'Debug' }),
          this.toggleCtl('nav grid', D, 'showGrid'),
          this.toggleCtl('paths', D, 'showPaths'),
          this.toggleCtl('AI state labels', D, 'showLabels'),
          this.toggleCtl('fps', D, 'showFps')
        )
      );

      // Advanced: raw JSON
      const ta = h('textarea', { spellcheck: 'false' });
      this.el.appendChild(
        h('div', { class: 'sec' },
          h('div', { class: 'st', text: 'Config JSON (all creature parameters)' }),
          ta,
          h('div', { class: 'btns' },
            this.button('Load current', () => (ta.value = JSON.stringify(cfg, null, 2))),
            this.button('Apply', () => {
              try {
                const parsed = JSON.parse(ta.value);
                U.deepMerge(cfg, parsed);
                this.save();
                this.flash('applied — reloading');
                setTimeout(() => location.reload(), 400);
              } catch (e) {
                this.flash('bad JSON: ' + e.message);
              }
            }),
            // Hosts that can't save files (e.g. a shared artifact page) set RW.noFileDownloads.
            RW.noFileDownloads
              ? null
              : this.button('Download', () => {
                  const a = h('a', { download: 'rain-world-desktop-config.json' });
                  a.href = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }));
                  a.click();
                }),
            this.button('Reset defaults', () => {
              RW.clearSavedConfig();
              location.reload();
            }, 'warn')
          )
        )
      );
      this.msg = h('div', { class: 'msg' });
      this.el.appendChild(this.msg);
      this.refreshLive();
    }

    flash(text) {
      this.msg.textContent = text;
      clearTimeout(this.msgT);
      this.msgT = setTimeout(() => (this.msg.textContent = ''), 3000);
    }

    refreshLive() {
      if (!this.open) return;
      const eco = this.engine.eco;
      for (const f of this.liveEls) f();
      const w = this.engine.weather;
      const left = Math.max(0, (1 - w.phase) * this.cfg.rain.cycleMinutes);
      this.stats.textContent =
        `population ${eco.population().toFixed(1)} / ${this.cfg.ecosystem.maxPopulation}   ` +
        // what's alive, by kind (lizards 1.2-2 each, centipedes by size; batflies free)
        '\n' + this.census() + '\n' +
        `born ${eco.stats.born}  eaten ${eco.stats.eaten}  left ${eco.stats.left}\n` +
        (w.downpour ? 'DOWNPOUR — creatures sheltering' : `rain in ~${left.toFixed(1)} min`) +
        (this.engine.provider.status ? '\n' + this.engine.provider.status() : '');
    }
  }

  RW.Panel = Panel;
})();
