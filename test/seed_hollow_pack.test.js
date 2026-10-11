// oculist-l0bs.2: seedHollowPack() (extension/background.js) seeds pack II ('hollow', "Haunted
// Hollow") ON exactly once, behind its OWN flag seededHollowPack, chained after
// seedHalloweenPack in the same onInstalled sequence. Separate from pack I's flag on purpose:
// every existing user already has seededHalloweenPack true, so reusing it would never seed
// pack II for them. Written red first: the off-then-reinstall test.
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


test('a user who turned pack II off keeps it off across a later update (no re-seed)', async () => {
  const backing = {
    'oc-settings': {
      seededDefaultBlocklist: true, seededHalloweenPack: true, seededHollowPack: true,
      disabledSites: [], enabledPacks: ['halloween', 'adventure'], // hollow removed by the user
    },
  };
  const { fire } = loadBackground({ backing });
  fire({ reason: 'update' });
  await flush(40);
  assert.deepStrictEqual(backing['oc-settings'].enabledPacks, ['halloween', 'adventure']);
});

test('fresh profile seeds hollow and sets seededHollowPack', async () => {
  const backing = {};
  const { fire } = loadBackground({ backing });
  fire({ reason: 'install' });
  await flush(40);
  const s = backing['oc-settings'];
  assert.ok(s.enabledPacks.includes('hollow'), JSON.stringify(s));
  assert.strictEqual(s.seededHollowPack, true);
  assert.strictEqual(s.seededHalloweenPack, true);
});

test('upgrade profile that already had pack I seeded gets pack II once, without clobbering', async () => {
  const backing = {
    'oc-settings': { seededDefaultBlocklist: true, seededHalloweenPack: true, disabledSites: [], enabledPacks: ['halloween', 'adventure', 'seasonal'] },
  };
  const { fire } = loadBackground({ backing });
  fire({ reason: 'update' });
  await flush(40);
  const s = backing['oc-settings'];
  assert.deepStrictEqual(s.enabledPacks, ['halloween', 'adventure', 'seasonal', 'hollow']);
  assert.strictEqual(s.seededHollowPack, true);
});

test('upgrade where pack I was turned off: pack II is still seeded, pack I stays off', async () => {
  const backing = {
    'oc-settings': { seededDefaultBlocklist: true, seededHalloweenPack: true, disabledSites: [], enabledPacks: ['adventure'] },
  };
  const { fire } = loadBackground({ backing });
  fire({ reason: 'update' });
  await flush(40);
  assert.deepStrictEqual(backing['oc-settings'].enabledPacks, ['adventure', 'hollow']);
});

test('turning pack I off leaves pack II alone and vice versa across re-fires', async () => {
  const backing = {
    'oc-settings': { seededDefaultBlocklist: true, seededHalloweenPack: true, seededHollowPack: true, disabledSites: [], enabledPacks: ['hollow'] },
  };
  const { fire } = loadBackground({ backing });
  fire({ reason: 'update' });
  fire({ reason: 'update' });
  await flush(60);
  assert.deepStrictEqual(backing['oc-settings'].enabledPacks, ['hollow']);
});

test('enabledPacks stored as a non-array is coerced on the pack II write side too', async () => {
  const backing = {
    'oc-settings': { seededDefaultBlocklist: true, seededHalloweenPack: true, disabledSites: [], enabledPacks: { x: 1 } },
  };
  const { fire } = loadBackground({ backing });
  fire({ reason: 'update' });
  await flush(40);
  assert.deepStrictEqual(backing['oc-settings'].enabledPacks, ['hollow']);
});
