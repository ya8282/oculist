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

const EXTENSION = path.resolve(__dirname, '../extension');

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
  let server, ctx, page, client, isolatedContextId;

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
    await page.waitForTimeout(250);

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
    await page.waitForTimeout(100);

    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.set(" +
        "{ 'oc-worklist': { terms: ['cat', 'dog'], activeIndex: -1 } }, resolve))"
    );

    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.waitForTimeout(150);

    // loadWorkList() on mount only populates workListTerms/activeTermIndex; a real DOM
    // mutation is what triggers the rescanAfterMutation() -> performListSearch() call
    // that actually builds termRanges/the dim registry for the restored list.
    await page.evaluate(() => {
      const marker = document.createElement('span');
      marker.textContent = 'trigger-rescan';
      document.body.appendChild(marker);
    });
    await page.waitForTimeout(600); // 350ms mutation-observer debounce + margin

    assert.strictEqual(await page.locator(NOTICE).count(), 0, 'no chip being active must not be reported as "no matches found"');
    assert.strictEqual((await page.locator(COUNT).textContent()).trim(), '', 'the count slot must stay blank, not "no match"');

    const dimTexts = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimTexts.length, 5, 'both terms\' real matches (3 "cat" + 2 "dog") must still be dim');
  });
});
