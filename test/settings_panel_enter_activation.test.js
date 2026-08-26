// Regression for oculist-oxh: the window-level keydown capture listener treats any Enter
// press while wrapRoot.activeElement is truthy as "commit the find chip" and calls
// e.preventDefault() unconditionally, which — being capture-phase — runs before a focused
// settings-panel <button>'s own default action and silently suppresses native
// Enter-activates-button behavior. listsPanel already had an early-return guard for this;
// settingsPanel did not. Space still worked (it fires the click on keyup, untouched by this
// handler), which is why oculist-l6m.38's test had to use Space and note the gap — see that
// file's history for the discovery.
//
// Needs a real browser for the same reasons as settings_panel_rebuild_focus.test.js: real
// layout, a real shadow root, and real native button keyboard-activation behaviour, none of
// which jsdom provides.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const THEME_LIGHT_BTN = '#oc-wrap >> [data-oc-key="theme:light"]';

describe('Settings-panel Enter activation (oculist-oxh)', () => {
  let server, ctx, page;

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: 5000 });
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
      { timeout: timeoutMs || 5000 }
    );
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

  // No CDP session in this file, so there is no isolatedContextId to poll for injection
  // readiness — retry Control+f itself (a keypress a not-yet-attached listener would
  // otherwise silently swallow) until the input actually appears, instead of guessing a
  // fixed delay.
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

  // Every test starts from a closed overlay, so panel/focus state never leaks between
  // tests.
  beforeEach(async () => {
    for (let attempts = 0; attempts < 3 && (await page.locator('#oc-wrap').count()) > 0; attempts++) {
      await page.keyboard.press('Escape').catch(() => {});
      await waitForOverlayClosed().catch(() => {});
    }
    await waitForOverlayClosed();
    await openFinder();
  });

  test('Enter on a focused settings-panel button activates it natively (theme toggle)', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });

    // Move focus onto the "Light" theme toggle button via a real DOM focus() call (not a
    // click), then activate it with a real Enter keypress — this is the exact interaction
    // the bug report describes: a keyboard user tabs to a settings button and presses
    // Enter.
    await page.locator(THEME_LIGHT_BTN).focus();
    await waitForActiveElement('[data-oc-key="theme:light"]');
    await page.keyboard.press('Enter');

    // Give the rebuild-in-place a moment to settle, then assert directly on the
    // observable effect — the button gaining .active — rather than merely "no error was
    // thrown". Deliberately not wrapped in waitForFunction: on unfixed code this Enter
    // press is swallowed by the capture-phase preventDefault() and nothing ever happens,
    // so this must be a clean, immediate assertion failure, not a timeout.
    await page.waitForTimeout(300);
    const isActive = await page.evaluate(() => {
      const host = document.getElementById('oc-wrap');
      const root = host && host.shadowRoot;
      const btn = root && root.querySelector('[data-oc-key="theme:light"]');
      return !!btn && btn.classList.contains('active');
    });
    assert.strictEqual(isActive, true, 'Enter on the focused theme:light button must activate it, same as a native click/Space');
  });
});
