// oculist-cvg: content.js's media queries (prefers-color-scheme, prefers-contrast) were
// read live per-call, but nothing re-ran injectHighlightStyles() when the OS setting
// flipped mid-session — the injected CSS stayed on whatever value got baked in at the
// last inject until some unrelated event happened to trigger one.
//
// This file is the "no other user action" case theme_system_dark_os.test.js and
// dim_contrast.test.js don't cover: both of those flip the emulated OS preference BEFORE
// causing a re-inject (a settings click). These flip it AFTER the CSS is already
// injected and assert it updates on its own, with nothing else done in between.
//
// prefers-reduced-motion is deliberately not covered here: injectHighlightStyles() writes
// no CSS that depends on it — motion is a JS-level gate (effectiveMotion(), see the
// comment above it in content.js) consulted fresh on every beacon render, so there is
// nothing for a listener to re-inject, and a re-inject would be a byte-for-byte no-op.
// prefers_reduced_motion.test.js already proves that live read works correctly with no
// extra listener, via the same interaction (Enter) the feature already requires.
//
// Needs a real browser for the same reasons as theme_system_dark_os.test.js /
// dim_contrast.test.js: matchMedia emulation and a real shadow root built by the actual
// content script.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const THEME_BTN = (value) => `#oc-wrap >> [data-oc-key="theme:${value}"]`;

// Same hover-tint pair theme_system_dark_os.test.js (oculist-l6m.28) reads — dark-mode
// value first, light-mode second.
const DARK_HOVER_RGBA = 'rgba(255,255,255,0.12)';
const LIGHT_HOVER_RGBA = 'rgba(0,0,0,0.08)';

function countOccurrences(text, needle) {
  if (!text) return 0;
  return text.split(needle).length - 1;
}

describe('OS-level media query flips refresh the injected CSS with no other user action (oculist-cvg)', () => {
  let server, ctx, page, extId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url === '/dark') {
        // Near-black background, matching dim_contrast.test.js's own '/dark' fixture: the
        // one case where a white matchColor's 35%-alpha wash clears 3:1 contrast without
        // prefers-contrast forcing the underline — needed so the flip has something to
        // visibly change from.
        res.end(
          '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#191919;font:16px/1.6 system-ui,sans-serif;padding:40px;}</style><p>cat cats dog</p>'
        );
      } else {
        res.end('<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all. colorScheme:'light' pins a known
    // starting OS preference; the theme test flips it with page.emulateMedia().
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
      colorScheme: 'light',
    });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
    extId = sw.url().split('/')[2];
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // No CDP session in this file, so there is no isolatedContextId to poll for injection
  // readiness — retry Control+f itself (a keypress a not-yet-attached listener would
  // otherwise silently swallow) until the input actually appears, instead of guessing a
  // fixed delay. Same pattern as theme_system_dark_os.test.js / dim_contrast.test.js.
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

  async function readDialogCss() {
    return page.evaluate(() => {
      const host = document.getElementById('oc-wrap');
      const root = host && host.shadowRoot;
      const styleEl = root && root.querySelector('#oc-dialog-styles');
      return styleEl ? styleEl.textContent : null;
    });
  }

  async function currentGlobalCss() {
    return page.evaluate(() => {
      const el = document.getElementById('oc-global-highlight-styles');
      return el ? el.textContent : null;
    });
  }

  test('an OS colour-scheme flip updates the injected dialog CSS with no click or reload afterward', async () => {
    page = await ctx.newPage();
    await page.goto(origin);
    await page.waitForLoadState('load');
    await openFinder();

    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
    await page.locator(THEME_BTN('system')).click();
    await page.waitForFunction(
      () => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        const btn = root && root.querySelector('[data-oc-key="theme:system"]');
        return !!btn && btn.classList.contains('active');
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    // Baseline: theme 'system' with the launch-time 'light' OS preference.
    const baseline = await readDialogCss();
    assert.ok(
      countOccurrences(baseline, LIGHT_HOVER_RGBA) > 0,
      'baseline (light OS) should render the light hover tint at least once'
    );
    assert.strictEqual(countOccurrences(baseline, DARK_HOVER_RGBA), 0);

    // The flip only — no settings click, no re-selecting the theme radio, no reload.
    await page.emulateMedia({ colorScheme: 'dark' });

    await page.waitForFunction(
      (needle) => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        const styleEl = root && root.querySelector('#oc-dialog-styles');
        return !!styleEl && styleEl.textContent.indexOf(needle) !== -1;
      },
      DARK_HOVER_RGBA,
      { timeout: POLL_TIMEOUT }
    );

    const flipped = await readDialogCss();
    assert.ok(countOccurrences(flipped, DARK_HOVER_RGBA) > 0, 'the dark hover tint must appear after the flip');
    assert.strictEqual(
      countOccurrences(flipped, LIGHT_HOVER_RGBA),
      0,
      'the stale light tint must be fully gone after the flip, with no click in between'
    );
  });

  test('an OS prefers-contrast flip forces the dim wash to the underline treatment with no other action afterward', async () => {
    if (page) await page.close().catch(() => {});
    page = await ctx.newPage();
    await page.goto(origin + 'dark');
    await page.waitForLoadState('load');
    await openFinder();
    await page.locator(INPUT).fill('cat');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    // Set a white custom match colour via the popup — same wiring dim_contrast.test.js's
    // setCustomMatchColor() uses. On this near-black page, a white wash clears 3:1 and
    // stays a wash until something forces the underline.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#configure-drawer');
    await popup.evaluate(() => {
      document.getElementById('configure-drawer').open = true;
    });
    await popup.waitForSelector('#color-palette', { state: 'visible' });
    await popup.selectOption('#vision-profile', 'custom');
    await popup.selectOption('#color-palette', 'custom');
    await popup.evaluate(() => {
      const el = document.getElementById('custom-match-color');
      el.value = '#ffffff';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await popup.waitForFunction(
      () =>
        chrome.storage.sync.get('oc-settings').then((d) => {
          const s = d['oc-settings'];
          return !!(
            s &&
            s.visionSettings &&
            s.visionSettings.customColors &&
            s.visionSettings.customColors.matchColor === '#ffffff'
          );
        }),
      null,
      { timeout: POLL_TIMEOUT }
    );
    await popup.close();
    await page.bringToFront();

    await page.waitForFunction(
      () => /oculist-dim-match[^}]*background-color:\s*rgba/.test(document.getElementById('oc-global-highlight-styles').textContent),
      null,
      { timeout: POLL_TIMEOUT }
    );
    const baseline = await currentGlobalCss();
    assert.match(
      baseline,
      /oculist-dim-match[^}]*background-color:\s*rgba/,
      'baseline (no prefers-contrast) should be the alpha wash, not the underline'
    );
    assert.ok(
      !/oculist-dim-match[^}]*text-decoration-line/.test(baseline),
      'baseline must not already be on the underline treatment — the flip below would prove nothing'
    );

    // The flip only — no popup revisit, no re-picking the colour, no reload.
    await page.emulateMedia({ contrast: 'more' });

    await page.waitForFunction(
      () => /oculist-dim-match[^}]*text-decoration-line/.test(document.getElementById('oc-global-highlight-styles').textContent),
      null,
      { timeout: POLL_TIMEOUT }
    );
    const flipped = await currentGlobalCss();
    assert.match(
      flipped,
      /oculist-dim-match[^}]*text-decoration-line/,
      'prefers-contrast: more must force the underline treatment with no other action after the flip'
    );
    assert.ok(
      !/oculist-dim-match[^}]*background-color:\s*rgba/.test(flipped),
      'the stale wash rule must be fully gone after the flip'
    );
  });
});
