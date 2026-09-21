// oculist-nq1x.2: seedHalloweenPack() (extension/background.js) turns the Halloween pack
// ON by default, exactly once, on both a fresh install and an existing user's update —
// same shape as seedDefaultBlocklist (test/settings_race.test.js covers that sibling).
// The regression that matters most is the SECOND update: a user who explicitly turned the
// pack back off must never have it silently re-seeded on a later chrome.runtime.onInstalled
// firing (every extension update fires it, not just the first). seededHalloweenPack is the
// flag that makes the seed a one-time default rather than a standing override, and the test
// below ("off, then a later update must not resurrect it") is written and proven red before
// any other test in this file, per the bead.
//
// Same minimal harness idiom as test/settings_race.test.js and test/background_tab_race.
// test.js: require extension/background.js directly against a mocked chrome global backed
// by a plain object, with get()/set() resolved on a macrotask so the real get->mutate->set
// round trip inside updateSettings() (extension/background.js) is exercised for real, not
// stubbed out. hardwareConcurrency is pinned to 8 (>= 4) throughout so the unrelated
// performanceMode write path never fires — isolates every assertion here to the two seed
// writes (blocklist, pack) actually under test, same trick settings_race.test.js uses.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

function loadBackground({ backing, onTabsCreate }) {
  const calls = { get: 0, set: 0 };
  let onInstalledListener = null;
  const noopEvent = () => ({ addListener: () => {} });

  // Node ships its own read-only `navigator` global; redefine (it's configurable) rather
  // than assign, same as settings_race.test.js.
  Object.defineProperty(global, 'navigator', {
    value: { hardwareConcurrency: 8 }, // >= 4: keeps the performanceMode branch out of scope
    configurable: true,
    writable: true,
  });

  // background.js loads settings-migration.js via importScripts() (real service worker
  // API, absent in Node) — stand in the same way settings_race.test.js does.
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

// Flushes the setTimeout(0) chain far enough for both chained seed writes (blocklist, then
// pack — each a get/mutate/confirming-get/set cycle) to fully settle. Generous on purpose:
// an under-count here would produce a flaky false pass reading pre-flush state, not a
// false failure, so there is no downside to more hops than strictly needed.
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

// Written and proven red first, per the bead: this is the regression that would silently
// override a user's explicit choice.
test('a user who turned the pack off keeps it off across a later update (no re-seed)', async () => {
  const backing = {
    'oc-settings': {
      seededDefaultBlocklist: true,
      disabledSites: [],
      enabledPacks: [], // user explicitly removed 'halloween' after the first seed
      seededHalloweenPack: true, // already seeded once — this is what must stop a re-add
    },
  };

  const { fire } = loadBackground({ backing });

  fire({ reason: 'update' });
  await flush(20);

  assert.deepStrictEqual(
    backing['oc-settings'].enabledPacks, [],
    'enabledPacks must stay without halloween once the user has turned it off: ' +
      JSON.stringify(backing['oc-settings'])
  );
});

test('fresh profile: onInstalled(install) seeds enabledPacks with halloween and sets the flag', async () => {
  const backing = {}; // no oc-settings key at all — a genuinely fresh profile

  const { fire } = loadBackground({ backing });

  fire({ reason: 'install' });
  await flush(20);

  const settings = backing['oc-settings'];
  assert.ok(
    Array.isArray(settings.enabledPacks) && settings.enabledPacks.includes('halloween'),
    'enabledPacks must include halloween on a fresh install: ' + JSON.stringify(settings)
  );
  assert.strictEqual(
    settings.seededHalloweenPack, true,
    'seededHalloweenPack must be true after the seed: ' + JSON.stringify(settings)
  );
});

test('upgrade profile: settings present, enabledPacks empty, flag absent — one update seeds it', async () => {
  const backing = {
    'oc-settings': { seededDefaultBlocklist: true, disabledSites: [], enabledPacks: [] },
  };

  const { fire } = loadBackground({ backing });

  fire({ reason: 'update' });
  await flush(20);

  const settings = backing['oc-settings'];
  assert.ok(
    Array.isArray(settings.enabledPacks) && settings.enabledPacks.includes('halloween'),
    'enabledPacks must include halloween after one update on an existing profile: ' +
      JSON.stringify(settings)
  );
  assert.strictEqual(
    settings.seededHalloweenPack, true,
    'seededHalloweenPack must be true after the seed: ' + JSON.stringify(settings)
  );
});

test('enabledPacks stored as a non-array (a string) is coerced, not thrown on', async () => {
  const backing = {
    'oc-settings': { seededDefaultBlocklist: true, disabledSites: [], enabledPacks: 'not-an-array' },
  };

  const { fire, calls } = loadBackground({ backing });

  fire({ reason: 'update' });
  await flush(20);

  const settings = backing['oc-settings'];
  assert.deepStrictEqual(
    settings.enabledPacks, ['halloween'],
    'a non-array enabledPacks must be replaced with an array containing just halloween: ' +
      JSON.stringify(settings)
  );
  assert.strictEqual(settings.seededHalloweenPack, true);
  assert.ok(calls.set > 0, 'the write must actually land, not be abandoned: ' + JSON.stringify(calls));
});

test('seeding does not clobber a pack list that already contains other pack ids', async () => {
  const backing = {
    'oc-settings': { seededDefaultBlocklist: true, disabledSites: [], enabledPacks: ['seasonal'] },
  };

  const { fire } = loadBackground({ backing });

  fire({ reason: 'update' });
  await flush(20);

  const settings = backing['oc-settings'];
  assert.deepStrictEqual(
    settings.enabledPacks.slice().sort(), ['halloween', 'seasonal'],
    'seeding must add halloween alongside an existing pack, not replace the list: ' +
      JSON.stringify(settings)
  );
});
