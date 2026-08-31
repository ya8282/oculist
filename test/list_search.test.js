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
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { enableAccessibilityDomain, computedAccessibleName } = require('./helpers/accessible_name');

const EXTENSION = path.resolve(__dirname, '../extension');
const CLOSED = () => !document.getElementById('oc-wrap');

// Known, hand-verified occurrence counts (substring match, same algorithm findRanges
// uses): "cat" appears 7 times total (4 standalone + 3 as the prefix of "cats"), "cats"
// appears 3 times, "dog" once. This is the load-bearing fixture for the overlapping-term
// assertion: "cat" and "cats" must each get their own correct, independent range count
// even though every "cats" is also a "cat" match.
//
// The hidden block adds 3 more "cat"s that findRanges() always filters out (its immediate
// parent <span> is not itself display:none, so buildPageIndex() includes it in flatText,
// but the enclosing <div> is display:none, so getClientRects() on any Range inside it
// returns zero rects) — every existing exact-count assertion below is unaffected. It
// exists solely for oculist-l6m.7's Lite Mode test: Lite Mode's count-only path scans
// flatText directly with no visibility filter, so it reports 10 "cat"s (7 real + 3
// hidden) where findRanges()/exact mode reports 7.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>cat cats cat dog cats bird cat cats cat</p>
<div style="display:none"><span>cat cat cat</span></div>`;

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const CHIP_REMOVE = '#oc-wrap >> .oc-chip-remove';
const CHIP_COUNT = '#oc-wrap >> .oc-chip-count';
const COUNT = '#oc-wrap >> .oc-count';

// Deliberately NOT page.waitForFunction(() => chrome.storage.sync.get(...).then(...)) —
// confirmed against this Playwright version that a promise-returning predicate resolves
// immediately on the (truthy) Promise object rather than being awaited (see
// test/wizard_no_clinical_persistence.test.js). This awaits a real page.evaluate() round
// trip from Node on every poll tick instead.
function readStoredSettings(target) {
  return target.evaluate(
    () => new Promise((resolve) => chrome.storage.sync.get('oc-settings', (d) => resolve(d['oc-settings'])))
  );
}

describe('performListSearch() and per-term chip counts', () => {
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
    // world existing at all — poll the execution-context-created flag the CDP listener
    // above sets, instead of guessing how long injection takes.
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });
    await openFinderRetry();
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
  async function openFinderRetry() {
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
    await openFinderRetry();
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
  // proxy for the whole re-scan (registries and every chip's count included) having landed.
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

  // Arm a probe listener inside the content script's own isolated world *before* changing
  // a setting via the popup: chrome.storage.onChanged fires every listener registered
  // against that same document for the same event, so observing OUR listener fire is a
  // direct proxy for content.js's own oc-settings listener (registered first, at page load)
  // having *also* already run — including its synchronous rescan — not just
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

  // Flips Lite Mode via the real popup UI (chrome.storage.sync round trip), the same path
  // a user toggling the setting takes — not a direct storage write — so content.js's
  // chrome.storage.onChanged listener is exercised exactly as it would be in production.
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
    await waitForCondition(
      () => readStoredSettings(popup),
      (stored) => !!(stored && stored.performanceMode === enabled),
      { timeout: POLL_TIMEOUT, message: `oc-settings.performanceMode never became ${enabled}` }
    );
    await popup.close();
    await page.bringToFront();

    // ...then wait for that same write to echo into content.js's own onChanged listener
    // (and, downstream of it, performListSearch()'s synchronous rescan) instead of a fixed
    // settle window.
    await waitForSettingsEcho(before);
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

    // oculist-l6m.5: committing a chip with Enter now runs performListSearch() itself
    // (inside addChipTerm()), so every chip's count is already populated the moment the
    // 4th chip lands — before any chip click. See draft_ownership.test.js for the
    // dedicated coverage of that Enter-driven scan.
    assert.deepStrictEqual(await chipCounts(), ['7', '3', '1', '0']);

    // Re-activating a chip via a click re-scans the whole list in one performListSearch()
    // call and keeps every chip's count correct, not just the one that was clicked.
    await clickChip(0);

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
    await clickChip(2); // 'dog'
    assert.deepStrictEqual(await chipCounts(), ['7', '3', '1', '0']);
    assert.strictEqual((await page.locator(COUNT).textContent()).trim(), '0 of 1');
  });

  // Regression guard for oculist-l6m.14: traverse()'s Oculist-node exclusion must route
  // through the shared isOculistNode() helper, not a narrower `child !== wrap` identity
  // check, so any Oculist-owned node mounted directly under <body> (not just `wrap`
  // itself) is still excluded from the scan. Production never mounts a
  // .oc-viewport-marker under <body> today (it goes on documentElement), but that is
  // exactly the kind of node the narrower identity check would silently start
  // self-matching against if it ever did — this plants one under <body> directly to prove
  // the exclusion is keyed off "is this ours", not "is this literally the wrap element".
  test('an Oculist-owned node mounted under <body> is never traversed into (oculist-l6m.14)', async () => {
    await page.evaluate(() => {
      const marker = document.createElement('div');
      marker.id = 'oc-l6m14-probe';
      marker.className = 'oc-viewport-marker';
      marker.textContent = 'zplerptastic';
      document.body.appendChild(marker);
    });

    try {
      await addTerm('zplerptastic');
      assert.deepStrictEqual(
        await chipCounts(),
        ['0'],
        'a node carrying an Oculist marker class must be excluded even when mounted under <body>, not just when it is `wrap` itself'
      );
    } finally {
      // beforeEach does not reload the page, so the probe would otherwise outlive this
      // test and sit in the fixture for every later one in this file.
      await page.evaluate(() => {
        const el = document.getElementById('oc-l6m14-probe');
        if (el) el.remove();
      });
    }
  });

  test('removing the only chip in the working list yields activeIndex -1', async () => {
    await addTerm('solo');
    assert.deepStrictEqual(await chipTerms(), ['solo']);

    await page.locator(CHIP_REMOVE).first().click();
    await waitForChipCount(0);

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
    // Wait on the exact counter this test measures instead of guessing the 150ms/400ms
    // debounce window — the debounce firing is precisely what makes it move.
    const after1 = await waitForContentScriptValue(evalInContentScript, 'window.__ocGCSCalls', (v) => v > before1, {
      timeout: POLL_TIMEOUT,
      message: 'draft-typing debounce never fired a buildPageIndex() call',
    });
    const baselineCalls = after1 - before1;
    assert.ok(baselineCalls > 0, 'the baseline single-buildPageIndex call made no getComputedStyle calls at all — instrumentation is broken');

    // Test: one performListSearch() call, triggered by a single chip click, against a
    // 3-term working list and the identical page/chip-row DOM used above.
    const before3 = await evalInContentScript('window.__ocGCSCalls');
    await page.locator(CHIP_TERM).nth(0).click();
    const after3 = await waitForContentScriptValue(evalInContentScript, 'window.__ocGCSCalls', (v) => v > before3, {
      timeout: POLL_TIMEOUT,
      message: 'chip-click performListSearch() never fired a buildPageIndex() call',
    });
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

  test('activating a chip corrects an inflated Lite Mode count exactly (oculist-l6m.7)', async () => {
    await setLiteMode(true);
    try {
      // 'cat' committed first (briefly active), then 'dog' committed second — addChipTerm()
      // always activates the newest chip, so this leaves 'cat' inactive and 'dog' active,
      // which is what triggers 'cat''s Lite Mode count-only path.
      await addTerm('cat');
      await addTerm('dog');

      assert.deepStrictEqual(await chipTerms(), ['cat', 'dog']);

      const countsBeforeActivation = await chipCounts();
      assert.strictEqual(
        countsBeforeActivation[0],
        '10',
        '"cat" is inactive under Lite Mode: its count must be the uncorrected indexOf scan (7 visible + 3 hidden), not the exact 7'
      );

      // Activating 'cat' re-scans the whole list; 'cat' is now the active term, so it
      // always gets an exact findRanges() scan (visibility-filtered) regardless of Lite
      // Mode — the stale inflated count must not survive activation.
      await clickChip(0);

      const countsAfterActivation = await chipCounts();
      assert.strictEqual(
        countsAfterActivation[0],
        '7',
        'activating the chip must correct the inflated Lite Mode count to the exact, visibility-filtered count'
      );
      assert.strictEqual(
        (await page.locator(COUNT).textContent()).trim(),
        '0 of 7',
        'the active term\'s own count element must also reflect the exact count, not the inflated one'
      );
    } finally {
      await setLiteMode(false);
    }
  });
});

// A separate describe (own server, context, and fixture) so the large repeated-term page
// below never shares state with the fixture above — this test needs distinct terms whose
// per-term counts are each near or at findRanges()'s own 999 cap, which the small
// cat/cats/dog fixture above cannot produce.
describe('performListSearch() total match cap across all terms (oculist-l6m.7)', () => {
  // Four distinct, non-overlapping terms. Lite Mode is used so only the active term
  // ('zzalpha', added last) pays the real Range/getClientRects cost — 'zzbravo' and
  // 'zzcharlie' are counted via the cheap indexOf path, keeping this fixture fast despite
  // ~3000 total words. 'zzbravo' and 'zzcharlie' each have 1000 raw occurrences (capped at
  // findRanges()/countMatchesOnly()'s existing 999-per-term ceiling); 'zzdelta' has only 5
  // — by the time it is scanned, the running total (999 active + 999 + 999 = 2997) has
  // already crossed TOTAL_MATCH_CAP (2000), so 'zzdelta' must be skipped entirely rather
  // than showing its real count.
  const CAP_PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 12px/1.2 system-ui, sans-serif; padding: 10px; }</style>
<p>${'zzbravo '.repeat(1000)}</p>
<p>${'zzcharlie '.repeat(1000)}</p>
<p>${'zzdelta '.repeat(5)}</p>
<p>${'zzalpha '.repeat(1000)}</p>`;

  const NOTICE_TEXT = '#oc-wrap >> .oc-notice-text';

  let server, ctx, page, extId, client, isolatedContextId;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CAP_PAGE);
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

    // Attach CDP and watch for execution-context creation *before* navigating (same
    // pattern as the sibling describe above) — needed by the unscanned-vs-starved test
    // below to seed chrome.storage.session directly from the content script's isolated
    // world, ahead of ever opening the finder.
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
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });
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

  // Each test starts from a closed overlay and a cleared working list, so chips never
  // leak between the two tests in this describe.
  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
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
    // saveSettings() is async (awaits chrome.storage.sync.set) and toggleLiteMode's
    // 'change' listener is not awaited by Playwright's click() — wait for the write to
    // actually land before tearing the popup page down, instead of guessing how long it
    // takes. (No CDP session in this describe to also confirm the content script's own
    // onChanged echo, unlike the sibling describe above — but Lite Mode here is a fixture
    // speed optimisation, not something any assertion below depends on for correctness:
    // findRanges()/countMatchesOnly() share the same 999-per-term cap either way.)
    await waitForCondition(
      () => readStoredSettings(popup),
      (stored) => !!(stored && stored.performanceMode === enabled),
      { timeout: POLL_TIMEOUT, message: `oc-settings.performanceMode never became ${enabled}` }
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

  // The service worker/content script can still be mid-injection right after navigation,
  // especially under heavy load — retry Control+f (a keypress a not-yet-attached listener
  // would otherwise silently swallow) until the input actually appears, instead of
  // guessing a fixed injection delay up front.
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

  // expression run via Runtime.evaluate in the page's default (main) world (see
  // test/helpers/accessible_name.js) — the shadow DOM node itself lives in the one real
  // page document even though content.js's own JS runs in an isolated world.
  function chipExprByIndex(i) {
    return `document.getElementById('oc-wrap').shadowRoot.querySelectorAll('.oc-chip-term')[${i}]`;
  }

  test('exceeding the 2000-match total cap stops materialising further terms, fires the notice, and never starves the active term', async () => {
    await setLiteMode(true);
    try {
      await openFinder();

      await addTerm('zzbravo');
      await addTerm('zzcharlie');
      await addTerm('zzdelta');
      await addTerm('zzalpha'); // added last -> active; must never be starved

      const counts = await page.locator(CHIP_COUNT).allTextContents();
      assert.deepStrictEqual(
        counts,
        ['999', '999', '—', '999'],
        '"zzbravo"/"zzcharlie" hit the per-term 999 cap, "zzdelta" is starved by the total cap (an em dash, not ' +
          'blank and not "5"), "zzalpha" (active) still shows its full per-term-capped count'
      );

      // Enter-driven commits land on match 0 via highlightActiveRange() (see
      // keydownHandler's Enter branch), so the active term's count shows "1 of 999", not
      // the static "0 of 999" a chip click leaves behind — either way, the load-bearing
      // part is the "999", not a starved/lower number.
      assert.strictEqual(
        (await page.locator(COUNT).textContent()).trim(),
        '1 of 999',
        'the active term ("zzalpha") must never be starved by the total cap'
      );

      // The starved chip's accessible name must say WHY it has no count, using the same
      // aria-label mechanism every other chip state already uses (oculist-l6m.21) — a bare
      // em dash on its own conveys nothing to a screen reader.
      const zzdeltaLabel = await page.locator(CHIP_TERM).nth(2).getAttribute('aria-label');
      assert.strictEqual(
        zzdeltaLabel,
        'Search term: zzdelta, skipped, match limit reached',
        '"zzdelta" was skipped by the total cap; its accessible name must say so, not just render an em dash'
      );

      // Strengthened per oculist-l6m.36: also assert on the COMPUTED accessible name (via
      // the CDP Accessibility domain, not getAttribute), which is what a screen reader
      // actually announces and is what regressions in name-computation precedence (e.g. an
      // aria-labelledby appearing) would change without necessarily changing the raw
      // attribute above.
      const zzdeltaComputedName = await computedAccessibleName(client, chipExprByIndex(2));
      assert.strictEqual(
        zzdeltaComputedName,
        'Search term: zzdelta, skipped, match limit reached',
        'the computed accessible name (not just the raw aria-label attribute) must state the starved chip was skipped'
      );

      // 999 (zzalpha, active) + 999 (zzbravo) + 999 (zzcharlie) = 2997, the REAL number of
      // matches materialised this scan — not the 2000 constant the cap is checked against.
      // The cap is checked BEFORE materialising each term (performListSearch()), so the
      // running total can — and here does — run past 2000 before a term is finally
      // skipped. This assertion fails if the literal 2000 is restored.
      const noticeText = await page.locator(NOTICE_TEXT).textContent();
      assert.strictEqual(noticeText, 'Showing the first 2997 matches. Remove a term for a complete count.');
    } finally {
      await setLiteMode(false);
    }
  });

  test('a starved chip is visually and semantically distinct from the same chip before it was ever scanned', async () => {
    // Seed the working list directly via storage (mirrors chip_count_accessibility.
    // test.js's carry-over-restore fixture) so the chip row renders once with all four
    // terms in the genuinely unscanned state — no performListSearch() has run yet, so
    // termRanges and termStarved are both still empty.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.set(" +
        "{ 'oc-worklist': { terms: ['zzbravo', 'zzcharlie', 'zzdelta', 'zzalpha'], activeIndex: 3 } }, resolve))"
    );

    await setLiteMode(true);
    try {
      await openFinder();
      await page.waitForFunction(
        (expected) => {
          const root = document.getElementById('oc-wrap');
          const chips = root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.oc-chip-term') : [];
          return chips.length === expected;
        },
        4,
        { timeout: POLL_TIMEOUT }
      );

      // Before ANY scan: every chip, including the one that is about to become starved,
      // is blank with no count suffix in its accessible name — carry-over restore alone
      // must never claim a count, real or skipped.
      const countsBeforeScan = await page.locator(CHIP_COUNT).allTextContents();
      assert.deepStrictEqual(
        countsBeforeScan,
        ['', '', '', ''],
        'an unscanned chip renders a plain blank, not the em dash a starved chip uses'
      );
      const zzdeltaLabelBeforeScan = await page.locator(CHIP_TERM).nth(2).getAttribute('aria-label');
      assert.strictEqual(
        zzdeltaLabelBeforeScan,
        'Search term: zzdelta',
        'an unscanned chip must not claim it was skipped before any scan has actually run'
      );
      // Strengthened per oculist-l6m.36: computed accessible name, not just the raw
      // attribute, must not claim "skipped" before any scan has run.
      const zzdeltaComputedNameBeforeScan = await computedAccessibleName(client, chipExprByIndex(2));
      assert.strictEqual(
        zzdeltaComputedNameBeforeScan,
        'Search term: zzdelta',
        'the computed accessible name of an unscanned chip must not claim it was skipped before any scan has run'
      );

      // Clicking the already-active chip still forces a full rescan (activateChip() always
      // calls performListSearch()) — the same chip element observed above now runs into
      // the total cap and becomes starved.
      await page.locator(CHIP_TERM).nth(3).click();
      await page.waitForFunction(
        () => {
          const root = document.getElementById('oc-wrap');
          const el = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
          return !!(el && el.textContent && el.textContent.indexOf('999') !== -1);
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      const countsAfterScan = await page.locator(CHIP_COUNT).allTextContents();
      assert.deepStrictEqual(
        countsAfterScan,
        ['999', '999', '—', '999'],
        'the same "zzdelta" chip now shows the starved em dash, visually distinct from the blank it showed before any scan ran'
      );
      const zzdeltaLabelAfterScan = await page.locator(CHIP_TERM).nth(2).getAttribute('aria-label');
      assert.strictEqual(
        zzdeltaLabelAfterScan,
        'Search term: zzdelta, skipped, match limit reached',
        'the same chip now states it was skipped, distinct from the plain "Search term: zzdelta" it had before the scan'
      );
      // Strengthened per oculist-l6m.36: computed accessible name transitions the same way.
      const zzdeltaComputedNameAfterScan = await computedAccessibleName(client, chipExprByIndex(2));
      assert.strictEqual(
        zzdeltaComputedNameAfterScan,
        'Search term: zzdelta, skipped, match limit reached',
        'the computed accessible name of the same chip must now state it was skipped'
      );
    } finally {
      await setLiteMode(false);
    }
  });
});
