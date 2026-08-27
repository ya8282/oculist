// List menu popover UI (oculist-l6m.9): the overlay surface for saved term lists, built
// on top of the storage CRUD from oculist-l6m.8 (listSavedLists/saveList/renameList/
// deleteList). This bead is UI only — every assertion here goes through real clicks,
// fills, and keypresses against the popover's DOM, never through a window.__oc* hook
// (those six exist purely for the storage layer's own tests to reach an isolated JS
// world; the list-menu UI itself has no test hook of its own and none should be added).
//
// Needs a real browser for the same reasons as chip_row.test.js and list_storage.test.js:
// real layout for the popover, and chrome.storage.sync/session round trips that only work
// with the real extension loaded. CDP is used here only for out-of-band setup/teardown
// (clearing saved lists and the working list between tests) — never to reach into
// content.js's closure state or to drive the test's actual assertions.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const CLOSED = () => !document.getElementById('oc-wrap');

const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

const INPUT = '#oc-wrap >> .oc-input';
const COUNT = '#oc-wrap >> .oc-count';
const PREV_BTN = '#oc-wrap >> .oc-up-btn';
const NEXT_BTN = '#oc-wrap >> .oc-down-btn';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';
const CHIP_COUNT = '#oc-wrap >> .oc-chip-count';
const CHIP_REMOVE = '#oc-wrap >> .oc-chip-remove';

const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';

const LISTS_BTN = '#oc-wrap >> button[title="Saved Lists"]';
const LISTS_PANEL = '#oc-wrap >> #oc-lists-panel';
const SAVE_INPUT = '#oc-wrap >> .oc-list-save-input';
const SAVE_BTN = '#oc-wrap >> .oc-list-save-btn';
const LIST_ITEM_NAME = '#oc-wrap >> .oc-list-item-name';
const LIST_ITEM_COUNT = '#oc-wrap >> .oc-list-item-count';
const LIST_RENAME_BTN = '#oc-wrap >> .oc-list-rename-btn';
const LIST_DELETE_BTN = '#oc-wrap >> .oc-list-delete-btn';
const LIST_RENAME_INPUT = '#oc-wrap >> .oc-list-rename-input';
const LIST_RENAME_CONFIRM = '#oc-wrap >> .oc-list-rename-confirm';
const LIST_EMPTY = '#oc-wrap >> .oc-list-empty';
const NOTICE = '#oc-wrap >> .oc-notice';

describe('List menu popover (saved lists UI)', () => {
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

  function clearSavedLists() {
    return evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.get(null, (data) => {" +
      "  var keys = Object.keys(data || {}).filter((k) => k.indexOf('oc-list-') === 0);" +
      "  if (keys.length === 0) { resolve(); return; }" +
      "  chrome.storage.sync.remove(keys, resolve);" +
      "}))"
    );
  }

  function clearWorkList() {
    return evalInContentScript("new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))");
  }

  // Reads every oc-list-* entry directly out of chrome.storage.sync, bypassing the
  // popover UI entirely — used to confirm a rename/delete genuinely persisted, rather
  // than trusting the popover's own re-render (which an optimistic-UI-only bug could
  // satisfy without ever writing anything to storage).
  function rawSavedLists() {
    return evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.get(null, (data) => {" +
      "  var out = Object.keys(data || {}).filter((k) => k.indexOf('oc-list-') === 0).map((k) => data[k]);" +
      "  resolve(out);" +
      "}))"
    );
  }

  // Every test starts from a closed overlay, an empty working list, and no saved lists,
  // so nothing leaks between tests. A previous test can end with either the popover or
  // the whole overlay left open (Escape only closes one level at a time — see the last
  // test in this file) — press it twice, unconditionally, so this always reaches fully
  // closed regardless of which state the previous test left behind; a second Escape
  // against an already-closed overlay is a documented no-op elsewhere in this file.
  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
    await clearSavedLists();
    await clearWorkList();
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

  // Reads a real CSS Custom Highlight registry via the content script's own isolated
  // world (same approach chip_row.test.js uses for its oculist-l6m.33 coverage) — used
  // below to confirm no highlight survives from either the draft or the pre-load working
  // list once a load has won the race.
  function highlightCount(registryName) {
    return evalInContentScript(`
      (function () {
        var h = CSS.highlights.get('${registryName}');
        return h ? Array.from(h).length : 0;
      })()
    `);
  }

  async function openListsMenu() {
    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { timeout: POLL_TIMEOUT });
  }

  function waitForListsPanelClosed(opts) {
    return page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        return !root || !root.shadowRoot.querySelector('#oc-lists-panel');
      },
      null,
      { timeout: POLL_TIMEOUT, ...opts }
    );
  }

  // Polls .oc-list-item-name's rendered text list until it exactly matches `expected`.
  function waitForListItemNames(expected, opts) {
    return page.waitForFunction(
      (exp) => {
        const root = document.getElementById('oc-wrap');
        const names = root
          ? Array.from(root.shadowRoot.querySelectorAll('.oc-list-item-name')).map((el) => el.textContent)
          : [];
        return JSON.stringify(names) === JSON.stringify(exp);
      },
      expected,
      { timeout: POLL_TIMEOUT, ...opts }
    );
  }

  async function saveCurrentAs(name) {
    await page.locator(SAVE_INPUT).fill(name);
    await page.locator(SAVE_BTN).click();
    // Wait for the real condition every call site immediately asserts on: the new item
    // actually landing in the popover's own re-render.
    await page.waitForFunction(
      (expectedName) => {
        const root = document.getElementById('oc-wrap');
        const items = root ? Array.from(root.shadowRoot.querySelectorAll('.oc-list-item-name')) : [];
        return items.some((el) => el.textContent === expectedName);
      },
      name,
      { timeout: POLL_TIMEOUT }
    );
  }

  test('saving the working list and loading it back replaces the working list, with no scan', async () => {
    // Terms deliberately absent from PAGE — if loading a saved list ever ran a scan, a
    // "no matches" notice and non-blank counts would give it away, exactly the same tell
    // chip_row.test.js's own carry-over-on-mount test relies on.
    await addTerm('zzzalpha');
    await addTerm('zzzbeta');
    assert.deepStrictEqual(await chipTerms(), ['zzzalpha', 'zzzbeta']);

    await openListsMenu();
    assert.strictEqual(await page.locator(SAVE_BTN).isDisabled(), true, 'Save starts disabled on an empty name');
    await saveCurrentAs('My List');

    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['My List']);
    assert.strictEqual(await page.locator(SAVE_INPUT).inputValue(), '', 'the save input clears itself after a successful save');
    assert.strictEqual(await page.locator(SAVE_BTN).isDisabled(), true, 'Save goes back to disabled once its input is empty again');

    // Saving never touches the working list.
    assert.deepStrictEqual(await chipTerms(), ['zzzalpha', 'zzzbeta']);

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        return !root || !root.shadowRoot.querySelector('#oc-lists-panel');
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 0, 'popover should be closed');
    assert.strictEqual(await page.locator('#oc-wrap').count(), 1, 'the overlay itself must still be open after the first Escape');

    // Change the working list before loading the saved one back, so the load is the
    // thing that visibly changes it.
    await addTerm('zzzgamma');
    assert.deepStrictEqual(await chipTerms(), ['zzzalpha', 'zzzbeta', 'zzzgamma']);

    await openListsMenu();
    await page.locator(LIST_ITEM_NAME).click();
    // loadSavedList() replaces the chip row and closes the popover synchronously — wait
    // for the load's own real effect instead of guessing its duration.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        if (!root) return false;
        const chips = Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')).map((el) => el.textContent);
        return JSON.stringify(chips) === JSON.stringify(['zzzalpha', 'zzzbeta']);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    // The saved two-term list replaced the three-term working list outright, with no
    // confirmation prompt anywhere in this flow.
    assert.deepStrictEqual(await chipTerms(), ['zzzalpha', 'zzzbeta']);
    assert.strictEqual(await activeChipTerm(), null, 'a freshly loaded list has no active chip yet');
    assert.deepStrictEqual(
      await page.locator(CHIP_COUNT).allTextContents(),
      ['', ''],
      'chip hit counts must stay blank until the user clicks a chip to scan'
    );
    assert.strictEqual(await page.locator(COUNT).textContent(), '', 'the bar count must also stay blank — no scan ran');
    assert.strictEqual(await page.locator(PREV_BTN).isDisabled(), true);
    assert.strictEqual(await page.locator(NEXT_BTN).isDisabled(), true);
    assert.strictEqual(await page.locator(INPUT).inputValue(), '', 'the find input is not touched by a load');
    assert.strictEqual(await page.locator(NOTICE).count(), 0, 'loading a list must never raise a "no matches" notice');
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 0, 'the popover closes itself once a list is loaded');
  });

  // oculist-l6m.29: loadSavedList() used to leave any in-flight input debounce running.
  // Typing a draft and loading a list inside the 150ms window let the debounce fire
  // afterwards with input.value === '' (loadSavedList() itself already force-clears the
  // input), reaching restoreActiveChip() -> performSearch('') with activeTermIndex ===
  // -1. That specific fallback is a true no-op today (an early return before
  // buildPageIndex() and before touching anything loadSavedList() hasn't already reset
  // to the exact same value) — so this test's real signature of the bug is the pending
  // 150ms setTimeout itself firing at all post-load, not any visible state it produces.
  // See this bead's report for why a buildPageIndex()/getComputedStyle counter (the
  // technique list_search.test.js uses to prove "no scan ran") cannot distinguish fixed
  // from unfixed code on this exact race.
  test('loading a saved list mid-debounce cancels the pending debounce instead of letting it fire later', async () => {
    await addTerm('zzzalpha');
    await addTerm('zzzbeta');
    await openListsMenu();
    await saveCurrentAs('Debounce List');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    // A third chip, committed via Enter (never touches the debounce), so the load below
    // has a visibly different pre-load working list to replace — same shape as the
    // preceding "no scan" test's own before/after contrast.
    await addTerm('zzzgamma');
    assert.deepStrictEqual(await chipTerms(), ['zzzalpha', 'zzzbeta', 'zzzgamma']);

    // Open the popover *before* typing the draft below, so the only Playwright action
    // needed inside the 150ms race window is the load click itself — opening the panel
    // here doesn't touch input, lastTerm, or the debounce timer at all.
    await openListsMenu();

    // Monkeypatches window.setTimeout inside the content script's own isolated world
    // (same cross-world trick list_search.test.js's getComputedStyle patch relies on) so
    // every timer scheduled with either input-debounce delay increments __oc150Fires,
    // and only when that callback actually executes — independent of what it does once
    // it runs. Both delays are matched (150ms normally, 400ms under Lite Mode, see
    // content.js's `settings.performanceMode ? 400 : 150`) so that making Lite Mode the
    // default could never leave this test vacuously green with no timer to count. No
    // other timer in content.js uses either delay; the mutation-observer, scroll,
    // viewport-marker and beacon timers all use different ones.
    await evalInContentScript(`
      (function () {
        if (window.__ocSTInstalled) return true;
        window.__ocSTInstalled = true;
        window.__oc150Fires = 0;
        var orig = window.setTimeout;
        window.setTimeout = function (fn, delay) {
          if (delay === 150 || delay === 400) {
            var wrapped = function () {
              window.__oc150Fires++;
              return fn.apply(this, arguments);
            };
            var args = [wrapped, delay].concat(Array.prototype.slice.call(arguments, 2));
            return orig.apply(window, args);
          }
          return orig.apply(window, arguments);
        };
        return true;
      })()
    `);

    const before150 = await evalInContentScript('window.__oc150Fires');

    // Type a draft (never committed — a synthetic 'input' event, same trigger .fill()
    // uses per chip_row.test.js's own note) and immediately click to load the saved list,
    // both within a single page.evaluate() round trip. This is the exact race the bead
    // describes — typing a draft, then loading a list, inside the 150ms debounce window
    // — but done as one round trip (rather than two separate Playwright actions, e.g.
    // .fill() then .click()) because Playwright's own actionability wait on .click() alone
    // measured ~200ms+ in this environment, comfortably past the 150ms window and masking
    // the race entirely; a single synchronous in-page turn keeps the gap at native JS
    // speed, reliably inside the window regardless of test-runner/CDP overhead.
    await page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const draftInput = root.querySelector('.oc-input');
      const item = root.querySelector('.oc-list-item-name');
      draftInput.value = 'strayDraftText';
      draftInput.dispatchEvent(new Event('input', { bubbles: true }));
      item.click();
    });
    await page.waitForTimeout(250); // well past the 150ms the stale debounce would need

    const after150 = await evalInContentScript('window.__oc150Fires');
    assert.strictEqual(
      after150,
      before150,
      'loadSavedList() must clearTimeout() the pending input debounce so it can never fire after a load'
    );

    // The load must win outright: the loaded 2-term list renders, not the 3-term
    // pre-load working list and not the just-typed draft.
    assert.deepStrictEqual(await chipTerms(), ['zzzalpha', 'zzzbeta']);
    assert.strictEqual(await activeChipTerm(), null, 'a freshly loaded list has no active chip yet');
    assert.deepStrictEqual(
      await page.locator(CHIP_COUNT).allTextContents(),
      ['', ''],
      'chip hit counts must stay blank until the user clicks a chip to scan'
    );
    assert.strictEqual(await page.locator(COUNT).textContent(), '', 'no scan ran for either the draft or the loaded list');
    assert.strictEqual(await page.locator(INPUT).inputValue(), '', 'the draft must not survive the load');
    assert.strictEqual(await page.locator(NOTICE).count(), 0, 'loading a list must never raise a "no matches" notice');
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 0, 'the popover closes itself once a list is loaded');

    // Real highlight registries agree with the count text — same defense-in-depth check
    // chip_row.test.js uses for its oculist-l6m.33 coverage.
    assert.strictEqual(await highlightCount('oculist-match'), 0);
    assert.strictEqual(await highlightCount('oculist-dim-match'), 0);
    assert.strictEqual(await highlightCount('oculist-active-match'), 0);
  });

  test('rename and delete work through the popover', async () => {
    await addTerm('roundtrip');
    await openListsMenu();
    await saveCurrentAs('Original Name');
    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['Original Name']);

    await page.locator(LIST_RENAME_BTN).click();
    await page.waitForSelector(LIST_RENAME_INPUT, { timeout: POLL_TIMEOUT });
    await page.locator(LIST_RENAME_INPUT).fill('Renamed List');
    await page.locator(LIST_RENAME_CONFIRM).click();
    await waitForListItemNames(['Renamed List']);
    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['Renamed List']);

    // Confirm the rename genuinely reached chrome.storage.sync — not just an
    // optimistic re-render of the popover's own in-memory copy.
    const rawAfterRename = await rawSavedLists();
    assert.strictEqual(rawAfterRename.length, 1);
    assert.strictEqual(rawAfterRename[0].name, 'Renamed List');

    // A close/reopen of the popover re-fetches from storage via listSavedLists() — the
    // renamed name must survive that fresh read, not just linger in the still-open DOM.
    await page.keyboard.press('Escape');
    await waitForListsPanelClosed();
    await openListsMenu();
    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['Renamed List']);

    await page.locator(LIST_DELETE_BTN).click();
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      return !root || root.shadowRoot.querySelectorAll('.oc-list-item-name').length === 0;
    }, null, { timeout: POLL_TIMEOUT });
    assert.strictEqual(await page.locator(LIST_ITEM_NAME).count(), 0, 'the deleted list must no longer be listed');
    assert.strictEqual(
      (await page.locator(LIST_EMPTY).textContent()).trim(),
      'No saved lists yet.'
    );

    // Confirm the delete genuinely removed the oc-list-<id> key.
    const rawAfterDelete = await rawSavedLists();
    assert.strictEqual(rawAfterDelete.length, 0);
  });

  test('a blank or whitespace-only name keeps Save/Rename disabled instead of silently doing nothing', async () => {
    await addTerm('blanktest');
    await openListsMenu();

    // Untouched (empty) input.
    assert.strictEqual(await page.locator(SAVE_BTN).isDisabled(), true);

    // Whitespace-only is treated the same as empty — the control stays disabled, so a
    // click (a native no-op on a disabled button) can never reach saveList()'s silent
    // {ok:false, reason:'empty-name'} rejection.
    await page.locator(SAVE_INPUT).fill('   ');
    assert.strictEqual(await page.locator(SAVE_BTN).isDisabled(), true);
    // Nothing was actually saved by that whitespace-only attempt.
    assert.strictEqual(await page.locator(LIST_ITEM_NAME).count(), 0);

    // Real text re-enables it, proving the control is genuinely reactive rather than
    // permanently stuck disabled.
    await page.locator(SAVE_INPUT).fill('Real Name');
    assert.strictEqual(await page.locator(SAVE_BTN).isDisabled(), false);
    await page.locator(SAVE_BTN).click();
    await waitForListItemNames(['Real Name']);
    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['Real Name']);

    // The identical guard on the rename control.
    await page.locator(LIST_RENAME_BTN).click();
    await page.waitForSelector(LIST_RENAME_INPUT, { timeout: POLL_TIMEOUT });
    await page.locator(LIST_RENAME_INPUT).fill('   ');
    assert.strictEqual(await page.locator(LIST_RENAME_CONFIRM).isDisabled(), true);
    // The rename never went through — the list still shows its original saved name once
    // the popover round-trips.
    await page.locator(LIST_RENAME_INPUT).fill('Real Name');
    await page.keyboard.press('Escape');
    await waitForListsPanelClosed();
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 0, 'Escape must still close the popover from inside the rename field');
  });

  // oculist-l6m.26: saveList() silently rejects an empty terms array (mirroring
  // 'empty-name'), and the popover's own Save control is the primary, visible guard
  // against ever reaching that silent rejection — the same disabled-control treatment
  // the blank-name case already gets, extended to cover an empty working list too.
  test('the Save control stays disabled while the working list is empty, and re-enables once a term exists', async () => {
    // No addTerm() call — the working list starts and stays at zero chips through this
    // first half of the test.
    await openListsMenu();
    assert.strictEqual(await page.locator(SAVE_BTN).isDisabled(), true, 'Save starts disabled with no name and no chips');

    await page.locator(SAVE_INPUT).fill('Empty List');
    // A non-blank name alone must not be enough — Save must stay disabled because the
    // working list itself has zero terms.
    assert.strictEqual(
      await page.locator(SAVE_BTN).isDisabled(),
      true,
      'Save must stay disabled while the working list has zero chips, even with a name typed'
    );

    // oculist-l6m.26 fix-pass regression: add a chip via the main bar WITHOUT closing the
    // popover. Before the fix, renderChipRow() never notified the still-open popover of a
    // main-bar chip edit, so Save stayed disabled even once the working list and name were
    // both populated — recoverable only by retyping the name or closing/reopening the
    // popover, and neither is discoverable. The bug is specifically about the live,
    // still-open state, so this must not close/reopen the popover to check.
    await addTerm('populated');
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 1, 'the popover must still be open after a main-bar chip add');
    assert.strictEqual(await page.locator(SAVE_INPUT).inputValue(), 'Empty List', 'the typed name must survive the chip add untouched');
    assert.strictEqual(
      await page.locator(SAVE_BTN).isDisabled(),
      false,
      'Save must live-enable once a chip is added via the main bar, with the popover left open the whole time'
    );

    // Mirror direction: remove that same chip via the main bar, popover still open — Save
    // must live-disable again, with no close/reopen anywhere in this check either.
    await page.locator(CHIP_REMOVE).first().click();
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      const btn = root && root.shadowRoot.querySelector('.oc-list-save-btn');
      return !!btn && btn.disabled === true;
    }, null, { timeout: POLL_TIMEOUT });
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 1, 'the popover must still be open after a main-bar chip removal');

    // Re-add a term, still without closing the popover, so the save round trip below has
    // something to save.
    await addTerm('populated');
    await page.locator(SAVE_INPUT).fill('Populated List');
    assert.strictEqual(
      await page.locator(SAVE_BTN).isDisabled(),
      false,
      'Save must re-enable once the working list has a term and the name is non-blank'
    );
    await page.locator(SAVE_BTN).click();
    // The real condition a fixed sleep would have been guessing at: the saved item
    // actually landing in the popover's own re-render.
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      const el = root && root.shadowRoot.querySelector('.oc-list-item-name');
      return !!el && el.textContent === 'Populated List';
    }, null, { timeout: POLL_TIMEOUT });

    // Saving a populated list still works end to end: it appears in the popover and the
    // write genuinely reached chrome.storage.sync with the working list's real terms.
    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['Populated List']);
    const raw = await rawSavedLists();
    assert.strictEqual(raw.length, 1);
    assert.deepStrictEqual(raw[0].terms, ['populated']);

    // Leave the popover closed, matching every other test in this suite — the shared
    // beforeEach only sends a single Escape, which closes just the popover while it's
    // still open (see the Escape-only-closes-the-popover behaviour covered below), and
    // would otherwise leave this test's 'populated' chip mounted and bleeding into the
    // next test.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      return !root || !root.shadowRoot.querySelector('#oc-lists-panel');
    }, null, { timeout: POLL_TIMEOUT });
  });

  // oculist-l6m.26: a list saved by a version of the extension before this fix (or
  // synced in from another device that still has the old, unguarded saveList()) can
  // already sit in chrome.storage.sync with zero terms. loadSavedList() has no
  // confirmation step by design, so loading one must not be allowed to silently wipe a
  // populated working list with no way back.
  test('a pre-existing saved list with zero terms cannot be loaded, and never wipes the working list', async () => {
    await addTerm('keepme');
    assert.deepStrictEqual(await chipTerms(), ['keepme']);

    // Seeded directly into chrome.storage.sync, bypassing saveList() entirely — this is
    // exactly the shape a pre-fix save (or an old synced-in list) would already have.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.set(" +
      "{'oc-list-zeroterm': { id: 'zeroterm', name: 'Empty Legacy List', terms: [] }}," +
      " resolve))"
    );

    await openListsMenu();
    await page.waitForSelector(LIST_ITEM_NAME, { timeout: POLL_TIMEOUT });
    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['Empty Legacy List']);
    assert.strictEqual(
      await page.locator(LIST_ITEM_NAME).isDisabled(),
      true,
      "a 0-term saved list's load control must be disabled, not clickable into a silent wipe"
    );

    // The working list is untouched — nothing was ever loaded.
    assert.deepStrictEqual(await chipTerms(), ['keepme']);
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 1, 'the popover stays open; no load happened');
  });

  // oculist-l6m.35: a stored list whose terms are all whitespace (e.g. terms: ['   '])
  // is a variant of the same oculist-l6m.26 hazard the test above covers, but one that
  // used to slip past it — buildListItem() gated the load control on the raw,
  // unsanitized terms.length, so a list like this rendered ENABLED and badged "1 term"
  // while loadSavedList() sanitized the whitespace away and hit its own zero-terms
  // early return, a silent no-op click. All three gates (buildListItem, loadSavedList,
  // listSavedLists) must now agree on sanitizeListTerms()'s definition of a real term.
  test('a stored list with only whitespace-only terms badges 0 terms and is disabled, not "1 term" and enabled', async () => {
    // Seeded directly into chrome.storage.sync, bypassing saveList() entirely — this
    // exact shape (terms: ['   ']) is rejected by saveList() itself (oculist-l6m.26), so
    // it can only reach storage via a hand edit or a corrupted sync payload.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.set(" +
      "{'oc-list-wsonly': { id: 'wsonly', name: 'Whitespace Only List', terms: ['   '] }}," +
      " resolve))"
    );

    await openListsMenu();
    await page.waitForSelector(LIST_ITEM_NAME, { timeout: POLL_TIMEOUT });
    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['Whitespace Only List']);
    assert.strictEqual(
      await page.locator(LIST_ITEM_COUNT).textContent(),
      '0 terms',
      'the badge must show the SANITIZED count, not the raw stored array length ("1 term")'
    );
    assert.strictEqual(
      await page.locator(LIST_ITEM_NAME).isDisabled(),
      true,
      "a whitespace-only saved list's load control must be disabled, matching its 0-term badge"
    );
  });

  test('clicking the disabled control on an all-whitespace saved list does nothing, does not throw, and does not mutate the stored entry', async () => {
    await addTerm('keepme');
    assert.deepStrictEqual(await chipTerms(), ['keepme']);

    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.set(" +
      "{'oc-list-wsonly': { id: 'wsonly', name: 'Whitespace Only List', terms: ['   '] }}," +
      " resolve))"
    );

    await openListsMenu();
    await page.waitForSelector(LIST_ITEM_NAME, { timeout: POLL_TIMEOUT });
    assert.strictEqual(await page.locator(LIST_ITEM_NAME).isDisabled(), true);

    // A disabled <button> suppresses its own click event natively; force:true performs a
    // real click at the element regardless, so this actually exercises "does nothing"
    // rather than just asserting the disabled attribute. Must not throw. No wait needed
    // here: a disabled native <button> never dispatches 'click' to its listener at all —
    // there is no async effect in flight to wait out, unlike the dedicated mid-debounce
    // test above.
    await page.locator(LIST_ITEM_NAME).click({ force: true });

    // Nothing loaded: the working list is untouched and the popover stayed open.
    assert.deepStrictEqual(await chipTerms(), ['keepme']);
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 1, 'the popover stays open; no load happened');

    // Rendering (and the no-op click) must not have rewritten the corrupted entry —
    // this stays a read-time-only fix, never a "repair" that mutates stored data.
    const raw = await rawSavedLists();
    assert.strictEqual(raw.length, 1);
    assert.deepStrictEqual(raw[0], { id: 'wsonly', name: 'Whitespace Only List', terms: ['   '] });
  });

  // Companion to the all-whitespace case above: a mix of real and whitespace-only terms
  // must badge and gate on the sanitized count (2), and loading it must load exactly the
  // real terms in order, with the whitespace-only entry silently dropped.
  test('a stored list with a mix of real and whitespace-only terms badges and loads only the real terms', async () => {
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.set(" +
      "{'oc-list-mixed': { id: 'mixed', name: 'Mixed List', terms: ['cat', '   ', 'dog'] }}," +
      " resolve))"
    );

    await openListsMenu();
    await page.waitForSelector(LIST_ITEM_NAME, { timeout: POLL_TIMEOUT });
    assert.strictEqual(await page.locator(LIST_ITEM_COUNT).textContent(), '2 terms');
    assert.strictEqual(await page.locator(LIST_ITEM_NAME).isDisabled(), false);

    await page.locator(LIST_ITEM_NAME).click();
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      if (!root) return false;
      const chips = Array.from(root.shadowRoot.querySelectorAll('.oc-chip-term')).map((el) => el.textContent);
      return JSON.stringify(chips) === JSON.stringify(['cat', 'dog']);
    }, null, { timeout: POLL_TIMEOUT });

    assert.deepStrictEqual(await chipTerms(), ['cat', 'dog']);

    // The stored entry itself is untouched by the load either.
    const raw = await rawSavedLists();
    assert.strictEqual(raw.length, 1);
    assert.deepStrictEqual(raw[0], { id: 'mixed', name: 'Mixed List', terms: ['cat', '   ', 'dog'] });
  });

  // oculist-dzi: unlike the whitespace-only case above (terms IS an array, just empty
  // after sanitizing), this entry's terms field isn't an array at all — the shape
  // Array.isArray(entry.terms) used to reject outright, dropping the whole entry and
  // leaving it invisible yet still counted toward the 50-list cap. It must now render
  // using the same disabled/badged-0 treatment, and — the actual point of making it
  // visible — delete must still work on it and the removal must persist in storage.
  test('an identifiable saved list with malformed (non-array) terms is visible, badged 0 terms, disabled, and genuinely deletable', async () => {
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.set(" +
      "{'oc-list-badterms': { id: 'badterms', name: 'Malformed Terms List', terms: 'nope' }}," +
      " resolve))"
    );

    await openListsMenu();
    await page.waitForSelector(LIST_ITEM_NAME, { timeout: POLL_TIMEOUT });
    assert.deepStrictEqual(await page.locator(LIST_ITEM_NAME).allTextContents(), ['Malformed Terms List']);
    assert.strictEqual(await page.locator(LIST_ITEM_COUNT).textContent(), '0 terms');
    assert.strictEqual(
      await page.locator(LIST_ITEM_NAME).isDisabled(),
      true,
      'malformed terms must not be loadable any more than a legitimately empty list is'
    );

    await page.locator(LIST_DELETE_BTN).click();
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      return !root || root.shadowRoot.querySelectorAll('.oc-list-item-name').length === 0;
    }, null, { timeout: POLL_TIMEOUT });
    assert.strictEqual(await page.locator(LIST_ITEM_NAME).count(), 0, 'the deleted malformed list must no longer be listed');
    assert.strictEqual(
      (await page.locator(LIST_EMPTY).textContent()).trim(),
      'No saved lists yet.'
    );

    // The delete genuinely reached storage — the malformed key itself is gone, not
    // just hidden by the popover's own re-render.
    const rawAfterDelete = await rawSavedLists();
    assert.strictEqual(rawAfterDelete.length, 0);
  });

  test('opening the list popover closes an open settings panel and the reverse; Escape closes only the popover', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });

    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { timeout: POLL_TIMEOUT });
    assert.strictEqual(await page.locator(SETTINGS_PANEL).count(), 0, 'opening the list popover must close settings');

    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 0, 'opening settings must close the list popover');

    // Close settings, reopen the list popover, and confirm the first Escape closes only it.
    await page.locator(GEAR_BTN).click();
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      return !root || !root.shadowRoot.querySelector('#oc-settings-panel');
    }, null, { timeout: POLL_TIMEOUT });
    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { timeout: POLL_TIMEOUT });

    await page.keyboard.press('Escape');
    await waitForListsPanelClosed();
    assert.strictEqual(await page.locator(LISTS_PANEL).count(), 0, 'the first Escape should close only the popover');
    assert.strictEqual(await page.locator('#oc-wrap').count(), 1, 'the overlay itself must still be open');

    await page.keyboard.press('Escape');
    await page.waitForFunction(CLOSED, null, { timeout: POLL_TIMEOUT });
    assert.strictEqual(await page.locator('#oc-wrap').count(), 0, 'the second Escape should close the whole overlay as before');
  });
});
