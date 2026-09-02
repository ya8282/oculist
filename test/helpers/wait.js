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

module.exports = { waitForCondition, waitForContentScriptValue, TIMEOUT_SCALE, POLL_TIMEOUT, LONG_TIMEOUT };
