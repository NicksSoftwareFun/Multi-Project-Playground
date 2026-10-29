// Isolated-world bridge between the page hook (which can see Zillow's map)
// and the extension (storage + background fetches).
//
// Chrome injects a file only once per frame, so config.js (already injected
// into the page world) can't also be loaded here. This script doesn't need
// it: the page hook fills in defaults, the background worker validates
// queries, and saved keys are limited to the ones already in storage.
(function () {
  'use strict';
  let settings = {};

  function toPage(msg) {
    window.postMessage({ source: 'zro-content', ...msg }, location.origin);
  }

  async function loadSettings() {
    try {
      const { settings: s } = await chrome.storage.sync.get('settings');
      settings = s || {};
    } catch (_) {
      settings = {};
    }
    toPage({ type: 'settings', settings });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = changes.settings.newValue || {};
      toPage({ type: 'settings', settings });
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'zro-page') return;
    const msg = ev.data;

    if (msg.type === 'ready') {
      loadSettings();
    } else if (msg.type === 'rpc' && typeof msg.method === 'string') {
      // The background worker validates method and params.
      const { reqId, method, params } = msg;
      chrome.runtime.sendMessage({ type: 'zro-rpc', method, params }).then(
        (res) => toPage({ type: 'rpcResult', reqId, ...(res || { error: 'no response' }) }),
        (err) => toPage({ type: 'rpcResult', reqId, error: String(err && err.message) })
      );
    } else if (msg.type === 'saveSettings' && msg.patch && typeof msg.patch === 'object') {
      const patch = {};
      for (const k of Object.keys(settings)) if (k in msg.patch) patch[k] = msg.patch[k];
      settings = { ...settings, ...patch };
      chrome.storage.sync.set({ settings });
    }
  });

  loadSettings();
})();
