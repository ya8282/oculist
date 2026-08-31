// Draft input vs. active chip ownership (oculist-l6m.5).
//
// Rules under test: a non-empty input holds a DRAFT term that owns searchRanges/the
// active highlight while committed chips stay rendered with their last known counts and
// stay in the dim registry; committing the draft with Enter (or clicking a chip) hands
// ownership back to the list; clearing the input restores the previously active chip
// without a beacon.
//
// The first test also covers the blocking scope addition from the .6 review: committing
// a draft with Enter must run performListSearch() (not a bare performSearch()), so dim
// highlights and every chip's count are on screen after a single Enter — no chip click
// required.
//
// Needs a real browser for the same reasons as list_search.test.js/dim_highlight.test.js:
// CSS.highlights/Highlight only exist in real Chromium, not jsdom, and
// buildPageIndex/findRanges/performListSearch/performDraftSearch/restoreActiveChip are
// IIFE-internal and not importable — so highlight-registry contents have to be observed
// from outside via CDP against the content script's isolated execution context.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { readStoredSettings } = require('./helpers/storage');

const EXTENSION = path.resolve(__dirname, '../extension');
const CLOSED = () => !document.getElementById('oc-wrap');

// Filler pads document.body.innerText past 500 chars so the "text-heavy page" branch of
// checkSiteOverride() is actually exercised by the last test below; it contains neither
// "cat", "dog", nor "bird" so it never perturbs the hand-verified counts those terms rely
// on. "cat" appears 3 times, "dog" 2 times, "bird" once — no term is a substring of
// another here, unlike list_search.test.js's cat/cats fixture, since this file isn't
// exercising overlapping-term counting.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${'filler words to pad the page past the notice threshold. '.repeat(15)}</p>
<p>cat dog cat bird dog cat</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const CHIP_COUNT = '#oc-wrap >> .oc-chip-count';
const COUNT = '#oc-wrap >> .oc-count';
const NOTICE = '#oc-wrap >> .oc-notice';

describe('Draft input vs. active chip ownership', () => {
  let server, ctx, page, client, isolatedContextId, extId;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });

    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
    extId = sw.url().split('/')[2];

    page = await ctx.newPage();

    // Attach CDP and watch for execution-context creation *before* navigating, so the
    // event for the content script's isolated world is never missed.
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId = c.id;
      }
    });

    await page.goto(origin);
    // The real precondition for Control+f doing anything is the content script's isolated
    // world existing at all — poll the execution-context-created flag instead of guessing
    // how long injection takes.
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });
    await openFinder();
    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
    await page.keyboard.press('Escape');
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // isolatedContextId existing only proves the content script's realm has been created,
  // not that its synchronous top-level init has reached the keydown-listener registration
  // yet — under load there can still be a gap. Retry Control+f (a keypress a not-yet-
  // attached listener would otherwise silently swallow) until the input actually appears,
  // instead of trusting a single press.
  async function openFinder() {
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        // Intentional unscaled sub-poll: the scaled waitForSelector below surfaces
        // the real timeout error if all 20 attempts fail.
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
  }

  function evalInContentScript(expression) {
    return client
      .send('Runtime.evaluate', {
        expression,
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

  // Every test starts from a closed overlay and an empty working list, so chips and
  // instrumentation never leak from one test into the next.
  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
    await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");
    await openFinder();
    // The worklist was just cleared above, but loadWorkList() (chrome.storage.session.get)
    // resolves asynchronously after open — poll for the chip row to actually reflect the
    // now-empty list, rather than guessing how long that round trip takes.
    await waitForChipCount(0);
  });

  function waitForChipCount(expected, opts) {
    return page.waitForFunction(
      (n) => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.oc-chip-term') : [];
        return chips.length === n;
      },
      expected,
      { timeout: POLL_TIMEOUT, ...opts }
    );
  }

  async function addTerm(term) {
    const before = await page.locator(CHIP_TERM).count();
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
    // Enter's chip-add path (addChipTerm() -> performListSearch(), or the existing-chip
    // re-activation path) runs synchronously and ends with renderChipRow() as its very
    // last statement, so the chip row reflecting the expected shape is a genuine proxy for
    // "the whole scan (counts, highlight registries) finished".
    await page.waitForFunction(
      ({ expected, term }) => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')) : [];
        const last = chips[chips.length - 1];
        if (chips.length === expected && last && last.textContent === term) return true;
        return chips.some((el) => el.textContent === term && el.classList.contains('active'));
      },
      { expected: before + 1, term },
      { timeout: POLL_TIMEOUT }
    );
  }

  // The 150ms/400ms input debounce ends in performDraftSearch(term)/restoreActiveChip()
  // (content.js) — either way it always leaves the oculist-match registry's *content* in a
  // new, checkable state, so callers wait for their own specific expected outcome
  // afterward (they already read rangeTexts()/registryPresent() next) rather than this
  // helper guessing the debounce duration itself.
  async function typeDraft(term) {
    await page.locator(INPUT).fill(term);
  }

  function chipTerms() {
    return page.locator(CHIP_TERM).allTextContents();
  }

  function chipCounts() {
    return page.locator(CHIP_COUNT).allTextContents();
  }

  function activeChipTerm() {
    return page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const el = root.querySelector('.oc-chip-term.active');
      return el ? el.textContent : null;
    });
  }

  function rangeTexts(registryName) {
    return evalInContentScript(`
      (function () {
        var h = CSS.highlights.get('${registryName}');
        if (!h) return [];
        return Array.from(h).map(function (r) { return r.toString(); });
      })()
    `);
  }

  function registryPresent(registryName) {
    return evalInContentScript(`CSS.highlights.has('${registryName}')`);
  }

  function beaconCount() {
    return page.evaluate(() => document.querySelectorAll('.oc-beacon').length);
  }

  // Waits for oculist-match to hold exactly `term`'s own ranges — the debounce-triggered
  // effect every typeDraft() caller below actually needs, instead of guessing the
  // 150ms/400ms debounce's duration. Non-vacuous: false while a prior term (or nothing)
  // still owns the registry, true once this term's own performDraftSearch()/
  // restoreActiveChip() call has landed.
  async function waitForMatchTexts(term) {
    return waitForContentScriptValue(
      evalInContentScript,
      `(function(){var h=CSS.highlights.get('oculist-match'); return h?Array.from(h).map(function(r){return r.toString();}):[];})()`,
      (v) => Array.isArray(v) && v.length > 0 && v.every((t) => t === term),
      { timeout: POLL_TIMEOUT, message: `debounce never populated oculist-match with "${term}"'s own matches` }
    );
  }

  // The mutation-observer rescan's own DOM-visible effect (oculist-match's content) can be
  // a no-op when the rescanned term is unchanged from before the mutation (as in the
  // zero-chip-mutation test below, which rescans the same lastTerm both before and after)
  // — waiting on that would be a vacuous poll. Monkeypatch window.setTimeout inside the
  // content script's own isolated world (same technique chip_row.test.js's debounce
  // counter and list_menu.test.js's mid-debounce test use) to count calls scheduled at the
  // mutation observer's own 350ms delay (content.js's sole use of that exact delay) that
  // have actually executed, so this polls the real event instead of either guessing a
  // duration or a DOM diff that isn't guaranteed to move.
  async function armMutationRescanCounter() {
    return evalInContentScript(`
      (function () {
        if (!window.__ocMutationRescanFiresInstalled) {
          window.__ocMutationRescanFiresInstalled = true;
          window.__ocMutationRescanFires = 0;
          var orig = window.setTimeout;
          window.setTimeout = function (fn, delay) {
            if (delay === 350) {
              var wrapped = function () {
                window.__ocMutationRescanFires++;
                return fn.apply(this, arguments);
              };
              var args = [wrapped, delay].concat(Array.prototype.slice.call(arguments, 2));
              return orig.apply(window, args);
            }
            return orig.apply(window, arguments);
          };
        }
        return window.__ocMutationRescanFires;
      })()
    `);
  }

  async function waitForMutationRescan(before) {
    return waitForContentScriptValue(evalInContentScript, 'window.__ocMutationRescanFires', (v) => v > before, {
      timeout: POLL_TIMEOUT,
      message: 'the mutation-observer rescan (350ms debounce) never fired',
    });
  }

  // Arm a probe listener inside the content script's own isolated world *before* changing
  // a setting via the popup: chrome.storage.onChanged fires every listener registered
  // against that same document for the same event, so observing OUR listener fire is a
  // direct proxy for content.js's own oc-settings listener (registered first, at page
  // load) having *also* already run — including its synchronous rescan.
  async function armSettingsEcho() {
    return evalInContentScript(`
      (function () {
        if (!window.__ocSettingsEchoInstalled) {
          window.__ocSettingsEchoInstalled = true;
          window.__ocSettingsEchoes = 0;
          chrome.storage.onChanged.addListener(function (changes) {
            if (changes['oc-settings']) window.__ocSettingsEchoes++;
          });
        }
        return window.__ocSettingsEchoes;
      })()
    `);
  }

  async function waitForSettingsEcho(before, opts) {
    return waitForContentScriptValue(evalInContentScript, 'window.__ocSettingsEchoes', (v) => v > before, {
      timeout: POLL_TIMEOUT,
      message: 'oc-settings change never echoed into the content script',
      ...opts,
    });
  }

  // Flips Lite Mode via the real popup UI (chrome.storage.sync round trip), so
  // content.js's chrome.storage.onChanged listener is exercised exactly as production
  // toggling is.
  async function setLiteMode(enabled) {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#toggle-lite-mode', { state: 'attached' });
    const checked = await popup.isChecked('#toggle-lite-mode');
    if (checked === enabled) {
      await popup.close();
      await page.bringToFront();
      return;
    }

    const before = await armSettingsEcho();

    // The checkbox itself is visually hidden by the slider CSS toggle pattern — click its
    // <label> (the actionable, visible element) instead of the input.
    await popup.click('label[for="toggle-lite-mode"]');
    await waitForCondition(
      () => readStoredSettings(popup),
      (stored) => !!(stored && stored.performanceMode === enabled),
      { timeout: POLL_TIMEOUT, message: `oc-settings.performanceMode never became ${enabled}` }
    );
    await popup.close();
    await page.bringToFront();
    await waitForSettingsEcho(before);
  }

  test('a single Enter after a draft leaves dim highlights and both chip counts on screen, no chip click', async () => {
    await addTerm('cat');
    await addTerm('dog');

    assert.deepStrictEqual(await chipTerms(), ['cat', 'dog']);

    const dimPresent = await registryPresent('oculist-dim-match');
    assert.strictEqual(dimPresent, true, 'oculist-dim-match must exist after a single Enter, with no chip click');

    const dimTexts = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimTexts.length, 3, 'the inactive term ("cat") has 3 matches on the page');
    assert.ok(dimTexts.every((t) => t === 'cat'), 'the dim registry must hold the inactive term\'s ranges, not the active one\'s');

    const matchTexts = await rangeTexts('oculist-match');
    assert.strictEqual(matchTexts.length, 2, 'the active term ("dog") has 2 matches on the page');
    assert.ok(matchTexts.every((t) => t === 'dog'));

    const counts = await chipCounts();
    assert.deepStrictEqual(counts, ['3', '2'], 'both chips must show their numeric count, not a blank slot');
  });

  test('draft-then-clear restores the previously active chip without a beacon', async () => {
    await addTerm('cat');
    assert.strictEqual(await activeChipTerm(), 'cat');

    // Type a new draft without committing it — 'cat' stays the active chip throughout.
    await typeDraft('dog');
    await waitForMatchTexts('dog');

    let matchTexts = await rangeTexts('oculist-match');
    assert.ok(matchTexts.length > 0 && matchTexts.every((t) => t === 'dog'), 'the draft must own oculist-match while it is non-empty');
    let dimTexts = await rangeTexts('oculist-dim-match');
    assert.ok(dimTexts.length > 0 && dimTexts.every((t) => t === 'cat'), 'the parked chip\'s term must stay in the dim registry while a draft is active');
    assert.strictEqual(await activeChipTerm(), 'cat', 'the chip DOM must not change while a draft is merely being typed');

    // addTerm('cat')'s own commit legitimately fired a beacon (landing on match 0) that
    // is still fading out at this point (~2s lifetime) — capture the count here, right
    // before clearing, so the assertion below proves the *clear* itself adds no new
    // beacon, independent of that unrelated one's own fade timing.
    const beaconsBeforeClear = await beaconCount();

    // Clear the draft.
    await typeDraft('');
    await waitForMatchTexts('cat');

    matchTexts = await rangeTexts('oculist-match');
    assert.strictEqual(matchTexts.length, 3, '"cat" has 3 matches on the page');
    assert.ok(matchTexts.every((t) => t === 'cat'), 'clearing the draft must restore the active chip\'s own ranges as oculist-match');
    assert.strictEqual(await activeChipTerm(), 'cat');

    const activePresent = await registryPresent('oculist-active-match');
    assert.strictEqual(activePresent, false, 'restoring a chip on clear must not set a pinpoint active-match highlight');
    assert.strictEqual(
      await beaconCount(),
      beaconsBeforeClear,
      'restoring a chip on clear must never fire a beacon animation'
    );

    assert.deepStrictEqual(await chipCounts(), ['3'], 'the restored chip\'s count must still be correct');
  });

  test('typing a draft equal to an existing chip activates it instead of duplicating it on Enter', async () => {
    await addTerm('cat');
    await addTerm('dog');
    assert.strictEqual(await activeChipTerm(), 'dog');

    await typeDraft('cat'); // draft text matches an already-committed (but inactive) chip
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      const chips = root && root.shadowRoot ? Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')) : [];
      return chips.some((el) => el.textContent === 'cat' && el.classList.contains('active'));
    }, null, { timeout: POLL_TIMEOUT });

    assert.deepStrictEqual(await chipTerms(), ['cat', 'dog'], 're-committing an existing term must not create a second chip');
    assert.strictEqual(await activeChipTerm(), 'cat', 'the existing chip must become active rather than being duplicated');

    const matchTexts = await rangeTexts('oculist-match');
    assert.strictEqual(matchTexts.length, 3);
    assert.ok(matchTexts.every((t) => t === 'cat'));

    const dimTexts = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimTexts.length, 2, '"dog" is now the sole inactive term');
    assert.ok(dimTexts.every((t) => t === 'dog'));
  });

  // Defensive case from the .4 review: a restored working list can have activeIndex -1
  // (no chip currently active) while still holding real terms with real matches. That
  // must never be reported as "no matches found" — this bead owns the ownership rules
  // that make -1-with-a-non-empty-list a state performListSearch() has to handle cleanly.
  test('a restored list with no active chip never raises a false "no matches" notice', async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });

    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.set(" +
        "{ 'oc-worklist': { terms: ['cat', 'dog'], activeIndex: -1 } }, resolve))"
    );

    await openFinder();
    await waitForChipCount(2);

    // loadWorkList() on mount only populates workListTerms/activeTermIndex; a real DOM
    // mutation is what triggers the rescanAfterMutation() -> performListSearch() call
    // that actually builds termRanges/the dim registry for the restored list. Poll on the
    // exact condition the assertion below checks (the 350ms mutation-observer debounce
    // firing) instead of guessing "debounce + margin" as a wall-clock number.
    await page.evaluate(() => {
      const marker = document.createElement('span');
      marker.textContent = 'trigger-rescan';
      document.body.appendChild(marker);
    });
    const dimTexts = await waitForContentScriptValue(
      evalInContentScript,
      `(function(){var h=CSS.highlights.get('oculist-dim-match'); return h?Array.from(h).map(function(r){return r.toString();}):[];})()`,
      (v) => Array.isArray(v) && v.length === 5,
      { timeout: POLL_TIMEOUT, message: 'mutation-observer rescan never rebuilt oculist-dim-match with both terms\' matches' }
    );

    assert.strictEqual(await page.locator(NOTICE).count(), 0, 'no chip being active must not be reported as "no matches found"');
    assert.strictEqual((await page.locator(COUNT).textContent()).trim(), '', 'the count slot must stay blank, not "no match"');

    assert.strictEqual(dimTexts.length, 5, 'both terms\' real matches (3 "cat" + 2 "dog") must still be dim');
  });

  // oculist-l6m.15: with zero chips, performListSearch() substitutes [lastTerm] as an
  // implicit single term (so the mutation-rescan caller behaves like a lone performSearch())
  // and fills termRanges accordingly — but termRanges must never be left holding a stale
  // term's Ranges once a real chip lands. Repro: a mutation rescan fires while zero chips
  // are committed and lastTerm is a leftover ('cat'), then the user types a DIFFERENT term
  // ('dog') as a draft and commits it with Enter — the new chip's rendered count, and the
  // live oculist-match registry, must both belong to 'dog', never to 'cat'.
  test('committing a chip after a zero-chip mutation rescan shows the new term\'s count, not the stale one\'s', async () => {
    // Zero chips, but a lastTerm ('cat') is on record from an earlier draft search.
    await typeDraft('cat');
    await waitForMatchTexts('cat');
    let matchTexts = await rangeTexts('oculist-match');
    assert.ok(matchTexts.length > 0 && matchTexts.every((t) => t === 'cat'), 'the draft search for "cat" must have run');

    // A DOM mutation while zero chips are committed fires rescanAfterMutation() ->
    // performListSearch(), which takes the zero-chip/implicit-lastTerm branch and fills
    // termRanges from 'cat' — while workListTerms stays []. oculist-match's own content
    // does not visibly change here (it is rescanning the same 'cat' term it already held),
    // so poll the debounce timer's own firing directly instead of a DOM effect that isn't
    // guaranteed to move.
    const mutationBefore = await armMutationRescanCounter();
    await page.evaluate(() => {
      const marker = document.createElement('span');
      marker.textContent = 'trigger-rescan';
      document.body.appendChild(marker);
    });
    await waitForMutationRescan(mutationBefore);

    // Type a DIFFERENT term as a draft — never touches termRanges (oculist-l6m.5's draft
    // path) — then commit it with Enter, which pushes the first real chip.
    await typeDraft('dog');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      const chips = root && root.shadowRoot ? Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')) : [];
      return chips.length === 1 && chips[0].textContent === 'dog';
    }, null, { timeout: POLL_TIMEOUT });

    assert.deepStrictEqual(await chipTerms(), ['dog']);
    assert.deepStrictEqual(
      await chipCounts(),
      ['2'],
      'the new "dog" chip must show its own match count, not the stale "cat" count left by the mutation rescan'
    );

    matchTexts = await rangeTexts('oculist-match');
    assert.strictEqual(matchTexts.length, 2, 'the live highlight registry must hold "dog"\'s ranges');
    assert.ok(matchTexts.every((t) => t === 'dog'), 'the live highlight registry must not still hold "cat"\'s stale ranges');
  });

  // oculist-l6m.7: updateDimHighlight() has three call sites — performListSearch(),
  // performDraftSearch(), and restoreActiveChip() — and Lite Mode has to guard all three,
  // not just the first. This test walks through all three in one Lite Mode session so a
  // guard on only performListSearch() (leaving dim highlights during draft typing or chip
  // restore) fails it.
  //
  // Kept last: it changes the persisted performanceMode setting (chrome.storage.sync, not
  // reset by beforeEach) and resets it back to off at the end so it never leaks into an
  // earlier-run test.
  test('Lite Mode suppresses dim highlights during draft typing and chip restore, not just a committed scan', async () => {
    await setLiteMode(true);
    try {
      // performListSearch() call site: committing 'cat' then 'dog' with Enter. Checked via
      // registryPresent(), not just rangeTexts(), so a guard that merely ends up building
      // an empty Highlight (still .set(), just with nothing added) is caught the same as
      // one that populates it with real ranges — Lite Mode must never .set() this registry
      // at all.
      await addTerm('cat');
      await addTerm('dog');
      assert.strictEqual(
        await registryPresent('oculist-dim-match'),
        false,
        'performListSearch() must not set oculist-dim-match at all under Lite Mode'
      );

      // performDraftSearch() call site: typing a draft without committing it.
      await typeDraft('bird');
      await waitForMatchTexts('bird');
      assert.strictEqual(
        await registryPresent('oculist-dim-match'),
        false,
        'performDraftSearch() must not set oculist-dim-match at all under Lite Mode while a draft is being typed'
      );
      const draftMatch = await rangeTexts('oculist-match');
      assert.ok(draftMatch.length > 0 && draftMatch.every((t) => t === 'bird'), 'the draft itself still gets its own oculist-match highlight under Lite Mode');

      // restoreActiveChip() call site: clearing the draft hands ownership back to 'dog'.
      await typeDraft('');
      await waitForMatchTexts('dog');
      assert.strictEqual(
        await registryPresent('oculist-dim-match'),
        false,
        'restoreActiveChip() must not set oculist-dim-match at all under Lite Mode'
      );
      const restoredMatch = await rangeTexts('oculist-match');
      assert.ok(restoredMatch.length > 0 && restoredMatch.every((t) => t === 'dog'), 'restoring the active chip still restores its own oculist-match highlight under Lite Mode');
    } finally {
      await setLiteMode(false);
    }
  });
});
