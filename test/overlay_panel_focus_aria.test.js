// Overlay panel triggers expose live popup semantics, and opening a panel moves focus
// into it (oculist-l6m.27).
//
// Both listsBtn (oculist-l6m.9) and the pre-existing gearBtn had aria-label/title but no
// aria-haspopup and no aria-expanded, so a screen reader user got no signal that the
// control opens a panel, or that a panel is open. Opening either role="dialog" panel also
// moved no focus into it. This asserts the fix at the level a screen reader actually sees
// it: the CDP accessibility tree's computed `hasPopup`/`expanded` properties (not merely
// that an aria-* attribute string is present on the element — a prior bead's tests were
// dinged for exactly that), and real DOM focus location (shadowRoot.activeElement) for the
// "focus moves into/out of the panel" half of the fix.
//
// Needs a real browser for the same reasons as list_menu.test.js: real layout, a real
// shadow root, and — new for this bead — the CDP Accessibility domain, which only computes
// anything meaningful against a real rendered accessibility tree, never jsdom.
//
// page.accessibility (Playwright's old convenience wrapper around this same CDP domain)
// was removed from the Playwright version this repo pins, so this file talks to
// Accessibility.getPartialAXTree directly over the CDP session already used elsewhere in
// this suite for isolated-world eval.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const LISTS_BTN = '#oc-wrap >> button[title="Saved Lists"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const LISTS_PANEL = '#oc-wrap >> #oc-lists-panel';

// Plain (non-Playwright-deep) CSS selectors, for reaching into the shadow root ourselves
// via CDP Runtime.evaluate — Accessibility.getPartialAXTree needs a remote objectId, which
// has to come from an in-page evaluate, not a Playwright locator.
const GEAR_BTN_CSS = 'button[title="Options"]';
const LISTS_BTN_CSS = 'button[title="Saved Lists"]';
const SETTINGS_PANEL_CSS = '#oc-settings-panel';
const LISTS_PANEL_CSS = '#oc-lists-panel';

describe('Overlay panel triggers: live aria-haspopup/aria-expanded, and focus moves with the panel', () => {
  let server, ctx, page, client, isolatedContextId;

  // Same readiness signal as find_next_list_ownership.test.js/chip_count_accessibility.
  // test.js: window.__ocToggle only exists once boot()'s async settings round trip has
  // resolved and the keydown listener is attached.
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
    await client.send('Accessibility.enable');
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

  // Resolves an element inside #oc-wrap's shadow root (the DEFAULT/main-world execution
  // context — the shadow root is real DOM, reachable from either world) to a CDP
  // objectId, reads its computed accessibility properties via
  // Accessibility.getPartialAXTree, then releases the remote handle. Returns
  // { role, props } where props is a plain map of AXProperty name -> computed value, e.g.
  // props.hasPopup === 'dialog', props.expanded === true/false. This is the computed
  // accessibility tree, not the raw aria-* attribute string.
  async function getAXProperties(cssSelector) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: 'document.getElementById(\'oc-wrap\').shadowRoot.querySelector(' + JSON.stringify(cssSelector) + ')',
    });
    if (!result.objectId) {
      throw new Error('AX probe: no element matched ' + cssSelector);
    }
    try {
      const ax = await client.send('Accessibility.getPartialAXTree', {
        objectId: result.objectId,
        fetchRelatives: false,
      });
      const node = ax.nodes[0];
      const props = {};
      (node.properties || []).forEach((p) => {
        props[p.name] = p.value ? p.value.value : undefined;
      });
      return {
        role: node.role ? node.role.value : undefined,
        name: node.name ? node.name.value : undefined,
        props: props,
      };
    } finally {
      await client.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    }
  }

  // Polls the real computed AX tree (not a fixed sleep) until aria-expanded's computed
  // value for the given trigger matches what is expected, or times out.
  async function waitForAXExpanded(cssSelector, expected, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    let last;
    for (;;) {
      const ax = await getAXProperties(cssSelector);
      last = ax.props.expanded;
      if (last === expected) return ax;
      if (Date.now() > deadline) {
        throw new Error(
          'aria-expanded (computed) for ' + cssSelector + ' never reached ' + expected + ' (last seen: ' + last + ')'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // Polls the real shadow root's activeElement (not a fixed sleep) until it is the single
  // element matched by cssSelector.
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

  // Every test starts from a closed overlay, so panel/focus state never leaks between
  // tests.
  beforeEach(async () => {
    // A single Escape now only closes a dialog panel, if one is left open by the previous
    // test (oculist-l6m.37) — settingsPanel behaves like listsPanel and no longer falls all
    // the way through to the full overlay destroy on the first press. Press repeatedly
    // (bounded) until the overlay itself is actually gone, so leftover panel state from one
    // test never leaks into the next.
    for (let attempts = 0; attempts < 3 && (await page.locator('#oc-wrap').count()) > 0; attempts++) {
      await page.keyboard.press('Escape').catch(() => {});
      await waitForOverlayClosed().catch(() => {});
    }
    await waitForOverlayClosed();
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
  });

  test('gearBtn (Options): aria-haspopup is "dialog" and aria-expanded flips true/false with open/close', async () => {
    let ax = await getAXProperties(GEAR_BTN_CSS);
    assert.strictEqual(ax.props.hasPopup, 'dialog', 'gearBtn must expose a computed haspopup of "dialog"');
    assert.strictEqual(ax.props.expanded, false, 'gearBtn must start collapsed');

    await page.locator(GEAR_BTN).click();
    ax = await waitForAXExpanded(GEAR_BTN_CSS, true);
    assert.strictEqual(ax.props.hasPopup, 'dialog', 'haspopup must not change across open/close');

    await page.locator(GEAR_BTN).click();
    await waitForAXExpanded(GEAR_BTN_CSS, false);
  });

  test('listsBtn (Saved Lists): aria-haspopup is "dialog" and aria-expanded flips true/false with open/close', async () => {
    let ax = await getAXProperties(LISTS_BTN_CSS);
    assert.strictEqual(ax.props.hasPopup, 'dialog', 'listsBtn must expose a computed haspopup of "dialog"');
    assert.strictEqual(ax.props.expanded, false, 'listsBtn must start collapsed');

    await page.locator(LISTS_BTN).click();
    ax = await waitForAXExpanded(LISTS_BTN_CSS, true);
    assert.strictEqual(ax.props.hasPopup, 'dialog', 'haspopup must not change across open/close');

    await page.locator(LISTS_BTN).click();
    await waitForAXExpanded(LISTS_BTN_CSS, false);
  });

  test('opening Settings moves focus into the settings panel; closing it via its own button returns focus to gearBtn', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });
    await waitForActiveElement(SETTINGS_PANEL_CSS);

    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { state: 'detached', timeout: 5000 });
    await waitForActiveElement(GEAR_BTN_CSS);
    await waitForAXExpanded(GEAR_BTN_CSS, false);
  });

  test('opening the list popover moves focus into it; closing it via its own button returns focus to listsBtn', async () => {
    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { timeout: 5000 });
    await waitForActiveElement(LISTS_PANEL_CSS);

    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { state: 'detached', timeout: 5000 });
    await waitForActiveElement(LISTS_BTN_CSS);
    await waitForAXExpanded(LISTS_BTN_CSS, false);
  });

  test('Escape closes the list popover and returns focus to listsBtn; a second Escape closes the whole overlay', async () => {
    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { timeout: 5000 });
    await waitForActiveElement(LISTS_PANEL_CSS);

    // First Escape: closes only the popover (oculist-l6m.9 behaviour), and must return
    // focus to the trigger that opened it, not strand it on the now-detached panel.
    await page.keyboard.press('Escape');
    await page.waitForSelector(LISTS_PANEL, { state: 'detached', timeout: 5000 });
    assert.strictEqual(await page.locator('#oc-wrap').count(), 1, 'the overlay itself must still be open after the first Escape');
    await waitForActiveElement(LISTS_BTN_CSS);
    await waitForAXExpanded(LISTS_BTN_CSS, false);

    // Second Escape: falls through to the full overlay destroy, exactly as before this
    // bead — must not be broken by the added focus/aria bookkeeping.
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
  });

  // oculist-l6m.37: settingsPanel carries the same role="dialog" as listsPanel
  // (oculist-l6m.27), so it must behave identically to the listsPanel case immediately
  // above for the same key — first Escape closes only the panel and returns focus to its
  // trigger (gearBtn); a second Escape (with no panel open) closes the whole overlay.
  test('Escape closes the settings panel and returns focus to gearBtn (overlay stays open)', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });
    await waitForActiveElement(SETTINGS_PANEL_CSS);

    // First Escape: closes only the settings panel, must not tear down the whole overlay.
    await page.keyboard.press('Escape');
    await page.waitForSelector(SETTINGS_PANEL, { state: 'detached', timeout: 5000 });
    assert.strictEqual(await page.locator('#oc-wrap').count(), 1, 'the overlay itself must still be open after the first Escape');
    await waitForActiveElement(GEAR_BTN_CSS);
    await waitForAXExpanded(GEAR_BTN_CSS, false);
  });

  test('a second Escape (settings panel already closed) closes the whole overlay, matching the listsPanel case', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });
    await waitForActiveElement(SETTINGS_PANEL_CSS);

    await page.keyboard.press('Escape');
    await page.waitForSelector(SETTINGS_PANEL, { state: 'detached', timeout: 5000 });

    // Second Escape: falls through to the full overlay destroy, matching the listsPanel
    // behaviour above.
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
  });

  // Edge case named in oculist-l6m.37: Escape must close the settings panel even when focus
  // has moved elsewhere in the overlay (e.g. the find input) without explicitly closing the
  // panel first — mirrors closeListsMenu()'s Escape branch above, which also closes
  // unconditionally on listsPanel presence rather than checking focus location first.
  test('Escape closes the settings panel even when focus is outside it (e.g. the find input)', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });
    await waitForActiveElement(SETTINGS_PANEL_CSS);

    await page.locator(INPUT).focus();
    await waitForActiveElement('.oc-input');

    await page.keyboard.press('Escape');
    await page.waitForSelector(SETTINGS_PANEL, { state: 'detached', timeout: 5000 });
    assert.strictEqual(await page.locator('#oc-wrap').count(), 1, 'the overlay itself must still be open after the first Escape');
    await waitForActiveElement(GEAR_BTN_CSS);
  });

  // Mutual exclusion (oculist-l6m.9): opening one panel while the other is open closes the
  // other one first. closeListsMenu()/closeSettings() both take a skipFocusReturn option
  // for exactly this path — the point of skipping it is that focus is about to land in the
  // panel that is opening, not back on the trigger whose panel just got closed out from
  // under it. The assertion here is the thing that option exists to guarantee: no stale
  // focus reference left on a detached node or a now-inactive trigger — the newly opened
  // panel actually has focus, and the aria-expanded state of both triggers is consistent
  // (old one false, new one true).
  // (oculist-l6m.27, fix pass) The settings dialog's aria-label is i18n.prefTitle
  // (sentence case), deliberately NOT aria-labelledby pointing at the visible header:
  // Blink applies CSS text-transform when computing a name from a referenced element, so
  // labelledby-at-the-visible-header would announce the all-caps text the header is styled
  // with via CSS, not the sentence-case string. aria-label reads the JS string directly and
  // sidesteps that.
  test('Settings dialog: computed accessible name is the sentence-case string, not the CSS-uppercased visible header', async () => {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });

    const ax = await getAXProperties(SETTINGS_PANEL_CSS);
    assert.strictEqual(ax.role, 'dialog');
    assert.strictEqual(ax.name, 'Oculist Preferences', 'accessible name must be the sentence-case string, not all-caps');
  });

  test('opening Settings while the list popover is open closes it without stranding focus, and vice versa', async () => {
    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { timeout: 5000 });
    await waitForActiveElement(LISTS_PANEL_CSS);

    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { state: 'detached', timeout: 5000 });
    await page.waitForSelector(SETTINGS_PANEL, { timeout: 5000 });
    await waitForActiveElement(SETTINGS_PANEL_CSS);
    await waitForAXExpanded(LISTS_BTN_CSS, false);
    await waitForAXExpanded(GEAR_BTN_CSS, true);

    // And the reverse direction.
    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { state: 'detached', timeout: 5000 });
    await page.waitForSelector(LISTS_PANEL, { timeout: 5000 });
    await waitForActiveElement(LISTS_PANEL_CSS);
    await waitForAXExpanded(GEAR_BTN_CSS, false);
    await waitForAXExpanded(LISTS_BTN_CSS, true);
  });
});
