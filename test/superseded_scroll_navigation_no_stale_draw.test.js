// Regression (oculist-rbx): when a scrolled navigation is superseded by another before it
// settles, highlightActiveRange()'s smooth-scroll branch (content.js) clears the superseded
// navigation's 600ms fallback timer and removes both its scroll listeners, but had no
// module-level handle on its 80ms scroll-debounce TIMER (as opposed to the listener that
// schedules it). That timer is closed over per-navigation, so it can survive the teardown
// and fire its own onScrollEnd later, calling animate() with a stale rect for a match that
// is no longer active.
//
// Demonstrated empirically (not just reasoned): a target requiring a long scroll (match2),
// interrupted ~50ms later by a second "next match" jump to a third, farther target (match3),
// produces an EXTRA border draw at match2's un-scrolled (still off-screen) position before
// the correct final draw at match3 — three draws total instead of the two legitimate ones
// (the initial in-view match, and the final settled match). Uninterrupted, match2 draws
// exactly once, on time, at its correctly-scrolled position — the extra draw only appears
// under supersession, which is what this test pins down.
//
// This is an ADJACENT finding to oculist-7k0 (same file, same three-entry-path mechanism)
// but a different hazard: oculist-7k0's scrollEndFired flag guards a single navigation's own
// closure against firing onScrollEnd twice; it does nothing for a STALE closure from an
// already-superseded navigation, which has its own flag still false.
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

// Three matches, each requiring a genuinely long scroll to reach the next one (viewport is
// 800px tall): match1 is in view at load (no scroll branch), match2 and match3 each sit
// 6000px below the previous one so their smooth-scroll animations run long enough to still
// be in flight ~50ms after they start — the window this bug needs.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p id="m1">quarklet</p>
<div style="height:6000px"></div>
<p id="m2">quarklet</p>
<div style="height:6000px"></div>
<p id="m3">quarklet</p>
<div style="height:6000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('a superseded scrolled navigation does not draw a stale rect (oculist-rbx)', () => {
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
  // drawn per animate() call, which is what the redraw counter below watches for.
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
  // overlay (`.oc-beacon`, no id — same shape as scrolled_navigation_single_redraw.test.js's
  // counter) lands in the DOM, and records the timestamp of the most recent one so callers
  // can wait for the count to go quiet instead of guessing a fixed duration.
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

  // Waits for the redraw count to have gone quiet for QUIET_MS. Unlike
  // scrolled_navigation_single_redraw.test.js (where the two competing draws for one
  // navigation land ~47ms apart), this test's two LEGITIMATE draws are far apart: match1
  // draws almost immediately, match3 only draws once its own long scroll settles hundreds
  // of ms later. QUIET_MS has to outlast that gap, or this would report "settled" right
  // after match1's draw and never observe match3's.
  async function waitForRedrawCountToSettle() {
    const QUIET_MS = 1000;
    await page.waitForFunction(
      (quiet) => window.__ocRedrawCount > 0 && performance.now() - window.__ocRedrawAt > quiet,
      QUIET_MS,
      { timeout: POLL_TIMEOUT }
    );
    return page.evaluate(() => window.__ocRedrawCount);
  }

  test('interrupting a scrolled navigation mid-flight with another draws exactly twice, not a stale third time', async () => {
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

    // Enter #1: commits the typed term as a chip, landing on match1 — already in view, no
    // scroll branch, draws once immediately.
    await page.keyboard.press('Enter');
    // Enter #2: findNext() to match2 — out of view, takes the smooth-scroll branch and
    // starts a long scrollIntoView animation (scroll events keep resetting its 80ms
    // debounce timer while the animation is still running).
    await page.keyboard.press('Enter');
    // A short real-clock delay lands inside match2's still-running scroll animation, where
    // its debounce timer is scheduled but not yet fired — the exact window this bug needs.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Enter #3: findNext() to match3 — supersedes match2's navigation. Pre-fix, match2's
    // orphaned scrollDebounceTimer survives this and fires later, drawing a stale rect.
    await page.keyboard.press('Enter');

    const count = await waitForRedrawCountToSettle();

    assert.strictEqual(
      count,
      2,
      'a scrolled navigation superseded mid-flight must not leave behind a stale draw for the ' +
        'match it was superseded away from — only the initial in-view match and the final ' +
        'settled match should ever draw'
    );
  });
});
