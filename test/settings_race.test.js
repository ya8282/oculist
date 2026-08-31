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
// stays open for want of a CAS primitive; see the comment in background.js. oculist-b65
// (below) narrows that residual window and adds recovery for writes landing inside it,
// but does not close it either — see that test and the same background.js comment.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

function loadBackground({
  backing, hardwareConcurrency, onTabsCreate, onGetSnapshot,
  // oculist-6tp: 1-indexed call numbers (matching calls.get/calls.set below) on which
  // to simulate chrome.runtime.lastError, following the transient-property pattern
  // test/worklist_storage.test.js uses — set immediately before the callback runs and
  // deleted immediately after, since real Chrome only exposes lastError for the
  // duration of the callback it belongs to.
  getLastErrorOnCall, setLastErrorOnCall,
}) {
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
          const failThisCall = getLastErrorOnCall === calls.get;
          const snapshot = JSON.parse(JSON.stringify({ [key]: backing[key] }));
          // Fires synchronously right after the snapshot is captured but before the
          // callback's macrotask is even scheduled to run — i.e. exactly the gap a
          // concurrent writer (the popup) can land in and still have this get()'s
          // eventual callback deliver a snapshot that predates it.
          if (onGetSnapshot) onGetSnapshot(calls.get, key);
          setTimeout(() => {
            if (failThisCall) {
              chrome.runtime.lastError = { message: 'Oculist test: simulated get() failure' };
              try { cb(undefined); } finally { delete chrome.runtime.lastError; }
              return;
            }
            cb(snapshot);
          }, 0);
        },
        set: (obj, cb) => {
          calls.set++;
          const failThisCall = setLastErrorOnCall === calls.set;
          setTimeout(() => {
            if (failThisCall) {
              chrome.runtime.lastError = { message: 'Oculist test: simulated set() failure' };
              try { if (cb) cb(); } finally { delete chrome.runtime.lastError; }
              return;
            }
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
// a write landing in the small residual gap oculist-b65's retry-and-recompute leaves
// open (the confirming re-read immediately before set()) is still not detected. This
// particular test's own concurrent write happens to land earlier — in the gap before
// that confirming re-read — so oculist-b65's fix now recovers it too: 'colorProfile'
// is NOT lost here (see the assertion below). The only invariant this test was ever
// written to guard is narrower and still holds regardless: the legacy field itself is
// never resurrected by background's write, whatever else that write does or doesn't
// clobber.
// oculist-b65: the seed's own get()-to-set() gap (not the wizard — see below) can still
// swallow a genuine concurrent page write whole, with the written key absent entirely
// from the final stored object (not merely stale). This is the actual production
// exposure: chrome.tabs.create(welcome.html) in the onInstalled handler below runs
// inside seedDefaultBlocklist's `done` callback, which only fires after the seed's own
// set() has already committed — so the wizard's own write can never land inside the
// seed's get-to-set window; the reachable case is some OTHER writer (a content script
// in an already-open tab, or the popup) landing in that window, most plausible on an
// 'update' from a pre-seeding build but modelled here on 'install' to isolate it from
// the separate performanceMode write path (hardwareConcurrency >= 4 skips that branch,
// same isolation trick as the visionProfile test above).
test('a concurrent write landing in the seed\'s own get-to-set gap survives (is not silently erased)', async () => {
  const backing = { 'oc-settings': {} };

  const { fire } = loadBackground({
    backing,
    hardwareConcurrency: 8, // >= 4: keep this test to the single seedDefaultBlocklist write site
    onGetSnapshot: (callIndex) => {
      if (callIndex === 1) {
        // Stands in for a content script's saveSettings() (extension/content.js)
        // landing in the exact gap between the seed's get() snapshot and its
        // callback firing — the hazard oculist-b65 measured in production, where
        // the concurrent write's key came back ABSENT from storage entirely, not
        // stale.
        backing['oc-settings'] = Object.assign({}, backing['oc-settings'], {
          effect: 'reader',
        });
      }
    },
  });

  fire({ reason: 'install' });

  await flush(10);

  const settings = backing['oc-settings'];
  assert.strictEqual(
    settings.effect, 'reader',
    'the concurrent page write must survive the seed\'s write-back, not be erased: ' + JSON.stringify(settings)
  );
  assert.ok(
    Array.isArray(settings.disabledSites) && settings.disabledSites.includes('github.com'),
    'the seed write itself must still land: ' + JSON.stringify(settings)
  );
  assert.strictEqual(settings.seededDefaultBlocklist, true, 'seed flag must still be set: ' + JSON.stringify(settings));
});

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
  assert.strictEqual(
    settings.colorProfile, 'deuteranopia',
    'oculist-b65: the popup\'s write lands early enough in this scenario for the retry-and-recompute fix to recover it too: ' + JSON.stringify(settings)
  );
});

// oculist-6tp: updateSettings() used to have three ways to strand `done` or clobber
// real data on a storage failure — see the bead. Each test below isolates the run to
// the single seedDefaultBlocklist write site (hardwareConcurrency: 8 skips the
// performanceMode branch, same trick the tests above use) so the get()/set() call
// counts are unambiguous, and spies on console.error / chrome.tabs.create as an
// external, black-box proxy for "did `done` fire, and how many times" — background.js
// exposes no internal hook to count `done` invocations directly.
function spyConsoleError() {
  const messages = [];
  const orig = console.error;
  console.error = (...args) => { messages.push(args.map(String).join(' ')); };
  return { messages, restore: () => { console.error = orig; } };
}

test('(a) a mutate() that throws synchronously still calls done exactly once, and issues NO set()', async () => {
  const backing = { 'oc-settings': {} };
  const errSpy = spyConsoleError();
  let tabsCreateCalls = 0;

  // Targeted, self-restoring: Array#push is used all over Node's own async machinery
  // (the event loop, the test runner itself), so a blanket "throw on the first push
  // anywhere" is not safe — it can fire on an unrelated push before mutate() ever runs.
  // Only throw on the exact call the seed mutate makes — settings.disabledSites.push
  // ('github.com'), per DEFAULT_DISABLED_SITES in background.js — and restore
  // immediately after either forwarding or throwing.
  const origPush = Array.prototype.push;
  Array.prototype.push = function (...args) {
    if (args.length === 1 && args[0] === 'github.com') {
      Array.prototype.push = origPush;
      throw new Error('oculist-6tp-test-mutate-threw');
    }
    return origPush.apply(this, args);
  };

  try {
    const { fire, calls } = loadBackground({
      backing,
      hardwareConcurrency: 8,
      onTabsCreate: () => { tabsCreateCalls++; },
    });

    fire({ reason: 'install' });
    await flush(6);

    assert.strictEqual(calls.set, 0, 'a throwing mutate() must not be followed by any set(): ' + JSON.stringify(calls));
    assert.strictEqual(
      tabsCreateCalls, 1,
      '(d) done must still fire exactly once — welcome tab opens exactly once despite the throw'
    );
    assert.ok(
      errSpy.messages.some((m) => m.includes('mutate() threw')),
      'the throw must be surfaced via console.error, not swallowed: ' + JSON.stringify(errSpy.messages)
    );
    assert.ok(
      errSpy.messages.some((m) => m.includes('seedDefaultBlocklist failed')),
      'onInstalled\'s done callback must have received a truthy error argument: ' + JSON.stringify(errSpy.messages)
    );
  } finally {
    Array.prototype.push = origPush; // safety net if push was never reached
    errSpy.restore();
  }
});

test('(b) a get() reporting chrome.runtime.lastError calls done exactly once, issues NO set(), and leaves storage untouched', async () => {
  const original = { untouchedMarker: 'do-not-clobber-me' };
  const backing = { 'oc-settings': Object.assign({}, original) };
  const errSpy = spyConsoleError();
  let tabsCreateCalls = 0;

  try {
    const { fire, calls } = loadBackground({
      backing,
      hardwareConcurrency: 8,
      getLastErrorOnCall: 1, // the very first (only) get() this run makes
      onTabsCreate: () => { tabsCreateCalls++; },
    });

    fire({ reason: 'install' });
    await flush(6);

    assert.strictEqual(calls.set, 0, 'a failed get() must never be followed by a set(): ' + JSON.stringify(calls));
    assert.deepStrictEqual(
      backing['oc-settings'], original,
      'a failed get() must not result in a near-empty object being written over real data: ' + JSON.stringify(backing['oc-settings'])
    );
    assert.strictEqual(
      tabsCreateCalls, 1,
      '(d) done must still fire exactly once — welcome tab opens exactly once despite the read failure'
    );
    assert.ok(
      errSpy.messages.some((m) => m.includes('chrome.storage.sync.get failed')),
      'the read failure must be surfaced via console.error: ' + JSON.stringify(errSpy.messages)
    );
    assert.ok(
      errSpy.messages.some((m) => m.includes('seedDefaultBlocklist failed')),
      'onInstalled\'s done callback must have received a truthy error argument: ' + JSON.stringify(errSpy.messages)
    );
  } finally {
    errSpy.restore();
  }
});

test('(c) a set() reporting chrome.runtime.lastError calls done exactly once, and done can tell the write failed', async () => {
  const backing = { 'oc-settings': {} };
  const errSpy = spyConsoleError();
  let tabsCreateCalls = 0;

  try {
    const { fire, calls } = loadBackground({
      backing,
      hardwareConcurrency: 8,
      setLastErrorOnCall: 1, // the only set() this run makes (no drift, no retry)
      onTabsCreate: () => { tabsCreateCalls++; },
    });

    fire({ reason: 'install' });
    await flush(6);

    assert.strictEqual(calls.set, 1, 'the set() must have been attempted exactly once (no blind retry on set failure): ' + JSON.stringify(calls));
    assert.strictEqual(
      backing['oc-settings'].seededDefaultBlocklist, undefined,
      'a failed set() must not be treated as a successful write: ' + JSON.stringify(backing['oc-settings'])
    );
    assert.strictEqual(
      tabsCreateCalls, 1,
      '(d) done must still fire exactly once — welcome tab opens exactly once despite the write failure ' +
      '(onboarding is judged more valuable than the seed write landing — see background.js\'s onInstalled comment)'
    );
    assert.ok(
      errSpy.messages.some((m) => m.includes('chrome.storage.sync.set failed')),
      'the write failure must be surfaced via console.error: ' + JSON.stringify(errSpy.messages)
    );
    assert.ok(
      errSpy.messages.some((m) => m.includes('seedDefaultBlocklist failed')),
      'done must receive a truthy error argument so a caller can branch on the write having failed: ' + JSON.stringify(errSpy.messages)
    );
  } finally {
    errSpy.restore();
  }
});

test('(e) the plain success path still calls done exactly once (no double-call from the new error branches)', async () => {
  const backing = { 'oc-settings': {} };
  let tabsCreateCalls = 0;

  const { fire, calls } = loadBackground({
    backing,
    hardwareConcurrency: 8,
    onTabsCreate: () => { tabsCreateCalls++; },
  });

  fire({ reason: 'install' });
  await flush(6);

  assert.strictEqual(tabsCreateCalls, 1, 'done must fire exactly once on the plain success path');
  assert.strictEqual(calls.get, 2, 'expected exactly one initial get() and one confirming re-read: ' + JSON.stringify(calls));
  assert.strictEqual(calls.set, 1, 'expected exactly one set() on the plain success path: ' + JSON.stringify(calls));
  assert.ok(
    Array.isArray(backing['oc-settings'].disabledSites) && backing['oc-settings'].disabledSites.includes('github.com'),
    'the seed write must still land: ' + JSON.stringify(backing['oc-settings'])
  );
});

test('(e) the confirm-then-retry (oculist-b65) path still calls done exactly once (no double-call from the new error branches)', async () => {
  const backing = { 'oc-settings': {} };
  let tabsCreateCalls = 0;

  const { fire, calls } = loadBackground({
    backing,
    hardwareConcurrency: 8,
    onGetSnapshot: (callIndex) => {
      if (callIndex === 1) {
        // Same drift-injection shape as "a concurrent write landing in the seed's own
        // get-to-set gap survives" above — forces exactly one retry recursion.
        backing['oc-settings'] = Object.assign({}, backing['oc-settings'], { concurrentWrite: true });
      }
    },
    onTabsCreate: () => { tabsCreateCalls++; },
  });

  fire({ reason: 'install' });
  await flush(10);

  assert.strictEqual(
    tabsCreateCalls, 1,
    'done must fire exactly once across the whole retry recursion, not once per attempt'
  );
  assert.ok(
    Array.isArray(backing['oc-settings'].disabledSites) && backing['oc-settings'].disabledSites.includes('github.com'),
    'the seed write must still land after the retry: ' + JSON.stringify(backing['oc-settings'])
  );
  assert.strictEqual(backing['oc-settings'].concurrentWrite, true, 'the concurrent write must survive: ' + JSON.stringify(backing['oc-settings']));
});
