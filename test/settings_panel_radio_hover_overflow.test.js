// Regression for oculist-nlp8: hovering an option in the Highlight Effect list (and the
// Packs checkbox list, the same widget family) popped a horizontal scrollbar.
//
// Root cause: the generic 'button:hover, .oc-bar button:hover { transform: scale(1.05); }'
// rule (content.js) applies to every <button>, including .oc-radio-item/.oc-checkbox-item —
// full-width (width: 100%) rows rendered by makeRadioList/makeCheckboxList inside
// .oc-radio-list/.oc-checkbox-list, both scrolling containers (overflow-y: auto). Per the
// CSS overflow spec, setting overflow-y to anything other than visible computes an unset
// overflow-x as auto too, so these containers are eligible to grow a horizontal scrollbar
// the instant their content's scrollWidth exceeds clientWidth. Neither
// '.oc-radio-item:hover' nor '.oc-checkbox-item:hover' overrode transform, so the row's
// painted box grew 5% on hover — just enough to push scrollWidth past clientWidth for as
// long as the pointer stayed over any row.
//
// The fix (content.js): 'transform: none;' on both hover rules, reserving the same box in
// resting and hovered states. Hover feedback still comes through via the existing
// background-color/opacity changes on the same rules — nothing about that visual affordance
// depended on the scale.
//
// Needs a real browser for real layout/transform/scrollbar behaviour and a real hover (jsdom
// has no rendering engine to compute scrollWidth against a scaled transform).

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, TIMEOUT_SCALE } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';

// 1280x800 mirrors the default viewport used by the other settings-panel overflow suites;
// 320px is the narrowest width this codebase's own test suite treats as supported (see e.g.
// batflight_effect.test.js/reanimate_effect.test.js's own setViewportSize(320, ...) calls).
const VIEWPORTS = [
  { label: 'default (1280x800)', width: 1280, height: 800 },
  { label: 'narrowest supported (320x900)', width: 320, height: 900 },
];

describe('Settings panel row hover never opens a horizontal scrollbar (oculist-nlp8)', () => {
  let server, ctx, page;

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

  // Same retry-Control+f-until-the-input-appears rationale as
  // settings_panel_effect_list_overflow.test.js (no CDP session needed in this file).
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

  // Returns { scrollWidth, clientWidth } for a scrolling row-list container (.oc-radio-list
  // or .oc-checkbox-list), read live off the real shadow DOM.
  async function getContainerOverflow(containerSelector) {
    return page.evaluate((sel) => {
      const host = document.getElementById('oc-wrap');
      const root = host.shadowRoot;
      const el = root.querySelector(sel);
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    }, containerSelector);
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
      viewport: VIEWPORTS[0],
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

  // Every test starts from a closed overlay, so panel state never leaks between tests (same
  // convention as settings_panel_effect_list_overflow.test.js).
  beforeEach(async () => {
    for (let attempts = 0; attempts < 5 && (await page.locator('#oc-wrap').count()) > 0; attempts++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page
        .waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: 300 * TIMEOUT_SCALE })
        .catch(() => {});
    }
    await waitForOverlayClosed();
    await openFinder();
  });

  for (const viewport of VIEWPORTS) {
    test(`hovering a Highlight Effect row at ${viewport.label} keeps .oc-radio-list within its own scroll bounds`, async () => {
      // Deliberately raw, no waitForOverlayResizeSettled: this file has no CDP session,
      // and this viewport change is setup for a CSS overflow measurement, not exercising
      // the resize debounce path.
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openSettings();

      const restBefore = await getContainerOverflow('.oc-radio-list');
      assert.ok(
        restBefore.scrollWidth <= restBefore.clientWidth,
        `sanity check: .oc-radio-list must not already overflow at rest (scrollWidth=${restBefore.scrollWidth}, clientWidth=${restBefore.clientWidth})`
      );

      // A real hover (real mouse move over the rendered row), not a synthetic class toggle —
      // the bug only reproduces once the browser actually applies :hover-matched rules.
      await page.locator('#oc-wrap >> .oc-radio-item').first().hover();
      // One frame's worth of settle time for the hover-triggered transform/background
      // transition (content.js's '.oc-radio-item' transition is 120ms) to actually apply
      // before measuring.
      await page.waitForTimeout(150 * TIMEOUT_SCALE);

      const hovered = await getContainerOverflow('.oc-radio-list');
      assert.ok(
        hovered.scrollWidth <= hovered.clientWidth,
        `hovering an effect row must not open a horizontal scrollbar on .oc-radio-list ` +
        `(scrollWidth=${hovered.scrollWidth}, clientWidth=${hovered.clientWidth})`
      );
    });

    test(`hovering a Packs row at ${viewport.label} keeps .oc-checkbox-list within its own scroll bounds`, async () => {
      // Deliberately raw, no waitForOverlayResizeSettled: this file has no CDP session,
      // and this viewport change is setup for a CSS overflow measurement, not exercising
      // the resize debounce path.
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openSettings();

      const checkboxRow = page.locator('#oc-wrap >> .oc-checkbox-item').first();
      // The Packs list always renders at least one row (one per pack in the registry,
      // regardless of enabled state — knownPacks()/makeCheckboxList, content.js) so this
      // does not need an enabledPacks override the way the effect-count-pinning suite does.
      await checkboxRow.waitFor({ state: 'attached', timeout: POLL_TIMEOUT });

      const restBefore = await getContainerOverflow('.oc-checkbox-list');
      assert.ok(
        restBefore.scrollWidth <= restBefore.clientWidth,
        `sanity check: .oc-checkbox-list must not already overflow at rest (scrollWidth=${restBefore.scrollWidth}, clientWidth=${restBefore.clientWidth})`
      );

      await checkboxRow.hover();
      await page.waitForTimeout(150 * TIMEOUT_SCALE);

      const hovered = await getContainerOverflow('.oc-checkbox-list');
      assert.ok(
        hovered.scrollWidth <= hovered.clientWidth,
        `hovering a pack row must not open a horizontal scrollbar on .oc-checkbox-list ` +
        `(scrollWidth=${hovered.scrollWidth}, clientWidth=${hovered.clientWidth})`
      );
    });
  }
});
