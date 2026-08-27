// Regression for oculist-a5z: chrome.storage.onChanged's listener in content.js calls
// applyWrapPosition()/updateViewportMarkers() whenever a relevant settings key changes,
// but wrap is null/undefined whenever the find overlay is currently closed (__ocDestroy()
// resets it). A settings change landing while the overlay is closed — from the popup,
// another tab, or a direct chrome.storage.sync.set() — used to throw
// "Cannot read properties of undefined (reading 'style')" inside applyWrapPosition(),
// surfacing in the console/DevTools as "Error in event handler".
//
// This has to run in a real browser: it exercises the live chrome.storage.onChanged
// listener registered by the actual content script, which only exists once the extension
// is loaded into a real Chromium instance (no jsdom equivalent).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>alpha beta gamma</p>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('Settings change landing while the overlay is closed', () => {
  let server, ctx, page, client, isolatedContextId, origin;
  const pageErrors = [];
  const consoleErrors = [];

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
    const deadline = Date.now() + POLL_TIMEOUT;
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
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

  async function openBar() {
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  // Writes 'oc-settings' straight to chrome.storage.sync from inside the content script's
  // own isolated execution context — the same underlying call the real popup makes, but
  // deliberately bypassing saveSettings() so this write is NOT recorded in
  // pendingSelfWrites and is therefore NOT treated as a self-echo by the onChanged
  // listener under test. This is exactly the path a genuinely foreign settings change
  // (popup, another tab) takes when it reaches this tab's content script.
  function setPosition(position) {
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

  // Arm a probe listener inside the content script's own isolated world *before* writing
  // a foreign settings change: chrome.storage.onChanged fires every listener registered
  // against that same document for the same event, in registration order — content.js's
  // own listener was registered at page load, long before this probe, so observing OUR
  // listener fire (and, before the fix under test, an uncaught error already having
  // landed in pageErrors/consoleErrors by then) is a direct proxy for content.js's own
  // listener having already run.
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
    const deadline = Date.now() + POLL_TIMEOUT;
    for (;;) {
      const now = await evalInContentScript('window.__ocSettingsEchoes');
      if (now > before) return;
      if (Date.now() > deadline) {
        throw new Error('oc-settings change never echoed into the content script');
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

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
      viewport: { width: 1200, height: 800 },
    });

    page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

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
    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('does not throw when a settings change lands while the overlay is closed', async () => {
    // Start from an explicitly-known position so the write below is guaranteed to
    // actually change 'oc-settings' — chrome.storage only fires onChanged when the
    // stored value differs, and an unchanged value would let this test pass for the
    // wrong reason (the listener never ran at all).
    await setPosition('tr');

    // Open the overlay, then close it — __ocDestroy() nulls out `wrap`, reproducing the
    // exact state (overlay closed) the bug report describes.
    await openBar();
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();

    pageErrors.length = 0;
    consoleErrors.length = 0;

    // A settings change lands from "another context" while the overlay is closed. Before
    // the fix, content.js's onChanged listener calls applyWrapPosition() unconditionally
    // here and throws "Cannot read properties of undefined (reading 'style')" because
    // wrap is null.
    const echoBefore = await armSettingsEcho();
    await setPosition('bl');

    // Wait for the write to actually echo into content.js's own onChanged listener,
    // instead of guessing how long that takes.
    await waitForSettingsEcho(echoBefore);

    assert.deepStrictEqual(
      pageErrors,
      [],
      'a settings change landing while the overlay is closed must not throw an uncaught page error'
    );
    assert.deepStrictEqual(
      consoleErrors,
      [],
      'a settings change landing while the overlay is closed must not log a console error'
    );

    // The fix must not come at the cost of losing the change: reopening the overlay
    // should pick up the position that changed while it was closed, since `settings` is
    // updated unconditionally in the listener regardless of whether wrap exists yet.
    await openBar();
    const hasBlClass = await page.evaluate(() => {
      const wrap = document.getElementById('oc-wrap');
      return !!wrap && wrap.classList.contains('pos-bl');
    });
    assert.strictEqual(hasBlClass, true, 'reopening the overlay must reflect the position set while it was closed');
  });
});
