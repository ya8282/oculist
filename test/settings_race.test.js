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
const path = require('node:path');

function loadBackground({ backing, hardwareConcurrency, onTabsCreate, onGetSnapshot }) {
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

  // background.js loads settings-migration.js via importScripts() (real service worker
  // API, not available in Node). Stand in for it: `self` is a classic service worker's
  // global object, so settings-migration.js's own self/globalThis fallback (see its
  // tail) attaches OculistSettingsMigration there when `window` is absent, same as it
  // would for real — using Node's `global` object as the stand-in `self` makes that
  // attachment visible to background.js's own top-level `self.OculistSettingsMigration`
  // read. importScripts itself is just a synchronous require() of the real file, which
  // is enough to trigger that attachment; Node's require cache means this only runs the
  // module body once per process, but the self-assignment survives on `global` after that.
  global.self = global;
  global.importScripts = (file) => {
    require(path.join(__dirname, '../extension', file));
  };
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
          // Fires synchronously right after the snapshot is captured but before the
          // callback's macrotask is even scheduled to run — i.e. exactly the gap a
          // concurrent writer (the popup) can land in and still have this get()'s
          // eventual callback deliver a snapshot that predates it.
          if (onGetSnapshot) onGetSnapshot(calls.get, key);
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

// Regression guard for oculist-hzr: seedDefaultBlocklist()'s get() is the first thing
// onInstalled does. If another surface (the popup here) normalizes settings and writes
// in the gap between that get() and its own set(), background used to write its stale,
// pre-popup-write snapshot straight back — resurrecting a legacy field (visionProfile)
// the popup's write had just deleted, because background's own read-modify-write cycle
// never passed through normalizeOcSettings() the way every other surface does. The fix
// (see background.js's updateSettings()) normalizes the snapshot in place before mutate()
// runs, on every call through that one choke point.
//
// What this test does NOT claim to fix (see the file-level comment above and the
// matching comment in background.js): chrome.storage.sync has no compare-and-swap, so
// background's own set() below still clobbers the popup's write wholesale (its
// 'colorProfile' field is expected to be lost here) — that residual cross-context race
// is explicitly out of scope for oculist-hzr. The only invariant under test is that the
// legacy field itself is never resurrected by background's write, regardless of what
// else that write clobbers.
test('a legacy visionProfile present at background\'s read is not resurrected by its write-back after a concurrent write deletes it', async () => {
  const backing = { 'oc-settings': { disabledSites: [], visionProfile: 'legacy-deuteranopia' } };

  const { fire } = loadBackground({
    backing,
    hardwareConcurrency: 8, // >= 4: keep this test to the single seedDefaultBlocklist write site
    onGetSnapshot: (callIndex) => {
      if (callIndex === 1) {
        // The popup's own get->normalize->set cycle completes here: it has already
        // deleted visionProfile by the time this write lands, in the gap between
        // background's get() snapshot (already captured, above) and its set().
        backing['oc-settings'] = { disabledSites: [], colorProfile: 'deuteranopia' };
      }
    },
  });

  fire({ reason: 'update' }); // 'update' skips the performanceMode branch — irrelevant to this race

  await flush(6);

  const settings = backing['oc-settings'];
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(settings, 'visionProfile'),
    false,
    'background must not resurrect the legacy visionProfile the popup deleted: ' + JSON.stringify(settings)
  );
  assert.ok(
    Array.isArray(settings.disabledSites) && settings.disabledSites.includes('github.com'),
    'the seed write itself must still land: ' + JSON.stringify(settings)
  );
  assert.strictEqual(settings.seededDefaultBlocklist, true, 'seed flag must still be set: ' + JSON.stringify(settings));
});
