// Regression guard for the chrome://extensions error:
//   "Unchecked runtime.lastError: No tab with id: <id>."
//
// chrome.tabs.get is callback-style, so a dead tab id sets chrome.runtime.lastError
// instead of throwing. If the callback never reads lastError, Chrome logs it as
// "Unchecked" on the extensions page. The onActivated listener must read it and bail.

const test = require('node:test');
const assert = require('node:assert');

function loadBackground({ lastError, tab }) {
  const calls = { setIcon: 0, storageGet: 0, lastErrorReads: 0 };
  let onActivatedListener = null;

  const noopEvent = () => ({ addListener: () => {} });

  global.chrome = {
    runtime: {
      // Chrome marks the error "checked" the moment this property is read, and logs
      // "Unchecked runtime.lastError" if the callback returns without reading it.
      // So the thing under test is the read itself, not any downstream side effect.
      get lastError() { calls.lastErrorReads++; return lastError; },
      onInstalled: noopEvent(),
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    commands: { onCommand: noopEvent() },
    action: {
      setIcon: () => { calls.setIcon++; return Promise.resolve(); },
    },
    scripting: { executeScript: () => Promise.resolve() },
    storage: {
      sync: {
        get: (_key, cb) => { calls.storageGet++; cb({ 'oc-settings': { disabledSites: [] } }); },
        set: () => {},
      },
      onChanged: noopEvent(),
    },
    tabs: {
      create: () => {},
      query: (_q, cb) => { if (cb) cb([]); },
      get: (_id, cb) => cb(tab),
      sendMessage: () => Promise.resolve(),
      onUpdated: noopEvent(),
      onActivated: { addListener: (fn) => { onActivatedListener = fn; } },
    },
  };

  delete require.cache[require.resolve('../extension/background.js')];
  require('../extension/background.js');

  assert.ok(onActivatedListener, 'background.js should register a tabs.onActivated listener');
  return { calls, fire: (tabId) => onActivatedListener({ tabId }) };
}

test('onActivated bails when the tab died before the callback ran', () => {
  // Chrome hands back undefined for `tab` and sets lastError.
  const { calls, fire } = loadBackground({
    lastError: { message: 'No tab with id: 640884360.' },
    tab: undefined,
  });

  fire(640884360);

  assert.ok(
    calls.lastErrorReads > 0,
    'callback must read chrome.runtime.lastError, otherwise Chrome logs ' +
    '"Unchecked runtime.lastError: No tab with id" on chrome://extensions'
  );
  assert.strictEqual(calls.storageGet, 0, 'must not look up settings for a dead tab');
  assert.strictEqual(calls.setIcon, 0, 'must not call setIcon for a dead tab');
});

test('onActivated still updates the icon for a live tab', () => {
  const { calls, fire } = loadBackground({
    lastError: undefined,
    tab: { id: 42, url: 'https://example.com/page' },
  });

  fire(42);

  assert.strictEqual(calls.setIcon, 1, 'live tab should still get its icon updated');
});
