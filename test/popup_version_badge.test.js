// Regression guard for oculist-6iu: popup.html used to hardcode 'v1.5.0' in its version
// badge while extension/manifest.json's real version had moved on to 1.7.0 — every user
// opening the toolbar popup saw the wrong version, and it was legible in a store-bound
// screenshot. The fix sources the badge at runtime from chrome.runtime.getManifest().version
// (popup.js) into #version-text (popup.html). No test asserted on it (oculist-rnr.7).
//
// The expected value is read straight out of extension/manifest.json here (the same file
// chrome.runtime.getManifest() itself is built from), never a literal — an assertion against
// a hardcoded 'v1.7.0' would recreate the exact defect this guards against, passing today
// and failing (or being "fixed" by editing the literal) at the next version bump.
//
// Needs a real browser — popup.html only boots against a real chrome.runtime.getManifest().

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

describe('Popup version badge tracks the real manifest version', () => {
  let ctx, extId;

  before(async () => {
    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
    extId = sw.url().split('/')[2];
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  test('the rendered badge equals "v" + the manifest version, and is never blank', async () => {
    // Read the manifest directly off disk — independent of whatever chrome.runtime.getManifest()
    // reports inside the page — so a drift between the two would also be caught, not just a
    // stale literal in this test.
    const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8'));
    const expected = `v${manifest.version}`;

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);

    // DOMContentLoaded's version-text assignment is synchronous, but poll for it rather than
    // trusting timing — this is the exact condition a blank badge (broken id wiring) or a
    // dropped assignment (removed textContent write) would fail.
    const badgeText = await waitForCondition(
      () => popup.locator('#version-text').textContent(),
      (v) => !!v,
      { timeout: POLL_TIMEOUT, message: 'the version badge (#version-text) never became non-empty' }
    );

    assert.notStrictEqual(badgeText, '', 'the version badge must never render blank');
    assert.strictEqual(badgeText, expected, `the rendered badge must equal 'v' + the manifest version (${expected})`);

    await popup.close();
  });
});
