// Lite Mode: remove-then-restore keeps the count and real highlights in agreement
// (oculist-l6m.20 — regression pin on the invariant oculist-l6m.33 established).
//
// Lite Mode (oculist-l6m.7) stores each INACTIVE term's termRanges entry as a sparse
// `new Array(count)` placeholder — holes carrying only a .length, never real Range
// objects — to skip the layout-thrashing cost of findRanges() for a chip nobody is
// looking at. Only the active index is ever given real Ranges, unconditionally, inside
// performListSearch() (see the comment there). removeChipAt() splices workListTerms/
// termRanges and re-points activeTermIndex, then calls performListSearch() synchronously
// in the same turn (oculist-l6m.33), so termRanges[activeTermIndex] is always real
// Ranges by the time any later caller — including restoreActiveChip() on a
// draft-then-clear — reads it. This file pins that behaviour end-to-end through real
// chip add/activate/remove/draft-clear interactions, asserting on the live
// CSS.highlights registry (not just the count text) so the count and what is actually
// lit can never silently disagree.
//
// Needs a real browser for the same reasons as draft_ownership.test.js/chip_row.test.js:
// CSS.highlights/Highlight only exist in real Chromium, and Lite Mode can only be
// toggled for real through the popup's own chrome.storage.sync round trip.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const CLOSED = () => !document.getElementById('oc-wrap');

const FILLER = 'filler words to fill the page and push it past the no-matches notice threshold. ';

// Three fixture terms with known, distinct occurrence counts and no substring overlap —
// zenithquokka (3), brindlefalcon (2), quarklet (1) — the same set chip_row.test.js's
// oculist-l6m.33 tests use, reused here so a removal sequence can assert on specific,
// non-trivial highlight counts.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${FILLER.repeat(20)}
zenithquokka zenithquokka zenithquokka brindlefalcon brindlefalcon quarklet</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const CHIP_REMOVE = '#oc-wrap >> .oc-chip-remove';
const COUNT = '#oc-wrap >> .oc-count';

describe('Lite Mode: remove-then-restore keeps count and highlights in agreement', () => {
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

    // Attach CDP before navigating so the isolated-world execution-context-created event
    // is never missed. Only used to read the real CSS.highlights registries — never to
    // reach into content.js's closure state directly.
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
    // world existing at all — poll the execution-context-created flag the CDP listener
    // above sets, instead of guessing how long injection takes.
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

  async function addTerm(term) {
    const before = await page.locator(CHIP_TERM).count();
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
    // Enter's chip-add path (addChipTerm() -> performListSearch()) runs synchronously and
    // ends with renderChipRow() as its very last statement, so the chip row reflecting the
    // new term is a genuine proxy for "the whole scan (counts, highlight registries)
    // finished", not just "the chip node exists".
    await page.waitForFunction(
      ({ expected, term }) => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.oc-chip-term') : [];
        return chips.length === expected && chips[chips.length - 1] && chips[chips.length - 1].textContent === term;
      },
      { expected: before + 1, term },
      { timeout: POLL_TIMEOUT }
    );
  }

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

  // Clicking a chip re-runs performListSearch() synchronously and ends by re-rendering the
  // chip row with the clicked chip's own '.active' class — waiting on that class is a
  // proxy for the whole re-scan (registries included) having landed.
  async function clickChip(index) {
    await page.locator(CHIP_TERM).nth(index).click();
    await page.waitForFunction(
      (i) => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')) : [];
        return !!chips[i] && chips[i].classList.contains('active');
      },
      index,
      { timeout: POLL_TIMEOUT }
    );
  }

  // The 150ms/400ms input debounce ends in performDraftSearch(term)/restoreActiveChip()
  // (content.js) — either way it always leaves the oculist-match registry's *content* in a
  // new, checkable state, so callers wait for their own specific expected outcome
  // afterward rather than this helper guessing the debounce duration itself.
  async function typeDraft(term) {
    await page.locator(INPUT).fill(term);
  }

  function chipTerms() {
    return page.locator(CHIP_TERM).allTextContents();
  }

  function activeChipTerm() {
    return page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const el = root.querySelector('.oc-chip-term.active');
      return el ? el.textContent : null;
    });
  }

  // Reads the real oculist-match/oculist-dim-match registry, so assertions can check what
  // is actually lit, not just the count text — the two must always agree.
  function highlightCount(registryName) {
    return evalInContentScript(`
      (function () {
        var h = CSS.highlights.get('${registryName}');
        return h ? Array.from(h).length : 0;
      })()
    `);
  }

  // Arm a probe listener inside the content script's own isolated world *before* changing
  // a setting via the popup: chrome.storage.onChanged fires every listener registered
  // against that same document for the same event, so observing OUR listener fire is a
  // direct proxy for content.js's own oc-settings listener (registered first, at page
  // load) having *also* already run — including its synchronous rescan — not just
  // "chrome.storage.sync.set() resolved", which is all a wait from the popup's own
  // separate context could prove.
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

    // saveSettings() is async (awaits chrome.storage.sync.set) and toggleLiteMode's
    // 'change' listener is not awaited by Playwright's click() — wait for the write to
    // actually land before tearing the popup page down, instead of guessing how long it
    // takes.
    await popup.waitForFunction(
      (expected) =>
        chrome.storage.sync
          .get('oc-settings')
          .then((d) => !!(d['oc-settings'] && d['oc-settings'].performanceMode === expected)),
      enabled,
      { timeout: POLL_TIMEOUT }
    );
    await popup.close();
    await page.bringToFront();

    // ...then wait for that same write to echo into content.js's own onChanged listener
    // (and, downstream of it, performListSearch()'s synchronous rescan) instead of a fixed
    // settle window.
    await waitForSettingsEcho(before);
  }

  // Regression pin, driven through real UI: three chips under Lite Mode (so the two
  // inactive ones are sparse placeholders), re-activate the first chip (zenithquokka) so
  // IT holds the real Ranges and the other two are placeholders, then remove it.
  // removeChipAt() splices workListTerms/termRanges, re-points activeTermIndex, and
  // synchronously rescans via performListSearch() (oculist-l6m.33) in that same call, so
  // the new active slot (brindlefalcon) is real Ranges again before removeChipAt()
  // returns. A draft-then-clear afterward exercises restoreActiveChip() directly, off
  // that same slot, pinning that count text and the live oculist-match registry stay in
  // agreement across the whole remove-then-restore sequence.
  //
  // Kept last: it changes the persisted performanceMode setting (chrome.storage.sync, not
  // reset by beforeEach) and resets it back to off at the end so it never leaks into an
  // earlier-run test.
  test('remove-then-restore under Lite Mode keeps the count and real highlights agreeing', async () => {
    await setLiteMode(true);
    try {
      await addTerm('zenithquokka');
      await addTerm('brindlefalcon');
      await addTerm('quarklet');
      assert.deepStrictEqual(await chipTerms(), ['zenithquokka', 'brindlefalcon', 'quarklet']);
      assert.strictEqual(await activeChipTerm(), 'quarklet');

      // Re-activate zenithquokka: it becomes the real-Ranges slot, brindlefalcon and
      // quarklet become Lite Mode placeholders.
      await clickChip(0);
      assert.strictEqual(await activeChipTerm(), 'zenithquokka');
      assert.strictEqual(await highlightCount('oculist-match'), 3, 'sanity check: zenithquokka must have 3 real matches while active');

      // Remove zenithquokka (the active chip, index 0) via its own remove control — a
      // real click, not a direct removeChipAt() call.
      await page.locator(CHIP_REMOVE).first().click();
      await waitForChipCount(2);

      assert.deepStrictEqual(await chipTerms(), ['brindlefalcon', 'quarklet'], 'only the removed chip should be gone');
      assert.strictEqual(await activeChipTerm(), 'brindlefalcon', 'removing the active first chip should activate the new leftmost chip');

      // removeChipAt()'s own rescan (oculist-l6m.33) should already have brindlefalcon's
      // real 2 ranges lit — sanity check before the draft-then-clear step below.
      assert.strictEqual(await highlightCount('oculist-match'), 2, 'sanity check: brindlefalcon must show its real 2 matches immediately after removal');

      // Type a draft (parking brindlefalcon as the inactive chip, owning nothing) then
      // clear it, which calls restoreActiveChip() to hand ownership back to brindlefalcon.
      // oculist-at7: wait on the exact condition the assertion below checks (the
      // 150ms/400ms debounce firing performDraftSearch('quarklet')) instead of guessing
      // its duration — this is the flaky assertion the bead names.
      await typeDraft('quarklet');
      const matchTextsExpr = `
        (function () {
          var h = CSS.highlights.get('oculist-match');
          return h ? Array.from(h).map(function (r) { return r.toString(); }) : [];
        })()
      `;
      let matchTexts = await waitForContentScriptValue(
        evalInContentScript,
        matchTextsExpr,
        (v) => Array.isArray(v) && v.length > 0 && v.every((t) => t === 'quarklet'),
        { timeout: POLL_TIMEOUT, message: 'the "quarklet" draft debounce never populated oculist-match' }
      );
      assert.ok(matchTexts.length > 0 && matchTexts.every((t) => t === 'quarklet'), 'the draft must own oculist-match while it is non-empty');

      // Clearing the draft debounces into restoreActiveChip() instead — wait for
      // brindlefalcon's real 2 ranges to actually be lit again before reading the count.
      await typeDraft('');
      await waitForContentScriptValue(
        evalInContentScript,
        "(function(){var h=CSS.highlights.get('oculist-match'); return h?Array.from(h).length:0;})()",
        (v) => v === 2,
        { timeout: POLL_TIMEOUT, message: 'restoreActiveChip() never re-lit brindlefalcon\'s 2 real ranges after the draft cleared' }
      );

      const count = (await page.locator(COUNT).textContent()).trim();
      const litCount = await highlightCount('oculist-match');

      assert.strictEqual(await activeChipTerm(), 'brindlefalcon', 'brindlefalcon must still be the active chip after the draft is cleared');
      // Count text and the live registry must agree, and both must reflect
      // brindlefalcon's true 2 matches.
      assert.match(count, /of 2$/, `count text must reflect brindlefalcon's real 2 matches, got "${count}"`);
      assert.strictEqual(litCount, 2, 'oculist-match must hold brindlefalcon\'s real 2 ranges');
      assert.notStrictEqual(litCount, 0, 'count text and the real highlight registry must never disagree (a non-blank count with zero highlights lit)');
    } finally {
      await setLiteMode(false);
    }
  });

  // Edge case: a term that has genuinely been scanned and truly has zero matches on the
  // page must render "no match" via restoreActiveChip(), never "0 of N" — a real
  // zero-length result and an unlit state must stay consistent across a draft-then-clear.
  test('a genuinely zero-match term under Lite Mode restores to "no match"', async () => {
    await setLiteMode(true);
    try {
      await addTerm('nonexistentxyzterm');
      assert.strictEqual(await activeChipTerm(), 'nonexistentxyzterm');
      assert.strictEqual((await page.locator(COUNT).textContent()).trim().length > 0, true);

      await typeDraft('quarklet');
      await waitForContentScriptValue(
        evalInContentScript,
        "(function(){var h=CSS.highlights.get('oculist-match'); return h?Array.from(h).map(function(r){return r.toString();}):[];})()",
        (v) => Array.isArray(v) && v.length > 0 && v.every((t) => t === 'quarklet'),
        { timeout: POLL_TIMEOUT, message: 'the "quarklet" draft debounce never populated oculist-match' }
      );

      // Clearing the draft debounces into restoreActiveChip() — 'nonexistentxyzterm' has
      // genuinely zero real matches, so waiting for oculist-match to actually reach 0 here
      // is a real, non-vacuous condition (it was just populated with 1 "quarklet" range
      // above).
      await typeDraft('');
      await waitForContentScriptValue(
        evalInContentScript,
        "(function(){var h=CSS.highlights.get('oculist-match'); return h?Array.from(h).length:0;})()",
        (v) => v === 0,
        { timeout: POLL_TIMEOUT, message: 'restoreActiveChip() never cleared oculist-match back to zero for the genuinely zero-match term' }
      );

      assert.strictEqual(await activeChipTerm(), 'nonexistentxyzterm');
      const count = (await page.locator(COUNT).textContent()).trim();
      assert.strictEqual(/^0 of \d+$/.test(count), false, 'a genuine zero-match term must never render as "0 of N", got "' + count + '"');
      assert.strictEqual(await highlightCount('oculist-match'), 0, 'no real matches exist for this term');

      // Sanity: the state is still stable a moment later, not merely caught mid-settle by
      // the poll above — a genuinely different kind of check (absence of *further* change
      // over time) that a condition poll cannot express, so this one is deliberately kept.
      await page.waitForTimeout(300);
      assert.strictEqual(await highlightCount('oculist-match'), 0);
    } finally {
      await setLiteMode(false);
    }
  });
});
