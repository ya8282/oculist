// Regression for oculist-dvt.5: the effect picker (makeRadioList, content.js) renders one
// row per effectsRegistry entry with no cap. The registry grew from 9 to 13 entries across
// the oculist-dvt epic (speedlines/chrono/lightcycle/cybervision added), and with no scroll
// container anywhere on #oc-radio-list or the settings panel itself, the picker's own
// height simply tracked registry size. A real-browser investigation (not a CSS read) found
// this genuinely regressed the picker specifically: at 1280x800 the list still fit before
// this fix, but the trend clearly did not scale — a 14th/15th effect would eventually push
// rows below the fold, at the shortest positions/viewports first, with no way to reach them
// (the whole overlay host is `position: fixed` with `overflow: hidden` on itself but no
// scrollable ancestor above the list, so content past the fold on a `position: fixed`
// element is not recoverable by page scroll at all).
//
// The fix (content.js, .oc-radio-list CSS): max-height + overflow-y: auto on the effect
// list only, mirroring the existing #oc-lists-panel idiom elsewhere in the same file. That
// decouples the picker's height from effectsRegistry size going forward — this file pins
// that at the *current* full registry length (13) so a future 14th entry cannot silently
// regress picker reachability again. It deliberately does not assert every other field in
// the settings panel fits every viewport height — the whole-panel-doesn't-fit-a-600px
// -viewport condition predates this epic (verified against the pre-epic 9-effect registry
// during investigation: it already overflowed a 600px-tall viewport by ~86px) and is a
// separate, out-of-scope, whole-panel-scrolling problem this bead does not take on.
//
// Needs a real browser for the same reasons as settings_panel_rebuild_focus.test.js and
// overlay_panel_focus_aria.test.js: real layout, a real shadow root, real
// scrollIntoView/overflow behaviour, and real native button keyboard-activation — jsdom
// gives none of that.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT, TIMEOUT_SCALE } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const THEME_LIGHT_BTN = '#oc-wrap >> [data-oc-key="theme:light"]';

// The registry as of oculist-dvt (content.js:685-698). Compared as a Set against the live
// DOM's data-oc-key values below, so this pins membership/count, not row order (order is
// alphabetical-by-label and derived from the live DOM, not assumed here).
const EXPECTED_EFFECT_KEYS = [
  'hud', 'iris', 'sweep', 'flame', 'lightning', 'electron', 'arrows',
  'dispersion', 'trail', 'speedlines', 'chrono', 'lightcycle', 'cybervision',
];

describe('Settings panel effect picker at 13 registry entries (oculist-dvt.5)', () => {
  let server, ctx, page;

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

  async function waitForActiveElement(cssSelector, timeoutMs) {
    await page.waitForFunction(
      (sel) => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        if (!root) return false;
        const el = root.querySelector(sel);
        return !!el && root.activeElement === el;
      },
      cssSelector,
      { timeout: timeoutMs || POLL_TIMEOUT }
    );
  }

  // No CDP session in this file (same rationale as settings_panel_enter_activation.
  // test.js) — retry Control+f itself until the input actually appears, instead of
  // guessing a fixed boot delay.
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

  async function openSettings() {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
  }

  // Ordered (DOM order = alphabetical-by-label, derived live rather than assumed) list of
  // every effect row's data-oc-key currently rendered.
  async function getEffectRowKeys() {
    return page.evaluate(() => {
      const host = document.getElementById('oc-wrap');
      const root = host.shadowRoot;
      const list = root.querySelector('.oc-radio-list');
      return Array.from(list.querySelectorAll('.oc-radio-item')).map((el) => el.getAttribute('data-oc-key'));
    });
  }

  async function getListAndRowGeometry(key) {
    return page.evaluate((k) => {
      const host = document.getElementById('oc-wrap');
      const root = host.shadowRoot;
      const list = root.querySelector('.oc-radio-list');
      const row = root.querySelector('[data-oc-key="' + k + '"]');
      const listRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        listRect,
        rowRect,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      };
    }, key);
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
    await page.goto(origin);
    await openFinder();
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // Every test starts from a closed overlay, so panel/focus state never leaks between
  // tests.
  beforeEach(async () => {
    // None of this file's tests explicitly close the settings panel before ending (unlike
    // overlay_panel_focus_aria.test.js's Escape-specific tests) — every one of them leaves
    // #oc-wrap mounted with the panel open. A single Escape only closes the panel, not the
    // whole overlay, so gating each retry on the full-budget waitForOverlayClosed() (as the
    // sibling files do) would burn a whole POLL_TIMEOUT on the always-failing first
    // attempt. Poll for overlay-closed with a short per-attempt budget instead — still
    // bounded/no bare timeout literal, just cheap enough to retry through the
    // one-Escape-closes-only-the-panel step quickly.
    for (let attempts = 0; attempts < 5 && (await page.locator('#oc-wrap').count()) > 0; attempts++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page
        .waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: 300 * TIMEOUT_SCALE })
        .catch(() => {});
    }
    await waitForOverlayClosed();
    await openFinder();
  });

  test('all 13 registry entries render as effect rows in the picker', async () => {
    await openSettings();
    const keys = await getEffectRowKeys();
    assert.strictEqual(keys.length, EXPECTED_EFFECT_KEYS.length, 'every effectsRegistry entry must render exactly one row');

    const gotValues = keys.map((k) => k.replace(/^effect:/, '')).sort();
    const expectedValues = EXPECTED_EFFECT_KEYS.slice().sort();
    assert.deepStrictEqual(gotValues, expectedValues, 'the rendered row keys must match the full current registry, no more and no fewer');
  });

  test('the effect list is a bounded scroll container (not simply grown to fit all 13 rows)', async () => {
    await openSettings();
    const keys = await getEffectRowKeys();
    const geo = await getListAndRowGeometry(keys[0]);

    // Self-check: the fix is only meaningful if the list's content genuinely exceeds its
    // visible box — otherwise "every row is reachable" would pass vacuously because nothing
    // needed scrolling in the first place.
    assert.ok(
      geo.scrollHeight > geo.clientHeight + 1,
      `effect list content (scrollHeight=${geo.scrollHeight}) must exceed its visible box (clientHeight=${geo.clientHeight}) at 13 rows — ` +
      'otherwise this test cannot tell a real scroll container from an accidentally-oversized one'
    );
  });

  test('every effect row is reachable — real rendered geometry stays within the list\'s scrollable bounds once scrolled to', async () => {
    await openSettings();
    const keys = await getEffectRowKeys();
    // Row count is asserted once, in the first test, against the live registry — not
    // re-asserted here (oculist-dvt.9): the loop below already iterates however many rows
    // actually exist (keys.length), so a mismatched registry count cannot silently pass
    // this test either way, and a future 14th entry won't produce a duplicate, misleadingly
    // -worded failure here on top of the one honest failure in the first test.

    // Second, independent detector of the dvt.5 .oc-radio-list cap (oculist-dvt.9): the
    // previous test's scrollHeight > clientHeight check is a relative, content-dependent
    // signal; this pins the list's own rendered clientHeight against the CSS's absolute
    // 220px cap on .oc-radio-list (content.js), not the separate, panel-level cap one level
    // up (oculist-6cd, #oc-settings-panel maxheight calc(100vh - 44px)). That distinction
    // matters: with the panel capped, a reverted *list* cap would make the panel itself
    // scroll instead of clip, which could otherwise mask the list-level regression — reading
    // the list's own box (not the panel's) keeps this test sensitive to a list-cap revert
    // specifically, regardless of what the panel does.
    const baseline = await getListAndRowGeometry(keys[0]);
    assert.ok(
      baseline.clientHeight <= 225,
      `effect list clientHeight (${baseline.clientHeight}) must stay pinned near the CSS's 220px cap on ` +
      '.oc-radio-list — a reverted cap would let the list grow to fit all rows instead of scrolling'
    );

    for (const key of keys) {
      // scrollIntoView({block:'nearest'}) only moves the nearest scrollable ancestor
      // (.oc-radio-list, overflow-y: auto) — the fixed-position host above it is not
      // scrollable, so this cannot mask a genuinely off-screen host.
      await page.evaluate((k) => {
        const host = document.getElementById('oc-wrap');
        const root = host.shadowRoot;
        const row = root.querySelector('[data-oc-key="' + k + '"]');
        row.scrollIntoView({ block: 'nearest' });
      }, key);

      const geo = await getListAndRowGeometry(key);
      const EPS = 0.5;
      const withinBounds =
        geo.rowRect.top >= geo.listRect.top - EPS &&
        geo.rowRect.bottom <= geo.listRect.bottom + EPS;

      assert.ok(
        withinBounds,
        `row ${key} must be within the effect list's visible scroll bounds after being scrolled to — ` +
        `row rect ${JSON.stringify(geo.rowRect)}, list rect ${JSON.stringify(geo.listRect)}`
      );
    }
  });

  test('keyboard Tab traversal reaches the last effect row, and the focused row stays within the visible scroll area', async () => {
    await openSettings();
    const keys = await getEffectRowKeys();
    // Row count is asserted once, in the first test, against the live registry — not
    // re-asserted here (oculist-dvt.9); the Tab loop below already runs keys.length times,
    // so it exercises however many rows actually exist rather than an assumed count.

    // Focus the first row directly (a real DOM focus() call, matching the convention used
    // by settings_panel_rebuild_focus.test.js/overlay_panel_focus_aria.test.js for landing
    // focus on a specific control before driving the keyboard from there).
    await page.locator('#oc-wrap >> [data-oc-key="' + keys[0] + '"]').focus();
    await waitForActiveElement('[data-oc-key="' + keys[0] + '"]');

    // Tab through every remaining row in order — each press must land on the next row in
    // DOM order (not skip any, not loop back early), ending on the last one.
    for (let i = 1; i < keys.length; i++) {
      await page.keyboard.press('Tab');
      await waitForCondition(
        () =>
          page.evaluate(() => {
            const host = document.getElementById('oc-wrap');
            const root = host.shadowRoot;
            const active = root.activeElement;
            return active ? active.getAttribute('data-oc-key') : null;
          }),
        (activeKey) => activeKey === keys[i],
        { message: `Tab press #${i} should focus row ${keys[i]}` }
      );
    }

    // Reached the last row — assert its real rendered geometry is actually visible inside
    // the list's scroll bounds, not merely that shadowRoot.activeElement points at it while
    // it sits scrolled out of view.
    const lastKey = keys[keys.length - 1];
    const geo = await getListAndRowGeometry(lastKey);
    const EPS = 0.5;
    const withinBounds =
      geo.rowRect.top >= geo.listRect.top - EPS &&
      geo.rowRect.bottom <= geo.listRect.bottom + EPS;
    assert.ok(
      withinBounds,
      `the focused last row (${lastKey}) must be within the visible scroll area — ` +
      `row rect ${JSON.stringify(geo.rowRect)}, list rect ${JSON.stringify(geo.listRect)}`
    );
  });

  test('an in-place rebuild (theme change) with the full registry keeps the focused effect row reachable', async () => {
    await openSettings();
    const keys = await getEffectRowKeys();
    const lastKey = keys[keys.length - 1];

    // Focus the last effect row before the rebuild — rebuildSettingsPanelPreservingFocus()
    // (content.js) tears the panel down and rebuilds it from scratch in place on any
    // settings change, and must re-resolve this same data-oc-key afterward (oculist-l6m.38).
    // This is the one case the existing rebuild-focus suite does not cover: an *effect* row
    // specifically, inside the now-scrollable list.
    await page.locator('#oc-wrap >> [data-oc-key="' + lastKey + '"]').focus();
    await waitForActiveElement('[data-oc-key="' + lastKey + '"]');

    await page.locator(THEME_LIGHT_BTN).focus();
    await waitForActiveElement('[data-oc-key="theme:light"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        const btn = root && root.querySelector('[data-oc-key="theme:light"]');
        return !!btn && btn.classList.contains('active');
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    // Refocus the same last effect row post-rebuild the way a keyboard user actually would
    // (the theme control itself isn't inside the effect list, so this isn't testing
    // rebuildSettingsPanelPreservingFocus()'s own restore target — it's confirming the
    // *rebuilt* list is still fully reachable after a rebuild, not just on first paint).
    // Compared against keys.length (captured pre-rebuild above), not a hardcoded literal
    // (oculist-dvt.9) — this still catches a rebuild that drops rows, without needing to
    // know or re-assert the registry's current size.
    const keysAfterRebuild = await getEffectRowKeys();
    assert.strictEqual(
      keysAfterRebuild.length,
      keys.length,
      'the rebuilt panel must still render the same number of effect rows as before the rebuild'
    );
    assert.ok(keysAfterRebuild.includes(lastKey), 'the previously-focused row must still exist post-rebuild');

    await page.locator('#oc-wrap >> [data-oc-key="' + lastKey + '"]').focus();
    await waitForActiveElement('[data-oc-key="' + lastKey + '"]');

    const geo = await getListAndRowGeometry(lastKey);
    const EPS = 0.5;
    const withinBounds =
      geo.rowRect.top >= geo.listRect.top - EPS &&
      geo.rowRect.bottom <= geo.listRect.bottom + EPS;
    assert.ok(
      withinBounds,
      `row ${lastKey} must be reachable within the rebuilt list's scroll bounds — ` +
      `row rect ${JSON.stringify(geo.rowRect)}, list rect ${JSON.stringify(geo.listRect)}`
    );
  });
});
