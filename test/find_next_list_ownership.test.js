// findNext() vs. list ownership (oculist-l6m.19).
//
// findNext() used to re-derive its search term from input.value on every nav key press,
// which assumed a lone-search world that knows nothing about the working list. Two ways
// that broke:
//
//   CASE 1 — a second Enter/Ctrl+G on a zero-match active chip fell through to
//   performSearch(), which unconditionally deletes oculist-dim-match before running —
//   wiping every OTHER chip's dim highlights for a keystroke that never touched them.
//
//   CASE 2 — after clearing the input restores a chip (restoreActiveChip()), the count
//   and nav-enabled state already agree with the 3-highlighted-matches on screen; the old
//   findNext() saw an empty input.value and blanked both out anyway, even though nothing
//   about the active chip changed.
//
// Needs a real browser for the same reasons as list_search.test.js/dim_highlight.test.js:
// CSS.highlights/Highlight only exist in real Chromium, not jsdom, and
// buildPageIndex/findRanges/performListSearch/findNext are IIFE-internal and not
// importable — so highlight-registry contents have to be observed from outside via CDP
// against the content script's isolated execution context.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// "cat" appears 3 times, "dog" 2 times, and "zebra" appears nowhere on the page — it is
// deliberately the chip we commit with zero real matches for case 1. Kept short (well
// under checkSiteOverride()'s 500-char "text-heavy page" threshold) so a zero-match chip
// never raises the unrelated "No matches found" site-override notice, which would only
// add noise to these assertions.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>cat cat cat dog dog</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const COUNT = '#oc-wrap >> .oc-count';
const PREV_BTN = '#oc-wrap >> .oc-up-btn';
const NEXT_BTN = '#oc-wrap >> .oc-down-btn';

describe('findNext() respects list ownership instead of re-deriving the term from input', () => {
  let server, ctx, page, client, isolatedContextId;

  // Polls the real signal a fixed sleep was standing in for, instead of guessing how long
  // content-script startup takes. Two things have to be true before Ctrl+F can do anything:
  // the isolated world has to exist (the CDP event for it, so CDP can evaluate into it),
  // AND boot() has to have actually run inside it — which only happens after content.js's
  // own async chrome.storage.sync.get('oc-settings', ...) round trip resolves and attaches
  // the keydown listener. window.__ocToggle is set at the very end of boot(), so its
  // presence is the real, final readiness signal; polling isolatedContextId alone raced
  // ahead of that storage round trip under load and pressed Ctrl+F on a page with no
  // listener yet.
  async function waitForContentScriptReady() {
    const deadline = Date.now() + POLL_TIMEOUT;
    for (;;) {
      if (isolatedContextId) {
        try {
          const ready = await evalInContentScript("typeof window.__ocToggle === 'function'");
          if (ready) return;
        } catch (e) {
          // Context can still be settling right after creation — keep polling.
        }
      }
      if (Date.now() > deadline) {
        throw new Error('content script never finished booting (window.__ocToggle never appeared)');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // __ocDestroy() removes #oc-wrap synchronously once its keydown handler runs, but the
  // handler itself only runs after the browser's own event dispatch — poll for the real
  // removal instead of sleeping a guessed dispatch delay.
  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

  // loadWorkList() on mount is an async chrome.storage.session.get() round trip whose
  // callback overwrites workListTerms/activeTermIndex and re-renders the chip row —
  // exactly the state a test is about to mutate with addTerm(). Chrome serializes
  // storage.session calls from the same execution context in issue order, so calling the
  // exact same exposed hook ourselves and awaiting its callback is a direct, non-sleeping
  // proxy for "the mount's own in-flight load has already landed": by the time this
  // resolves, the earlier call it was queued behind must have already resolved too.
  async function waitForWorkListLoad() {
    await evalInContentScript("new Promise(function (resolve) { window.__ocTest.loadWorkList(resolve); })");
  }

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
    await waitForContentScriptReady();
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
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
    await waitForOverlayClosed();
    await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    await waitForWorkListLoad();
  });

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

  function countText() {
    return page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      return root.querySelector('.oc-count').textContent;
    });
  }

  function navDisabled() {
    return page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      return {
        prev: root.querySelector('.oc-up-btn').disabled,
        next: root.querySelector('.oc-down-btn').disabled,
      };
    });
  }

  // Polls the real, already-rendered DOM (shared between the page's main world and the
  // isolated content-script world — no CDP needed for this part) instead of sleeping a
  // guessed debounce duration.
  async function waitForActiveChip(term) {
    await page.waitForFunction((t) => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const el = root.querySelector('.oc-chip-term.active');
      return el && el.textContent === t;
    }, term, { timeout: POLL_TIMEOUT });
  }

  async function waitForCountText(expected) {
    await page.waitForFunction((t) => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const el = root.querySelector('.oc-count');
      return el && el.textContent === t;
    }, expected, { timeout: POLL_TIMEOUT });
  }

  async function addTerm(term) {
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
    await waitForActiveChip(term);
  }

  test('CASE 1: a second Enter on a zero-match active chip never deletes oculist-dim-match', async () => {
    await addTerm('cat');
    await addTerm('dog');
    await addTerm('zebra'); // 0 matches on the page — becomes the active chip anyway

    assert.deepStrictEqual(await chipTerms(), ['cat', 'dog', 'zebra']);
    assert.strictEqual(await activeChipTerm(), 'zebra');

    const dimBefore = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimBefore.length, 5, '"cat" (3) + "dog" (2) must both be dim while "zebra" is active');
    assert.strictEqual(dimBefore.filter((t) => t === 'cat').length, 3);
    assert.strictEqual(dimBefore.filter((t) => t === 'dog').length, 2);

    // The input still holds 'zebra' (Enter never clears it) and 'zebra' is already the
    // active chip, so this Enter commits nothing — it is exactly the "second Enter" that
    // used to fall through to findNext() -> performSearch().
    // findNext() is entirely synchronous when searchRanges is empty (it sets countEl
    // and returns early, with no deferred draw) — no wait is needed between the keypress
    // and reading the result back.
    await page.keyboard.press('Enter');

    assert.strictEqual(
      await registryPresent('oculist-dim-match'),
      true,
      'oculist-dim-match must still exist after navigating with a list active'
    );
    const dimAfterEnter = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimAfterEnter.length, 5, 'dim ranges must survive a second Enter on the zero-match chip untouched');

    // Ctrl+G drives the exact same findNext() path as Enter's fall-through. Confirm it
    // too leaves the dim registry alone.
    await page.keyboard.press('Control+g');

    assert.strictEqual(await registryPresent('oculist-dim-match'), true);
    const dimAfterCtrlG = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimAfterCtrlG.length, 5, 'dim ranges must survive Ctrl+G on the zero-match chip untouched');
    assert.strictEqual(dimAfterCtrlG.filter((t) => t === 'cat').length, 3);
    assert.strictEqual(dimAfterCtrlG.filter((t) => t === 'dog').length, 2);

    // The zero-match chip's own count/nav state must stay correctly "no match", not get
    // reset to something else by the navigation attempts above.
    assert.strictEqual(await countText(), 'no match');
    assert.deepStrictEqual(await navDisabled(), { prev: true, next: true });
  });

  test('CASE 2: after a restore, the count and nav enabled-state agree with what is highlighted', async () => {
    await addTerm('cat');
    await addTerm('dog');
    assert.strictEqual(await activeChipTerm(), 'dog');

    // Clear the input — this hands ownership back to 'dog' via restoreActiveChip(), with
    // no beacon and no Enter involved.
    await page.locator(INPUT).fill('');
    await waitForCountText('0 of 2');

    // Before any navigation: the restore itself must already leave count and nav in
    // agreement with the 2 "dog" matches actually on screen.
    assert.deepStrictEqual(await navDisabled(), { prev: false, next: false }, 'nav must be enabled: 2 real matches are on screen after the restore');
    const matchAfterRestore = await rangeTexts('oculist-match');
    assert.strictEqual(matchAfterRestore.length, 2, 'restoreActiveChip() must have put "dog"\'s 2 ranges in oculist-match');

    // Next: this used to hit findNext()'s empty-term early return, which blanked the
    // count and disabled nav while the 2 highlights stayed lit on the page.
    await page.locator(NEXT_BTN).click();
    await waitForCountText('1 of 2');

    assert.deepStrictEqual(await navDisabled(), { prev: false, next: false }, 'nav must stay enabled after navigating a restored chip');
    const activeAfterNext = await rangeTexts('oculist-active-match');
    assert.strictEqual(activeAfterNext.length, 1, 'next must have set a single active-match range');
    assert.strictEqual(activeAfterNext[0], 'dog');

    // Prev from here must land back on the other of the 2 matches, still without ever
    // dropping the count/nav out of sync with what is highlighted.
    await page.locator(PREV_BTN).click();
    await waitForCountText('2 of 2');
    assert.deepStrictEqual(await navDisabled(), { prev: false, next: false });

    // Enter (the third input the bug report named) drives the same findNext() fall-
    // through as the buttons whenever the input still echoes the active chip's term —
    // here the input is empty, which is exactly the restored-chip state under test.
    await page.keyboard.press('Enter');
    await waitForCountText('1 of 2');
    assert.deepStrictEqual(await navDisabled(), { prev: false, next: false });

    // The working list itself must be completely unaffected by all this navigation.
    assert.deepStrictEqual(await chipTerms(), ['cat', 'dog']);
    assert.strictEqual(await activeChipTerm(), 'dog');
  });

  test('CASE 3 (regression): a restored, unscanned active chip does not report "no match" on Enter', async () => {
    // Simulate the mount-restore path (loadWorkList()'s callback) directly, the same one
    // chip_row.test.js's "restoring a saved working list on mount" test exercises — but
    // with a term that has real matches on this file's page ('dog' has 2), so a false
    // "no match" claim is actually observable. That older test seeds terms absent from its
    // page and never presses Enter, which is exactly why this regression slipped through.
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.set(" +
        "{ 'oc-worklist': { terms: ['cat', 'dog'], activeIndex: 1 } }, resolve))"
    );
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    await waitForActiveChip('dog');

    // Mount restore never scans (see loadWorkList()/buildUI()) — count starts blank and
    // nav disabled even though 'dog' has 2 real matches on the page.
    assert.strictEqual(await countText(), '');
    assert.deepStrictEqual(await navDisabled(), { prev: true, next: true });
    assert.strictEqual(await registryPresent('oculist-match'), false, 'no scan has run yet');

    // The input is empty, so Enter commits nothing (maybeAddChipFromInput() has no draft
    // to add) and falls through to findNext() — the exact path the regression hit.
    await page.keyboard.press('Enter');

    // Must stay blank, not become "no match": that would be a false claim about a page
    // that has 2 real "dog" matches on it. Restoring never scans on its own (the carry-
    // over contract), so the count only fills in once the user actually asks for a scan
    // (e.g. clicking the chip), not merely by pressing Enter/Ctrl+G against the restore.
    assert.strictEqual(
      await countText(),
      '',
      'count must stay blank, not fall back to "no match", for an unscanned restored chip'
    );
    assert.deepStrictEqual(await navDisabled(), { prev: true, next: true });
    assert.strictEqual(await registryPresent('oculist-match'), false, 'Enter must not trigger a scan either');

    // Ctrl+G drives the identical findNext() fall-through; confirm it too leaves the count
    // blank instead of claiming "no match".
    await page.keyboard.press('Control+g');
    assert.strictEqual(await countText(), '');
    assert.deepStrictEqual(await navDisabled(), { prev: true, next: true });

    // The working list itself must be unaffected by any of this.
    assert.deepStrictEqual(await chipTerms(), ['cat', 'dog']);
    assert.strictEqual(await activeChipTerm(), 'dog');
  });

  test('CASE 4 (regression): Ctrl+G racing the debounce after typing a draft term never loses oculist-dim-match', async () => {
    await addTerm('cat');
    await addTerm('dog');

    // 'dog' is the active chip, so only the OTHER committed term ('cat') is dim — the
    // active chip's own matches live in oculist-match/oculist-active-match instead.
    const dimBefore = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimBefore.length, 3, 'only "cat" (3) should be dim while "dog" is active');

    // Race Ctrl+G against the input's own 150ms debounce timer on purpose: fill() dispatches
    // the 'input' event (scheduling the debounce), and Ctrl+G fires before it — with no wait
    // in between — landing squarely inside the window the debounce timer is still pending.
    // findNext() clears that pending timer, so if findNext() itself does not rebuild
    // oculist-dim-match, nothing else ever will: the callback that would have is gone.
    await page.locator(INPUT).fill('ca');
    await page.keyboard.press('Control+g');

    // 'ca' is a substring of every 'cat' on the page, so the draft it becomes has 3
    // matches; landing on the first via findNext()'s own firstEnter handling gives '1 of 3'.
    await waitForCountText('1 of 3');

    assert.strictEqual(
      await registryPresent('oculist-dim-match'),
      true,
      'oculist-dim-match must still exist after a findNext() call raced ahead of the debounce'
    );
    // A draft in progress owns the active highlight, so no chip is "active" for dimming
    // purposes and every committed term — 'dog' included, even though it was active a
    // moment ago — must now be dim alongside 'cat'.
    const dimAfter = await rangeTexts('oculist-dim-match');
    assert.strictEqual(
      dimAfter.length,
      5,
      'the debounce race must not have dropped the dim ranges for "cat" and "dog"'
    );
    assert.strictEqual(dimAfter.filter((t) => t === 'cat').length, 3);
    assert.strictEqual(dimAfter.filter((t) => t === 'dog').length, 2);

    // The draft itself must have become the active search — this is not blocked by list
    // ownership, only the dim registry underneath it is protected.
    const matchAfter = await rangeTexts('oculist-match');
    assert.strictEqual(matchAfter.length, 3);
    assert.deepStrictEqual(await navDisabled(), { prev: false, next: false });
  });
});
