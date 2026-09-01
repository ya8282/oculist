// Regression (oculist-7uc): a third path into the same class of hazard as oculist-rbx
// (commit 3ddc082) and oculist-tz6 (commit 80f2a30). highlightActiveRange()'s smooth-scroll
// branch entry clears all four module-level scroll handles (activeScrollTimeout,
// activeScrollEndHandler, activeScrollDebounceHandler, activeScrollDebounceTimer) before
// arming a new navigation. But when a new navigation supersedes an in-flight smooth scroll
// AND the new navigation's own match is already fully in the viewport, control takes the
// `else` branch instead — which drew immediately without ever running that teardown. The
// superseded navigation's handles (and its still-running native scrollIntoView animation)
// were left live, so its orphaned timer/scrollend could still fire later and animate() a
// stale rect at the OLD (far-away) position, on top of the correct draw.
//
// Demonstrated empirically: match1 sits in view, matchFar sits 6000px below (forcing the
// smooth-scroll branch). Enter -> m1 (in view, draws once) -> Enter -> matchFar (out of
// view, arms the smooth-scroll branch's handles + a real scrollIntoView animation) -> ~50ms
// later, while that scroll is still in flight -> Enter again, which wraps back to m1 (still
// near its original screen position - i.e. already in the viewport) and takes the `else`
// branch. Pre-fix this reliably (3/3) produced a THIRD draw hundreds of ms later, at
// matchFar's document position (~1300+px top, ~4700+px scrollY) - the superseded
// navigation's orphaned scrollend/timer painting a stale rect after the legitimate redraw at
// m1. Post-fix only the two legitimate m1 draws occur.
//
// Needs a real browser for the same reasons as scrolled_navigation_single_redraw.test.js:
// real layout/scrolling and 'scrollend' don't exist in jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// match1 is in view at load (no scroll branch); matchFar sits 6000px below so its
// smooth-scroll animation is still genuinely in flight ~50ms after it starts - the window
// this bug needs, and wide enough that its stale draw (if any) lands far from match1's.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p id="m1">quarklet</p>
<div style="height:6000px"></div>
<p id="mfar">quarklet</p>
<div style="height:6000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('a navigation superseded by one already in the viewport does not draw a stale rect (oculist-7uc)', () => {
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

  // Same rationale as scrolled_navigation_single_redraw.test.js: borderStyle:'thick' with
  // the magnifier/labels off leaves exactly one non-transient `.oc-beacon` (the border)
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
  // (`.oc-beacon`, no id — same shape as scrolled_navigation_single_redraw.test.js's
  // counter) along with its rect top and scrollY, so a stale draw at the far-away match's
  // position is distinguishable from a legitimate draw at match1's.
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

  // Waits for the draw count to have gone quiet for QUIET_MS. The stale draw (when present)
  // lands hundreds of ms after the two legitimate ones, once the superseded navigation's
  // orphaned scrollend/timer finally fires — QUIET_MS has to outlast that gap.
  async function waitForDrawsToSettle() {
    const QUIET_MS = 1000;
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

  test('interrupting a scrolled navigation with one landing back on an in-viewport match draws exactly twice', async () => {
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

    // Enter #1: commits the typed term as a chip, landing on m1 — already in view, no
    // scroll branch, draws once immediately.
    await page.keyboard.press('Enter');
    // Enter #2: findNext() to matchFar — out of view, takes the smooth-scroll branch and
    // starts a long scrollIntoView animation (still running well past 50ms out).
    await page.keyboard.press('Enter');
    // A short real-clock delay lands inside matchFar's still-running scroll animation.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Enter #3: findNext() wraps back to m1 — which is still near its original on-screen
    // position (already in the viewport), so this takes the `else` branch. Pre-fix, this
    // branch never tore down matchFar's handles, so its orphaned scrollend/timer survives.
    await page.keyboard.press('Enter');

    const draws = await waitForDrawsToSettle();

    assert.strictEqual(
      draws.length,
      2,
      'a scrolled navigation superseded by one landing on an already-in-viewport match must ' +
        'not leave behind a stale draw for the match it was superseded away from — only the ' +
        'two legitimate draws at the in-viewport match should ever occur, got: ' +
        JSON.stringify(draws)
    );
  });
});
