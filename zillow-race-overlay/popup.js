(function () {
  'use strict';
  const { RACES, DEFAULT_SETTINGS } = window.ZRO_CONFIG;
  const $ = (id) => document.getElementById(id);
  let settings = { ...DEFAULT_SETTINGS };

  // Sliders fire many events; storage.sync allows ~120 writes a minute.
  let saveTimer = 0;
  function save(patch) {
    settings = { ...settings, ...patch };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.sync.set({ settings }), 150);
    render();
  }

  const raceBoxes = RACES.map((r) => {
    const row = document.createElement('label');
    row.className = 'race';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => {
      const hidden = new Set(settings.hidden);
      if (cb.checked) hidden.delete(r.field);
      else hidden.add(r.field);
      save({ hidden: [...hidden] });
    });
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = `rgb(${r.color})`;
    const lab = document.createElement('span');
    lab.textContent = r.label;
    row.append(cb, sw, lab);
    $('races').append(row);
    return cb;
  });

  function render() {
    $('enabled').checked = settings.enabled;
    $('metro').checked = settings.metro;
    $('level').value = settings.level;
    $('dotValue').value = settings.dotValue > 0 ? settings.dotValue : '';
    $('dotSize').value = settings.dotSize;
    $('dotSizeOut').textContent = settings.dotSize > 0 ? `${settings.dotSize}px` : 'auto';
    $('opacity').value = settings.opacity;
    $('opacityOut').textContent = `${Math.round(settings.opacity * 100)}%`;
    $('dim').value = settings.dim;
    $('dimOut').textContent = `${Math.round(settings.dim * 100)}%`;
    $('outlines').checked = settings.outlines;
    $('legend').checked = settings.legend;
    raceBoxes.forEach((cb, i) => (cb.checked = !settings.hidden.includes(RACES[i].field)));
  }

  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('metro').addEventListener('change', (e) => save({ metro: e.target.checked }));
  $('level').addEventListener('change', (e) => save({ level: e.target.value }));
  $('dotValue').addEventListener('change', (e) => save({ dotValue: Math.max(0, Math.round(Number(e.target.value) || 0)) }));
  $('dotSize').addEventListener('input', (e) => save({ dotSize: Number(e.target.value) }));
  $('opacity').addEventListener('input', (e) => save({ opacity: Number(e.target.value) }));
  $('dim').addEventListener('input', (e) => save({ dim: Number(e.target.value) }));
  $('outlines').addEventListener('change', (e) => save({ outlines: e.target.checked }));
  $('legend').addEventListener('change', (e) => save({ legend: e.target.checked }));
  $('reset').addEventListener('click', () => save({ ...DEFAULT_SETTINGS }));

  chrome.storage.sync.get('settings').then(({ settings: s }) => {
    settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
    render();
  });
})();
