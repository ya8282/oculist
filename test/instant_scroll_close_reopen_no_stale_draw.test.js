// Regression (oculist-44y, Site A): same hazard family as oculist-rbx (3ddc082),
// oculist-tz6 (80f2a30), and oculist-7uc (3ab9005), but at a fourth site — the bare
// `setTimeout(function () { animate(freshRect); }, 50)` in highlightActiveRange()'s
// instant-scroll-behavior sub-branch (the `behavior !== 'smooth'` else, taken when
// settings.scrollBehavior === 'instant'). Unlike the smooth-scroll branch a few lines
// above, this timer had no module-level handle at all — nothing for any teardown to
// reach, so neither __ocDestroy() nor a superseding navigation could cancel it.
//
// scrollBehavior: 'instant' is user-selectable from the settings panel (the
// 'smooth'/'instant' option group next to i18n.scrollBehavior), so this path is
// reachable from normal UI, not just theoretically.
//
// Reachable in practice via the same window.__ocToggle() close+reopen path as
// oculist-tz6: element.scrollIntoView({behavior:'auto', ...}) jumps synchronously, but
// the bare 50ms timer that draws the border afterward is still pending. Closing and
// reopening within that window (__ocToggle() calls __ocDestroy() then buildUI() in the
// same module instance) pre-fix left the orphaned timer to paint a stale border onto
// the freshly rebuilt, empty overlay.
//
// Needs a real browser for the same reasons as the sibling stale-draw tests: real
// layout/scrolling and 'scrollend' don't exist in jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForContentScriptValue } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// m1 is in view at load (no scroll branch, exercises the ordinary in-viewport draw).
// mfar sits 6000px below so it needs a scroll; distance itself is irrelevant to this
// bug (an 'auto' scrollIntoView jumps synchronously regardless of distance) but keeps
// it safely out of the initial viewport.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p id="m1">quarklet</p>
<div style="height:6000px"></div>
<p id="mfar">quarklet</p>
<div style="height:6000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('closing and reopening within an instant-behavior scroll draws only the legitimate match (oculist-44y)', () => {
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

  async function setSettings(patch) {
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, ' + JSON.stringify(patch) + ');' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
  }

  // Same rationale as the sibling stale-draw tests: borderStyle:'thick' with the
  // magnifier/labels off leaves exactly one non-transient `.oc-beacon` (the border)
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
  // overlay (`.oc-beacon`, no id) lands in the DOM, and records the timestamp of the
  // most recent one so callers can wait for the count to go quiet instead of guessing a
  // fixed duration.
  async function armRedrawCounter() {
    await page.evaluate(() => {
      window.__ocRedrawCount = 0;
      window.__ocRedrawAt = performance.now();
      if (window.__ocRedrawObserver) window.__ocRedrawObserver.disconnect();
      window.__ocRedrawObserver = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1 || !n.classList) continue;
            if (n.classList.contains('oc-beacon') && !n.classList.contains('oc-beacon-transient') && !n.id) {
              window.__ocRedrawCount++;
              window.__ocRedrawAt = performance.now();
            }
          }
        }
      });
      window.__ocRedrawObserver.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  async function waitForRedrawCountToSettle() {
    // No numeric margin here at all: the setTimeout patch below arms a sibling timer at
    // the same instant and with the same stretched delay as mfar's orphan draw timer.
    // Same-delay setTimeout calls fire in the order they were registered (verified
    // separately, see oculist-4z3's report — 0/200 violations at a 50ms delay and 0/15 at
    // the actual 4000ms stretch used here, across plain Chromium pages), so the sibling
    // firing proves the orphan's slot has already come and gone, whether or not the
    // orphan itself actually fired (i.e. whether or not it was cancelled). That is a
    // structural guarantee, not a guess at how much overhead to budget for.
    //
    // The sibling reports back through window.__ocSiblingFired, a plain isolated-world
    // global — not a DOM mutation. The setTimeout patch runs in the same isolated world
    // as this flag, so no cross-world signaling is needed at all here (unlike the
    // .oc-beacon redraw counter above, which does have to cross from the isolated world's
    // real DOM insertions into this main-world MutationObserver).
    // If the patched setTimeout was never called with delay===50 (e.g. the instant-scroll
    // branch wasn't taken, or the patch failed to intercept it), __ocSiblingFired stays
    // false forever and this fails loudly and promptly instead of hanging or silently
    // passing.
    await waitForContentScriptValue(evalInContentScript, 'window.__ocSiblingFired === true', (v) => v === true, {
      timeout: POLL_TIMEOUT,
      message: 'the stretched instant-draw sibling timer never fired (no delay===50 setTimeout ' +
        'call observed, or the patch failed to intercept it) — nothing proves the orphan\'s slot has passed.',
    });
    return page.evaluate(() => window.__ocRedrawCount);
  }

  test('close+reopen within an in-flight instant scroll draws only the legitimate in-view match, never a stale one', async () => {
    await setSettings({ scrollBehavior: 'instant' });
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

    // Enter #1: commits the typed term as a chip, landing on m1 — already in view, no
    // scroll branch, draws once.
    await page.keyboard.press('Enter');
    // Wait for m1's own inViewDrawTimer to actually fire before moving on, so the count
    // below isolates this bug (mfar's orphaned instant-branch timer) instead of
    // conflating it with a second, still-pending in-viewport draw of its own (oculist-44y
    // Site B, covered by its own regression test). A fixed sleep here races: Enter #2's
    // own instant-behavior branch calls clearActiveImmediateDrawTimer() on entry, which
    // CANCELS (not merely delays) m1's still-pending 50ms timer if it hasn't fired yet —
    // silently dropping m1's legitimate draw rather than just running it late. Waiting
    // for the counter to actually observe that draw proves the timer fired for real.
    await page.waitForFunction(() => window.__ocRedrawCount > 0, null, { timeout: POLL_TIMEOUT });

    // Stretch the isolated world's own window.setTimeout so any 50ms call armed from here
    // on (mfar's own instant-draw timer, below) actually fires much later. This test's
    // whole point is that __ocDestroy() must cancel that timer while it is still pending —
    // for that to mean anything, destroy() has to genuinely run before the timer fires,
    // and racing a real 50ms browser timer against two CDP round trips (destroy, then
    // rebuild) under concurrency is a wall-clock coin flip, not a property of the code
    // under test. Stretching the delay buys destroy() a deterministic, generous window to
    // win that race every time; clearTimeout() on the (now longer) timer cancels it just as
    // completely regardless of how much delay was left, so what happens when the timer
    // fires — or gets cancelled — is exercised exactly as before, just decoupled from how
    // fast this run's CDP round trips happen to be. m1's own draw above already fired on
    // the real, unpatched 50ms, so this is scoped to only the timer armed after it.
    await evalInContentScript(`
      (function () {
        if (window.__ocStretchedInstantTimerInstalled) return true;
        window.__ocStretchedInstantTimerInstalled = true;
        window.__ocSiblingFired = false;
        var orig = window.setTimeout;
        window.setTimeout = function (fn, delay) {
          var stretched = (delay === 50) ? 4000 : delay;
          var args = [fn, stretched].concat(Array.prototype.slice.call(arguments, 2));
          var handle = orig.apply(window, args);
          if (delay === 50) {
            // Arm a sibling timer immediately after the orphan, with the exact same
            // (stretched) delay, no synchronous work between the two orig.apply/orig
            // calls. Same-delay timers fire in registration order, so this sibling
            // firing proves the orphan's slot has passed — whether or not the orphan
            // itself actually fired — without guessing at any margin for it. See
            // waitForRedrawCountToSettle() above for how this flag is consumed.
            orig(function () { window.__ocSiblingFired = true; }, stretched);
          }
          return handle;
        };
        return true;
      })()
    `);

    // Enter #2: findNext() to mfar — out of view, takes the instant-behavior branch,
    // jumps synchronously, and arms the bare draw timer under test (now stretched above).
    await page.keyboard.press('Enter');

    // Close, then reopen, via window.__ocToggle() directly — the same function the
    // Ctrl+F command and the 'toggle'/'destroy' runtime messages invoke, well within
    // mfar's 50ms window. Pre-fix, __ocDestroy() leaves that orphaned timer armed; it
    // fires later and paints a stale border onto the freshly rebuilt, empty overlay.
    await evalInContentScript('window.__ocToggle()'); // destroy
    await evalInContentScript('window.__ocToggle()'); // rebuild

    // Confirm the reopen actually happened (a fresh #oc-wrap/.oc-input exist) before
    // trusting the draw count below — otherwise a failed reopen would pass vacuously.
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    const reopenedInputValue = await page.locator(INPUT).inputValue();
    assert.strictEqual(reopenedInputValue, '', 'the reopened overlay must start with an empty, un-searched input');

    const count = await waitForRedrawCountToSettle();

    assert.strictEqual(
      count,
      1,
      'closing and reopening mid instant-scroll must not leave behind a stale draw for the ' +
        'match the in-flight scroll was navigating to — only the initial in-view match should ever draw'
    );
  });
});
