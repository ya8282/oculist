// Regression guard for the read-modify-write race in seedDefaultBlocklist/onInstalled
// (oculist-9s9). Both write sites in background.js used to do their own independent
// chrome.storage.sync.get -> mutate -> set round trip. Because onInstalled fired both
// get() calls without waiting for either set() to land, the second set() could commit
// a snapshot that predated the first write, silently erasing it. The fix routes both
// sites through one updateSettings() helper and sequences the second write to only
// start (and read fresh) after the first write has fully committed.
//
// This harness models a chrome.storage.sync backed by a plain object, with get()/set()
// resolved on a macrotask (setTimeout) so calls interleave the way two independent
// async round trips would in real Chrome: a get() snapshots the store synchronously at
// call time (representing the request being sent with the state as of then) and
// delivers that snapshot to its callback later, so anything written to the store after
// the get() call but before its callback fires is invisible to that read — exactly the
// stale-snapshot hazard the bead describes.
//
// chrome.tabs.create is also hooked to perform a "concurrent write" (standing in for
// the popup, or any other writer) between the two sites' storage operations. Be clear
// about what that does and does not demonstrate: it lands before the second get() is
// issued, so it survives under the OLD implementation too. It is present to pin the
// surrounding state, not as evidence that cross-context writes are now safe — they are
// not. What this test actually guards is the seed write surviving the performanceMode
// write, i.e. background.js no longer clobbering its own earlier write. The popup race
// stays open for want of a CAS primitive; see the comment in background.js.

const test = require('node:test');
const assert = require('node:assert');

function loadBackground({ backing, hardwareConcurrency, onTabsCreate }) {
  const calls = { get: 0, set: 0 };
  let onInstalledListener = null;
  const noopEvent = () => ({ addListener: () => {} });

  // Node ships its own read-only `navigator` global (with the host's real core
  // count), so a plain `global.navigator = ...` assignment is silently ignored.
  // It's configurable, so redefine it instead.
  Object.defineProperty(global, 'navigator', {
    value: { hardwareConcurrency: hardwareConcurrency },
    configurable: true,
    writable: true,
  });
  global.chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => { onInstalledListener = fn; } },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    commands: { onCommand: noopEvent() },
    action: { setIcon: () => Promise.resolve() },
    scripting: { executeScript: () => Promise.resolve() },
    storage: {
      sync: {
        // Snapshot taken synchronously at call time — a write landing after this call
        // but before the callback fires must NOT be visible to this read.
        get: (key, cb) => {
          calls.get++;
          const snapshot = JSON.parse(JSON.stringify({ [key]: backing[key] }));
          setTimeout(() => cb(snapshot), 0);
        },
        set: (obj, cb) => {
          calls.set++;
          setTimeout(() => {
            Object.assign(backing, obj);
            if (cb) cb();
          }, 0);
        },
      },
      onChanged: noopEvent(),
    },
    tabs: {
      create: (opts) => {
        if (onTabsCreate) onTabsCreate();
        return opts;
      },
      query: (_q, cb) => { if (cb) cb([]); },
      onUpdated: noopEvent(),
      onActivated: noopEvent(),
    },
  };

  delete require.cache[require.resolve('../extension/background.js')];
  require('../extension/background.js');

  assert.ok(onInstalledListener, 'background.js should register a runtime.onInstalled listener');
  return { calls, fire: (details) => onInstalledListener(details) };
}

// Flushes the setTimeout(0) chain far enough to let both get/mutate/set round trips
// (four hops: get, set, get, set) settle, without a real wall-clock sleep.
function flush(hops) {
  return new Promise((resolve) => {
    let remaining = hops;
    function step() {
      if (remaining-- <= 0) return resolve();
      setTimeout(step, 0);
    }
    step();
  });
}

test('a concurrent write landing between the two onInstalled writes survives, and both writes still land', async () => {
  const backing = { 'oc-settings': { disabledSites: [] } };

  const { fire } = loadBackground({
    backing,
    hardwareConcurrency: 2, // < 4 triggers the performanceMode write path
    onTabsCreate: () => {
      // Simulated concurrent writer (e.g. the popup) completing its own write in the
      // window between the seed write finishing and the performanceMode write's read.
      backing['oc-settings'] = Object.assign({}, backing['oc-settings'], {
        userNote: 'popup-write-survived',
      });
    },
  });

  fire({ reason: 'install' });

  await flush(12);

  const settings = backing['oc-settings'];
  assert.ok(
    Array.isArray(settings.disabledSites) && settings.disabledSites.includes('github.com'),
    'seed write (disabledSites) must survive: ' + JSON.stringify(settings)
  );
  assert.strictEqual(
    settings.seededDefaultBlocklist, true,
    'seed write (seededDefaultBlocklist flag) must survive: ' + JSON.stringify(settings)
  );
  assert.strictEqual(
    settings.performanceMode, true,
    'performanceMode write must land: ' + JSON.stringify(settings)
  );
  assert.strictEqual(
    settings.userNote, 'popup-write-survived',
    'concurrent write must not be clobbered: ' + JSON.stringify(settings)
  );
});

test('an already-seeded blocklist is not rewritten (user re-enabling github.com is not undone)', async () => {
  const backing = { 'oc-settings': { disabledSites: [], seededDefaultBlocklist: true } };

  const { fire, calls } = loadBackground({ backing, hardwareConcurrency: 8 });

  fire({ reason: 'update' });

  await flush(4);

  assert.strictEqual(calls.set, 0, 'no write should happen once already seeded');
  assert.deepStrictEqual(backing['oc-settings'].disabledSites, [], 'disabledSites must be left untouched');
});
