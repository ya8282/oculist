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

module.exports = { waitForHalloweenSeedSettled };
