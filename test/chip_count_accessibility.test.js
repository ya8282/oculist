// Chip hit counts are accessible to assistive tech (oculist-l6m.16).
//
// .oc-chip-count is aria-hidden — screen readers never read it. Bead .4 made the number it
// shows meaningful (it is how a user knows which terms actually hit on this page), so the
// same information has to be reachable through the chip term button's accessible name
// instead. This asserts on that COMPUTED accessible name (read via the CDP Accessibility
// domain, not getAttribute('aria-label') — see test/helpers/accessible_name.js for why the
// two can diverge), not merely that some string exists, across every state the count
// actually has:
//
//   - several matches      -> "..., N matches"
//   - exactly one match    -> "..., 1 match" (singular, not "1 matches")
//   - a scanned zero-match term -> "..., 0 matches" (a real scan ran and found nothing)
//   - an unscanned chip (termRanges[i] === undefined, e.g. right after a carry-over
//     restore, before any scan has run) -> no count suffix at all, so the accessible name
//     never claims "0 matches" for a term nobody has looked at yet.
//
// Needs a real browser for the same reasons as chip_row.test.js/find_next_list_ownership.
// test.js: CSS.highlights/real layout only exist in real Chromium, and
// renderChipRow/performListSearch are IIFE-internal, not importable.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { enableAccessibilityDomain, computedAccessibleName, waitForComputedAccessibleName } = require('./helpers/accessible_name');

const EXTENSION = path.resolve(__dirname, '../extension');

// "cat" appears 3 times, "dog" exactly once, "quokka" appears nowhere on the page (not
// even as a substring — matching here is plain substring search, no word boundaries).
// Kept short (well under checkSiteOverride()'s 500-char "text-heavy page" threshold) so a
// zero-match chip never raises the unrelated "No matches found" site-override notice.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>cat cat cat dog</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';

describe('Chip term accessible name includes the hit count', () => {
  let server, ctx, page, client, isolatedContextId;

  // Same readiness signal as find_next_list_ownership.test.js: window.__ocToggle only
  // exists once boot()'s async settings round trip has resolved and the keydown listener
  // is attached, so polling for it (instead of a fixed sleep) is the real, final signal
  // that Ctrl+F will actually do something.
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

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

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

    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await enableAccessibilityDomain(client);
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

  // Every test starts from a closed overlay and an empty working list, so chips never
  // leak from one test into the next.
  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await waitForOverlayClosed();
    await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    await waitForWorkListLoad();
  });

  // expression run via Runtime.evaluate in the page's default (main) world — the shadow
  // DOM node itself lives in the one real page document even though content.js's own JS
  // runs in the isolated content-script world (see test/helpers/accessible_name.js).
  function chipExprByIndex(i) {
    return `document.getElementById('oc-wrap').shadowRoot.querySelectorAll('.oc-chip-term')[${i}]`;
  }

  function chipExprByTerm(term) {
    return (
      "(function(){ var root = document.getElementById('oc-wrap').shadowRoot; " +
      'return Array.from(root.querySelectorAll(".oc-chip-term")).find(function(e){ ' +
      `return e.textContent === ${JSON.stringify(term)}; }); })()`
    );
  }

  async function chipAccessibleNames() {
    const count = await page.evaluate(
      () => document.getElementById('oc-wrap').shadowRoot.querySelectorAll('.oc-chip-term').length
    );
    const names = [];
    for (let i = 0; i < count; i++) {
      names.push(await computedAccessibleName(client, chipExprByIndex(i)));
    }
    return names;
  }

  // Polls the real, already-rendered computed accessible name instead of sleeping a
  // guessed scan/render duration — renderChipRow() is the single render path that fills
  // the aria-label (and therefore the computed name) in.
  async function waitForChipAccessibleName(term, expected) {
    await waitForComputedAccessibleName(client, chipExprByTerm(term), expected);
  }

  async function addTerm(term) {
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
  }

  test('a term with several matches gets a plural "N matches" accessible name', async () => {
    await addTerm('cat');
    await waitForChipAccessibleName('cat', 'Active search term: cat, 3 matches');

    const names = await chipAccessibleNames();
    assert.deepStrictEqual(names, ['Active search term: cat, 3 matches']);
  });

  test('a term with exactly one match gets a singular "1 match" accessible name', async () => {
    await addTerm('dog');
    await waitForChipAccessibleName('dog', 'Active search term: dog, 1 match');
  });

  test('a scanned zero-match term gets "0 matches", never a blank or false count', async () => {
    await addTerm('quokka');
    await waitForChipAccessibleName('quokka', 'Active search term: quokka, 0 matches');
  });

  test('an unscanned chip after a carry-over restore has no count in its accessible name', async () => {
    // Close the overlay first — beforeEach's own Ctrl+F/Escape cycle only clears session
    // storage; loadWorkList() only ever runs from buildUI() on a fresh mount below.
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();

    // Seed chrome.storage.session directly (bypassing any in-page UI) with a term that
    // does not exist anywhere on the page — if a scan ran against it, the accessible name
    // would give it away with a count.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.set(" +
        "{ 'oc-worklist': { terms: ['unscanned-term'], activeIndex: 0 } }, resolve))"
    );

    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    await waitForChipAccessibleName('unscanned-term', 'Active search term: unscanned-term');

    const names = await chipAccessibleNames();
    assert.deepStrictEqual(
      names,
      ['Active search term: unscanned-term'],
      'a carry-over-restored chip must not claim "0 matches" before any scan has run'
    );
  });
});

// A Lite Mode chip's accessible name (oculist-l6m.36 gap 2b): an INACTIVE chip under Lite
// Mode gets its count from countMatchesOnly()'s cheap indexOf scan rather than the exact,
// visibility-filtered findRanges() scan every chip otherwise gets. Own describe (own
// server/context/fixture) so toggling the real performanceMode setting here never leaks
// into the sibling describe above.
//
// The fixture deliberately gives Lite Mode's flat-text indexOf scan and an exact
// visibility-filtered scan DIFFERENT counts for the same term (5 vs 3, via a
// display:none duplicate — same trick list_search.test.js's cat/cats fixture uses) so
// this test actually proves the accessible name is sourced from countMatchesOnly(), not
// merely that some plausible-looking count happens to appear.
// The hidden text's immediate parent must be a non-hidden <span> (not the display:none
// <div> itself) — buildPageIndex() only checks each text node's IMMEDIATE parent's own
// computed display, and a child's own computed display is unaffected by an ancestor's
// display:none (that only ever removes it from LAYOUT, which is what findRanges() checks
// via getClientRects() instead). Same trick list_search.test.js's cat/cats fixture uses.
const LITE_PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>zqcat zqcat zqcat zqdog</p>
<div style="display:none"><span>zqcat zqcat</span></div>`;

describe('A Lite Mode chip announces the real countMatchesOnly() count, not a blank', () => {
  let server, ctx, page, client, isolatedContextId, extId;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LITE_PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/`;

    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });

    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
    extId = sw.url().split('/')[2];

    page = await ctx.newPage();

    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await enableAccessibilityDomain(client);
    client.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId = c.id;
      }
    });

    await page.goto(origin);
    const deadline = Date.now() + POLL_TIMEOUT;
    for (;;) {
      if (isolatedContextId) break;
      if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

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

  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await waitForOverlayClosed();
    await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");
  });

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
    // The checkbox itself is visually hidden by the slider CSS toggle pattern — click its
    // <label> (the actionable, visible element) instead of the input.
    await popup.click('label[for="toggle-lite-mode"]');
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
  }

  async function addTerm(term) {
    const before = await page.locator(CHIP_TERM).count();
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
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

  function chipExprByIndex(i) {
    return `document.getElementById('oc-wrap').shadowRoot.querySelectorAll('.oc-chip-term')[${i}]`;
  }

  test('an inactive Lite Mode chip\'s accessible name carries the real (uncorrected) countMatchesOnly count', async () => {
    await setLiteMode(true);
    try {
      await openFinder();

      // 'zqcat' committed first (briefly active), then 'zqdog' committed second —
      // addChipTerm() always activates the newest chip, so this leaves 'zqcat' inactive,
      // which is what puts it on Lite Mode's countMatchesOnly() path.
      await addTerm('zqcat');
      await addTerm('zqdog');

      await page.waitForFunction(
        (expected) => {
          const root = document.getElementById('oc-wrap').shadowRoot;
          const el = root.querySelectorAll('.oc-chip-count')[0];
          return el && el.textContent === expected;
        },
        '5',
        { timeout: POLL_TIMEOUT }
      );

      const zqcatName = await computedAccessibleName(client, chipExprByIndex(0));
      assert.strictEqual(
        zqcatName,
        'Search term: zqcat, 5 matches',
        'the inactive Lite Mode chip\'s computed accessible name must carry the real countMatchesOnly() count (5, ' +
          'the uncorrected indexOf scan including the hidden duplicates) — not a blank, and not the exact ' +
          'visibility-filtered count (3) only the active term gets'
      );
    } finally {
      await setLiteMode(false);
    }
  });
});
