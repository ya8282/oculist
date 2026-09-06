// Regression (oculist-30k): __ocDestroy() never called clearAutoScrollFlag(), so the
// 'scroll'/'scrollend' listeners triggerAutoScrollFlag() (content.js) arms for the
// oculist-z8n grace-timer suppression outlive teardown. This did not regress anything by
// itself (the old flat 800ms timer wasn't cleared by __ocDestroy() either), but the shape
// changed: on a page that keeps generating 'scroll' events forever (an infinite
// auto-scroller, a stuck momentum scroll), the still-attached 'scroll' listener
// (extendAutoScrollFlag) keeps re-arming the 300ms grace timer indefinitely after
// __ocDestroy() has torn everything else down.
//
// Bounded, not directly reachable from the page's own DOM/UI: __ocDestroy() already nulls
// out every other piece of overlay state, and the leaked listener's own effect is purely
// internal (isAutoScrolling / autoScrollTimer, both module-private closure variables with
// no other reader — handleScroll(), the only thing that ever consulted isAutoScrolling, is
// itself removed by __ocDestroy()). So there is no DOM mutation, redraw, or other page-
// visible side effect a test could observe. window.__ocTest.getAutoScrollTimer() (added by
// this bead, same "single sanctioned test-only surface" reasoning as the pre-existing
// window.__ocTest.getDebounceTimer) is used instead, read through the same CDP
// Runtime.evaluate-against-the-isolated-context idiom every other __ocTest consumer in this
// suite already uses (see chip_row.test.js) — never a page-world addEventListener/
// removeEventListener instrumentation, which content scripts' isolated JS world would not
// even observe (isolated worlds share the DOM but not the JS heap/prototypes with the main
// world a Playwright page.addInitScript() would patch).
//
// Needs a real browser for the same reason as the other scroll-timing tests in this suite:
// real layout/scrolling and native 'scroll'/'scrollend' don't exist in jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// "target" sits far enough below the fold that Enter takes the smooth-scroll branch and
// calls triggerAutoScrollFlag() before the native scrollIntoView() animation starts. Tall
// enough that the continuous oscillating scroll driven by the test (see startNeverEndingScroll
// below) has room to move without ever hitting a document edge, which would stop generating
// 'scroll' events and defeat the "page that never stops scrolling" premise this bug needs.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:4000px"></div>
<p id="target">quarklet</p>
<div style="height:30000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('__ocDestroy() leaves no stale auto-scroll listener/timer on a continuously-scrolling page (oculist-30k)', () => {
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

    // Install the scrollend counter here — before openFinder(), fill(), Enter, or
    // startNeverEndingScroll() ever run — so there is no window in which a native
    // 'scrollend' could fire uncounted. Installing it any later (even "right after the wait
    // for the armed timer resolves") leaves a CDP-round-trip-sized gap between confirming
    // the timer armed and the addEventListener call actually landing; a scrollend in that
    // gap would run the real clearAutoScrollFlag() listener, tearing down the very state
    // this test is trying to observe, without ever being counted. Registering it before any
    // scrolling of any kind happens in this suite closes that gap outright rather than
    // narrowing it.
    await evalInContentScript(
      'window.__ocDebugScrollendCount = 0;' +
        'window.addEventListener("scrollend", function () { window.__ocDebugScrollendCount++; });'
    );
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function waitForIsolatedContext() {
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });
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

  // Simulates "a page that never stops scrolling" (an infinite auto-scroller, a stuck
  // momentum scroll — the bead's own framing): oscillates window.scrollY back and forth
  // inside a small band near the top of the page, forever, via a short setInterval — started
  // *before* the Enter navigation below and never paused, so native 'scrollend' has no
  // window of genuine quiescence in which to fire on its own. That matters: this test's
  // premise only holds if the ONLY thing that can ever clear the grace timer is
  // clearAutoScrollFlag() running (via native scrollend, or via __ocDestroy() with the fix);
  // if the native scrollIntoView() animation were left to finish undisturbed, its own
  // 'scrollend' would fire once and clear everything naturally, making the test pass
  // vacuously regardless of __ocDestroy()'s behavior. The 0-300 band sits far above
  // "target" (past 4000px) so isFullyInViewport for that match is unaffected by it. Returns
  // a stop() that clears the interval — the test always calls it before ctx.close() so no
  // timer outlives this file's own run.
  async function startNeverEndingScroll() {
    await page.evaluate(() => {
      window.__ocNeverEndingScrollDir = 1;
      window.__ocNeverEndingScrollHandle = setInterval(() => {
        // oculist-30k test note: an *instant* scrollTo() completes synchronously and fires
        // its own native 'scrollend' right away — a burst of discrete instant jumps is many
        // separate finished scroll operations, not one continuous one, so it does not
        // simulate "a page that never stops scrolling" at all (verified empirically: it
        // fired scrollend on nearly every tick). behavior:'smooth', re-targeted before each
        // prior animation settles, keeps one scroll operation continuously in flight instead.
        const y = window.scrollY;
        if (y > 300) window.__ocNeverEndingScrollDir = -1;
        // scrollY clamps at 0 and can never go negative, so the lower-bound check must be
        // reachable at exactly 0 (not '< 0', which nothing ever satisfies) or the motion
        // stalls the instant it descends to the clamp: every subsequent target is negative,
        // clamps right back to 0, produces no further motion, and stops generating
        // 'scroll'/'scrollend' events at all — silently defeating the "page that never
        // stops scrolling" premise this test depends on.
        if (y <= 0) window.__ocNeverEndingScrollDir = 1;
        window.scrollTo({ top: y + window.__ocNeverEndingScrollDir * 30, behavior: 'smooth' });
      }, 40);
    });
    return async function stop() {
      await page.evaluate(() => {
        if (window.__ocNeverEndingScrollHandle) clearInterval(window.__ocNeverEndingScrollHandle);
      });
    };
  }

  test('a scroll listener is armed, __ocDestroy() clears it, and it never re-arms despite scrolling continuing forever', async () => {
    await openFinder();

    // Start the never-ending scroll *before* the navigation that arms the auto-scroll
    // listeners below — see startNeverEndingScroll()'s comment for why the ordering matters.
    const stopScrolling = await startNeverEndingScroll();

    try {
      await page.locator(INPUT).fill('quarklet');
      await page.waitForFunction(
        () => {
          const root = document.getElementById('oc-wrap');
          const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
          return !!count && /of \d+/.test(count.textContent);
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      // Enter: navigates to the only match, out of view — takes the smooth-scroll branch,
      // which calls triggerAutoScrollFlag() and arms the 'scroll'/'scrollend' listeners and
      // autoScrollTimer under test, before the native scrollIntoView() animation starts.
      await page.keyboard.press('Enter');

      // Confirm the grace timer is actually armed before relying on it — a vacuous pass
      // (nothing to leak) would otherwise be indistinguishable from the fix working.
      await waitForCondition(() => evalInContentScript('window.__ocTest.getAutoScrollTimer()'), (v) => v !== null, {
        timeout: POLL_TIMEOUT,
        message: 'autoScrollTimer was never armed by the Enter navigation',
      });

      // The scrollend counter (sanity instrument: a native 'scrollend' firing during this
      // test would clear everything on its own, independent of __ocDestroy(), making the
      // assertion below vacuous) was installed in before(), before any scrolling of any
      // kind in this suite — see that comment for why.

      // __ocDestroy() itself — the same function window.__ocToggle() and the
      // 'toggle'/'destroy' runtime messages invoke.
      await evalInContentScript('window.__ocDestroy()');

      // Immediately after destroy, the fixed code has already cleared autoScrollTimer via
      // clearAutoScrollFlag(); the pre-fix code never touches it, so whatever value survived
      // from the still-armed grace timer (non-null, per the wait above) is what would be
      // observed here on the buggy code. This first read is not itself the interesting
      // assertion below — it is the readings after further scrolling that distinguish "torn
      // down" from "coincidentally quiet right now".
      const rightAfterDestroy = await evalInContentScript('window.__ocTest.getAutoScrollTimer()');

      // Poll for 500ms (well past one more never-ending-scroll tick (40ms) and the 300ms
      // grace window), while scrolling continues throughout, collecting every observed
      // value. If __ocDestroy() removed the 'scroll' listener (the fix), autoScrollTimer
      // stays null for the whole window — nothing left to re-arm it. If the listener is
      // still attached (the bug), every scroll tick calls extendAutoScrollFlag(), which
      // re-arms a fresh non-null timer, so at least one reading here must be non-null
      // despite rightAfterDestroy potentially already being null.
      const observedAfterDestroy = [];
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        observedAfterDestroy.push(await evalInContentScript('window.__ocTest.getAutoScrollTimer()'));
      }

      const scrollendCount = await evalInContentScript('window.__ocDebugScrollendCount');
      assert.strictEqual(
        scrollendCount,
        0,
        'test premise violated: native scrollend fired during the observation window, which ' +
          'would clear autoScrollTimer on its own regardless of the bug under test'
      );

      assert.ok(
        observedAfterDestroy.every((v) => v === null),
        '__ocDestroy() must remove the auto-scroll scroll/scrollend listeners so a page that ' +
          'keeps scrolling forever cannot re-arm autoScrollTimer after teardown ' +
          `(right after destroy: ${JSON.stringify(rightAfterDestroy)}, subsequent readings: ` +
          `${JSON.stringify(observedAfterDestroy)})`
      );
    } finally {
      await stopScrolling();
    }
  });
});
