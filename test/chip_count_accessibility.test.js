// Chip hit counts are accessible to assistive tech (oculist-l6m.16).
//
// .oc-chip-count is aria-hidden — screen readers never read it. Bead .4 made the number it
// shows meaningful (it is how a user knows which terms actually hit on this page), so the
// same information has to be reachable through the chip term button's accessible name
// instead. This asserts on that accessible name (aria-label), not merely that some string
// exists, across every state the count actually has:
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
const { POLL_TIMEOUT } = require('./helpers/wait');

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
    await evalInContentScript("new Promise(function (resolve) { window.__ocLoadWorkList(resolve); })");
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

  function chipAriaLabels() {
    return page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      return Array.from(root.querySelectorAll('.oc-chip-term')).map((el) => el.getAttribute('aria-label'));
    });
  }

  // Polls the real, already-rendered aria-label instead of sleeping a guessed scan/render
  // duration — renderChipRow() is the single render path that fills it in.
  async function waitForChipAriaLabel(term, expected) {
    await page.waitForFunction(
      (args) => {
        const root = document.getElementById('oc-wrap').shadowRoot;
        const el = Array.from(root.querySelectorAll('.oc-chip-term')).find((e) => e.textContent === args.term);
        return el && el.getAttribute('aria-label') === args.expected;
      },
      { term: term, expected: expected },
      { timeout: POLL_TIMEOUT }
    );
  }

  async function addTerm(term) {
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
  }

  test('a term with several matches gets a plural "N matches" accessible name', async () => {
    await addTerm('cat');
    await waitForChipAriaLabel('cat', 'Active search term: cat, 3 matches');

    const labels = await chipAriaLabels();
    assert.deepStrictEqual(labels, ['Active search term: cat, 3 matches']);
  });

  test('a term with exactly one match gets a singular "1 match" accessible name', async () => {
    await addTerm('dog');
    await waitForChipAriaLabel('dog', 'Active search term: dog, 1 match');
  });

  test('a scanned zero-match term gets "0 matches", never a blank or false count', async () => {
    await addTerm('quokka');
    await waitForChipAriaLabel('quokka', 'Active search term: quokka, 0 matches');
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
    await waitForChipAriaLabel('unscanned-term', 'Active search term: unscanned-term');

    const labels = await chipAriaLabels();
    assert.deepStrictEqual(
      labels,
      ['Active search term: unscanned-term'],
      'a carry-over-restored chip must not claim "0 matches" before any scan has run'
    );
  });
});
