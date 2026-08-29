// Regression for oculist-l6m.28: injectHighlightStyles() resolves the theme once into
// activeTheme (getActiveThemeName(), content.js) — 'system' maps to the live OS
// prefers-color-scheme signal — but three call sites inside that same function compared
// the RAW settings.theme against 'dark' instead of using the already-in-scope
// activeTheme. Under theme 'system' with a dark OS, those three hover/press tints
// rendered the light-mode rgba value instead of the dark one.
//
// All three sites build one CSS string (dialogCss) injected as a single
// <style id="oc-dialog-styles"> inside the shadow root, so reading that one style
// element's textContent and counting occurrences of the light/dark rgba values proves
// all three at once instead of needing three separate probes.
//
// Needs a real browser: JSDOM has no matchMedia emulation, and the theme controls live
// inside a real shadow root built by the actual content script.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const THEME_BTN = (value) => `#oc-wrap >> [data-oc-key="theme:${value}"]`;

// The hover/press tint pair fixed by oculist-l6m.28 — dark-mode value first, light-mode
// (buggy under 'system' + dark OS) second. rgba(255,255,255,0.12) also appears once via
// the pre-existing, already-correct --oc-btn-hover-bg custom property (content.js:4805),
// so a correct fix yields 4 dark occurrences (1 pre-existing + 3 fixed), not 3.
const DARK_HOVER_RGBA = 'rgba(255,255,255,0.12)';
const LIGHT_HOVER_RGBA = 'rgba(0,0,0,0.08)';
// Whichever theme resolves, all 4 sites (the pre-existing --oc-btn-hover-bg custom
// property plus the 3 fixed by oculist-l6m.28) must render that theme's value, and none
// of the 4 may render the other theme's value.
const EXPECTED_MATCHING_COUNT = 4;
const EXPECTED_OPPOSITE_COUNT = 0;

function countOccurrences(text, needle) {
  if (!text) return 0;
  return text.split(needle).length - 1;
}

describe('Theme hover colour follows the resolved theme, not the raw setting (oculist-l6m.28)', () => {
  let server, ctx, page, origin;

  async function readDialogCss() {
    return page.evaluate(() => {
      const host = document.getElementById('oc-wrap');
      const root = host && host.shadowRoot;
      const styleEl = root && root.querySelector('#oc-dialog-styles');
      return styleEl ? styleEl.textContent : null;
    });
  }

  async function clickThemeOption(value) {
    await page.locator(THEME_BTN(value)).click();
    await page.waitForFunction(
      (sel) => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        const btn = root && root.querySelector(sel);
        return !!btn && btn.classList.contains('active');
      },
      `[data-oc-key="theme:${value}"]`,
      { timeout: POLL_TIMEOUT }
    );
  }

  async function waitForDialogCssToContain(needle) {
    await page.waitForFunction(
      (n) => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        const styleEl = root && root.querySelector('#oc-dialog-styles');
        return !!styleEl && styleEl.textContent.indexOf(n) !== -1;
      },
      needle,
      { timeout: POLL_TIMEOUT }
    );
  }

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all. colorScheme:'light' pins a known
    // starting OS preference; individual tests flip it with page.emulateMedia().
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
      colorScheme: 'light',
    });

    page = await ctx.newPage();
    await page.goto(origin);
    await page.waitForLoadState('load');

    // No CDP session in this file, so there is no isolatedContextId to poll for injection
    // readiness — retry Control+f itself (a keypress a not-yet-attached listener would
    // otherwise silently swallow) until the input actually appears, instead of guessing a
    // fixed delay.
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        // Intentional unscaled sub-poll: the scaled waitForSelector below surfaces
        // the real timeout error if all 20 attempts fail.
        await page.waitForSelector(INPUT, { timeout: 250 });
        break;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('system theme with a dark OS renders the dark hover tint, and the OS signal is read live without a reload', async () => {
    // Baseline: theme 'system' with the OS still at the launch-time 'light' preference
    // must render the light values everywhere, confirming the harness itself is sound
    // before flipping anything.
    await clickThemeOption('system');
    const lightBaseline = await readDialogCss();
    assert.strictEqual(
      countOccurrences(lightBaseline, LIGHT_HOVER_RGBA),
      EXPECTED_MATCHING_COUNT,
      'system theme with a light OS should render the light hover tint at all 4 sites'
    );
    assert.strictEqual(countOccurrences(lightBaseline, DARK_HOVER_RGBA), EXPECTED_OPPOSITE_COUNT);

    // Flip the OS preference live, with no reload and no re-selecting the theme radio
    // to some other value first.
    await page.emulateMedia({ colorScheme: 'dark' });

    // Re-clicking the already-active 'system' option re-fires makeOptionGroup's onChange
    // unconditionally (content.js has no same-value guard there), which calls
    // injectHighlightStyles() again — proving getActiveThemeName() re-reads
    // matchMedia('(prefers-color-scheme: dark)') live rather than a value captured once
    // at content-script boot.
    await clickThemeOption('system');
    await waitForDialogCssToContain(DARK_HOVER_RGBA);

    const dialogCss = await readDialogCss();
    assert.strictEqual(
      countOccurrences(dialogCss, DARK_HOVER_RGBA),
      EXPECTED_MATCHING_COUNT,
      `expected the dark hover rgba to appear ${EXPECTED_MATCHING_COUNT} times (1 pre-existing ` +
        `--oc-btn-hover-bg + 3 sites fixed by oculist-l6m.28), got: ${JSON.stringify(dialogCss)}`
    );
    assert.strictEqual(
      countOccurrences(dialogCss, LIGHT_HOVER_RGBA),
      EXPECTED_OPPOSITE_COUNT,
      `the buggy light hover rgba must not appear at all under system theme + dark OS, got: ${JSON.stringify(dialogCss)}`
    );
  });

  test('an explicit theme choice overrides the OS preference in both directions', async () => {
    // OS is still 'dark' from the previous test. An explicit 'light' choice must still
    // render light — the user's explicit choice wins over the OS.
    await clickThemeOption('light');
    await waitForDialogCssToContain(LIGHT_HOVER_RGBA);
    const explicitLightOnDarkOs = await readDialogCss();
    assert.strictEqual(countOccurrences(explicitLightOnDarkOs, LIGHT_HOVER_RGBA), EXPECTED_MATCHING_COUNT);
    assert.strictEqual(countOccurrences(explicitLightOnDarkOs, DARK_HOVER_RGBA), EXPECTED_OPPOSITE_COUNT);

    // Flip the OS the other way and pick an explicit 'dark' theme — must still render
    // dark.
    await page.emulateMedia({ colorScheme: 'light' });
    await clickThemeOption('dark');
    await waitForDialogCssToContain(DARK_HOVER_RGBA);
    const explicitDarkOnLightOs = await readDialogCss();
    assert.strictEqual(countOccurrences(explicitDarkOnLightOs, DARK_HOVER_RGBA), EXPECTED_MATCHING_COUNT);
    assert.strictEqual(countOccurrences(explicitDarkOnLightOs, LIGHT_HOVER_RGBA), EXPECTED_OPPOSITE_COUNT);
  });
});
