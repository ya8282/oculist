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
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');

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

  // Arm a probe listener inside the content script's own isolated world *before* writing
  // a settings change: chrome.storage.onChanged fires every listener registered against
  // that same document for the same event, in registration order — content.js's own
  // listener was registered at page load, long before this probe, so observing OUR
  // listener fire is a direct proxy for content.js's own listener (and its synchronous
  // injectHighlightStyles() re-render, which is what actually updates --oc-chip-scale)
  // having already run. Mirrors dispersion_bloom.test.js's own helper of the same name.
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

  async function waitForSettingsEcho(before) {
    return waitForContentScriptValue(evalInContentScript, 'window.__ocSettingsEchoes', (v) => v > before, {
      timeout: POLL_TIMEOUT,
      message: 'oc-settings change never echoed into the content script',
    });
  }

  // Merges `patch` into the nested visionSettings object via chrome.storage.sync.set —
  // the same underlying write the popup/in-page settings panel makes — and waits for
  // content.js's own onChanged listener to actually apply it.
  async function setVisionSettings(patch) {
    const echoBefore = await armSettingsEcho();
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var vs = Object.assign({}, current.visionSettings || {}, ' + JSON.stringify(patch) + ');' +
        'var next = Object.assign({}, current, { visionSettings: vs });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
    await waitForSettingsEcho(echoBefore);
  }

  // Every test starts from a closed overlay and an empty working list, so chips never
  // leak from one test into the next.
  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
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
      { timeout: POLL_TIMEOUT, ...opts }
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
    // deliberately-rejected term. Scoped to the two cap notice keys ('term-cap' for the
    // 10-term cap, 'term-length' for the 100-char cap) so a stray notice left over from an
    // earlier step (e.g. site-override, list-write-failed) can't satisfy this poll.
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
        return !!(root && root.shadowRoot && root.shadowRoot.querySelector(
          '.oc-notice[data-oc-notice="term-cap"], .oc-notice[data-oc-notice="term-length"]'
        ));
      },
      { expected: before + 1, term },
      { timeout: POLL_TIMEOUT }
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
        // Re-checked by identity (not just gated behind __ocDebounceFiresInstalled) so
        // this survives being installed for the first time while armDebounceBlocker() is
        // already armed underneath it: disarmDebounceBlocker() restores window.setTimeout
        // to whatever it captured at arm time, which — if that happened before this
        // counter ever installed — would silently strip the counter's wrapper forever on
        // a once-only install. Comparing window.setTimeout against the saved wrapper
        // reference detects that and reinstalls, wrapping whatever setTimeout currently
        // is, instead of relying on today's incidental test order to keep it safe.
        if (!window.__ocDebounceFiresInstalled || window.setTimeout !== window.__ocDebounceFireCounterFn) {
          window.__ocDebounceFiresInstalled = true;
          window.__ocDebounceFires = window.__ocDebounceFires || 0;
          var orig = window.setTimeout;
          var counterFn = function (fn, delay) {
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
          window.__ocDebounceFireCounterFn = counterFn;
          window.setTimeout = counterFn;
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
      timeout: POLL_TIMEOUT,
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

  // Deterministically proves the state right after removeChipAt() rather than racing the
  // real 150ms/400ms debounce (a sub-debounce-window transient is inherently racy to catch
  // via a screenshot/UI poll): swallows the setTimeout call the input's debounce handler
  // makes (matched the same way armDebounceFireCounter() above matches it) so the callback
  // that setTimeout schedules can never actually run while this is armed — the debounce it
  // scheduled stays genuinely, unconditionally "pending" for as long as the test needs it
  // to, with no dependency on how fast the test itself runs. Always paired with
  // disarmDebounceBlocker() in a finally: this page (and its content-script world) is
  // reused across the whole describe block, not reloaded per test, so a stuck patch would
  // otherwise break every later debounce-dependent test in this file (e.g.
  // emptyInputByBackspace(), which needs the real timer to fire).
  async function armDebounceBlocker() {
    return evalInContentScript(`
      (function () {
        if (window.__ocDebounceBlockerRestore) window.__ocDebounceBlockerRestore();
        var orig = window.setTimeout;
        window.__ocDebounceBlockerRestore = function () {
          window.setTimeout = orig;
          window.__ocDebounceBlockerRestore = null;
        };
        window.setTimeout = function (fn, delay) {
          if (delay === 150 || delay === 400) {
            // Swallowed: never scheduled, so it can never fire while armed. Returns a
            // truthy fake id (real setTimeout never returns 0) so content.js's own
            // \`if (debounceTimer)\` truthy checks behave exactly as they would for a
            // real, still-pending timer.
            window.__ocDebounceBlockerNextId = (window.__ocDebounceBlockerNextId || 0) + 1;
            return window.__ocDebounceBlockerNextId;
          }
          return orig.apply(window, arguments);
        };
        return true;
      })()
    `);
  }

  async function disarmDebounceBlocker() {
    return evalInContentScript(`
      (function () {
        if (window.__ocDebounceBlockerRestore) window.__ocDebounceBlockerRestore();
        return true;
      })()
    `);
  }

  // oculist-bxm: removeChipAt()'s empty-worklist guard only synced lastTerm to the input
  // when the input was itself empty. When the input instead held a non-empty draft with a
  // debounce still in flight (e.g. the user removed the only chip via the X button while
  // typing something else), lastTerm was left pointing at the just-removed chip's term, so
  // performListSearch()'s implicit-lastTerm fallback re-scanned that removed term — briefly
  // showing its stale count/highlights until the pending debounce fired ~150ms/400ms later
  // and self-corrected. The fix syncs lastTerm to the current draft in that case too, so the
  // implicit scan targets what the user is actually typing from the very first tick.
  //
  // Asserts on the count text and the real oculist-match registry — the actual observable
  // symptom the bug report describes ("briefly shows the removed term's count and
  // highlights") — rather than the internal lastTerm variable, which would need a
  // dedicated test-only hook to reach. zenithquokka (3 matches) and brindlefalcon (2
  // matches) are deliberately distinct so a stale-vs-fresh scan is unambiguous from the
  // count/highlight numbers alone.
  test('X-button removal of the only chip shows the draft\'s own count and highlights, not the removed chip\'s', async () => {
    await addTerm('zenithquokka');
    assert.deepStrictEqual(await chipTerms(), ['zenithquokka']);
    assert.strictEqual(await highlightCount('oculist-match'), 3, 'sanity check: zenithquokka must have 3 real matches before removal');

    await armDebounceBlocker();
    try {
      await page.locator(INPUT).fill('brindlefalcon');
      assert.strictEqual(await page.locator(INPUT).inputValue(), 'brindlefalcon');

      // A debounce was scheduled by the fill()'s 'input' event; the blocker above
      // guarantees it is still pending (never fired) at the moment this click's
      // synchronous removeChipAt() runs — so whatever the count/highlights show right
      // after this click came from removeChipAt()'s own synchronous performListSearch()
      // call, not from the draft's live debounced search catching up afterward.
      await page.locator(CHIP_REMOVE).first().click();
      await waitForChipCount(0);

      const count = await page.locator(COUNT).textContent();
      assert.match(
        count,
        /of 2$/,
        `count must reflect the draft brindlefalcon's 2 matches, not the removed zenithquokka chip's 3, got "${count}"`
      );
      assert.strictEqual(
        await highlightCount('oculist-match'),
        2,
        'oculist-match must hold exactly brindlefalcon\'s 2 ranges, not the removed zenithquokka chip\'s 3'
      );
    } finally {
      await disarmDebounceBlocker();
    }
  });

  // Companion to the test above: the existing empty-input path (removeChipAt() reached
  // with the input already empty, e.g. after backspacing through the chip's own leftover
  // text) must keep working exactly as before — lastTerm forced to '' and the pending
  // debounce actually cancelled, not merely left to expire on its own.
  test('X-button removal of the only chip with an empty input clears lastTerm and cancels the pending debounce', async () => {
    await addTerm('zenithquokka');
    assert.deepStrictEqual(await chipTerms(), ['zenithquokka']);

    await armDebounceBlocker();
    try {
      await page.locator(INPUT).focus();
      const value = await page.locator(INPUT).inputValue();
      for (let i = 0; i < value.length; i++) {
        await page.keyboard.press('Backspace');
      }
      assert.strictEqual(await page.locator(INPUT).inputValue(), '');

      // The final Backspace's own 'input' event scheduled another debounce (delay 150);
      // the blocker keeps it genuinely pending, unfired, when the X-button click below
      // runs removeChipAt() synchronously.
      await page.locator(CHIP_REMOVE).first().click();
      await waitForChipCount(0);

      // lastTerm cleared is observed via the count text: performListSearch()'s
      // no-terms/no-lastTerm early return is the only path that leaves it truly blank
      // (rather than an implicit re-scan of the just-removed term).
      assert.strictEqual(await page.locator(COUNT).textContent(), '', 'count text must return to the true empty state');
      assert.strictEqual(
        await evalInContentScript('window.__ocTest.getDebounceTimer()'),
        null,
        'the pending debounce must be cancelled, not left to fire later against stale closures'
      );
    } finally {
      await disarmDebounceBlocker();
    }
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
    await page.waitForSelector(NOTICE_TEXT, { timeout: POLL_TIMEOUT });
    assert.match(await page.locator(NOTICE_TEXT).textContent(), /No matches found/);

    await page.locator(NOTICE_CLOSE).click();
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      return !root || !root.shadowRoot.querySelector('.oc-notice');
    }, null, { timeout: POLL_TIMEOUT });
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

    await page.waitForSelector(NOTICE, { timeout: POLL_TIMEOUT }).catch(() => {});
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
    }, null, { timeout: POLL_TIMEOUT });
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
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });

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
    }, null, { timeout: POLL_TIMEOUT });

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

  // oculist-l6m.11: chip text size derives from --oc-chip-scale, which reuses
  // getBeaconScale() (the vision-profile beacon size knob, range 0.7-2.25) rather than a
  // dedicated UI-text scale. Left unclamped, an xl beacon would render 27px chip text and
  // an s beacon 8.4px — both absurd for a chip label. getChipScale() clamps that shared
  // knob into a legible [1, 1.5] band for chips specifically (s/m -> 1.0, l/xl -> 1.5),
  // while genuine beacon sizing (every other getBeaconScale() call site) keeps its full
  // range untouched. Reads the COMPUTED font-size (not the --oc-chip-scale variable text)
  // so a regression in the CSS calc() itself, not just the JS clamp, would also be caught.
  test('chip text renders at a sensible, clamped size across all four beacon sizes', async () => {
    await addTerm('scaletest');

    const EXPECTED = { s: '12px', m: '12px', l: '18px', xl: '18px' };
    try {
      for (const size of ['s', 'm', 'l', 'xl']) {
        await setVisionSettings({ beaconSize: size });
        const fontSize = await page.locator(CHIP_TERM).first().evaluate((el) => getComputedStyle(el).fontSize);
        assert.strictEqual(
          fontSize,
          EXPECTED[size],
          `beaconSize="${size}" should render chip text at ${EXPECTED[size]}, got ${fontSize}`
        );
      }
    } finally {
      // Restore the default so no later test in this file inherits a non-default beacon
      // size (this file never otherwise touches visionSettings, so the browser context's
      // persisted 'oc-settings' would otherwise leak this value into subsequent tests).
      await setVisionSettings({ beaconSize: 'm' });
    }
  });
});
