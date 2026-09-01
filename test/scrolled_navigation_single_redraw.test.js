// Regression (oculist-7k0): highlightActiveRange()'s smooth-scroll branch (content.js)
// waits for 'scrollend' before calling animate(), which does cancelBeacons() plus a full
// overlay redraw. The native 'scrollend' event and the handler's own scroll-debounce
// fallback timer both call the same onScrollEnd function, and neither path used to guard
// against the other also firing — so a single scrolled navigation ran animate() TWICE,
// ~47ms apart (see beacon_fade_persistent_overlays.test.js's fireAndTagBeacon(), which
// used to have to wait this second cycle out).
//
// This proves the fix by counting how many times the persistent border overlay gets torn
// down and re-created for one scrolled Enter: cancelBeacons() removes every existing
// `.oc-beacon`, and drawActiveOverlays() creates a brand-new border element on every
// animate() call, so each animate() call is observable as exactly one fresh border element
// landing in the DOM. Before the fix that count is 2 for a single navigation; after the
// fix it is 1.
//
// Needs a real browser for the same reasons as reposition_overlays_no_entrance_replay.
// test.js: real layout/scrolling and 'scrollend' don't exist in jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// A tall spacer pushes the target well below the fold (viewport is 800px tall) so
// highlightActiveRange() takes the smooth-scroll branch instead of drawing immediately.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:3000px"></div>
<p id="target-wrap">quarklet</p>
<div style="height:3000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('a scrolled navigation redraws the active-match overlay exactly once (oculist-7k0)', () => {
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
      viewport: { width: 1200, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP before navigating so the isolated-world execution-context-created event
    // is never missed.
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
    await waitForIsolatedContext();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function waitForIsolatedContext() {
    const deadline = Date.now() + POLL_TIMEOUT;
    while (!isolatedContextId) {
      if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

  // Writes straight through chrome.storage.sync from inside the content script's own
  // isolated world, merging into visionSettings — borderStyle:'thick' with the
  // magnifier/labels off leaves exactly one non-transient `.oc-beacon` (the border) drawn
  // per animate() call, which is what the redraw counter below watches for.
  async function setVisionSettings(patch) {
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
  }

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

  // Arms a MutationObserver that counts every time a brand-new, non-transient border
  // overlay (`.oc-beacon`, no id — the same shape as the one in
  // reposition_overlays_no_entrance_replay.test.js's BORDER_MATCH_FN) lands in the DOM,
  // and records the timestamp of the most recent one so callers can wait for the count to
  // go quiet instead of guessing a fixed duration.
  async function armRedrawCounter() {
    await page.evaluate(() => {
      window.__ocRedrawCount = 0;
      window.__ocRedrawAt = performance.now();
      if (window.__ocRedrawObserver) window.__ocRedrawObserver.disconnect();
      window.__ocRedrawObserver = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (
              n.nodeType === 1 &&
              n.classList &&
              n.classList.contains('oc-beacon') &&
              !n.classList.contains('oc-beacon-transient') &&
              !n.id
            ) {
              window.__ocRedrawCount++;
              window.__ocRedrawAt = performance.now();
            }
          }
        }
      });
      window.__ocRedrawObserver.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // Waits for the redraw count to have gone quiet for QUIET_MS — long enough to span both
  // the native 'scrollend' path and the ~47ms-later scroll-debounce fallback that used to
  // fire a second animate() — then returns the settled count.
  async function waitForRedrawCountToSettle() {
    const QUIET_MS = 300;
    await page.waitForFunction(
      (quiet) => window.__ocRedrawCount > 0 && performance.now() - window.__ocRedrawAt > quiet,
      QUIET_MS,
      { timeout: POLL_TIMEOUT }
    );
    return page.evaluate(() => window.__ocRedrawCount);
  }

  test('a single scrolled Enter draws the border overlay exactly once', async () => {
    await setVisionSettings({ borderStyle: 'thick', magnifier: false, textLabels: false, motionSensitivity: 'full' });
    await openFinder();

    await page.locator(INPUT).fill('quarklet');
    // Wait for the draft debounce to actually land a real match count before firing,
    // instead of guessing its duration.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    await armRedrawCounter();
    await page.keyboard.press('Enter');

    const count = await waitForRedrawCountToSettle();

    assert.strictEqual(
      count,
      1,
      'a single scrolled navigation must run animate() exactly once, not once per scrollend firing'
    );
  });
});
