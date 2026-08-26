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

const EXTENSION = path.resolve(__dirname, '../extension');

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

    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
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
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

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
    await page.waitForTimeout(100);
    await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.waitForTimeout(150);
  });

  async function addTerm(term) {
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  }

  async function typeDraft(term) {
    await page.locator(INPUT).fill(term);
    await page.waitForTimeout(400); // clears the 150ms/400ms debounce
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

  // Flips Lite Mode via the real popup UI (chrome.storage.sync round trip), so
  // content.js's chrome.storage.onChanged listener is exercised exactly as production
  // toggling is.
  async function setLiteMode(enabled) {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#toggle-lite-mode', { state: 'attached' });
    const checked = await popup.isChecked('#toggle-lite-mode');
    // The checkbox itself is visually hidden by the slider CSS toggle pattern — click its
    // <label> (the actionable, visible element) instead of the input.
    if (checked !== enabled) await popup.click('label[for="toggle-lite-mode"]');
    await popup.waitForTimeout(300);
    await popup.close();
    await page.bringToFront();
    await page.waitForTimeout(300);
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
      await page.locator(CHIP_TERM).first().click();
      await page.waitForTimeout(250);
      assert.strictEqual(await activeChipTerm(), 'zenithquokka');
      assert.strictEqual(await highlightCount('oculist-match'), 3, 'sanity check: zenithquokka must have 3 real matches while active');

      // Remove zenithquokka (the active chip, index 0) via its own remove control — a
      // real click, not a direct removeChipAt() call.
      await page.locator(CHIP_REMOVE).first().click();
      await page.waitForTimeout(150);

      assert.deepStrictEqual(await chipTerms(), ['brindlefalcon', 'quarklet'], 'only the removed chip should be gone');
      assert.strictEqual(await activeChipTerm(), 'brindlefalcon', 'removing the active first chip should activate the new leftmost chip');

      // removeChipAt()'s own rescan (oculist-l6m.33) should already have brindlefalcon's
      // real 2 ranges lit — sanity check before the draft-then-clear step below.
      assert.strictEqual(await highlightCount('oculist-match'), 2, 'sanity check: brindlefalcon must show its real 2 matches immediately after removal');

      // Type a draft (parking brindlefalcon as the inactive chip, owning nothing) then
      // clear it, which calls restoreActiveChip() to hand ownership back to brindlefalcon.
      await typeDraft('quarklet');
      let matchTexts = await evalInContentScript(`
        (function () {
          var h = CSS.highlights.get('oculist-match');
          return h ? Array.from(h).map(function (r) { return r.toString(); }) : [];
        })()
      `);
      assert.ok(matchTexts.length > 0 && matchTexts.every((t) => t === 'quarklet'), 'the draft must own oculist-match while it is non-empty');

      await typeDraft('');

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
      await typeDraft('');

      assert.strictEqual(await activeChipTerm(), 'nonexistentxyzterm');
      const count = (await page.locator(COUNT).textContent()).trim();
      assert.strictEqual(/^0 of \d+$/.test(count), false, 'a genuine zero-match term must never render as "0 of N", got "' + count + '"');
      assert.strictEqual(await highlightCount('oculist-match'), 0, 'no real matches exist for this term');

      // Sanity: the state is stable a moment later, not still settling.
      await page.waitForTimeout(300);
      assert.strictEqual(await highlightCount('oculist-match'), 0);
    } finally {
      await setLiteMode(false);
    }
  });
});
