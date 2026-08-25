// performListSearch() and per-term chip counts (oculist-l6m.4): every term in the
// working list gets its own scan, searchRanges keeps describing only the ACTIVE term
// (so findNext/highlightActiveRange/beacons/viewport markers/countEl need no changes),
// and buildPageIndex() — the expensive DOM traversal — runs exactly once per scan
// regardless of how many terms are in the list.
//
// Needs a real browser for the same reasons as chip_row.test.js: real layout (JSDOM has
// none), real Ranges, and a real chrome.storage.session round trip. buildPageIndex/
// findRanges/performListSearch are IIFE-internal and not importable, so counts and the
// "exactly once" assertion have to be observed from outside via CDP against the content
// script's isolated execution context, the same pattern worklist_storage.test.js uses.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');

// Known, hand-verified occurrence counts (substring match, same algorithm findRanges
// uses): "cat" appears 7 times total (4 standalone + 3 as the prefix of "cats"), "cats"
// appears 3 times, "dog" once. This is the load-bearing fixture for the overlapping-term
// assertion: "cat" and "cats" must each get their own correct, independent range count
// even though every "cats" is also a "cat" match.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>cat cats cat dog cats bird cat cats cat</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const CHIP_REMOVE = '#oc-wrap >> .oc-chip-remove';
const CHIP_COUNT = '#oc-wrap >> .oc-chip-count';
const COUNT = '#oc-wrap >> .oc-count';

describe('performListSearch() and per-term chip counts', () => {
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

  function chipTerms() {
    return page.locator(CHIP_TERM).allTextContents();
  }

  function chipCounts() {
    return page.locator(CHIP_COUNT).allTextContents();
  }

  test('each chip shows its own hit count, overlapping terms included, zero-match terms show 0', async () => {
    await addTerm('cat');
    await addTerm('cats');
    await addTerm('dog');
    await addTerm('elephant'); // not present on the page anywhere

    assert.deepStrictEqual(await chipTerms(), ['cat', 'cats', 'dog', 'elephant']);

    // Counts stay blank until a scan actually runs — addChipTerm() only pushes/persists,
    // it never calls performListSearch() itself.
    assert.deepStrictEqual(await chipCounts(), ['', '', '', '']);

    // A single chip click scans the whole list in one performListSearch() call and
    // populates every chip's count, not just the one that was clicked.
    await page.locator(CHIP_TERM).nth(0).click();
    await page.waitForTimeout(250);

    assert.deepStrictEqual(
      await chipCounts(),
      ['7', '3', '1', '0'],
      '"cat" and "cats" must each get their own correct range count despite every "cats" also matching "cat"'
    );

    // searchRanges = termRanges[activeTermIndex] is the load-bearing line downstream —
    // countEl (fed by searchRanges.length, unchanged code) must show the clicked term's
    // own count, not some other term's.
    assert.strictEqual((await page.locator(COUNT).textContent()).trim(), '0 of 7');

    // Clicking a different chip re-scans the whole list again and keeps every count
    // correct, not just the newly active one.
    await page.locator(CHIP_TERM).nth(2).click(); // 'dog'
    await page.waitForTimeout(250);
    assert.deepStrictEqual(await chipCounts(), ['7', '3', '1', '0']);
    assert.strictEqual((await page.locator(COUNT).textContent()).trim(), '0 of 1');
  });

  test('removing the only chip in the working list yields activeIndex -1', async () => {
    await addTerm('solo');
    assert.deepStrictEqual(await chipTerms(), ['solo']);

    await page.locator(CHIP_REMOVE).first().click();
    await page.waitForTimeout(150);

    assert.deepStrictEqual(await chipTerms(), [], 'the chip must actually be gone');

    const stored = await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.get('oc-worklist', (r) => resolve(r['oc-worklist'])))"
    );
    assert.strictEqual(stored.terms.length, 0);
    assert.strictEqual(stored.activeIndex, -1, 'removing the only chip must leave activeIndex at -1');

    const chipRowState = await page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const row = root.querySelector('.oc-chip-row');
      return row ? { hidden: row.hidden, display: getComputedStyle(row).display } : null;
    });
    assert.strictEqual(chipRowState.hidden, true, 'an emptied working list must hide the chip row again');
    assert.strictEqual(chipRowState.display, 'none');
  });

  test('buildPageIndex() runs exactly once per performListSearch() call', async () => {
    await addTerm('cat');
    await addTerm('cats');
    await addTerm('dog');

    // Monkeypatch window.getComputedStyle *inside the content script's own isolated
    // world* — content.js reads window.getComputedStyle dynamically on every
    // buildPageIndex() call, so this is visible to it despite isolated worlds not
    // sharing JS state, because both worlds' `window` proxy the same underlying page
    // and this assignment happens directly in the isolated world's own global object.
    await evalInContentScript(`
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

    // Baseline: exactly one known-good buildPageIndex() call, via the untouched
    // draft-typing path (performSearch()), against the *same* DOM as the chip-click
    // measurement below (typing into the input never touches the chip row, so the page
    // and the 3-chip row are byte-for-byte identical for both measurements).
    const before1 = await evalInContentScript('window.__ocGCSCalls');
    await page.locator(INPUT).fill('no-such-term-zyxwvut');
    await page.waitForTimeout(400); // clears the 150ms/400ms debounce
    const after1 = await evalInContentScript('window.__ocGCSCalls');
    const baselineCalls = after1 - before1;
    assert.ok(baselineCalls > 0, 'the baseline single-buildPageIndex call made no getComputedStyle calls at all — instrumentation is broken');

    // Test: one performListSearch() call, triggered by a single chip click, against a
    // 3-term working list and the identical page/chip-row DOM used above.
    const before3 = await evalInContentScript('window.__ocGCSCalls');
    await page.locator(CHIP_TERM).nth(0).click();
    await page.waitForTimeout(250);
    const after3 = await evalInContentScript('window.__ocGCSCalls');
    const listCalls = after3 - before3;

    // If performListSearch() called buildPageIndex() once per term (a bug) instead of
    // once total, listCalls would be ~3x baselineCalls instead of equal to it.
    assert.strictEqual(
      listCalls,
      baselineCalls,
      `expected performListSearch() to call buildPageIndex() exactly once (${baselineCalls} getComputedStyle calls, ` +
        `matching the known-single-call baseline), got ${listCalls} for a 3-term list`
    );
  });
});
