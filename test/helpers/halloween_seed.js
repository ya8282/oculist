// oculist-e5c5: background.js's seedHalloweenPack() (oculist-nq1x.2) runs on every
// chrome.runtime.onInstalled -- i.e. on every fresh --load-extension a test launches --
// and does an async chrome.storage.sync get -> mutate -> set round trip that pushes
// 'halloween' into settings.enabledPacks. content.js picks that up via its own
// chrome.storage.onChanged listener and overwrites its module-private settings.enabledPacks
// asynchronously, independent of anything a test does. A test that writes its own fixture
// state into settings.enabledPacks (directly, or through storage) and reads it straight
// back races that seed: if the seed's onChanged fallout lands in between, the read
// reflects the seed's value instead of the test's own.
//
// waitForHalloweenSeedSettled(evalInContentScript) waits out BOTH halves of that seed
// before a caller writes its own fixture state, so nothing written afterward can be
// clobbered by it landing late:
//   1. background.js's write has actually committed (settings.seededHalloweenPack is true
//      in chrome.storage.sync) -- proves the WRITE happened, not that content.js has
//      reacted to it yet.
//   2. content.js's own storage.onChanged listener has applied that write to its
//      module-private `settings` -- proven via window.__ocTest.getAvailableEffectKeys()
//      including 'boneassembly' (extension/content.js's own halloween-packed effectsRegistry
//      entry, oculist-nq1x.5). Every fixture in this suite that copies extension/ wholesale
//      (fs.cpSync) keeps that entry even when it separately patches other registry entries
//      (e.g. to give some other effect a `pack`), so this check is safe to share across
//      fixtures. A fixture that deliberately STRIPS boneassembly's own `pack` field (so the
//      seed can't affect it at all, e.g. effect_pack_settings_control.test.js) has nothing
//      to wait for in the first place and does not need this helper.
//
// `evalInContentScript` is the caller's own CDP Runtime.evaluate bridge (same convention as
// every *.test.js file in this suite) -- it must be called with awaitPromise: true, since
// both expressions below hand it a Promise.
const { waitForCondition, POLL_TIMEOUT } = require('./wait');

const READ_SEEDED_FLAG_EXPR =
  "new Promise(function (resolve) {" +
  "chrome.storage.sync.get('oc-settings', function (data) {" +
  "resolve(!!(data && data['oc-settings'] && data['oc-settings'].seededHalloweenPack));" +
  "});" +
  "})";

async function waitForHalloweenSeedSettled(evalInContentScript, opts = {}) {
  const { timeout = POLL_TIMEOUT } = opts;
  await waitForCondition(() => evalInContentScript(READ_SEEDED_FLAG_EXPR), Boolean, {
    timeout,
    message: 'seedHalloweenPack never finished writing seededHalloweenPack',
  });
  await waitForCondition(
    () => evalInContentScript('window.__ocTest.getAvailableEffectKeys()'),
    (keys) => keys.indexOf('boneassembly') !== -1,
    {
      timeout,
      message: 'seedHalloweenPack storage write landed but content.js never applied it (onChanged)',
    }
  );
}

// oculist-hmql: waits, via the extension service worker, for every write background.js's
// onInstalled makes (seededDefaultBlocklist, seededHalloweenPack, and performanceMode on
// machines with under 4 cores) to land in chrome.storage.sync 'oc-settings'. A test's own
// settings write issued before they land can be clobbered by a seed's late read-modify-write.
// Called once per extension launch from the launchPersistentContext patch in wait.js.
async function waitForOnInstalledSeeds(ctx, opts = {}) {
  const { timeout = POLL_TIMEOUT } = opts;
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout }));
  await waitForCondition(
    () =>
      sw.evaluate(
        () =>
          new Promise((resolve) =>
            chrome.storage.sync.get('oc-settings', (d) =>
              resolve({ s: d && d['oc-settings'], cores: navigator.hardwareConcurrency })
            )
          )
      ),
    ({ s, cores }) =>
      !!(s && s.seededDefaultBlocklist && s.seededHalloweenPack && (!(cores && cores < 4) || s.performanceMode === true)),
    {
      timeout,
      interval: 20,
      message: 'onInstalled writes (seededDefaultBlocklist, seededHalloweenPack, performanceMode on <4 cores) never all landed',
    }
  );
}

// oculist-7dcg: on a <4-core machine onInstalled auto-enables Lite Mode, so every test would
// start in Lite and a test's own setSettings({performanceMode:true}) would be a no-op write
// with no onChanged echo. Called right after waitForOnInstalledSeeds (which, on <4 cores,
// already waited for performanceMode === true to land), this resets it to the full-motion
// default. Writes nothing when performanceMode is already falsy (>= 4 cores), so those
// machines see no extra storage write.
async function clearAutoLiteMode(ctx, opts = {}) {
  const { timeout = POLL_TIMEOUT } = opts;
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout }));
  await sw.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.storage.sync.get('oc-settings', (d) => {
          const s = d && d['oc-settings'];
          if (!s || !s.performanceMode) return resolve();
          chrome.storage.sync.set({ 'oc-settings': Object.assign({}, s, { performanceMode: false }) }, resolve);
        })
      )
  );
  await waitForCondition(
    () =>
      sw.evaluate(
        () =>
          new Promise((resolve) =>
            chrome.storage.sync.get('oc-settings', (d) => resolve(!!(d && d['oc-settings'] && d['oc-settings'].performanceMode)))
          )
      ),
    (lite) => lite === false,
    { timeout, interval: 20, message: 'oc-settings.performanceMode never read back false after the launch helper cleared it' }
  );
}

module.exports = { waitForHalloweenSeedSettled, waitForOnInstalledSeeds, clearAutoLiteMode };
