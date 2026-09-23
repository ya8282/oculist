// Mirrors active_match_magnifier.test.js's own waitForWorkListLoad(): buildUI() issues its
// own loadWorkList() call as soon as the overlay mounts (content.js), but that round trip
// is async and a beforeEach that only polls waitForChipCount(0) can observe "0 chips"
// simply because the mount's own callback hasn't landed yet, not because it landed with an
// empty list. Real chrome.storage.session.get() calls against the same key resolve in the
// order they were issued, so a second loadWorkList() call issued here — after the mount's
// own — only resolves once that first one already has (oculist-v1jg).
function waitForWorkListLoad(evalInContentScript) {
  return evalInContentScript('new Promise(function (resolve) { window.__ocTest.loadWorkList(resolve); })');
}

// Ported from stale_mount_guard.test.js's own installDelayOnNextGet(): monkeypatches
// chrome.storage.session.get *inside the content script's own isolated world* so exactly
// the next call's callback is deferred delayMs (every later call resolves instantly, same
// as an unmodified browser) — used to deterministically force a mount's own loadWorkList()
// callback to land late, without relying on CPU contention. Unlike the original, the
// remaining-delay counter is re-armed on every call (not just the first), so a single test
// file can use this more than once against the same browser context/content-script world.
function installDelayOnNextGet(evalInContentScript, delayMs) {
  return evalInContentScript(
    '(function () {' +
    'window.__ocDelayRemaining = ' + delayMs + ';' +
    'if (window.__ocDelayInstalled) return true;' +
    'window.__ocDelayInstalled = true;' +
    'var origGet = chrome.storage.session.get.bind(chrome.storage.session);' +
    'chrome.storage.session.get = function (key, cb) {' +
    'var d = window.__ocDelayRemaining;' +
    'window.__ocDelayRemaining = 0;' +
    'if (d > 0 && typeof cb === "function") {' +
    'return origGet(key, function (data) { setTimeout(function () { cb(data); }, d); });' +
    '}' +
    'return origGet(key, cb);' +
    '};' +
    'return true;' +
    '})()'
  );
}

module.exports = { waitForWorkListLoad, installDelayOnNextGet };
