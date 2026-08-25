// Chip row UI and working-list state (oculist-l6m.3): each search term the user commits
// with Enter becomes a chip beneath the bar. Multi-term searching and hit counts are out
// of scope here — the count slot stays blank until performListSearch (l6m.4) fills it in.
//
// Needs a real browser for the same reason as color_picker_persistence.test.js and
// worklist_storage.test.js: the chip row needs real layout (JSDOM has none) and the
// restore-on-mount test needs a real chrome.storage.session round trip, which content
// scripts can only reach once background.js's setAccessLevel call has actually run.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');

const FILLER = 'filler words to fill the page and push it past the no-matches notice threshold. ';

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${FILLER.repeat(20)} <span id="target">quarklet</span></p>`;

// A >100-char term that is a literal substring of PAGE's own filler text (the repeated
// FILLER phrase), so it both trips the 100-char cap and matches the page — needed to
// exercise the cap-notice-erasure path (findNext()'s performSearch() -> checkSiteOverride()
// unconditionally clears the notice when the just-typed term matches).
const LONG_MATCHING_TERM = FILLER.repeat(2).slice(0, 108);

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const CHIP_REMOVE = '#oc-wrap >> .oc-chip-remove';
const NOTICE_TEXT = '#oc-wrap >> .oc-notice-text';
const PREV_BTN = '#oc-wrap >> .oc-up-btn';
const NEXT_BTN = '#oc-wrap >> .oc-down-btn';
const COUNT = '#oc-wrap >> .oc-count';

describe('Chip row and working-list state', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

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
    // event for the content script's isolated world is never missed. Only used here to
    // clear chrome.storage.session between tests and to seed it for the restore test —
    // never to reach into content.js's closure state directly.
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

  // Every test starts from a closed overlay and an empty working list, so chips never
  // leak from one test into the next.
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

  function activeChipTerm() {
    return page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const el = root.querySelector('.oc-chip-term.active');
      return el ? el.textContent : null;
    });
  }

  test('Enter with a new term adds a chip, activates it, and next-match still works', async () => {
    await addTerm('quarklet');

    assert.deepStrictEqual(await chipTerms(), ['quarklet']);
    assert.strictEqual(await activeChipTerm(), 'quarklet');

    // Input is never cleared.
    assert.strictEqual(await page.locator(INPUT).inputValue(), 'quarklet');

    // Muscle memory intact: the first Enter still lands on match 1 of N via firstEnter.
    const count = await page.locator(COUNT).textContent();
    assert.match(count, /^1 of \d+$/, `expected "1 of N" after the first Enter, got "${count}"`);
  });

  test('adding a term already in the list activates that chip instead of duplicating it', async () => {
    await addTerm('alpha');
    await addTerm('beta');
    assert.deepStrictEqual(await chipTerms(), ['alpha', 'beta']);
    assert.strictEqual(await activeChipTerm(), 'beta');

    await addTerm('alpha');

    assert.deepStrictEqual(await chipTerms(), ['alpha', 'beta'], 're-adding "alpha" must not create a second chip');
    assert.strictEqual(await activeChipTerm(), 'alpha', 're-adding "alpha" should activate the existing chip');
  });

  test('Backspace in an empty input removes the last chip and activates the previous one', async () => {
    await addTerm('one');
    await addTerm('two');
    assert.deepStrictEqual(await chipTerms(), ['one', 'two']);

    await page.locator(INPUT).fill('');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);

    assert.deepStrictEqual(await chipTerms(), ['one']);
    assert.strictEqual(await activeChipTerm(), 'one', 'removing the active last chip should activate the previous one');
  });

  test('removing the active first chip of several activates the new leftmost chip', async () => {
    await addTerm('one');
    await addTerm('two');
    await addTerm('three');
    assert.deepStrictEqual(await chipTerms(), ['one', 'two', 'three']);

    // Activate the first chip explicitly, then remove it via its own remove control.
    await page.locator(CHIP_TERM).first().click();
    assert.strictEqual(await activeChipTerm(), 'one');
    await page.locator(CHIP_REMOVE).first().click();
    await page.waitForTimeout(150);

    assert.deepStrictEqual(await chipTerms(), ['two', 'three']);
    const active = await activeChipTerm();
    assert.notStrictEqual(active, null, 'a chip must still be active after removing the first of several');
    assert.strictEqual(active, 'two', 'removing the active first chip should activate the new leftmost chip');

    const stored = await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.get('oc-worklist', (r) => resolve(r['oc-worklist'])))"
    );
    assert.notStrictEqual(stored.activeIndex, -1, 'the persisted activeIndex must not be -1 while chips remain');
    assert.strictEqual(stored.activeIndex, 0);
  });

  // Single Enter at the cap: the same keystroke that trips a cap also runs findNext() ->
  // performSearch() -> checkSiteOverride(), which unconditionally clears whatever notice is
  // up when the just-typed term matches the page. Both cap terms here are deliberately
  // chosen to match PAGE's own text so this path is actually exercised — a non-matching
  // term would never hit checkSiteOverride's notice-clearing branch and would silently pass
  // even with the erasure bug present.

  test('the 10-term cap fires its notice and refuses the 11th term on a single Enter', async () => {
    for (let i = 1; i <= 10; i++) {
      await addTerm('capterm' + i);
    }
    assert.strictEqual((await chipTerms()).length, 10);

    // 'quarklet' exists on the page (see PAGE above), so this single Enter also runs a
    // matching search via findNext() -> performSearch() -> checkSiteOverride().
    await addTerm('quarklet');

    assert.strictEqual((await chipTerms()).length, 10, 'the 11th term must not be added');
    const notice = await page.locator(NOTICE_TEXT).textContent();
    assert.strictEqual(
      notice,
      'Oculist searches up to 10 terms at once. Remove a term to add another.'
    );
  });

  test('a term over 100 characters fires its notice and is not added, on a single Enter', async () => {
    // LONG_MATCHING_TERM is a literal substring of PAGE's filler text, so this single
    // Enter also runs a matching search via findNext() -> performSearch() -> checkSiteOverride().
    await addTerm(LONG_MATCHING_TERM);

    assert.deepStrictEqual(await chipTerms(), [], 'an over-length term must not be added as a chip');
    const notice = await page.locator(NOTICE_TEXT).textContent();
    assert.strictEqual(
      notice,
      'Search terms are limited to 100 characters. Shorten the term and try again.'
    );
  });

  test('restoring a saved working list on mount renders chips without running a scan', async () => {
    // beforeEach leaves the overlay open (it needs it open to clear session storage
    // through the content script's isolated world) — close it first, otherwise the
    // upcoming Ctrl+F below just refocuses the existing bar instead of remounting it,
    // and loadWorkList() only ever runs from buildUI() on mount.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // Seed chrome.storage.session directly (bypassing any in-page UI) with terms that do
    // not exist anywhere on the page — if a scan ran against them, both the count and a
    // "no matches" notice would give it away.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.set(" +
        "{ 'oc-worklist': { terms: ['gamma', 'delta'], activeIndex: 1 } }, resolve))"
    );

    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.waitForTimeout(400); // let the async loadWorkList round trip land

    assert.deepStrictEqual(await chipTerms(), ['gamma', 'delta']);
    assert.strictEqual(await activeChipTerm(), 'delta');

    // No scan: the input was never populated, the count slot is still blank (performSearch
    // would have set it to "no match"), the nav buttons are still disabled, and no
    // "no matches" notice was raised for a term that doesn't exist on the page.
    assert.strictEqual(await page.locator(INPUT).inputValue(), '');
    assert.strictEqual(await page.locator(COUNT).textContent(), '');
    assert.strictEqual(await page.locator(PREV_BTN).isDisabled(), true);
    assert.strictEqual(await page.locator(NEXT_BTN).isDisabled(), true);
    assert.strictEqual(await page.locator('#oc-wrap >> .oc-notice').count(), 0);
  });

  test('a zero-chip overlay renders no chip row at all', async () => {
    const chipRowState = await page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const row = root.querySelector('.oc-chip-row');
      if (!row) return { present: false };
      const style = getComputedStyle(row);
      return { present: true, hidden: row.hidden, display: style.display };
    });

    assert.strictEqual(chipRowState.present, true, 'the chip row element should exist in the DOM');
    assert.strictEqual(chipRowState.hidden, true, 'an empty working list must leave the chip row hidden');
    assert.strictEqual(chipRowState.display, 'none', 'a hidden chip row must not affect layout');
  });
});
