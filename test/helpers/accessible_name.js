// Reads the COMPUTED accessible name (the accname the browser's own accessibility tree
// would hand a screen reader) rather than the raw aria-label attribute. Regressions where
// name-computation precedence shifts (e.g. an aria-labelledby appearing, or text content
// winning over aria-label) change the computed name without necessarily changing the
// attribute, so asserting on getAttribute('aria-label') alone would miss exactly that class
// of bug (oculist-l6m.36).
//
// Uses the CDP Accessibility domain (Accessibility.getPartialAXTree keyed off a Runtime
// RemoteObjectId), the same mechanism a prior reviewer verified by hand against this
// extension's shadow-DOM overlay. Accessibility.getPartialAXTree accepts an `objectId`
// directly, so no separate DOM.requestNode round trip is needed — but DOM.enable + one
// DOM.getDocument call must have run first, or CDP has no document tree to resolve nodes
// against at all.
//
// The Runtime.evaluate expression passed in MUST run in the page's default (main) world,
// not a content script's isolated execution context — the shadow DOM node itself lives in
// the one real page document; only content.js's own JS state is isolated. Do not pass a
// contextId pointing at an isolated world here.
const { waitForCondition, POLL_TIMEOUT } = require('./wait');

async function enableAccessibilityDomain(client) {
  await client.send('Accessibility.enable');
  await client.send('DOM.enable');
  await client.send('DOM.getDocument');
}

// expression must evaluate (in the page's main world) to the element whose computed name
// is wanted. Throws — rather than returning undefined — if the expression resolves to no
// element, so a selector typo surfaces as a loud failure instead of a silently-vacuous pass.
async function computedAccessibleName(client, expression) {
  const evalResult = await client.send('Runtime.evaluate', { expression, returnByValue: false });
  if (evalResult.exceptionDetails) {
    throw new Error('computedAccessibleName(): expression threw: ' + JSON.stringify(evalResult.exceptionDetails));
  }
  if (!evalResult.result || !evalResult.result.objectId) {
    throw new Error('computedAccessibleName(): expression resolved to no element: ' + expression);
  }
  const ax = await client.send('Accessibility.getPartialAXTree', {
    objectId: evalResult.result.objectId,
    fetchRelatives: false,
  });
  const axNode = ax.nodes && ax.nodes[0];
  return axNode && axNode.name ? axNode.name.value : undefined;
}

// Polls computedAccessibleName() until it resolves to `expected` or times out. Tolerates
// the expression resolving to no element yet (e.g. the chip hasn't rendered) by treating
// that as "not yet equal" rather than failing immediately, since callers use this to wait
// out an in-flight render/rescan.
async function waitForComputedAccessibleName(client, expression, expected, opts = {}) {
  return waitForCondition(
    async () => {
      try {
        return await computedAccessibleName(client, expression);
      } catch (e) {
        return undefined;
      }
    },
    (value) => value === expected,
    { timeout: POLL_TIMEOUT, message: `computed accessible name never became ${JSON.stringify(expected)}`, ...opts }
  );
}

module.exports = { enableAccessibilityDomain, computedAccessibleName, waitForComputedAccessibleName };
