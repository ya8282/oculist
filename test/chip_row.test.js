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
const { waitForCondition, waitForContentScriptValue } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const CLOSED = () => !document.getElementById('oc-wrap');

const FILLER = 'filler words to fill the page and push it past the no-matches notice threshold. ';

// Two fixture terms with known, distinct occurrence counts (oculist-l6m.33) — zenithquokka
// appears 3 times (matching the bug repro's own "0 of 3" description), brindlefalcon 2 —
// so a chip-removal test can assert on a specific, non-trivial highlight count rather than
// merely "some" or "none".
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${FILLER.repeat(20)} <span id="target">quarklet</span>
zenithquokka zenithquokka zenithquokka brindlefalcon brindlefalcon</p>`;

// A >100-char term that is a literal substring of PAGE's own filler text (the repeated
// FILLER phrase), so it both trips the 100-char cap and matches the page — needed to
// exercise the cap-notice-erasure path (findNext()'s performSearch() -> checkSiteOverride()
// unconditionally clears the notice when the just-typed term matches).
const LONG_MATCHING_TERM = FILLER.repeat(2).slice(0, 108);

const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const CHIP_REMOVE = '#oc-wrap >> .oc-chip-remove';
const NOTICE = '#oc-wrap >> .oc-notice';
const NOTICE_TEXT = '#oc-wrap >> .oc-notice-text';
const NOTICE_CLOSE = '#oc-wrap >> .oc-notice-close';
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
    // The real precondition for Control+f doing anything is the content script's isolated
    // world existing at all — poll the execution-context-created flag instead of guessing
    // how long injection takes.
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: 5000,
      message: 'never observed the content script isolated execution context',
    });
    await openFinder();
    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
    await page.keyboard.press('Escape');
    await page.waitForFunction(CLOSED, null, { timeout: 5000 });
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
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: 5000 }); // surfaces the real timeout error
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

  // Every test starts from a closed overlay and an empty working list, so chips never
  // leak from one test into the next.
  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(CLOSED, null, { timeout: 5000 });
    await evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");
    await openFinder();
    // The worklist was just cleared above, but loadWorkList() (chrome.storage.session.get)
    // resolves asynchronously after open — poll for the chip row to actually reflect the
    // now-empty list, rather than guessing how long that round trip takes.
    await waitForChipCount(0);
  });

  function waitForChipCount(expected, opts) {
    return page.waitForFunction(
      (n) => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.oc-chip-term') : [];
        return chips.length === n;
      },
      expected,
      { timeout: 5000, ...opts }
    );
  }

  async function addTerm(term) {
    const before = await page.locator(CHIP_TERM).count();
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
    // Enter's chip-add path (addChipTerm() -> performListSearch(), or the existing-chip
    // re-activation path) runs synchronously and ends with renderChipRow() as its very
    // last statement, so the chip row reflecting the expected shape is a genuine proxy for
    // "the whole scan (counts, highlight registries) finished", not just "a chip exists".
    // A cap hit (10-term or 100-char) is a third legitimate outcome: addChipTerm() rejects
    // the term outright and calls showNotice() synchronously instead of touching the chip
    // row at all — accept that too, so addTerm() stays usable for the cap tests' own
    // deliberately-rejected term.
    await page.waitForFunction(
      ({ expected, term }) => {
        const root = document.getElementById('oc-wrap');
        const chips = root && root.shadowRoot ? Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')) : [];
        const last = chips[chips.length - 1];
        // Re-adding an already-present term activates it (via its chip's own .active
        // class) instead of appending a new one, so the chip count can legitimately stay
        // the same — accept either a grown row with this term last, or this term's
        // existing chip becoming active.
        if (chips.length === expected && last && last.textContent === term) return true;
        if (chips.some((el) => el.textContent === term && el.classList.contains('active'))) return true;
        return !!(root && root.shadowRoot && root.shadowRoot.querySelector('.oc-notice'));
      },
      { expected: before + 1, term },
      { timeout: 5000 }
    );
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

  // Empties the input via real per-character Backspace presses (never .fill('')) and
  // waits for the resulting debounce to settle. This matters: .fill('') dispatches a
  // single synthetic 'input' event whose 150ms debounce can still be *pending* right when
  // a following Backspace removes the chip, and that pending debounce's own
  // restoreActiveChip()/performSearch('') call can accidentally clean up the very state
  // this suite exists to catch — masking oculist-l6m.33's bug entirely. The real repro
  // requires the input's debounce to have already converged (searchRanges/highlights
  // already reflect the active chip) *before* the chip-removing Backspace, exactly like a
  // real user backspacing through the chip's own leftover text one key at a time.
  //
  // Rather than guess a duration, this waits on the exact event that must have happened
  // for convergence to be real: the input debounce's own setTimeout callback actually
  // firing. Monkeypatches window.setTimeout inside the content script's own isolated
  // world (same technique list_menu.test.js's own mid-debounce test uses) to count calls
  // scheduled at either debounce delay (150ms normal, 400ms under Lite Mode — matched so
  // this could never go vacuously green if Lite Mode ever became the default) that have
  // actually executed.
  async function armDebounceFireCounter() {
    return evalInContentScript(`
      (function () {
        if (!window.__ocDebounceFiresInstalled) {
          window.__ocDebounceFiresInstalled = true;
          window.__ocDebounceFires = 0;
          var orig = window.setTimeout;
          window.setTimeout = function (fn, delay) {
            if (delay === 150 || delay === 400) {
              var wrapped = function () {
                window.__ocDebounceFires++;
                return fn.apply(this, arguments);
              };
              var args = [wrapped, delay].concat(Array.prototype.slice.call(arguments, 2));
              return orig.apply(window, args);
            }
            return orig.apply(window, arguments);
          };
        }
        return window.__ocDebounceFires;
      })()
    `);
  }

  async function emptyInputByBackspace() {
    await page.locator(INPUT).focus();
    const value = await page.locator(INPUT).inputValue();
    if (value.length === 0) return;
    const before = await armDebounceFireCounter();
    for (let i = 0; i < value.length; i++) {
      await page.keyboard.press('Backspace');
    }
    await waitForContentScriptValue(evalInContentScript, 'window.__ocDebounceFires', (v) => v > before, {
      timeout: 5000,
      message: 'the input debounce triggered by backspacing to empty never fired',
    });
  }

  // The final Backspace on an already-empty, focused input removes the last chip via
  // removeLastChip() -> removeChipAt() -> performListSearch(), all synchronous and ending
  // in renderChipRow() — so the chip row shrinking by one is a genuine proxy for the whole
  // removal (registries included) having landed.
  async function backspaceRemoveLastChip() {
    await emptyInputByBackspace();
    const before = await page.locator(CHIP_TERM).count();
    await page.keyboard.press('Backspace');
    await waitForChipCount(before - 1);
  }

  // Reads the real oculist-match/oculist-dim-match CSS Custom Highlight registries via
  // the content script's own isolated world (same approach as dim_highlight.test.js) —
  // the point of oculist-l6m.33's tests is to catch the count TEXT and the actual lit
  // highlights disagreeing, so asserting on the registry itself (not the count string) is
  // load-bearing.
  function highlightCount(registryName) {
    return evalInContentScript(`
      (function () {
        var h = CSS.highlights.get('${registryName}');
        return h ? Array.from(h).length : 0;
      })()
    `);
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

    await backspaceRemoveLastChip();

    assert.deepStrictEqual(await chipTerms(), ['one']);
    assert.strictEqual(await activeChipTerm(), 'one', 'removing the active last chip should activate the previous one');
  });

  // oculist-l6m.33: removeChipAt() used to only splice the term/range arrays and call
  // renderChipRow() — it never rescanned, so the count text, the nav enabled-state, and
  // the real oculist-match highlight registry disagreed after a removal (the count/nav
  // kept claiming the just-removed term's matches while the highlights either stayed lit
  // or silently detached). Backspace is used (a real key event, not a direct
  // removeChipAt() call) both to match the bug's own repro and per the brief.
  test('Backspace-removal of the only chip clears the count, disables nav, and clears every highlight', async () => {
    await addTerm('zenithquokka');
    assert.deepStrictEqual(await chipTerms(), ['zenithquokka']);
    assert.strictEqual(await activeChipTerm(), 'zenithquokka');
    assert.strictEqual(await highlightCount('oculist-match'), 3, 'sanity check: zenithquokka must have 3 real matches before removal');

    await backspaceRemoveLastChip();

    assert.deepStrictEqual(await chipTerms(), [], 'the only chip must be gone');
    assert.strictEqual(await activeChipTerm(), null, 'no chip remains to be active');
    assert.strictEqual(await page.locator(COUNT).textContent(), '', 'count text must return to the true empty state');
    assert.strictEqual(await page.locator(PREV_BTN).isDisabled(), true, 'nav must be disabled with no chip left');
    assert.strictEqual(await page.locator(NEXT_BTN).isDisabled(), true, 'nav must be disabled with no chip left');
    // The bug's signature: assert on the real highlight registry, not just the count
    // text, since the two used to disagree.
    assert.strictEqual(await highlightCount('oculist-match'), 0, 'zero oculist-match highlights must remain lit after removing the only chip');
    assert.strictEqual(await highlightCount('oculist-dim-match'), 0, 'zero oculist-dim-match highlights must remain lit after removing the only chip');
    assert.strictEqual(await highlightCount('oculist-active-match'), 0, 'zero oculist-active-match highlights must remain lit after removing the only chip');
  });

  test('Backspace-removal of the active chip among several activates the previous chip and its highlights', async () => {
    // zenithquokka (3 matches) is added first, so it ends up at index 0 once
    // brindlefalcon (2 matches) is added second and becomes the active, last-index chip
    // — exactly the shape Backspace's removeLastChip() removes.
    await addTerm('zenithquokka');
    await addTerm('brindlefalcon');
    assert.deepStrictEqual(await chipTerms(), ['zenithquokka', 'brindlefalcon']);
    assert.strictEqual(await activeChipTerm(), 'brindlefalcon');
    assert.strictEqual(await highlightCount('oculist-match'), 2, 'sanity check: brindlefalcon must have 2 real matches before removal');

    await backspaceRemoveLastChip();

    assert.deepStrictEqual(await chipTerms(), ['zenithquokka'], 'only the removed chip should be gone');
    assert.strictEqual(await activeChipTerm(), 'zenithquokka', 'the previous chip should become active');

    const count = await page.locator(COUNT).textContent();
    assert.match(count, /of 3$/, `count must reflect the newly active chip's own 3 matches, got "${count}"`);
    assert.strictEqual(await page.locator(PREV_BTN).isDisabled(), false, 'nav must be enabled: the new active chip has more than one match');
    assert.strictEqual(await page.locator(NEXT_BTN).isDisabled(), false, 'nav must be enabled: the new active chip has more than one match');

    // The real highlight registry must hold exactly the new active chip's 3 ranges —
    // brindlefalcon's 2 must be gone, not merely uncounted.
    assert.strictEqual(await highlightCount('oculist-match'), 3, 'oculist-match must hold exactly zenithquokka\'s 3 ranges');
    assert.strictEqual(await highlightCount('oculist-dim-match'), 0, 'no other chip remains to be dimmed');
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
    await waitForChipCount(2);

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

  // oculist-l6m.12: showNotice() used to gate on a single session-wide noticeDismissed
  // flag, so dismissing ANY notice — including the unrelated site-override notice below —
  // silenced every later notice for the rest of the session, including the 10-term cap.
  // Dismissal is now keyed per notice class, so the two must not interfere.
  test('dismissing a site-override notice does not suppress a later term-cap notice', async () => {
    // A draft search (no Enter, so no chip/slot is consumed) for a term absent from the
    // page trips checkSiteOverride()'s zero-matches branch — PAGE's FILLER text pushes
    // body length well past its >500-char threshold — raising the 'site-override' notice.
    await page.locator(INPUT).fill('nonexistentxyzzyterm');
    await page.waitForSelector(NOTICE_TEXT, { timeout: 5000 });
    assert.match(await page.locator(NOTICE_TEXT).textContent(), /No matches found/);

    await page.locator(NOTICE_CLOSE).click();
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      return !root || !root.shadowRoot.querySelector('.oc-notice');
    }, null, { timeout: 5000 });
    assert.strictEqual(await page.locator(NOTICE).count(), 0, 'the site-override notice must actually dismiss');

    await emptyInputByBackspace();

    for (let i = 1; i <= 10; i++) {
      await addTerm('capterm' + i);
    }
    assert.strictEqual((await chipTerms()).length, 10);

    // 'quarklet' exists on the page, so this Enter also runs checkSiteOverride() again —
    // exactly the erasure/race path the 10-term cap test above exercises.
    await addTerm('quarklet');
    assert.strictEqual((await chipTerms()).length, 10, 'the 11th term must still be refused');

    await page.waitForSelector(NOTICE, { timeout: 5000 }).catch(() => {});
    assert.strictEqual(
      await page.locator(NOTICE).count(),
      1,
      'the term-cap notice must still surface after an unrelated site-override notice was dismissed'
    );
    assert.strictEqual(
      await page.locator(NOTICE_TEXT).textContent(),
      'Oculist searches up to 10 terms at once. Remove a term to add another.'
    );
  });

  // Guard against over-correcting oculist-l6m.12: per-class keying must not simply disable
  // dismissal altogether — dismissing a term-cap notice must still suppress a later,
  // identical term-cap hit for the rest of the session.
  test('dismissing a term-cap notice suppresses a subsequent identical term-cap notice', async () => {
    for (let i = 1; i <= 10; i++) {
      await addTerm('capterm' + i);
    }
    assert.strictEqual((await chipTerms()).length, 10);

    await addTerm('quarklet');
    assert.strictEqual((await chipTerms()).length, 10);
    assert.strictEqual(
      await page.locator(NOTICE_TEXT).textContent(),
      'Oculist searches up to 10 terms at once. Remove a term to add another.'
    );

    await page.locator(NOTICE_CLOSE).click();
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      return !root || !root.shadowRoot.querySelector('.oc-notice');
    }, null, { timeout: 5000 });
    assert.strictEqual(await page.locator(NOTICE).count(), 0, 'the term-cap notice must actually dismiss');

    // Not addTerm(): this Enter is expected to produce genuinely NO observable DOM change
    // — the cap rejects it (chip row untouched) and showNotice() itself no-ops silently
    // for an already-dismissed notice key (that's exactly what this test is proving), so
    // there is nothing to poll for. addChipTerm() has no awaits/timers of its own — the
    // whole keydown handler runs synchronously — so by the time press('Enter') resolves,
    // that (non-)effect has already fully landed; no wait is needed either way.
    await page.locator(INPUT).fill('quarklet');
    await page.keyboard.press('Enter');
    assert.strictEqual((await chipTerms()).length, 10, 'still refused past the cap');
    assert.strictEqual(
      await page.locator(NOTICE).count(),
      0,
      'a dismissed term-cap notice must stay suppressed for a later identical cap hit'
    );
  });

  test('restoring a saved working list on mount renders chips without running a scan', async () => {
    // beforeEach leaves the overlay open (it needs it open to clear session storage
    // through the content script's isolated world) — close it first, otherwise the
    // upcoming Ctrl+F below just refocuses the existing bar instead of remounting it,
    // and loadWorkList() only ever runs from buildUI() on mount.
    await page.keyboard.press('Escape');
    await page.waitForFunction(CLOSED, null, { timeout: 5000 });

    // Seed chrome.storage.session directly (bypassing any in-page UI) with terms that do
    // not exist anywhere on the page — if a scan ran against them, both the count and a
    // "no matches" notice would give it away.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.set(" +
        "{ 'oc-worklist': { terms: ['gamma', 'delta'], activeIndex: 1 } }, resolve))"
    );

    await openFinder();
    // loadWorkList() (chrome.storage.session.get) resolves asynchronously after open —
    // poll for the chip row to actually reflect the restored list, rather than guessing
    // how long that round trip takes.
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      const chips = root && root.shadowRoot
        ? Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')).map((el) => el.textContent)
        : [];
      return JSON.stringify(chips) === JSON.stringify(['gamma', 'delta']);
    }, null, { timeout: 5000 });

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
