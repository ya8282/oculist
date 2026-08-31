// Regression coverage for oculist-xvh: the page-side settings writers — content.js's
// saveSettings(), popup.js's load-path eager persist and its own saveSettings(), and
// welcome.js's saveProfileAndFinish() — used to do a bare whole-object
// chrome.storage.sync.set() of their own in-memory `settings`, with no protection against
// a concurrent write from another surface (or from background.js). Two hazards followed:
//
//   1. Lost update: two writers racing each other could silently drop one of them.
//      content.js's chrome.storage.onChanged handler guards per key
//      (`if (!(k in nv)) return;`), so a key a clobbering write erased produces no change
//      entry at all — an open tab keeps a stale value forever, not just transiently.
//   2. Unmodelled-key drop: because the write was of a surface's own in-memory settings,
//      it also silently dropped any stored key that surface doesn't itself model.
//
// oculist-b65 gave background.js's updateSettings() confirm-then-retry concurrency
// protection (see test/settings_race.test.js). This file covers the fix for the page-side
// writers: extension/settings-migration.js's writeOcSettings()/rememberOcSettings(),
// which three-way merge every write (fresh stored state x last-known base x this
// context's in-memory settings) instead of blindly overwriting, with the same
// confirm-then-retry shape layered on top. See settings-migration.js's own comments for
// the full algorithm and its still-open residual race window.
//
// Tests are split into two shapes:
//   - Most of them drive OculistSettingsMigration.writeOcSettings() directly (via a plain
//     require(), no DOM) — the fastest, most precise way to pin the merge/retry/error
//     semantics themselves.
//   - (a) and (e) drive the real content.js / welcome.js call sites through a jsdom
//     environment (same style as test/settings_panel.test.js's eval-based harness), to
//     prove the actual call-site wiring — not just the shared helper in isolation — does
//     the right thing.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const EXTENSION = path.resolve(__dirname, '../extension');
const SETTINGS_MIGRATION_PATH = path.join(EXTENSION, 'settings-migration.js');
const CONTENT_JS_PATH = path.join(EXTENSION, 'content.js');
const WELCOME_JS_PATH = path.join(EXTENSION, 'welcome.js');
const WELCOME_HTML_PATH = path.join(EXTENSION, 'welcome.html');

// A chrome.storage.sync stand-in, backed by a plain object, shaped like
// test/settings_race.test.js's own fake: get() snapshots the store synchronously at call
// time (anything written to the backing store after the get() call but before its
// callback fires is invisible to that read — the real-Chrome hazard this whole bead is
// about), delivered on a macrotask. Supports BOTH calling conventions real chrome.* APIs
// do (callback, or a Promise when no callback is given): writeOcSettings() always uses
// the callback form, but welcome.js's own get() (before it ever reaches writeOcSettings)
// uses the Promise form.
//
//   state.onGetHook(callIndex) - invoked synchronously right after a get() call's
//     snapshot is captured (before its callback/resolution fires) - the same hook shape
//     settings_race.test.js's onGetSnapshot uses, so a test can land a "concurrent write"
//     in the exact gap between one get() call and its own delivery.
//   state.nextGetError = { atCall, message } - makes the given call's callback observe
//     chrome.runtime.lastError (callback form only; nothing here exercises the Promise
//     form rejecting, since no test needs that).
function makeFakeChromeStorage(backing) {
  const state = { getCalls: 0, setCalls: 0, setLog: [], onGetHook: null, onSetHook: null, nextGetError: null };
  const runtime = {};

  function snapshotOf(key) {
    return { [key]: backing[key] === undefined ? undefined : JSON.parse(JSON.stringify(backing[key])) };
  }

  function deliverGet(key, cb) {
    state.getCalls++;
    const callIndex = state.getCalls;
    const snapshot = snapshotOf(key);
    if (state.onGetHook) state.onGetHook(callIndex);
    return new Promise((resolve) => {
      setTimeout(() => {
        if (cb && state.nextGetError && state.nextGetError.atCall === callIndex) {
          runtime.lastError = { message: state.nextGetError.message };
          try {
            cb(snapshot);
          } finally {
            delete runtime.lastError;
          }
          resolve(snapshot);
          return;
        }
        if (cb) cb(snapshot);
        resolve(snapshot);
      }, 0);
    });
  }

  function deliverSet(obj, cb) {
    state.setCalls++;
    // Snapshot the payload SYNCHRONOUSLY at call time, matching real chrome.storage.sync.set()
    // (which structured-clones its argument essentially immediately, not lazily when its
    // callback eventually fires) — reading `obj` lazily inside the setTimeout below would let
    // a caller's later in-place mutation of an object it already handed to set() bleed into
    // what "storage" ends up holding, which a real browser's set() call does not allow.
    const committed = JSON.parse(JSON.stringify(obj));
    state.setLog.push(committed);
    // Fires synchronously right after the payload is snapshotted (so it cannot pollute
    // `committed`) but before the set() call's own macrotask callback — lets a test land a
    // mutation in exactly that gap, mirroring onGetHook's placement for get().
    if (state.onSetHook) state.onSetHook(state.setCalls);
    return new Promise((resolve) => {
      setTimeout(() => {
        Object.assign(backing, committed);
        if (cb) cb();
        resolve();
      }, 0);
    });
  }

  const sync = {
    get(key, cb) {
      if (typeof cb === 'function') {
        deliverGet(key, cb);
        return undefined;
      }
      return deliverGet(key);
    },
    set(items, cb) {
      if (typeof cb === 'function') {
        deliverSet(items, cb);
        return undefined;
      }
      return deliverSet(items);
    },
  };

  const chrome = {
    runtime: Object.assign(runtime, {
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        if (cb) setTimeout(cb, 0);
      },
    }),
    storage: { sync, onChanged: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
  };

  return { chrome, state };
}

// Flushes the setTimeout(0) chain far enough for a multi-hop get/get/set (or a full
// retry cycle) to settle, without a real wall-clock sleep. Same shape as
// test/settings_race.test.js's own flush().
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

// A fresh require() of settings-migration.js per test, so its module-level
// `lastKnownOcSettings` (see rememberOcSettings()) never leaks state between tests.
function freshSettingsMigration() {
  delete require.cache[require.resolve(SETTINGS_MIGRATION_PATH)];
  return require(SETTINGS_MIGRATION_PATH);
}

beforeEach(() => {
  delete global.window;
  delete global.document;
  delete global.navigator;
  delete global.chrome;
  delete global.OculistSettingsMigration;
});

describe('OculistSettingsMigration.writeOcSettings() — shared three-way-merge write path (oculist-xvh)', () => {
  test('(b) a key the surface actually changed still wins over the stored value', async () => {
    const M = freshSettingsMigration();
    const backing = { 'oc-settings': { effect: 'hud', theme: 'dark' } };
    const { chrome } = makeFakeChromeStorage(backing);
    global.chrome = chrome;

    M.rememberOcSettings({ effect: 'hud', theme: 'dark' });
    const local = { effect: 'reader', theme: 'dark' };

    const result = await new Promise((resolve) => M.writeOcSettings(local, resolve));

    assert.strictEqual(backing['oc-settings'].effect, 'reader', 'the locally-changed key must win');
    assert.strictEqual(backing['oc-settings'].theme, 'dark', 'the untouched key is unaffected');
    assert.deepStrictEqual(result, backing['oc-settings'], 'done() must receive the merged object that was actually written');
  });

  test(
    "(c) a concurrent write landing between the initial get and the confirming re-read triggers a retry, and both writers' keys survive",
    async () => {
      const M = freshSettingsMigration();
      const backing = { 'oc-settings': { a: 1 } };
      const { chrome, state } = makeFakeChromeStorage(backing);
      global.chrome = chrome;

      M.rememberOcSettings({ a: 1 });
      const local = { a: 1, b: 2 }; // b is this surface's own new local key

      // Land a foreign write in the gap between the initial get()'s snapshot and its
      // callback firing — the same residual-gap shape oculist-b65 measured for
      // background.js.
      state.onGetHook = (callIndex) => {
        if (callIndex === 1) {
          backing['oc-settings'] = Object.assign({}, backing['oc-settings'], { c: 3 });
        }
      };

      let doneCalls = 0;
      let doneVal;
      M.writeOcSettings(local, (v) => {
        doneCalls++;
        doneVal = v;
      });
      await flush(10);

      assert.ok(state.getCalls >= 4, 'a retry must re-read at least once more: got ' + state.getCalls + ' get() calls');
      assert.strictEqual(state.setCalls, 1, 'only the recovered attempt may commit a write');
      assert.strictEqual(doneCalls, 1, 'done must fire exactly once even across a retry');
      assert.strictEqual(backing['oc-settings'].a, 1, 'the untouched key is unaffected');
      assert.strictEqual(backing['oc-settings'].b, 2, "this surface's own new key must survive");
      assert.strictEqual(backing['oc-settings'].c, 3, "the concurrent writer's key must survive");
      assert.deepStrictEqual(doneVal, backing['oc-settings']);
    }
  );

  test('(d) done fires exactly once, and no set() is issued, when the initial get() reports chrome.runtime.lastError', async () => {
    const M = freshSettingsMigration();
    const backing = { 'oc-settings': { a: 1 } };
    const { chrome, state } = makeFakeChromeStorage(backing);
    global.chrome = chrome;

    M.rememberOcSettings({ a: 1 });
    state.nextGetError = { atCall: 1, message: 'simulated denial' };

    let doneCalls = 0;
    let doneVal = 'not-called';
    M.writeOcSettings({ a: 2 }, (v) => {
      doneCalls++;
      doneVal = v;
    });
    await flush(6);

    assert.strictEqual(doneCalls, 1, 'done must fire exactly once');
    assert.strictEqual(doneVal, null, 'done must be called with null when the write is abandoned');
    assert.strictEqual(state.setCalls, 0, 'a failed read must never be followed by a set()');
    assert.deepStrictEqual(backing['oc-settings'], { a: 1 }, 'stored data must be untouched');
  });

  // Not one of the bead's lettered cases, but part of its exactly-once requirement —
  // mirrors test/worklist_storage.test.js's "(e) a synchronous get() callback whose
  // caller callback throws still calls back exactly once".
  test("done fires exactly once, and the throw still propagates once, when a caller-supplied done throws", () => {
    const M = freshSettingsMigration();
    const backing = { 'oc-settings': { a: 1 } };
    // A synchronous mock (get()/set() invoke their callback on the same call stack) puts
    // a throw from the caller's own `done` on the same stack as writeOcSettings' own
    // work — the shape that would trip an over-eager try/catch into treating the throw as
    // "our" failure and calling done() a second time.
    global.chrome = {
      runtime: {},
      storage: {
        sync: {
          get: (key, cb) => {
            cb({ [key]: backing[key] });
          },
          set: (obj, cb) => {
            Object.assign(backing, obj);
            if (cb) cb();
          },
        },
      },
    };
    M.rememberOcSettings({ a: 1 });

    let doneCalls = 0;
    let thrown = null;
    try {
      M.writeOcSettings({ a: 2 }, () => {
        doneCalls++;
        throw new Error('oculist-xvh-caller-done-threw');
      });
    } catch (e) {
      thrown = e && e.message;
    }

    assert.strictEqual(doneCalls, 1, 'done must fire exactly once even though it threw');
    assert.strictEqual(thrown, 'oculist-xvh-caller-done-threw', 'the throw must propagate once, not be swallowed');
    assert.strictEqual(backing['oc-settings'].a, 2, 'the write itself must still have landed before done was invoked');
  });

  test('(f) a deliberate local key deletion still propagates to storage rather than being resurrected from the fresh read', async () => {
    const M = freshSettingsMigration();
    const backing = { 'oc-settings': { a: 1, b: 2 } };
    const { chrome } = makeFakeChromeStorage(backing);
    global.chrome = chrome;

    M.rememberOcSettings({ a: 1, b: 2 });
    const local = { a: 1 }; // b deliberately absent -- this surface deleted it locally

    const result = await new Promise((resolve) => M.writeOcSettings(local, resolve));

    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(backing['oc-settings'], 'b'),
      false,
      'the deletion must propagate to storage rather than being resurrected'
    );
    assert.deepStrictEqual(backing['oc-settings'], { a: 1 });
    assert.deepStrictEqual(result, { a: 1 });
  });

  // Regression guard for a bug found while reproducing this bead's popup.js scenario
  // (three saveSettings() calls fired in quick succession from one popup: vision
  // profile, colour palette, then a custom colour): mergeOcSettings() used to assign
  // `merged[k] = local[k]` for an object-valued key, aliasing that nested object rather
  // than copying it. `local` is the caller's own live, still-mutable settings object, so
  // a write's own remembered base (captured from `merged` once its set() lands) could
  // end up reflecting whatever `local`'s nested object had been mutated to BY THEN,
  // rather than what that write actually computed and stored — corrupting the base a
  // later write in the same context diffs against, and making that later write's own
  // genuine change look like a no-op `fresh` should win, silently dropping it. Fixed by
  // deep-copying an object-valued `local[k]` into `merged[k]`.
  //
  // Reproduced deterministically (not via timing/flush luck, which does not reliably
  // land the exact interleaving) using onSetHook to mutate the shared `local.visionSettings`
  // object IN PLACE in the gap between one write's set() call and its callback — exactly
  // where the real popup.js race (three overlapping saveSettings() calls sharing one
  // in-memory `settings` object) put a later call's own mutation relative to an earlier
  // call's still-in-flight set().
  test(
    "a write's remembered base reflects what it actually stored, not a later in-place mutation of the shared local settings object",
    async () => {
      const M = freshSettingsMigration();
      const backing = { 'oc-settings': { visionSettings: { colorPalette: 'default' } } };
      const { chrome, state } = makeFakeChromeStorage(backing);
      global.chrome = chrome;

      M.rememberOcSettings(JSON.parse(JSON.stringify(backing['oc-settings'])));
      // A single shared, live in-memory settings object -- mirrors popup.js's
      // module-scoped `settings`, mutated in place across overlapping writes.
      const settings = JSON.parse(JSON.stringify(backing['oc-settings']));

      // Write B's own change.
      settings.visionSettings.colorPalette = 'custom';

      // Land a second write's own mutation of the SAME visionSettings object (same
      // reference, mutated in place) in the gap between write B's set() call and its
      // callback -- i.e. after write B's set() payload has already been snapshotted (so
      // storage itself is unaffected by this), but before write B's rememberOcSettings()
      // runs.
      state.onSetHook = (callIndex) => {
        if (callIndex === 1) {
          settings.visionSettings.matchColor = 'write-c-value';
        }
      };

      const mergedB = await new Promise((resolve) => M.writeOcSettings(settings, resolve));

      assert.deepStrictEqual(
        backing['oc-settings'].visionSettings,
        { colorPalette: 'custom' },
        "write B's own set() payload must be unaffected by the later in-place mutation"
      );
      assert.deepStrictEqual(
        mergedB.visionSettings,
        { colorPalette: 'custom' },
        "write B's done() callback must receive what it actually wrote, not the later mutation"
      );

      // Write C: `settings.visionSettings.matchColor` is already 'write-c-value' from the
      // mutation above (standing in for write C's own synchronous local change having
      // already landed) -- no further mutation needed before calling writeOcSettings again.
      const mergedC = await new Promise((resolve) => M.writeOcSettings(settings, resolve));

      assert.strictEqual(
        backing['oc-settings'].visionSettings.matchColor,
        'write-c-value',
        "write C's own change must not be dropped as a spurious no-op against a corrupted base"
      );
      assert.strictEqual(backing['oc-settings'].visionSettings.colorPalette, 'custom');
      assert.deepStrictEqual(mergedC.visionSettings, { colorPalette: 'custom', matchColor: 'write-c-value' });
    }
  );
});

// Loads content.js (with settings-migration.js listed before it, mirroring
// manifest.json's content_scripts order and sharing the same jsdom `window`) against a
// fake chrome.storage.sync backed by `backing`. Same eval-based technique as
// test/settings_panel.test.js's createDOMEnvironment(), extended with the get/set call
// tracking and injection hooks this bead's tests need.
function loadContentScript(backing) {
  const { chrome, state } = makeFakeChromeStorage(backing);
  const dom = new JSDOM('<!doctype html><html><body><p>alpha beta gamma</p></body></html>', {
    url: 'http://localhost/',
  });

  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  global.chrome = chrome;

  // jsdom has no Web Animations API / layout engine — same stand-ins
  // test/settings_panel.test.js uses to let content.js boot and build its UI.
  dom.window.Element.prototype.animate = function () {
    return { finished: Promise.resolve(), cancel() {}, play() {}, pause() {} };
  };
  dom.window.Range.prototype.getClientRects = function () {
    return [{ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }];
  };
  dom.window.Range.prototype.getBoundingClientRect = function () {
    return { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0 };
  };

  eval(fs.readFileSync(SETTINGS_MIGRATION_PATH, 'utf8'));
  eval(fs.readFileSync(CONTENT_JS_PATH, 'utf8'));

  return { dom, state };
}

describe("content.js's saveSettings() (oculist-xvh)", () => {
  test(
    '(a) does not clobber a foreign key another surface wrote after this tab\'s last read, and still applies its own change',
    async () => {
      // A full, internally-consistent default settings object — every key content.js's
      // own SETTINGS_KEYS models, at content.js's own hardcoded default value — so
      // nothing here looks "changed" merely because of a base/local default mismatch;
      // the only thing that changes is what the test drives below.
      const backing = {
        'oc-settings': {
          effect: 'hud',
          position: 'tr',
          theme: 'dark',
          matchColor: '#fef08a',
          activeColor: '#f59e0b',
          beaconColor: '#fbbf24',
          scrollBehavior: 'smooth',
          disabledSites: [],
          performanceMode: false,
          displayPreset: null,
          visionSettings: {
            beaconSize: 'm',
            animationSpeed: 'normal',
            textLabels: false,
            magnifier: false,
            motionSensitivity: 'full',
            colorPalette: 'default',
            borderStyle: 'none',
            customColors: { matchColor: '#fef08a', activeColor: '#f59e0b', beaconColor: '#fbbf24' },
          },
          setupWizardCompleted: false,
          seededDefaultBlocklist: false,
        },
      };

      const { dom, state } = loadContentScript(backing);
      await flush(6); // let the boot get()/rememberOcSettings() settle.

      state.getCalls = 0;
      state.setCalls = 0;
      state.setLog = [];

      // A foreign write of a key content.js does not model at all (not in
      // SETTINGS_KEYS), landing after this tab's boot read.
      backing['oc-settings'] = Object.assign({}, backing['oc-settings'], { foreignExtensionMarker: 'xyz' });

      dom.window.__ocToggle();
      const wrapRoot = dom.window.document.getElementById('oc-wrap').shadowRoot;
      const gearBtn = wrapRoot.querySelector('button[title^="Options"]');
      assert.ok(gearBtn, 'settings gear button must exist once the bar is open');
      gearBtn.click();

      const scrollInstantBtn = wrapRoot.querySelector('[data-oc-key="scroll:instant"]');
      assert.ok(scrollInstantBtn, 'the scroll-behavior "instant" option must exist in the settings panel');
      scrollInstantBtn.click(); // triggers settings.scrollBehavior = 'instant'; saveSettings();

      await flush(8);

      assert.strictEqual(state.setCalls, 1, 'exactly one write should have landed');
      assert.strictEqual(
        backing['oc-settings'].foreignExtensionMarker,
        'xyz',
        'a key this tab does not model at all must survive its own whole-object write'
      );
      assert.strictEqual(
        backing['oc-settings'].scrollBehavior,
        'instant',
        "this tab's own change must still land"
      );
    }
  );
});

// Loads the real welcome.html markup (so every id welcome.js dereferences exists) against
// a fake chrome.storage.sync, evaluates settings-migration.js then welcome.js against that
// jsdom `window`/`document`, and dispatches a manual 'DOMContentLoaded' (jsdom already
// fired its own automatic one during construction, before welcome.js's own listener was
// registered, so this replay is required for that listener to ever run).
function loadWelcomePage(backing) {
  const { chrome, state } = makeFakeChromeStorage(backing);
  const html = fs.readFileSync(WELCOME_HTML_PATH, 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/welcome.html' });

  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  global.chrome = chrome;

  dom.window.Element.prototype.animate = function () {
    return { finished: Promise.resolve(), cancel() {}, play() {}, pause() {} };
  };

  eval(fs.readFileSync(SETTINGS_MIGRATION_PATH, 'utf8'));
  // welcome.js references OculistSettingsMigration as a bare identifier (matching a real
  // browser, where `window` IS the global object, so window.OculistSettingsMigration and
  // the bare global are the same binding) — this jsdom harness keeps `window` as a
  // separate object from Node's `global`, so make that alias explicit.
  global.OculistSettingsMigration = dom.window.OculistSettingsMigration;
  eval(fs.readFileSync(WELCOME_JS_PATH, 'utf8'));

  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

  return { dom, state };
}

// Drives the 4-step wizard to completion using each step's default selection (set up by
// welcome.js's own resetWizardState()), then polls for the modal closing as the signal
// that saveProfileAndFinish()'s awaited write has settled (success or failure either way
// reach that line).
async function driveWizardToFinish(dom) {
  const document = dom.window.document;
  document.getElementById('start-wizard').click();
  document.getElementById('wizard-next').click();
  document.getElementById('wizard-next').click();
  document.getElementById('wizard-next').click();
  document.getElementById('wizard-next').click(); // 4th click: currentStep === 4 -> saveProfileAndFinish()

  const deadline = Date.now() + 2000;
  while (document.getElementById('wizard-modal').style.display !== 'none' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.strictEqual(
    document.getElementById('wizard-modal').style.display,
    'none',
    'saveProfileAndFinish() should have settled (and closed the modal) within the poll deadline'
  );
}

describe("welcome.js's saveProfileAndFinish() (oculist-xvh)", () => {
  test('(e) preserves a concurrently-written unrelated key', async () => {
    const backing = { 'oc-settings': { seededDefaultBlocklist: false, disabledSites: [] } };
    const { dom, state } = loadWelcomePage(backing);

    // Land a foreign write (e.g. background.js's own seed completing, or another tab)
    // in the gap between saveProfileAndFinish()'s own get() snapshot and its callback --
    // i.e. before this wizard's remembered base is even recorded, so this is a genuine
    // concurrent write, not merely a value this read already saw.
    state.onGetHook = (callIndex) => {
      if (callIndex === 1) {
        backing['oc-settings'] = Object.assign({}, backing['oc-settings'], { seededDefaultBlocklist: true });
      }
    };

    await driveWizardToFinish(dom);

    assert.strictEqual(
      backing['oc-settings'].seededDefaultBlocklist,
      true,
      'the concurrently-written key must survive the wizard\'s own write'
    );
    assert.strictEqual(
      backing['oc-settings'].setupWizardCompleted,
      true,
      "the wizard's own write must still land"
    );
  });
});
