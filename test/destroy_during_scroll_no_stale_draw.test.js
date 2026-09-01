// Regression (oculist-tz6): same hazard oculist-rbx (commit 3ddc082) fixed at the
// smooth-scroll branch entry, at a different teardown site. __ocDestroy() clears the 600ms
// fallback timer and removes both scroll listeners, but had no module-level handle it
// cleared for the 80ms scroll-debounce TIMER (as opposed to the listener that schedules it).
// That timer is closed over per-navigation, so it survives __ocDestroy() and can still fire
// its own onScrollEnd afterward, calling animate() with a stale rect.
//
// This is reachable in practice because window.__ocToggle() (what the Ctrl+F command and
// the 'toggle'/'destroy' runtime messages invoke) calls __ocDestroy() and then, on the next
// toggle, buildUI() in the SAME module instance — so a close+reopen within the debounce
// timer's ~80ms window rebuilds a fresh, empty overlay that the orphaned timer then paints a
// stale border onto.
//
// Needs a real browser for the same reasons as scrolled_navigation_single_redraw.test.js and
// superseded_scroll_navigation_no_stale_draw.test.js: real layout/scrolling and 'scrollend'
// don't exist in jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// match1 is in view at load (no scroll branch). match2 sits 6000px below it so its smooth-
// scroll animation is still genuinely in flight ~50ms after it starts — the window this bug
// needs (varying distance, not just delay: closer spacing settles before the debounce timer
// is even armed and never reaches this bug).
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p id="m1">quarklet</p>
<div style="height:6000px"></div>
<p id="m2">quarklet</p>
<div style="height:6000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('closing and reopening mid-scroll does not draw a stale rect on the fresh overlay (oculist-tz6)', () => {
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
  // overlay (`.oc-beacon`, no id — same shape as the two precedent tests' counters) lands
  // in the DOM, and records the timestamp of the most recent one so callers can wait for
  // the count to go quiet instead of guessing a fixed duration.
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

  // oculist-6jw (issue 1): registers our own 'scroll' listener in the isolated world as a
  // live proxy for the content script's own onScrollEndDebounced listener (added by the
  // smooth-scroll branch just before it calls scrollIntoView()) having already (re-)armed
  // activeScrollDebounceTimer. That variable is a closure local with no test-reachable
  // getter — adding one is a production-code change, out of scope for this test-only fix —
  // but both listeners run inside the same synchronous 'scroll' dispatch on the same
  // window, so observing ours fire is equivalent evidence that the debounce timer is now
  // armed. Same idiom as armSettingsEcho/waitForSettingsEcho used elsewhere in this suite
  // (e.g. active_beacons_counter.test.js) for the analogous chrome.storage.onChanged case.
  async function armScrollDebounceProbe() {
    await evalInContentScript(
      'window.__ocScrollProbeCount = 0;' +
        'window.addEventListener("scroll", function () { window.__ocScrollProbeCount++; });'
    );
  }

  // Waits until at least one 'scroll' event has landed since armScrollDebounceProbe() ran,
  // i.e. the debounce timer is now armed — replacing a fixed dwell that could elapse before
  // the smooth-scroll animation had emitted a single 'scroll' event on a slow/idle run,
  // leaving nothing for __ocDestroy() to leak and letting the test pass vacuously even
  // against a reverted production fix (oculist-tz6 reviewer note). Bounded so a scroll that
  // never emits an event fails loudly instead of hanging.
  async function waitForScrollDebounceArmed() {
    return waitForContentScriptValue(evalInContentScript, 'window.__ocScrollProbeCount', (v) => v > 0, {
      timeout: POLL_TIMEOUT,
      message: 'no scroll event observed — the smooth-scroll debounce timer was never armed',
    });
  }

  // Waits for the redraw count to have gone quiet for QUIET_MS, measured from whichever is
  // later: `sinceMs` (when the close+reopen was kicked off) or the most recent draw.
  // oculist-6jw (issue 2): this used to require `window.__ocRedrawCount > 0` and measure
  // quiet only from the last draw — which depended on match1's own in-view draw landing "by
  // now" to ever become true at all, and, once callers started synchronizing on that draw
  // explicitly beforehand (see the test below), could go stale enough to report "quiet"
  // before a stale draw fired by this bug had a chance to land. Anchoring to `sinceMs`
  // removes both problems: a correct run with zero further draws still settles instead of
  // hanging, and a stale draw arriving after `sinceMs` still pushes the quiet window out.
  async function waitForRedrawCountToSettle(sinceMs) {
    const QUIET_MS = 400;
    await page.waitForFunction(
      (args) => performance.now() - Math.max(args.since, window.__ocRedrawAt) > args.quiet,
      { since: sinceMs, quiet: QUIET_MS },
      { timeout: POLL_TIMEOUT }
    );
    return page.evaluate(() => window.__ocRedrawCount);
  }

  test('close+reopen within an in-flight smooth scroll draws only the legitimate in-view match, never a stale one', async () => {
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
    // scroll branch. Its draw is not immediate: it goes through the same bare 50ms
    // immediate-draw timer the fully-in-viewport branch always arms.
    await page.keyboard.press('Enter');
    // oculist-6jw (issue 2): synchronize on match1's draw explicitly instead of assuming it
    // has landed by some later arbitrary moment. Enter #2 below disowns (but does not
    // cancel) this timer if it is still pending, and __ocDestroy() further down can
    // legitimately cancel a disowned-but-not-yet-fired one — so without waiting here, this
    // draw landing at all (and thus the `count === 1` assertion below being meaningful)
    // would depend on timing rather than being guaranteed.
    await page.waitForFunction(() => window.__ocRedrawCount >= 1, null, { timeout: POLL_TIMEOUT });

    await armScrollDebounceProbe();
    // Enter #2: findNext() to match2 — out of view, takes the smooth-scroll branch and
    // starts a long scrollIntoView animation, arming the 80ms scroll-debounce timer once a
    // real 'scroll' event lands.
    await page.keyboard.press('Enter');
    // oculist-6jw (issue 1): poll until the debounce timer is actually armed instead of a
    // fixed dwell — see waitForScrollDebounceArmed()'s comment for why a fixed sleep can
    // false-negative here.
    await waitForScrollDebounceArmed();

    const closeStartedAt = await page.evaluate(() => performance.now());
    // Close, then reopen, via window.__ocToggle() directly — the same function the Ctrl+F
    // command and the 'toggle'/'destroy' runtime messages invoke. Pre-fix, __ocDestroy()
    // leaves match2's orphaned scroll-debounce timer armed; it fires later and paints a
    // stale border onto the freshly rebuilt, empty overlay this reopen creates.
    await evalInContentScript('window.__ocToggle()'); // destroy
    await evalInContentScript('window.__ocToggle()'); // rebuild

    // Confirm the reopen actually happened (a fresh #oc-wrap/.oc-input exist) before
    // trusting the draw count below — otherwise a failed reopen would pass vacuously.
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    const reopenedInputValue = await page.locator(INPUT).inputValue();
    assert.strictEqual(reopenedInputValue, '', 'the reopened overlay must start with an empty, un-searched input');

    const count = await waitForRedrawCountToSettle(closeStartedAt);

    assert.strictEqual(
      count,
      1,
      'closing and reopening mid-scroll must not leave behind a stale draw for the match the ' +
        'in-flight scroll was navigating to — only the initial in-view match should ever draw'
    );
  });
});
