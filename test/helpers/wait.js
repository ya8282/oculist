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
