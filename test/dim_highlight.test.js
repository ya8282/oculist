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
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const CLOSED = () => !document.getElementById('oc-wrap');

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

    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
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
    await openFinder();
    // The worklist was just cleared above, but loadWorkList() (chrome.storage.session.get)
    // resolves asynchronously after open — poll for the chip row to actually reflect the
    // now-empty list, rather than guessing how long that round trip takes.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.oc-chip-term') : [];
        return chips.length === 0;
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
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

  // Arm a probe listener inside the content script's own isolated world *before* changing
  // a setting via the popup: chrome.storage.onChanged fires every listener registered
  // against that same document for the same event, so observing OUR listener fire is a
  // direct proxy for content.js's own oc-settings listener (registered first, at page
  // load) having *also* already run — including its synchronous rescan/rebuild — not just
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

  // Flips Lite Mode via the real popup UI (chrome.storage.sync round trip) rather than a
  // direct storage write, so content.js's chrome.storage.onChanged listener — and its
  // oculist-l6m.7 rescan-on-toggle — is exercised exactly as production toggling is.
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

  // renderChipRow() is the last synchronous statement of performListSearch() (see
  // content.js), so the chip row reaching an exact expected chip count is a genuine proxy
  // for "the whole scan — counts, highlight registries — finished", not just "some chip
  // exists".
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

  function waitForRegistries(predicate, opts) {
    return waitForCondition(registriesPresent, predicate, { timeout: POLL_TIMEOUT, ...opts });
  }

  function waitForDimTexts(predicate, opts) {
    return waitForCondition(() => rangeTexts('oculist-dim-match'), predicate, { timeout: POLL_TIMEOUT, ...opts });
  }

  test('dim set holds exactly the inactive terms\' ranges and excludes the active term\'s', async () => {
    await addTerm('cat');
    await addTerm('dog');

    // A single chip click scans the whole list in one performListSearch() call and
    // builds oculist-dim-match from every term but the one just activated. clickChip()
    // waits on the clicked chip's '.active' class, renderChipRow()'s last synchronous
    // output — a genuine proxy for the whole scan (registries included) having landed.
    await clickChip(0); // activate 'cat'

    const matchTexts = await rangeTexts('oculist-match');
    const dimTexts = await rangeTexts('oculist-dim-match');

    assert.strictEqual(matchTexts.length, 7, 'oculist-match should hold every match of the active term ("cat")');
    assert.ok(matchTexts.every((t) => t === 'cat'), 'oculist-match must only contain the active term\'s own text');

    assert.strictEqual(dimTexts.length, 1, 'oculist-dim-match should hold only the one inactive term ("dog")\'s match');
    assert.strictEqual(dimTexts[0], 'dog');
    assert.ok(!dimTexts.includes('cat'), 'the active term\'s own ranges must never appear in the dim set');

    // Activating the other chip flips which term is dim and which is bright.
    await clickChip(1); // activate 'dog'

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
    await clickChip(0);

    // Clicking a chip does not itself move the active-match cursor (that is findNext()'s
    // job) — F3 drives findNext() directly, without going through the Enter-key path that
    // would re-add/re-activate a chip from the stale input value. Two presses land on
    // searchRanges[1]: the "cat" that is the prefix of the FIRST "cats" occurrence, which
    // spatially overlaps one of oculist-dim-match's ranges at the exact same start point.
    // findNext() is synchronous end-to-end (ends in highlightActiveRange(true), which sets
    // the oculist-active-match registry before any scroll/animation timers), so polling for
    // the exact expected landing spot below is a real, non-vacuous wait, not a guess.
    await page.keyboard.press('F3');
    await page.keyboard.press('F3');

    const priorities = await registryPriorities();
    // No assertion on priorities.dim here (oculist-l6m.18): Highlight.priority defaults to
    // 0 per the CSS Custom Highlight API spec, which is exactly the value
    // updateDimHighlight() assigns oculist-dim-match, so deleting that assignment produces
    // an identical priorities.dim reading and can never fail a check on its value. Verified
    // by mutation: removing `dimHighlight.priority = 0;` from content.js left this whole
    // test suite green. The real invariant — that the active match renders above the dim
    // wash — is what the overlap check below exercises instead.
    assert.strictEqual(priorities.match, 1, 'oculist-match must have priority 1');
    assert.strictEqual(priorities.active, 2, 'oculist-active-match must have priority 2 — the highest of the three');

    const overlapExpr = `
      (function () {
        var active = CSS.highlights.get('oculist-active-match');
        var dim = CSS.highlights.get('oculist-dim-match');
        if (!active || !dim) return null;
        var activeRange = Array.from(active)[0];
        if (!activeRange) return null;
        var dimRanges = Array.from(dim);
        var overlapping = dimRanges.some(function (r) {
          return r.startContainer === activeRange.startContainer && r.startOffset === activeRange.startOffset;
        });
        return { activeText: activeRange.toString(), overlapping: overlapping };
      })()
    `;
    const overlap = await waitForContentScriptValue(
      evalInContentScript,
      overlapExpr,
      (v) => v && v.activeText === 'cat' && v.overlapping === true,
      {
        timeout: POLL_TIMEOUT,
        message: 'two F3 presses never landed the active-match cursor on the overlapping "cat" occurrence',
      }
    );

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
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
    await openFinder();
    // loadWorkList() populated workListTerms with the restored ['cat', 'dog'] list above —
    // wait for that to actually reach the chip row before triggering the mutation below.
    await waitForChipCount(2);

    // loadWorkList() on open only populates workListTerms/activeTermIndex — a real DOM
    // mutation is what actually triggers the rescanAfterMutation() -> performListSearch()
    // call that builds termRanges and the dim registry for the restored list.
    await page.evaluate(() => {
      var marker = document.createElement('span');
      marker.textContent = 'trigger-rescan';
      document.body.appendChild(marker);
    });
    // The real condition is the mutation-observer debounce (350ms) actually firing
    // rescanAfterMutation() and it finishing — poll oculist-dim-match reaching its final
    // 8-range shape instead of guessing "debounce + margin" as a wall-clock number. This is
    // the exact race the bead reproduced: under load the rescan can overrun a fixed
    // wait entirely and read back zero highlights.
    const dimTexts = await waitForDimTexts((v) => Array.isArray(v) && v.length === 8, {
      timeout: POLL_TIMEOUT,
      message: 'mutation-observer rescan never rebuilt oculist-dim-match with all 8 inactive-term matches',
    });
    assert.strictEqual(dimTexts.length, 8, 'every term is inactive, so all 7 "cat" + 1 "dog" matches must be dim');
    assert.strictEqual(dimTexts.filter((t) => t === 'cat').length, 7);
    assert.strictEqual(dimTexts.filter((t) => t === 'dog').length, 1);

    assert.deepStrictEqual(pageErrors, [], 'activeTermIndex === -1 must not throw an uncaught error in the page');
  });

  test('teardown clears all three highlight registries', async () => {
    await addTerm('cat');
    await addTerm('cats');
    await clickChip(0);
    await page.keyboard.press('F3'); // populate oculist-active-match too
    const before = await waitForRegistries((v) => v.active === true, {
      message: 'F3 never populated oculist-active-match',
    });
    assert.strictEqual(before.match, true);
    assert.strictEqual(before.dim, true);
    assert.strictEqual(before.active, true);

    await page.keyboard.press('Escape'); // -> window.__ocDestroy()
    const after = await waitForRegistries((v) => !v.match && !v.dim && !v.active, {
      message: 'teardown never cleared all three highlight registries',
    });
    assert.strictEqual(after.match, false, 'oculist-match must be deleted on teardown');
    assert.strictEqual(after.dim, false, 'oculist-dim-match must be deleted on teardown');
    assert.strictEqual(after.active, false, 'oculist-active-match must be deleted on teardown');

    // Re-open for the next test's beforeEach to build on. __ocDestroy() left session
    // storage's 'oc-worklist' untouched (only in-memory state is reset), so loadWorkList()
    // on this reopen restores the same 2-chip ('cat'/'cats') list persisted above.
    await openFinder();
    await waitForChipCount(2);
  });

  test('Lite Mode builds no Range objects for inactive terms and sets no dim highlights (oculist-l6m.7)', async () => {
    await setLiteMode(true);
    try {
      await addTerm('cat');
      await addTerm('dog'); // 'dog' committed second -> active; 'cat' (7 matches) inactive

      // Monkeypatch document.createRange *inside the content script's own isolated
      // world* — findRanges() is the only place content.js calls it, so counting calls
      // there is a direct proxy for "was a Range ever built for this term". Same
      // isolated-world-local-assignment technique as list_search.test.js's
      // window.getComputedStyle monkeypatch.
      await evalInContentScript(`
        (function () {
          if (window.__ocCreateRangeInstalled) return true;
          window.__ocCreateRangeInstalled = true;
          window.__ocCreateRangeCalls = 0;
          var orig = document.createRange.bind(document);
          document.createRange = function () {
            window.__ocCreateRangeCalls++;
            return orig();
          };
          return true;
        })()
      `);

      // Re-trigger a fresh performListSearch() scan without changing which chip is
      // active, by clicking the already-active 'dog' chip again.
      const before = await evalInContentScript('window.__ocCreateRangeCalls');
      // 'dog' is already active, so clickChip()'s "gained the .active class" signal would
      // be true even before this click reruns anything — poll the counter this test
      // actually asserts on instead, so the wait only resolves once the fresh scan has
      // genuinely happened.
      await page.locator(CHIP_TERM).nth(1).click();
      await waitForContentScriptValue(evalInContentScript, 'window.__ocCreateRangeCalls', (v) => v > before, {
        timeout: POLL_TIMEOUT,
        message: 're-clicking the already-active chip never triggered a fresh performListSearch() scan',
      });
      const after = await evalInContentScript('window.__ocCreateRangeCalls');

      assert.strictEqual(
        after - before,
        1,
        'only the active term ("dog", 1 match) should build a Range under Lite Mode — the inactive term ("cat", 7 matches) must build none'
      );

      const dimTexts = await rangeTexts('oculist-dim-match');
      assert.deepStrictEqual(dimTexts, [], 'Lite Mode must never populate oculist-dim-match');

      const present = await registriesPresent();
      assert.strictEqual(present.dim, false, 'Lite Mode must not even leave an empty oculist-dim-match registry set');
      assert.strictEqual(present.match, true, 'oculist-match (the active term) is unaffected by Lite Mode');
    } finally {
      await setLiteMode(false);
    }
  });

  test('toggling Lite Mode with a list active adds and drops dim highlights (oculist-l6m.7)', async () => {
    await addTerm('cat');
    await addTerm('dog'); // 'dog' active, 'cat' (7 matches) inactive, Lite Mode off

    let dimTexts = await rangeTexts('oculist-dim-match');
    assert.strictEqual(dimTexts.length, 7, 'sanity check: "cat" is dim before Lite Mode is touched');

    await setLiteMode(true);

    const midPresent = await registriesPresent();
    assert.strictEqual(midPresent.dim, false, 'enabling Lite Mode with a list already active must rescan and drop dim highlights');

    await setLiteMode(false);

    dimTexts = await rangeTexts('oculist-dim-match');
    assert.strictEqual(
      dimTexts.length,
      7,
      'disabling Lite Mode with a list already active must rescan and rebuild dim highlights — no stale empty registry'
    );
    assert.ok(dimTexts.every((t) => t === 'cat'));
  });

  // Kept last: it changes the persisted visionProfile setting (chrome.storage.sync, not
  // reset by beforeEach) and resets it back to 'none' at the end so it never leaks into
  // an earlier-run test.
  //
  // oculist-l6m.17: the dim treatment is now gated on the blended dim colour's MEASURED
  // contrast against the page background (WCAG 2.2 SC 1.4.11, 3:1), not on
  // settings.visionProfile === 'low-vision' by name. On this file's white-background
  // fixture, the default matchColor (#fef08a) blended at 35% alpha measures ~1.06:1 —
  // already well under 3:1 — so the DEFAULT profile (no vision profile active at all) must
  // also be using the underline treatment here, for the same measured reason low-vision is.
  // That default/low-vision parity is itself the regression check: if the gate were still
  // keyed on the profile name, only low-vision would come out underlined. See
  // dim_contrast.test.js for the full measured-contrast matrix across every built-in
  // profile, the prefers-contrast: more trigger, and the alpha-wash-survives case.
  test('dim treatment uses the underline fallback by measured contrast, not by the "low-vision" profile name (oculist-l6m.17)', async () => {
    const defaultCss = await page.evaluate(
      () => document.getElementById('oc-global-highlight-styles').textContent
    );
    const defaultRule = /::highlight\(oculist-dim-match\)\s*\{([^}]*)\}/.exec(defaultCss);
    assert.ok(defaultRule, 'oculist-dim-match rule must be present in the injected stylesheet');
    assert.match(
      defaultRule[1],
      /text-decoration-line:\s*underline/,
      'default profile\'s pale matchColor blends to ~1.06:1 against this page\'s white background — well under 3:1 — so dim must already be the underline treatment even with no vision profile active'
    );

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#vision-profile');

    // Not a waitForFunction-on-CSS-diff here: low-vision's colorPalette is 'default', the
    // same as the 'none' preset just asserted above, so the injected stylesheet text can be
    // byte-identical before and after this switch — diffing it would be a vacuous wait.
    // Instead this arms the same onChanged-echo probe setLiteMode() uses above and waits
    // for content.js's own oc-settings listener to have actually run, which is agnostic to
    // whether the visible CSS text changed.
    const before = await armSettingsEcho();
    await popup.selectOption('#vision-profile', 'low-vision');
    await waitForCondition(
      () => readStoredSettings(popup),
      // oculist-rnr.12: persisted field is 'displayPreset', holding the functional
      // translation of the 'low-vision' dropdown option ('high-contrast').
      (stored) => !!(stored && stored.displayPreset === 'high-contrast'),
      { timeout: POLL_TIMEOUT, message: "oc-settings.displayPreset never became 'high-contrast'" }
    );
    await popup.close();
    await page.bringToFront();
    await waitForSettingsEcho(before);

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
      'low-vision must not use the background wash — its blended colour also measures below 3:1 on this page'
    );

    // Reset so this test's side effect never leaks into another test file run against the
    // same persistent context.
    const resetPopup = await ctx.newPage();
    await resetPopup.goto(`chrome-extension://${extId}/popup.html`);
    await resetPopup.waitForSelector('#vision-profile');
    await resetPopup.selectOption('#vision-profile', 'none');
    // Wait for the reset write to actually land in chrome.storage.sync before closing —
    // this context may persist across test file runs, so the write genuinely has to
    // commit, not just be dispatched.
    await waitForCondition(
      () => readStoredSettings(resetPopup),
      // oculist-rnr.12: selecting 'none' persists displayPreset as null, not the
      // string 'none'.
      (stored) => !!stored && stored.displayPreset === null,
      { timeout: POLL_TIMEOUT, message: 'oc-settings.displayPreset never became null' }
    );
    await resetPopup.close();
  });
});
