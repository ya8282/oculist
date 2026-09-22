// chrome.storage.session is unusable from a content script until background.js's
// service-worker startup call to setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS') actually
// lands — an independent async path with no ordering guarantee relative to this content
// script's own boot (both fire off the same extension load, on separate timelines). Racing
// it fails fast and silent, not slow: a chrome.storage.session call issued before the grant
// lands is rejected within a couple of milliseconds with chrome.runtime.lastError "Access
// to storage is not allowed from this context.", and content.js's own loadWorkList()/
// saveWorkList() deliberately swallow that error (production code must not throw on a
// browser lacking the access-level API) — they also retry once via background.js's
// ensureSessionAccess message, so they tolerate the race on their own.
//
// A test's own RAW chrome.storage.session call (bypassing that retry, e.g. seeding or
// clearing 'oc-worklist' directly via CDP) has no such protection: if it loses the race,
// the write/removal is silently and permanently dropped, and every later poll for its
// effect times out (or, worse, observes stale leftover state from a previous test) at the
// full budget waiting for data that was never written/cleared. Root-caused by instrumenting
// both sides directly (oculist-z4s): a standalone repro launching this same extension cold,
// timestamping content.js's saveWorkList() call against background.js's setAccessLevel()
// resolution, hit exactly this ordering on 2 of 15 cold launches (once by 9ms) with no
// artificial load, and reproduced far more readily under synthetic CPU contention
// (oculist-434k, oculist-ilkz) — the denial window measured 128-713ms under 8-worker load,
// occasionally spanning more than one test's worth of hooks. Wait out the real precondition
// once, here, before any test in the caller's file touches chrome.storage.session, using a
// harmless probe key so nothing here depends on (or leaves behind) real working-list data.
//
// Originally duplicated verbatim across worklist_storage.test.js, stale_mount_guard.test.js
// and draft_ownership.test.js; extracted here so a future change to the probe only has one
// place to land.
const { waitForCondition, POLL_TIMEOUT } = require('./wait');

async function waitForSessionAccess(client, isolatedContextId, opts = {}) {
  const { timeout = POLL_TIMEOUT } = opts;
  await waitForCondition(
    async () => {
      const res = await client.send('Runtime.evaluate', {
        expression:
          "new Promise((resolve) => chrome.storage.session.get('__oc_access_probe__', " +
          '() => resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : null)))',
        contextId: isolatedContextId,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error('access-probe eval failed: ' + JSON.stringify(res.exceptionDetails));
      }
      return res.result.value;
    },
    (denied) => !denied,
    {
      timeout,
      interval: 30,
      message: 'chrome.storage.session access was never granted to the content script',
    }
  );
}

module.exports = { waitForSessionAccess };
