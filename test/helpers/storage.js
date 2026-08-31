// Reads the extension's persisted settings blob (oc-settings) out of chrome.storage.sync,
// via a page.evaluate() round trip against whatever Playwright page/popup handle the caller
// passes in. Used together with waitForCondition (test/helpers/wait.js) to poll for a
// storage write landing, rather than page.waitForFunction(() => chrome.storage.sync.get(...)
// .then(...)) — a promise is always truthy, so that pattern resolves on its first poll
// whether or not the write ever actually happens.
function readStoredSettings(target) {
  return target.evaluate(
    () => new Promise((resolve) => chrome.storage.sync.get('oc-settings', (d) => resolve(d['oc-settings'])))
  );
}

module.exports = { readStoredSettings };
