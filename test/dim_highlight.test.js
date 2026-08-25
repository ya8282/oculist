// Dim highlight registry for inactive terms (oculist-l6m.6): every INACTIVE term in the
// working list stays visible in a muted 'oculist-dim-match' highlight while the ACTIVE
// term keeps the full-strength 'oculist-match'/'oculist-active-match' treatment.
//
// Needs a real browser for the same reasons as list_search.test.js: CSS.highlights /
// Highlight only exist in real Chromium, not jsdom, and buildPageIndex/findRanges/
// performListSearch are IIFE-internal and not importable — so the dim range set, the
// three registries' explicit .priority values, and teardown all have to be observed from
// outside via CDP against the content script's isolated execution context.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');

// Same fixture and hand-verified occurrence counts as list_search.test.js: "cat" appears
// 7 times (4 standalone + 3 as the prefix of "cats"), "cats" appears 3 times, "dog" once.
// The standalone/prefix mix is load-bearing for the overlapping-term priority test below:
// findRanges() scans left-to-right, so with "cat" active, searchRanges[0] is the first
// standalone "cat" and searchRanges[1] is the "cat" prefix of the first "cats" — a range
// that spatially overlaps one of oculist-dim-match's "cats" ranges at the same start
// point.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>cat cats cat dog cats bird cat cats cat</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';

describe('Dim highlight registry for inactive terms', () => {
  let server, ctx, page, client, isolatedContextId, extId;
  const pageErrors = [];

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
    page.on('pageerror', (err) => pageErrors.push(err));

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

  function rangeTexts(registryName) {
    return evalInContentScript(`
      (function () {
        var h = CSS.highlights.get('${registryName}');
        if (!h) return [];
        return Array.from(h).map(function (r) { return r.toString(); });
      })()
    `);
  }

  function registryPriorities() {
    return evalInContentScript(`
      (function () {
        function p(name) {
          var h = CSS.highlights.get(name);
          return h ? h.priority : null;
        }
        return { dim: p('oculist-dim-match'), match: p('oculist-match'), active: p('oculist-active-match') };
      })()
    `);
  }

  function registriesPresent() {
    return evalInContentScript(`
      (function () {
        return {
          dim: CSS.highlights.has('oculist-dim-match'),
          match: CSS.highlights.has('oculist-match'),
          active: CSS.highlights.has('oculist-active-match')
        };
      })()
    `);
  }

  test('dim set holds exactly the inactive terms\' ranges and excludes the active term\'s', async () => {
    await addTerm('cat');
    await addTerm('dog');

    // A single chip click scans the whole list in one performListSearch() call and
    // builds oculist-dim-match from every term but the one just activated.
    await page.locator(CHIP_TERM).nth(0).click(); // activate 'cat'
    await page.waitForTimeout(250);

    const matchTexts = await rangeTexts('oculist-match');
    const dimTexts = await rangeTexts('oculist-dim-match');

    assert.strictEqual(matchTexts.length, 7, 'oculist-match should hold every match of the active term ("cat")');
    assert.ok(matchTexts.every((t) => t === 'cat'), 'oculist-match must only contain the active term\'s own text');

    assert.strictEqual(dimTexts.length, 1, 'oculist-dim-match should hold only the one inactive term ("dog")\'s match');
    assert.strictEqual(dimTexts[0], 'dog');
    assert.ok(!dimTexts.includes('cat'), 'the active term\'s own ranges must never appear in the dim set');

    // Activating the other chip flips which term is dim and which is bright.
    await page.locator(CHIP_TERM).nth(1).click(); // activate 'dog'
    await page.waitForTimeout(250);

    const matchTexts2 = await rangeTexts('oculist-match');
    const dimTexts2 = await rangeTexts('oculist-dim-match');
    assert.deepStrictEqual(matchTexts2, ['dog']);
    assert.strictEqual(dimTexts2.length, 7, 'every "cat" match should now be dim since "cat" is no longer active');
    assert.ok(dimTexts2.every((t) => t === 'cat'));
  });

  test('overlapping terms: explicit priorities keep the active term above the dim wash', async () => {
    await addTerm('cat');
    await addTerm('cats');

    // Re-activate 'cat' via a chip click (performListSearch()) — termRanges[0] is the 7
    // "cat" ranges (standalone + the "cats" prefixes), termRanges[1] is the 3 "cats"
    // ranges, and oculist-dim-match is built from termRanges[1] only.
    await page.locator(CHIP_TERM).nth(0).click();
    await page.waitForTimeout(250);

    // Clicking a chip does not itself move the active-match cursor (that is findNext()'s
    // job) — F3 drives findNext() directly, without going through the Enter-key path that
    // would re-add/re-activate a chip from the stale input value. Two presses land on
    // searchRanges[1]: the "cat" that is the prefix of the FIRST "cats" occurrence, which
    // spatially overlaps one of oculist-dim-match's ranges at the exact same start point.
    await page.keyboard.press('F3');
    await page.waitForTimeout(150);
    await page.keyboard.press('F3');
    await page.waitForTimeout(150);

    const priorities = await registryPriorities();
    assert.strictEqual(priorities.dim, 0, 'oculist-dim-match must have priority 0');
    assert.strictEqual(priorities.match, 1, 'oculist-match must have priority 1');
    assert.strictEqual(priorities.active, 2, 'oculist-active-match must have priority 2 — the highest of the three');

    const overlap = await evalInContentScript(`
      (function () {
        var active = CSS.highlights.get('oculist-active-match');
        var dim = CSS.highlights.get('oculist-dim-match');
        var activeRange = Array.from(active)[0];
        var dimRanges = Array.from(dim);
        var overlapping = dimRanges.some(function (r) {
          return r.startContainer === activeRange.startContainer && r.startOffset === activeRange.startOffset;
        });
        return { activeText: activeRange.toString(), overlapping: overlapping };
      })()
    `);

    assert.strictEqual(overlap.activeText, 'cat', 'sanity check: the active range should be a "cat" match');
    assert.ok(
      overlap.overlapping,
      'test setup is not exercising the overlap this test exists to cover — the active range must start at the ' +
        'same DOM position as one of the dim ranges'
    );
    // With overlapping.overlapping confirmed true, the priority assertions above are what
    // guarantee the browser paints oculist-active-match (priority 2) over
    // oculist-dim-match (priority 0) at that shared position, rather than the dim wash
    // (or worse, a stale "last registered wins" ordering) hiding the active term.
  });

  test('activeTermIndex === -1 with a non-empty list dims every term without throwing', async () => {
    await addTerm('cat');
    await addTerm('dog');

    // Not reachable through the chip-remove UI (removeChipAt() always clamps to 0 unless
    // the whole list empties) but a legitimate persisted/restored state — e.g. a working
    // list restored from session storage before any chip has been (re-)activated —
    // performListSearch() must handle it without throwing.
    await evalInContentScript(`
      new Promise((resolve) => chrome.storage.session.set(
        { 'oc-worklist': { terms: ['cat', 'dog'], activeIndex: -1 } }, resolve
      ))
    `);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.waitForTimeout(150);

    // loadWorkList() on open only populates workListTerms/activeTermIndex — a real DOM
    // mutation is what actually triggers the rescanAfterMutation() -> performListSearch()
    // call that builds termRanges and the dim registry for the restored list.
    await page.evaluate(() => {
      var marker = document.createElement('span');
      marker.textContent = 'trigger-rescan';
      document.body.appendChild(marker);
    });
    await page.waitForTimeout(600); // 350ms mutation-observer debounce + margin

    const dimTexts = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimTexts.length, 8, 'every term is inactive, so all 7 "cat" + 1 "dog" matches must be dim');
    assert.strictEqual(dimTexts.filter((t) => t === 'cat').length, 7);
    assert.strictEqual(dimTexts.filter((t) => t === 'dog').length, 1);

    assert.deepStrictEqual(pageErrors, [], 'activeTermIndex === -1 must not throw an uncaught error in the page');
  });

  test('teardown clears all three highlight registries', async () => {
    await addTerm('cat');
    await addTerm('cats');
    await page.locator(CHIP_TERM).nth(0).click();
    await page.waitForTimeout(250);
    await page.keyboard.press('F3'); // populate oculist-active-match too
    await page.waitForTimeout(150);

    const before = await registriesPresent();
    assert.strictEqual(before.match, true);
    assert.strictEqual(before.dim, true);
    assert.strictEqual(before.active, true);

    await page.keyboard.press('Escape'); // -> window.__ocDestroy()
    await page.waitForTimeout(150);

    const after = await registriesPresent();
    assert.strictEqual(after.match, false, 'oculist-match must be deleted on teardown');
    assert.strictEqual(after.dim, false, 'oculist-dim-match must be deleted on teardown');
    assert.strictEqual(after.active, false, 'oculist-active-match must be deleted on teardown');

    // Re-open for the next test's beforeEach to build on.
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.waitForTimeout(150);
  });

  // Kept last: it changes the persisted visionProfile setting (chrome.storage.sync, not
  // reset by beforeEach) and resets it back to 'none' at the end so it never leaks into
  // an earlier-run test.
  test('low-vision profile swaps the dim wash for a full-color dotted underline', async () => {
    const defaultCss = await page.evaluate(
      () => document.getElementById('oc-global-highlight-styles').textContent
    );
    const defaultRule = /::highlight\(oculist-dim-match\)\s*\{([^}]*)\}/.exec(defaultCss);
    assert.ok(defaultRule, 'oculist-dim-match rule must be present in the injected stylesheet');
    assert.match(
      defaultRule[1],
      /background-color:\s*rgba\([^)]*,\s*0\.35\s*\)/,
      'default profile must render dim as a 35% alpha wash of matchColor'
    );
    assert.doesNotMatch(
      defaultRule[1],
      /text-decoration/,
      'default profile must not use the low-vision underline treatment'
    );

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#vision-profile');
    await popup.selectOption('#vision-profile', 'low-vision');
    await popup.waitForTimeout(300);
    await popup.close();

    await page.bringToFront();
    await page.waitForFunction(
      () => {
        var el = document.getElementById('oc-global-highlight-styles');
        return !!el && /oculist-dim-match[^}]*text-decoration-line/.test(el.textContent);
      },
      null,
      { timeout: 5000 }
    );

    const lowVisionCss = await page.evaluate(
      () => document.getElementById('oc-global-highlight-styles').textContent
    );
    const lowVisionRule = /::highlight\(oculist-dim-match\)\s*\{([^}]*)\}/.exec(lowVisionCss);
    assert.ok(lowVisionRule, 'oculist-dim-match rule must still be present after switching profile');
    assert.match(lowVisionRule[1], /text-decoration-line:\s*underline/);
    assert.match(lowVisionRule[1], /text-decoration-style:\s*dotted/);
    assert.doesNotMatch(
      lowVisionRule[1],
      /background-color/,
      'low-vision must drop the background wash entirely — a 35% wash would defeat the contrast the profile exists to provide'
    );

    // Reset so this test's side effect never leaks into another test file run against the
    // same persistent context.
    const resetPopup = await ctx.newPage();
    await resetPopup.goto(`chrome-extension://${extId}/popup.html`);
    await resetPopup.waitForSelector('#vision-profile');
    await resetPopup.selectOption('#vision-profile', 'none');
    await resetPopup.waitForTimeout(300);
    await resetPopup.close();
  });
});
