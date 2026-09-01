// Regression (oculist-44y, Site B): same hazard family as oculist-rbx (3ddc082),
// oculist-tz6 (80f2a30), and oculist-7uc (3ab9005), at a fifth site — the bare
// `setTimeout(function () { animate(freshRect); }, 50)` in highlightActiveRange()'s
// own fully-in-viewport `else` branch. The oculist-7uc fix (3ab9005) added a
// clearActiveScrollHandles() call at the top of this branch, but that only clears the
// FOUR handles the smooth-scroll branch owns — it does nothing for this branch's own
// bare timer, which had no module-level handle of its own.
//
// Flagged explicitly by the oculist-7uc reviewer: two in-viewport navigations less
// than 50ms apart still leave an orphaned timer here. Nav #1 lands on an in-viewport
// match and arms this bare timer; nav #2, landing on a second in-viewport match before
// nav #1's timer fires, calls clearActiveScrollHandles() (a no-op against this
// untracked timer) and arms its own. Pre-fix, nav #1's timer survives and later paints
// a stale border at nav #1's now-superseded position, on top of nav #2's legitimate
// draw.
//
// Demonstrated empirically: three matches, all within the initial viewport (distance
// is irrelevant to this bug — no scrollIntoView is ever involved in this branch, only
// the <50ms timing between two in-viewport navigations). Enter -> m1 (in view) -> Enter
// (fired back-to-back, well under 50ms later) -> m2 (in view). Pre-fix this reliably
// (3/3) produced two draws: a stale one at m1's position and the legitimate one at
// m2's. Post-fix only the legitimate m2 draw occurs.
//
// Needs a real browser for the same reasons as the sibling stale-draw tests: real
// layout and shadow-DOM event dispatch don't behave the same in jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// All three matches sit close together, well within the 800px viewport, so every
// navigation among them takes the fully-in-viewport `else` branch.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p id="m1">quarklet</p>
<p id="m2">quarklet</p>
<p id="m3">quarklet</p>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('two in-viewport navigations under 50ms apart draw only the final match (oculist-44y)', () => {
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

  // Same rationale as the sibling stale-draw tests: borderStyle:'thick' with the
  // magnifier/labels off leaves exactly one non-transient `.oc-beacon` (the border)
  // drawn per animate() call, which is what the draw watcher below watches for.
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

  // Arms a MutationObserver that records every new, non-transient border overlay
  // (`.oc-beacon`, no id) along with its rect top, so a stale draw at m1's superseded
  // position is distinguishable from the legitimate draw at m2's.
  async function armDrawWatcher() {
    await page.evaluate(() => {
      window.__ocDraws = [];
      if (window.__ocDrawObserver) window.__ocDrawObserver.disconnect();
      window.__ocDrawObserver = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (
              n.nodeType === 1 &&
              n.classList &&
              n.classList.contains('oc-beacon') &&
              !n.classList.contains('oc-beacon-transient') &&
              !n.id
            ) {
              window.__ocDraws.push({ t: performance.now(), top: n.getBoundingClientRect().top });
            }
          }
        }
      });
      window.__ocDrawObserver.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  async function waitForDrawsToSettle() {
    const QUIET_MS = 400;
    await page.waitForFunction(
      (quiet) => {
        if (!window.__ocDraws || window.__ocDraws.length === 0) return false;
        return performance.now() - window.__ocDraws[window.__ocDraws.length - 1].t > quiet;
      },
      QUIET_MS,
      { timeout: POLL_TIMEOUT }
    );
    return page.evaluate(() => window.__ocDraws);
  }

  test('two in-viewport navigations <50ms apart draw only the final match, never an orphaned stale one', async () => {
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

    await armDrawWatcher();

    // Fires two 'Enter' keydowns on the finder input back-to-back inside one
    // page.evaluate() call, so the real-clock gap between the two synchronous
    // keydownHandler runs they trigger is far under 50ms — the window this bug needs.
    // Enter #1 commits the typed term as a chip, landing on m1 (in view) and arming the
    // bare timer under test. Enter #2 (findNext) advances to m2 (also in view) before
    // that timer fires.
    await page.evaluate(() => {
      function fireEnter() {
        const root = document.getElementById('oc-wrap');
        const input = root.shadowRoot.querySelector('.oc-input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, composed: true }));
      }
      fireEnter();
      fireEnter();
    });

    const draws = await waitForDrawsToSettle();

    assert.strictEqual(
      draws.length,
      1,
      'two in-viewport navigations under 50ms apart must draw only the final match once, ' +
        'never leave an orphaned stale draw from the superseded one, got: ' + JSON.stringify(draws)
    );
  });
});
