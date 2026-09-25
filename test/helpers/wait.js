// Generic condition poller for assertions that cannot use page.waitForFunction() directly
// (e.g. state read via CDP Runtime.evaluate against a content script's isolated execution
// context, or state that lives on the Node side of the test rather than in the page).
//
// For anything reachable from the page's main world, prefer page.waitForFunction() itself
// (the existing convention in this suite) — this helper exists for the isolated-world and
// Node-side cases that convention can't reach.
//
// This does not replace `assert` — it only waits for `predicate(value)` to become true (or
// times out) and returns the last observed value so the caller can still assert on it.
// Timeout budget knob: default 1 keeps the budget tight so a genuine regression still
// surfaces quickly as a timeout. Set OCULIST_TEST_TIMEOUT_SCALE=3 (e.g. `OCULIST_TEST_TIMEOUT_SCALE=3 npm test`)
// to buy headroom on a contended box or in CI without changing a single assertion.
const parsedScale = Number(process.env.OCULIST_TEST_TIMEOUT_SCALE);
const TIMEOUT_SCALE = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;
const POLL_TIMEOUT = 5000 * TIMEOUT_SCALE;
const LONG_TIMEOUT = 15000 * TIMEOUT_SCALE;

// oculist-8ou: TIMEOUT_SCALE above only reaches this suite's own POLL_TIMEOUT/LONG_TIMEOUT
// waits. It does not touch Playwright's default action timeout (a fixed 30000ms applied to
// any locator call, e.g. .fill()/.click(), that doesn't pass an explicit timeout), so a
// contended box can still time out at a fixed 30s even with the scale turned up.
//
// Every one of the ~51 test files that opens a browser does so via
// chromium.launchPersistentContext(...) and all of them already require this file for
// POLL_TIMEOUT/LONG_TIMEOUT, so patching launchPersistentContext once here, to set the new
// context's default timeout to the same scaled budget, covers every call site without
// editing each test file individually. At the default scale of 1 this sets 30000ms, which is
// Playwright's existing default, so unscaled behavior is unchanged.
const { chromium } = require('playwright');
const DEFAULT_ACTION_TIMEOUT = 30000;
const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (...args) => {
  const ctx = await originalLaunchPersistentContext(...args);
  ctx.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT * TIMEOUT_SCALE);
  return ctx;
};

async function waitForCondition(getValue, predicate, opts = {}) {
  const { timeout = POLL_TIMEOUT, interval = 30, message } = opts;
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await getValue();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      const detail = message ? `${message} ` : '';
      throw new Error(
        `${detail}waitForCondition timed out after ${timeout}ms; last observed value: ${JSON.stringify(last)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// Convenience wrapper for the common case of polling a value read out of the content
// script's isolated execution context via an `evalInContentScript(expression)` function
// (see the CDP Runtime.evaluate helper each *.test.js file defines locally).
async function waitForContentScriptValue(evalInContentScript, expression, predicate, opts = {}) {
  return waitForCondition(() => evalInContentScript(expression), predicate, opts);
}

// popup.html's own DOMContentLoaded handler (extension/popup.js) attaches every `change`
// listener it registers — #vision-profile, #magnifier, #beacon-size, etc. — before its
// first `await` (a `chrome.storage.sync.get('oc-settings')` round trip) resolves. A caller
// that only waits for a control to exist in the DOM (true from HTML parse time, via e.g.
// `page.waitForSelector('#vision-profile')`) can still be racing that pending promise: if a
// driven `change` event (Playwright's selectOption()/fill() etc. all dispatch one) lands on
// the control before its listener is attached, the event is dropped for good — browsers do
// not queue or replay it — and the application code that would have run silently never does,
// with no error and no timeout at the point of the drop; only a caller polling the outcome
// times out later, mis-diagnosing what actually failed.
//
// #status-text starts as the literal 'Checking...' (popup.html) and is only ever overwritten
// by the tail of that same DOMContentLoaded handler — every branch (the 'Restricted' /
// 'Unavailable' early-returns and updateUI()'s 'Enabled'/'Disabled') rewrites it.
//
// WHAT THIS DOES AND DOES NOT PROVE. Every branch sits below the `chrome.tabs.query` await,
// so once the text reads anything other than 'Checking...', every listener registered above
// that await is attached. That covers the settings controls: #vision-profile, the custom
// controls, the colour pickers. It does NOT cover #toggle-site, whose listener is registered
// after updateUI(): on the 'Restricted' and 'Unavailable' early-return paths that listener is
// never attached at all, and this helper still reports ready. In the extension test fixtures
// #status-text commonly resolves to 'Unavailable', so that path is the normal one, not an
// edge case. Before driving #toggle-site, wait for something that proves its own listener.
//
// Call this once, right after opening popup.html and waiting for the control(s) you'll drive
// to exist, and before driving any of them — not per-assertion. Once listener wiring is
// proven, the assertions that follow need no further wait of their own.
async function waitForPopupReady(popup, opts = {}) {
  const { timeout = POLL_TIMEOUT } = opts;
  await popup.waitForFunction(
    () => document.getElementById('status-text').textContent !== 'Checking...',
    null,
    { timeout }
  );
}

// content.js's own handleResize() (extension/content.js, near "function handleResize")
// debounces repositionActiveOverlays() 100ms behind overlayResizeTimer. Call this INSTEAD
// of page.setViewportSize(viewport) (it makes the call itself) rather than after a fixed
// page.waitForTimeout(200): a fixed sleep can lose the race against the debounce on a
// loaded machine.
//
// Two earlier designs of this helper (both oculist-l9sg, both measured wrong, not just
// theorized) inferred "settled" from a TIME budget or from a size/count snapshot that could
// already be stale by the time it was read:
// - v1 treated window.innerWidth/innerHeight already matching the new size as proof
//   handling had happened. Wrong: those flip to the new value as soon as the CDP-level
//   resize lands, before the 'resize' event ever reaches handleResize() -- the wait
//   returned instantly, before any debounce ran at all.
// - v2 added a lastResizeSettledSize written by the debounce's own callback, and waited for
//   it to match the target size. Still wrong: if an EARLIER resize's debounce was still
//   pending when this setViewportSize landed, that earlier debounce goes on to write the
//   new size (matching by coincidence) before the new resize event is even handled -- the
//   wait returned early. Measured with a 1200ms handleResize delay: 4 of 9 calls returned
//   early.
//
// v3 (this version) polls three facts together, none of which can be true early:
//   1. getOverlayResizeTimer() === null -- nothing currently pending.
//   2. getSettledResizeEvent() === getResizeEventCount() -- the debounce has actually run to
//      completion for the MOST RECENT resize event counted, not some earlier one.
//   3. window.innerWidth/innerHeight match the requested viewport.
// (2) alone is still ambiguous the instant after setViewportSize returns: if the debounce
// from a PRIOR resize had already settled before this call, count and settled can already
// be equal, and (3) can already read true (same CDP-level flip v1 hit), even though the
// 'resize' event this call caused has not been dispatched yet. So this helper additionally
// requires the event count to have advanced by at least 1 since before setViewportSize was
// called, whenever the size is actually changing -- closing exactly the gap that made (2)
// insufficient on its own. When the size does NOT change (a same-size no-op resize, which
// fires no 'resize' event at all), that extra requirement is skipped, so the wait can still
// resolve immediately instead of hanging until timeout.
//
// v3 was still wrong for one more state (review fix, oculist-l9sg): a caller in a finally
// block after the overlay has already closed (__ocDestroy() has run, or never opened this
// test at all). handleResize's own 'resize' listener is only attached between __ocToggle()'s
// open branch and __ocDestroy() -- unlike the page-lifetime listener that drives
// resizeEventCount -- so while closed, settledResizeEvent never advances to meet
// resizeEventCount and (2) above waits for something that can never become true, timing out
// for no real problem. window.__ocTest.isHandleResizeAttached() tells the two states apart:
// while detached, this only waits for the plain physical facts a torn-down handler can still
// guarantee -- no pending timer (__ocDestroy() clears it) and the size itself has landed --
// and skips the count/settled check entirely.
async function waitForOverlayResizeSettled(page, evalInContentScript, viewport, opts = {}) {
  const { timeout = POLL_TIMEOUT } = opts;
  const before = await evalInContentScript(
    `({ count: window.__ocTest.getResizeEventCount(), w: window.innerWidth, h: window.innerHeight })`
  );
  await page.setViewportSize(viewport);
  const sizeChanging = before.w !== viewport.width || before.h !== viewport.height;
  const minCount = before.count + (sizeChanging ? 1 : 0);
  await waitForContentScriptValue(
    evalInContentScript,
    `(function () {
       var timer = window.__ocTest.getOverlayResizeTimer();
       var sizeOk = window.innerWidth === ${viewport.width} && window.innerHeight === ${viewport.height};
       if (!window.__ocTest.isHandleResizeAttached()) {
         return timer === null && sizeOk;
       }
       var count = window.__ocTest.getResizeEventCount();
       var settled = window.__ocTest.getSettledResizeEvent();
       return timer === null && sizeOk && count >= ${minCount} && settled === count;
     })()`,
    Boolean,
    {
      timeout,
      message: `overlay resize never settled at ${viewport.width}x${viewport.height}`
    }
  );
}

module.exports = {
  waitForCondition,
  waitForContentScriptValue,
  waitForPopupReady,
  waitForOverlayResizeSettled,
  TIMEOUT_SCALE,
  POLL_TIMEOUT,
  LONG_TIMEOUT
};
