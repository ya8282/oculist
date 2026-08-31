// Regression test for oculist-3z6: buildUI()'s loadWorkList() mount-restore callback
// (content.js) guards `ownMountGeneration !== mountGeneration` before touching
// workListTerms/activeTermIndex/the chip DOM. That guard exists specifically for a mount
// (call it A) whose chrome.storage.session.get('oc-worklist', cb) round trip is slow: the
// overlay can be closed (tearing A down) and reopened (mount B, which runs its own
// loadWorkList() and restores the real working list) before A's cb ever fires. Without the
// guard, A's stale callback still lands, still sees a non-null wrapRoot/chipRow (mount B's),
// and clobbers the list B just restored.
//
// This was previously verified only by a throwaway probe script, never by a committed
// test — see this bead. The technique below (delay exactly the first
// chrome.storage.session.get callback, then let every later call resolve instantly) is the
// same one that probe used, ported into this suite's CDP/Playwright harness (see
// worklist_storage.test.js for the underlying rationale: content scripts run in an isolated
// world that page.evaluate() cannot reach, so real content-script-context state has to be
// read/mutated through a CDP Runtime.evaluate call scoped to that isolated execution
// context, not through the page).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { TIMEOUT_SCALE, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world</p>';

const INPUT = '#oc-wrap >> .oc-input';
const CLOSED = () => !document.getElementById('oc-wrap');

// Fixed, not scaled: this stands in for a genuinely slow chrome.storage.session IPC round
// trip, not for contention on the test machine — scaling it up would just make the test
// slower without exercising the guard any harder. The wait past it (below) is what needs
// the contention headroom, and that one is scaled.
const DELAY_MS = 3000;
const SETTLE_MARGIN = 1500 * TIMEOUT_SCALE;

describe('Stale mount loadWorkList guard (oculist-3z6)', () => {
  let server, ctx, page, client, isolatedContextId;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP and watch for execution-context creation *before* navigating, so the
    // event for the content script's isolated world (created once the extension injects
    // at document_idle) is never missed.
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId = c.id;
      }
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    {
      const deadline = Date.now() + POLL_TIMEOUT;
      while (!isolatedContextId) {
        if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        await page.waitForSelector(INPUT, { timeout: 250 });
        break;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });

    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
  });

  after(async () => {
    // The delay monkeypatch installed below lives only inside this test's own
    // launchPersistentContext(), which is closed here — nothing survives into another
    // test file's (freshly launched) browser context.
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function closeOverlay() {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
  }

  async function reopenOverlay() {
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  function evalInContentScript(expression) {
    return client
      .send('Runtime.evaluate', {
        expression: expression,
        contextId: isolatedContextId,
        awaitPromise: true,
        returnByValue: true,
      })
      .then((res) => {
        if (res.exceptionDetails) {
          throw new Error('content-script eval failed: ' + JSON.stringify(res.exceptionDetails));
        }
        return res.result.value;
      });
  }

  function readChipTerms() {
    return page.evaluate(() => {
      const root = document.getElementById('oc-wrap');
      const chips = root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.oc-chip-term') : [];
      return Array.from(chips).map((el) => el.textContent);
    });
  }

  // LONG_TIMEOUT (not the default POLL_TIMEOUT): the only caller (below) uses this to wait
  // for mount B's chip row after a fresh reopen — a real chrome.storage.session.get() round
  // trip through the extension's storage backend, plus a full buildUI() render, the same
  // storage-IO-bound cost category worklist_storage.test.js already budgets LONG_TIMEOUT
  // for. (The other wait in this file, below — DELAY_MS + SETTLE_MARGIN — is not a budget
  // for this same kind of work: it deliberately waits past mount A's own
  // artificially-delayed callback, a fixed point in time this test controls, not a real
  // storage round trip it is estimating. This is the first LONG_TIMEOUT use in this file.)
  // Observed under contention: this call timed out at POLL_TIMEOUT (5000ms) waiting on a
  // genuinely-still-in-flight restore (page.waitForFunction: Timeout 5000ms exceeded),
  // not a stuck or broken predicate.
  function waitForChipTerms(expectedTerms) {
    return page.waitForFunction(
      (terms) => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')).map((e) => e.textContent) : [];
        return chips.length === terms.length && chips.every((c, i) => c === terms[i]);
      },
      expectedTerms,
      { timeout: LONG_TIMEOUT }
    );
  }

  // Monkeypatch chrome.storage.session.get *inside the content script's own isolated
  // world*, so exactly the next call's callback is deferred delayMs (every later call
  // resolves instantly, same as an unmodified browser). This mirrors the reviewer's
  // repro_3z6.js probe: buildUI() only ever calls chrome.storage.session.get() from
  // loadWorkList() (content.js:140), so delaying "the next call" and then immediately
  // triggering a fresh mount reliably delays that mount's own loadWorkList() callback and
  // nothing else's.
  function installDelayOnNextGet(delayMs) {
    return evalInContentScript(
      '(function () {' +
      'if (window.__ocDelayInstalled) return true;' +
      'window.__ocDelayInstalled = true;' +
      'window.__ocDelayRemaining = ' + delayMs + ';' +
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

  test("a stale mount's delayed loadWorkList callback does not clobber a newer mount's restored chip row", async () => {
    // before() already opened one mount while booting the content script; start this test
    // from a clean, closed baseline.
    await closeOverlay();
    await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");

    await installDelayOnNextGet(DELAY_MS);

    // Mount A: its buildUI() loadWorkList() callback is now in flight, delayed DELAY_MS.
    // Storage is empty at this point, so once it lands it would restore the empty default.
    await reopenOverlay();

    // Tear mount A down well before its delayed callback can fire.
    await closeOverlay();

    // Seed a real working list directly in storage — this is mount B's restore target,
    // written the same way a carried-over list from a previous mount would already be
    // sitting in chrome.storage.session before a fresh mount reads it.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.set({'oc-worklist':{terms:['unscanned-term'],activeIndex:0}}, resolve))"
    );

    // Mount B: its own loadWorkList() call is undelayed (the delay was consumed by mount
    // A's call) and restores the seeded list synchronously.
    await reopenOverlay();
    await waitForChipTerms(['unscanned-term']);

    // Wait past mount A's delayed callback landing. With the mountGeneration guard intact,
    // that stale callback is dropped and mount B's chip row is untouched. Without it, the
    // stale callback still runs against mount B's (non-null) wrapRoot/chipRow, overwrites
    // workListTerms with mount A's own (empty) load, and wipes the chip row.
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS + SETTLE_MARGIN));

    const survivingChips = await readChipTerms();
    assert.deepStrictEqual(
      survivingChips,
      ['unscanned-term'],
      'stale mount-A loadWorkList callback clobbered the chip row restored by mount B'
    );
  });
});
