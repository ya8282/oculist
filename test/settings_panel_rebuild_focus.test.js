// Regression for oculist-l6m.38: several settings-panel controls (theme, position, the
// reset button, and a foreign settings.onChanged rebuild) tear the whole #oc-settings-panel
// subtree down and rebuild it from scratch in place. Before the fix that always dropped
// keyboard focus out of the shadow root entirely — shadowRoot.activeElement === null and
// document.activeElement === the shadow host — silently ejecting a keyboard user who was
// mid-interaction with the panel back to document body.
//
// rebuildSettingsPanelPreservingFocus() (content.js) now captures a data-oc-key identifier
// for whatever control was focused *inside the panel* before a rebuild and re-resolves the
// equivalent control afterward, but only when focus was actually inside the panel to begin
// with — a rebuild triggered by a settings change landing from elsewhere (the popup,
// another tab) must never steal focus into the panel.
//
// Needs a real browser for the same reasons as overlay_panel_focus_aria.test.js: real
// layout, a real shadow root, and real keyboard event dispatch — jsdom has no meaningful
// shadowRoot.activeElement / native button keyboard-activation behaviour.

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
const POSITION_BL_BTN_CSS = '[data-oc-key="position:bl"]';
const COLOR_MATCH_INPUT = '#oc-wrap >> [data-oc-key="color:match"]';
const SETTINGS_PANEL_CSS = '#oc-settings-panel';

describe('Settings panel in-place rebuild: focus stays in the shadow root (oculist-l6m.38)', () => {
  let server, ctx, page, client, isolatedContextId;

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

  async function waitForContentScriptReady() {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (isolatedContextId) {
        try {
          const ready = await evalInContentScript("typeof window.__ocToggle === 'function'");
          if (ready) return;
        } catch (e) {
          // Context can still be settling right after creation — keep polling.
        }
      }
      if (Date.now() > deadline) {
        throw new Error('content script never finished booting (window.__ocToggle never appeared)');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: 5000 });
  }

  // Polls the real shadow root's activeElement (not a fixed sleep) until it is the single
  // element matched by cssSelector. Mirrors overlay_panel_focus_aria.test.js.
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

  // Writes 'oc-settings' straight to chrome.storage.sync from inside the content script's
  // own isolated execution context, deliberately bypassing saveSettings() so the write is
  // NOT recorded in pendingSelfWrites and is therefore treated as a genuinely foreign
  // change by the onChanged listener under test — exactly the path a popup or another tab's
  // write takes (same pattern as closed_overlay_settings_change.test.js).
  function setForeignPosition(position) {
    return evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, { position: ' + JSON.stringify(position) + ' });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
  }

  // Same foreign-write pattern as setForeignPosition(), but for visionProfile — setting a
  // named profile like 'eye-strain' disables the colour pickers (getProfileConstraints() /
  // constraints.colorsDisabled, content.js) on rebuild, so a control that was focused before
  // the rebuild can still be *found* afterward by its data-oc-key but is no longer a valid
  // focus target.
  function setForeignVisionProfile(visionProfile) {
    return evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, { visionProfile: ' + JSON.stringify(visionProfile) + ' });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
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
    await waitForContentScriptReady();
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
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
    await page.keyboard.press('Escape').catch(() => {});
    await waitForOverlayClosed();
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
  });

  test('changing the theme by keyboard rebuilds the panel in place but keeps focus on the equivalent control', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });

    // Move focus onto the "Light" theme toggle button via a real DOM focus() call (not a
    // click), then activate it with a real Space keypress — the setting change itself goes
    // through native button keyboard activation, not a programmatic .click(). (Not Enter:
    // content.js's window-level keydown capture handler treats any Enter press while focus
    // is inside the shadow root as "commit the find chip" and calls preventDefault() on it,
    // which — being a capture-phase listener that runs before the button's own default
    // action — suppresses the native Enter-activates-button behavior entirely. That's a
    // pre-existing interaction outside this bead's scope; Space isn't intercepted by that
    // handler and is just as valid a native button-activation key.)
    await page.locator(THEME_LIGHT_BTN).focus();
    await waitForActiveElement('[data-oc-key="theme:light"]');
    await page.keyboard.press('Space');

    // The panel is torn down and rebuilt as a side effect of the theme change — wait for
    // the rebuilt "Light" button to actually reflect the new state, confirming the rebuild
    // (not just the click) has completed.
    await page.waitForFunction(
      () => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        const btn = root && root.querySelector('[data-oc-key="theme:light"]');
        return !!btn && btn.classList.contains('active');
      },
      null,
      { timeout: 5000 }
    );

    // Base requirement: focus is still somewhere inside the panel, read from the shadow
    // root's activeElement (document.activeElement would just report the <oc-wrap> host).
    const focusInPanel = await page.evaluate(() => {
      const host = document.getElementById('oc-wrap');
      const root = host.shadowRoot;
      const panel = root.querySelector('#oc-settings-panel');
      return !!panel && panel.contains(root.activeElement);
    });
    assert.strictEqual(focusInPanel, true, 'focus must still be inside the settings panel after an in-place rebuild');

    // Stronger requirement: focus landed back on the *equivalent* control, not merely the
    // panel container.
    await waitForActiveElement('[data-oc-key="theme:light"]');
  });

  test('a settings change rebuild triggered while focus is outside the panel does not steal focus into it', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });

    // Move focus to the find input — inside the shadow root, but outside the settings
    // panel. The settings panel stays mounted (only gearBtn/Escape close it), matching a
    // real scenario where a user tabs away from an open panel without closing it.
    await page.locator(INPUT).focus();
    await waitForActiveElement('.oc-input');

    // A settings change lands from "another context" (popup, another tab) while the panel
    // is open and focus is elsewhere. This exercises the storage.onChanged rebuild path.
    await setForeignPosition('bl');

    // Confirm the rebuild actually ran (not a false pass because nothing happened).
    await page.waitForFunction(
      (sel) => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        const btn = root && root.querySelector(sel);
        return !!btn && btn.classList.contains('active');
      },
      POSITION_BL_BTN_CSS,
      { timeout: 5000 }
    );

    // Focus must still be on the find input — the rebuild must not have pulled it into the
    // settings panel.
    await waitForActiveElement('.oc-input');
  });
  test('a rebuild that disables the previously focused control (colours, via a visionProfile change) falls back to the panel container, not BODY', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });

    // Focus a colour picker control — still resolvable by data-oc-key after the rebuild
    // below, but about to become disabled, so it is not a valid restore target.
    await page.locator(COLOR_MATCH_INPUT).focus();
    await waitForActiveElement('[data-oc-key="color:match"]');

    // A foreign visionProfile change lands (popup/another tab) while focus is on the now
    // soon-to-be-disabled colour control. eye-strain disables the colour pickers
    // (constraints.colorsDisabled) on rebuild.
    await setForeignVisionProfile('eye-strain');

    // Confirm the rebuild actually ran and the control is genuinely disabled now (not a
    // false pass because nothing happened).
    await page.waitForFunction(
      () => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        const input = root && root.querySelector('[data-oc-key="color:match"]');
        return !!input && input.disabled === true;
      },
      null,
      { timeout: 5000 }
    );

    const state = await page.evaluate((panelSel) => {
      const host = document.getElementById('oc-wrap');
      const root = host.shadowRoot;
      const panel = root.querySelector(panelSel);
      return {
        shadowActive: root.activeElement ? (root.activeElement.getAttribute('data-oc-key') || root.activeElement.tagName) : null,
        inPanel: !!panel && panel.contains(root.activeElement),
        docActive: document.activeElement ? document.activeElement.tagName : null,
      };
    }, SETTINGS_PANEL_CSS);

    assert.strictEqual(state.inPanel, true, 'focus must still be inside the settings panel when the equivalent control is disabled');
    assert.notStrictEqual(state.docActive, 'BODY', 'document.activeElement must not be BODY (the original bug report symptom)');

    // The definitive assertion: since the equivalent control (color:match) is now
    // disabled and therefore not a valid restore target, focus must specifically be on the
    // panel container fallback (tabIndex -1), not merely "somewhere" inside it.
    await waitForActiveElement(SETTINGS_PANEL_CSS);
  });
});
