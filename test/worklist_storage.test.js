// Working-list session storage plumbing: content.js's loadWorkList/saveWorkList wrap
// chrome.storage.session under the 'oc-worklist' key. Content scripts can't read
// chrome.storage.session at all unless background.js's service-worker startup call to
// setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS') has run — so this needs a real
// browser with the real extension loaded, the same way color_picker_persistence.test.js
// does. A mocked chrome.storage would never exercise that access-level gate.
//
// Content scripts execute in an isolated JS world: nothing outside content.js's IIFE
// (including page.evaluate(), which runs in the page's main world) can call
// loadWorkList/saveWorkList directly, or even see window.__ocTest — Chrome's
// isolated-world model does not expose content-script state to the page. There is also
// no extension-API bridge available here: chrome.scripting.executeScript needs a host
// permission or a fresh user gesture (activeTab) that this test cannot manufacture, and
// the manifest deliberately requests neither (per this bead's "no new permissions"
// constraint). The bridge that actually works, with zero extension-permission
// involvement, is raw CDP: attach a CDPSession, find the isolated execution context
// Chrome created for this extension's content script, and call Runtime.evaluate against
// that context directly. That runs genuinely inside content.js's isolated world — a real
// content-script-context call, not a mock.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world</p>';

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const COUNT = '#oc-wrap >> .oc-count';
const CLOSED = () => !document.getElementById('oc-wrap');

describe('Working-list session storage (oc-worklist)', () => {
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
      // Every frame also gets a "default" (main-world) context and Playwright's own
      // utility-world context; the content script's world is the isolated one whose
      // origin is the extension itself, not the page.
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId = c.id;
      }
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // The real precondition for Control+f doing anything is the content script's isolated
    // world existing at all — poll the execution-context-created flag instead of guessing
    // how long injection takes.
    {
      const deadline = Date.now() + POLL_TIMEOUT;
      while (!isolatedContextId) {
        if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    // Confirms the content script (and its window.__ocTest.loadWorkList/saveWorkList
    // hooks) has actually mounted before any test tries to reach into its world. Retry
    // Control+f itself (a keypress a not-yet-attached listener would otherwise silently
    // swallow) until the input actually appears, instead of trusting a single press.
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
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // Closing (Escape) and reopening (Control+f) the overlay within the same page load
  // reuses the same content-script instance and its window.__ocToggle — this is what
  // actually re-runs buildUI()'s loadWorkList() mount-restore callback, unlike calling
  // window.__ocTest.loadWorkList directly (which never touches workListTerms/termRanges/the
  // chip DOM at all). keydownHandler is registered once in boot() and never torn down
  // by __ocDestroy(), so a single Control+f press is reliable here — no retry loop needed
  // the way the very first open (before any listener exists) requires elsewhere.
  async function closeOverlay() {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
  }

  async function reopenOverlay() {
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  function waitForChipCount(expected) {
    return page.waitForFunction(
      (n) => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.oc-chip-term') : [];
        return chips.length === n;
      },
      expected,
      { timeout: POLL_TIMEOUT }
    );
  }

  // Monkeypatch window.getComputedStyle *inside the content script's own isolated world* —
  // buildPageIndex() reads it on every call (content.js:2322), so a rise in this counter
  // is consistent with a scan having run. It is not the ONLY caller: drawActiveMatchMagnifier
  // (content.js:2043) and getPageBackgroundRgb() (content.js:4786, called synchronously
  // right after buildUI() returns via injectHighlightStyles()) both call it too, for
  // reasons unrelated to scanning. That is exactly why a raw before/after diff of this
  // counter across "close the overlay, then reopen it" is not sufficient on its own to
  // prove no scan ran — installRestoreProbe() below narrows the window to only the
  // mount-restore callback's own synchronous execution, where the ambiguity does not
  // matter. Idempotent so it is safe to call from more than one test.
  function installGCSProbe() {
    return evalInContentScript(`
      (function () {
        if (window.__ocGCSInstalled) return true;
        window.__ocGCSInstalled = true;
        window.__ocGCSCalls = 0;
        var orig = window.getComputedStyle;
        window.getComputedStyle = function () {
          window.__ocGCSCalls++;
          return orig.apply(window, arguments);
        };
        return true;
      })()
    `);
  }

  // Monkeypatch chrome.storage.session.get *inside the content script's own isolated
  // world*, specifically for the 'oc-worklist' key — the only key loadWorkList() ever
  // reads (content.js:112). Its callback wraps whatever callback buildUI() passed in
  // (content.js:4658-4671: sets workListTerms/activeTermIndex/termRanges and calls
  // renderChipRow(), all synchronously, no further await in between). Snapshotting
  // window.__ocGCSCalls immediately before and immediately after that inner callback
  // runs — both taken synchronously inside the same monkeypatched function, not
  // round-tripped through Playwright/CDP in between — brackets exactly the mount-restore
  // callback's own execution and nothing else: not the earlier synchronous
  // injectHighlightStyles()/getPageBackgroundRgb() work (content.js:5675, which the real
  // __ocToggle() runs right after buildUI() returns, well before this storage round trip
  // resolves), and not the CDP/network latency of observing it from Node. A
  // buildPageIndex() call injected into the mount-restore callback lands inside this
  // window and diverges before !== after; this was verified by temporarily adding one to
  // content.js and confirming the "triggers no scan" test below then fails. Depends on
  // installGCSProbe() already being installed. Idempotent.
  function installRestoreProbe() {
    return evalInContentScript(`
      (function () {
        if (window.__ocRestoreProbeInstalled) return true;
        window.__ocRestoreProbeInstalled = true;
        window.__ocRestoreGCSBefore = null;
        window.__ocRestoreGCSAfter = null;
        var origGet = chrome.storage.session.get.bind(chrome.storage.session);
        chrome.storage.session.get = function (key, cb) {
          if (key === 'oc-worklist' && typeof cb === 'function') {
            return origGet(key, function (data) {
              window.__ocRestoreGCSBefore = window.__ocGCSCalls;
              cb(data);
              window.__ocRestoreGCSAfter = window.__ocGCSCalls;
            });
          }
          return origGet(key, cb);
        };
        return true;
      })()
    `);
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

  test('a read with no stored value yields the empty default', async () => {
    // The whole justification for window.__ocTest existing is that it is invisible outside
    // this extension's isolated execution context: reachable via CDP Runtime.evaluate
    // scoped to isolatedContextId (as the loadWorkList call below and every other test in
    // this file relies on), but never visible from the host page's own main world, which
    // is exactly what page.evaluate() runs in. Pinned directly here, alongside the first
    // real use of the namespace, so a future regression that accidentally leaked it onto
    // the page is caught explicitly rather than merely implied by other tests succeeding.
    const isolatedType = await evalInContentScript('typeof window.__ocTest');
    assert.strictEqual(isolatedType, 'object');
    const mainWorldValue = await page.evaluate(() => window.__ocTest);
    assert.strictEqual(mainWorldValue, undefined);

    // Explicitly clear first — chrome.storage.session persists for the whole browser
    // session, not just this page load, so a prior test's write would otherwise leak in.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))"
    );

    const result = await evalInContentScript(
      'new Promise((resolve) => window.__ocTest.loadWorkList((list) => resolve(list)))'
    );

    assert.deepStrictEqual(result, { terms: [], activeIndex: -1 });
  });

  test('a working list saved from a content-script context round-trips through loadWorkList', async () => {
    const saved = { terms: ['alpha', 'beta'], activeIndex: 1 };

    const result = await evalInContentScript(
      '(' +
        function (deadlineMs) {
          return new Promise((resolve, reject) => {
            window.__ocTest.saveWorkList({ terms: ['alpha', 'beta'], activeIndex: 1 });
            // saveWorkList has no completion callback by design (its signature is
            // saveWorkList(list)) — poll the underlying chrome.storage.session write
            // directly until it actually lands, instead of guessing how long the async
            // set() call takes, before reading it back through loadWorkList. A generous
            // deadline: chrome.storage's IPC round trip to the extension/browser process
            // can lag well past a same-process JS timer under heavy CPU contention.
            // deadlineMs comes in as an argument (not read from process.env, which is
            // unreachable from this in-page context) so OCULIST_TEST_TIMEOUT_SCALE still
            // reaches this poller.
            var deadline = Date.now() + deadlineMs;
            (function poll() {
              chrome.storage.session.get('oc-worklist', function (data) {
                var stored = data && data['oc-worklist'];
                if (stored && stored.terms && stored.terms.length === 2) {
                  window.__ocTest.loadWorkList(function (loaded) { resolve(loaded); });
                  return;
                }
                if (Date.now() > deadline) {
                  reject(new Error('chrome.storage.session write from saveWorkList() never landed'));
                  return;
                }
                setTimeout(poll, 30);
              });
            })();
          });
        }.toString() +
        `)(${LONG_TIMEOUT})`
    );

    assert.deepStrictEqual(result, saved);

    // Confirm it is genuinely sitting in chrome.storage.session (not just echoed back by
    // an in-memory shortcut) — read it back directly, bypassing loadWorkList entirely.
    const stored = await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.get('oc-worklist', (data) => resolve(data['oc-worklist'])))"
    );
    assert.deepStrictEqual(stored, saved);
  });

  // oculist-la4: buildUI()'s loadWorkList() mount-restore callback writes
  // workListTerms/activeTermIndex straight from storage without a rescan. It now also
  // sets termRanges = [] explicitly (content.js:4670) rather than relying on __ocDestroy()
  // having already zeroed it, so the invariant holds locally rather than by action at a
  // distance. The tests below pin: (1) the resulting chip render is blank-count/no-active
  // as expected, not stale data, (2) no scan actually runs to produce that state, and (3)
  // an out-of-range stored index ends up rendering no active chip and no throw. Note (3)
  // deliberately makes no claim about WHICH layer produces that outcome — see the note
  // above that test.
  //
  // What this suite CANNOT observe: whether termRanges = [] is a live fix or a no-op,
  // because a genuinely non-empty termRanges is not reachable at this callback through any
  // real product path this black-box test can drive. The only two ways into buildUI()'s
  // mount-restore callback are (a) the very first open of a page, where termRanges is
  // freshly initialised to [] (content.js:647) and nothing has run yet to populate it, or
  // (b) a reopen after __ocDestroy() (content.js:742), which already resets termRanges to
  // [] as part of teardown — so there is no reachable sequence of real user actions that
  // leaves a stale non-empty termRanges sitting around for this callback to inherit. This
  // is confirmed, not assumed: negative-controlling these tests against the pre-fix
  // content.js (git stash the one-line change) leaves them green, because the reset is a
  // provable no-op today. Constructing a positive case would require a test-only hook into
  // production state, which is exactly what this bead's own instructions rule out — so
  // this half of the invariant is pinned defensively, not proven to catch a live defect.
  describe('mount-restore leaves termRanges consistent with activeTermIndex (oculist-la4)', () => {
    async function setStoredWorkList(list) {
      await evalInContentScript(
        `new Promise((resolve, reject) => {
          chrome.storage.session.set({ 'oc-worklist': ${JSON.stringify(list)} }, function () {
            var deadline = Date.now() + ${LONG_TIMEOUT};
            (function poll() {
              chrome.storage.session.get('oc-worklist', function (data) {
                var stored = data && data['oc-worklist'];
                if (stored && stored.activeIndex === ${list.activeIndex} && stored.terms.length === ${list.terms.length}) {
                  resolve(true);
                  return;
                }
                if (Date.now() > deadline) { reject(new Error('storage write never landed')); return; }
                setTimeout(poll, 30);
              });
            })();
          });
        })`
      );
    }

    test('a restored working list renders blank chip counts and triggers no scan', async () => {
      await closeOverlay();
      await setStoredWorkList({ terms: ['restored-alpha', 'restored-beta'], activeIndex: 1 });
      await installGCSProbe();
      await installRestoreProbe();

      await reopenOverlay();
      await waitForChipCount(2);

      // "No scan ran": window.__ocRestoreGCSBefore/After bracket only the mount-restore
      // callback's own synchronous body (see installRestoreProbe() above) — not the
      // earlier, unrelated getComputedStyle() traffic from opening the overlay at all, and
      // not the latency of this Node-side wait. A real scan (buildPageIndex()) executing
      // inside that callback would move the counter between the two snapshots; nothing
      // else in this test touches the page or input to trigger a debounced scan either.
      const restoreBefore = await evalInContentScript('window.__ocRestoreGCSBefore');
      const restoreAfter = await evalInContentScript('window.__ocRestoreGCSAfter');
      assert.strictEqual(
        restoreAfter,
        restoreBefore,
        'the loadWorkList() mount-restore callback must not call buildPageIndex() / getComputedStyle()'
      );

      const chips = await page.evaluate(() => {
        const root = document.getElementById('oc-wrap').shadowRoot;
        return Array.from(root.querySelectorAll('.oc-chip-term')).map((btn) => ({
          text: btn.textContent,
          active: btn.classList.contains('active'),
          ariaLabel: btn.getAttribute('aria-label'),
          count: btn.closest('.oc-chip').querySelector('.oc-chip-count').textContent,
        }));
      });

      assert.deepStrictEqual(
        chips.map((c) => c.text),
        ['restored-alpha', 'restored-beta']
      );
      // activeIndex: 1 -> the second chip is active, the first is not.
      assert.strictEqual(chips[0].active, false);
      assert.strictEqual(chips[1].active, true);
      // Blank counts, not stale/zero counts from any previous session — termRanges[i] must
      // be undefined for every restored term, matching the un-scanned chip contract
      // renderChipRow() already gives addChipTerm()'s freshly-pushed terms.
      for (const chip of chips) {
        assert.strictEqual(chip.count, '', `expected a blank count for "${chip.text}", got "${chip.count}"`);
        assert.ok(
          !/match/i.test(chip.ariaLabel),
          `expected no match count in aria-label for "${chip.text}", got "${chip.ariaLabel}"`
        );
      }
    });

    // What this test pins, precisely: the END-TO-END outcome that a stored activeIndex of
    // 99 against a 2-term list yields no active chip and no throw. That is worth having.
    //
    // What it does NOT pin, despite being the obvious thing to assume: normalizeWorkList()'s
    // clamp (content.js:108). Verified by mutation — deleting that line leaves all five
    // tests in this file green. The outcome is overdetermined: with the clamp, the index is
    // coerced to -1 upstream; without it, activeTermIndex really is 99 at the callback and
    // renderChipRow()'s `isActive = i === activeTermIndex` simply never matches. Both layers
    // independently produce "no active chip", so no assertion here can tell them apart.
    //
    // Making it discriminate would need a value-level assertion on activeTermIndex itself,
    // which is not reachable black-box without adding a production hook. Not worth one.
    test('a stored activeIndex out of range for its terms renders no active chip and does not throw', async () => {
      await closeOverlay();
      await setStoredWorkList({ terms: ['x', 'y'], activeIndex: 99 });

      await reopenOverlay();
      await waitForChipCount(2);

      const chips = await page.evaluate(() => {
        const root = document.getElementById('oc-wrap').shadowRoot;
        return Array.from(root.querySelectorAll('.oc-chip-term')).map((btn) => ({
          active: btn.classList.contains('active'),
          ariaPressed: btn.getAttribute('aria-pressed'),
          count: btn.closest('.oc-chip').querySelector('.oc-chip-count').textContent,
        }));
      });

      assert.strictEqual(chips.length, 2, 'both chips must still render despite the out-of-range index');
      for (const chip of chips) {
        assert.strictEqual(chip.active, false);
        assert.strictEqual(chip.ariaPressed, 'false');
        assert.strictEqual(chip.count, '');
      }
    });

    test('an empty stored working list is unaffected: chip row stays hidden on mount', async () => {
      await closeOverlay();
      await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");

      await reopenOverlay();
      // No chips ever appear, so there is nothing to poll for — wait on the chip row's own
      // hidden state settling instead, via the isolated-world termRanges/workListTerms
      // pairing already exercised above (an empty list resolves synchronously fast, but
      // still asynchronously after the storage.session.get round trip).
      await page.waitForFunction(
        () => {
          const root = document.getElementById('oc-wrap');
          const row = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-chip-row') : null;
          return !!row && row.hidden === true;
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      const chipCount = await page.locator(CHIP_TERM).count();
      assert.strictEqual(chipCount, 0);
    });

    // oculist-l6m.34: the same false "no match" claim .19 fixed in findNext(), reached
    // through a different entry point. restoreActiveChip() (content.js) does
    // `searchRanges = termRanges[activeTermIndex] || [];` — coalescing "never scanned"
    // (undefined) and "scanned, genuinely zero matches" ([]) into the same [] before the
    // count text is decided, so without a guard captured BEFORE that coalesce, an
    // unscanned chip and a real zero-match chip become indistinguishable by the time the
    // count text is chosen. Only reachable via restoreActiveChip(), which only the input's
    // own debounce (typing a draft, then clearing it) calls — driving it directly would
    // not prove the bug is fixed on the path that actually hits it, so both tests below
    // go through page.locator(INPUT).fill() + the real 150ms debounce, never a direct
    // content-script call.
    test('typing a draft then clearing it against a restored-but-unscanned active chip leaves the count blank, not "no match"', async () => {
      await closeOverlay();
      // activeIndex: 1 -> 'restored-beta' is the active chip, exactly like the mount-restore
      // fixture above; termRanges[1] is undefined because mount-restore never scans.
      await setStoredWorkList({ terms: ['restored-alpha', 'restored-beta'], activeIndex: 1 });

      await reopenOverlay();
      await waitForChipCount(2);

      // Type a draft that genuinely matches the page ('quarklet', from PAGE above) so the
      // debounce's performDraftSearch() branch moves the count off its post-mount blank
      // state first — the blank -> real count -> blank transition below is what proves the
      // debounce actually re-ran restoreActiveChip() on clear, rather than the count simply
      // never having moved since mount.
      await page.locator(INPUT).fill('quarklet');
      await page.waitForFunction(
        () => {
          const el = document.getElementById('oc-wrap')?.shadowRoot?.querySelector('.oc-count');
          return !!el && /of \d+$/.test(el.textContent);
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      // Clear the draft — the input's own debounce handler calls restoreActiveChip()
      // against the still-unscanned 'restored-beta' chip.
      await page.locator(INPUT).fill('');
      await page.waitForFunction(
        () => {
          const el = document.getElementById('oc-wrap')?.shadowRoot?.querySelector('.oc-count');
          return !!el && el.textContent === '';
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      assert.strictEqual(
        await page.locator(COUNT).textContent(),
        '',
        'restoreActiveChip() must leave the count blank for an unscanned chip, not report "no match"'
      );
    });

    // Contrast case: without this, a fix that simply blanks the count unconditionally
    // (rather than testing termRanges[activeTermIndex] for undefined) would pass the test
    // above for the wrong reason. A real Enter commit runs an actual scan
    // (performListSearch()), so termRanges[0] ends up a genuine, empty array — not
    // undefined — for a term with no matches on the page.
    test('typing a draft then clearing it against a chip that was actually scanned and has zero matches still shows "no match"', async () => {
      await closeOverlay();
      await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");

      await reopenOverlay();
      await waitForChipCount(0);

      const before = await page.locator(CHIP_TERM).count();
      await page.locator(INPUT).fill('zzzznomatchterm');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (expected) => {
          const root = document.getElementById('oc-wrap');
          const chips = root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.oc-chip-term') : [];
          return chips.length === expected;
        },
        before + 1,
        { timeout: POLL_TIMEOUT }
      );
      await page.waitForFunction(
        () => {
          const el = document.getElementById('oc-wrap')?.shadowRoot?.querySelector('.oc-count');
          return !!el && el.textContent === 'no match';
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      // Type a draft that genuinely matches, moving ownership off the committed chip.
      await page.locator(INPUT).fill('quarklet');
      await page.waitForFunction(
        () => {
          const el = document.getElementById('oc-wrap')?.shadowRoot?.querySelector('.oc-count');
          return !!el && /of \d+$/.test(el.textContent);
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      // Clear the draft — restoreActiveChip() runs against the SCANNED, genuinely
      // zero-match chip.
      await page.locator(INPUT).fill('');
      await page.waitForFunction(
        () => {
          const el = document.getElementById('oc-wrap')?.shadowRoot?.querySelector('.oc-count');
          return !!el && el.textContent === 'no match';
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      assert.strictEqual(
        await page.locator(COUNT).textContent(),
        'no match',
        'a chip that was actually scanned and genuinely has zero matches must still report "no match"'
      );
    });
  });
});
