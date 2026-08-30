// Regression coverage for oculist-rnr.13: the welcome.html setup wizard offers two paths
// to the same color-blindness presets — a named-condition shortcut (Deuteranopia/
// Protanopia/Tritanopia) for a user who already knows their diagnosis, and a sample-
// comparison path for a user who doesn't. Both are legitimate to show in the UI (the human
// decision behind this: OSes name these conditions in their own accessibility settings, so
// removing the vocabulary would be a regression), but neither may ever write the clinical
// string anywhere — only the functional displayPreset/visionSettings values from
// oculist-rnr.12 may reach chrome.storage.sync.
//
// Needs a real browser: welcome.html only boots against a real chrome.storage.sync, and
// this drives the actual wizard UI (real clicks/'change' events, real Tab-key presses)
// rather than seeding storage directly or asserting on the `hidden` attribute, so the
// wiring itself is under test, not just the persisted shape.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { enableAccessibilityDomain, computedAccessibleName } = require('./helpers/accessible_name');

const EXTENSION = path.resolve(__dirname, '../extension');

// Any of these substrings appearing anywhere in the persisted 'oc-settings' object would
// mean a clinical label leaked into storage. Matched case-insensitively against the whole
// JSON blob, not field-by-field, so a leak into an unexpected key is still caught.
const CLINICAL_LEAK_PATTERN = /deuteranopia|protanopia|tritanopia|color[-_]?blind|eye[-_]?strain/i;

describe('Setup wizard does not persist the clinical selection (oculist-rnr.13)', () => {
  let ctx, extId;

  before(async () => {
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 900 },
    });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
    extId = sw.url().split('/')[2];
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  async function openWelcome() {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/welcome.html`);
    await page.waitForSelector('#start-wizard');
    await page.click('#start-wizard');
    await page.waitForSelector('#step-1.active');
    return page;
  }

  function readStoredSettings(page) {
    return page.evaluate(
      () => new Promise((resolve) => chrome.storage.sync.get('oc-settings', (d) => resolve(d['oc-settings'])))
    );
  }

  // Deadline-bounded poll (test/helpers/wait.js) for the async chrome.storage.sync.set()
  // write to land. Deliberately NOT page.waitForFunction(() => chrome.storage.sync.get(...)
  // .then(...)) — confirmed against this Playwright version that a promise-returning
  // predicate resolves on its (truthy) Promise object immediately rather than being awaited,
  // so that pattern passes in ~14ms whether or not the write ever actually happens. This
  // helper instead awaits a real page.evaluate() round trip from Node on every poll tick.
  async function waitForSetupWizardCompleted(page) {
    return waitForCondition(
      () => readStoredSettings(page),
      (stored) => !!(stored && stored.setupWizardCompleted),
      { timeout: POLL_TIMEOUT, message: 'oc-settings.setupWizardCompleted never became true' }
    );
  }

  // Step 2 and Step 3 answers don't matter for most of this file's assertions; clicking
  // each step's first option auto-advances (welcome.js's 300ms setTimeout after 'selected').
  async function clickFirstOptionAndWait(page, stepSelector) {
    await page.waitForSelector(`${stepSelector}.active`);
    await page.click(`${stepSelector}.active .wizard-option`);
    await page.waitForTimeout(400);
  }

  async function finishWizard(page) {
    await page.waitForSelector('#step-4.active');
    await page.click('#wizard-next');
  }

  test('named-condition shortcut (Deuteranopia) persists only the functional preset', async () => {
    const page = await openWelcome();

    // Named panel is the default-visible tab; click the Deuteranopia shortcut directly.
    await page.click('#step1-panel-named .wizard-option[data-value="amber-sky"]');
    await page.waitForTimeout(400);

    await clickFirstOptionAndWait(page, '#step-2');
    await clickFirstOptionAndWait(page, '#step-3');
    await finishWizard(page);

    const stored = await waitForSetupWizardCompleted(page);
    assert.strictEqual(stored.displayPreset, 'rg-adjust-deut', 'the named Deuteranopia shortcut must persist the functional preset key');
    assert.strictEqual(stored.visionSettings.colorPalette, 'amber-sky', 'colorPalette must persist as the functional value, not a clinical one');

    const blob = JSON.stringify(stored);
    assert.doesNotMatch(blob, CLINICAL_LEAK_PATTERN, `persisted oc-settings must contain no clinical string, got: ${blob}`);

    await page.close();
  });

  test('sample-comparison path reaches the same preset as its matching named condition, without persisting a clinical string', async () => {
    const page = await openWelcome();

    // Switch to the sample tab and pick "Sample D" (rose against cyan), which is wired to
    // the same data-value ('rose-cyan') as the named Tritanopia shortcut.
    await page.click('#step1-tab-sample');
    await page.waitForSelector('#step1-panel-sample:not([hidden])');
    await page.click('#step1-panel-sample .wizard-option[data-value="rose-cyan"]');
    await page.waitForTimeout(400);

    await clickFirstOptionAndWait(page, '#step-2');
    await clickFirstOptionAndWait(page, '#step-3');
    await finishWizard(page);

    const stored = await waitForSetupWizardCompleted(page);
    assert.strictEqual(stored.displayPreset, 'by-adjust', 'the sample path must reach the same functional preset as the named Tritanopia shortcut');
    assert.strictEqual(stored.visionSettings.colorPalette, 'rose-cyan');

    const blob = JSON.stringify(stored);
    assert.doesNotMatch(blob, CLINICAL_LEAK_PATTERN, `persisted oc-settings must contain no clinical string, got: ${blob}`);

    await page.close();
  });

  test('the inactive step-1 panel is genuinely display:none, not merely carrying the hidden attribute', async () => {
    const page = await openWelcome();

    // Default state: named panel is the active tab, so the sample panel must be the one
    // computed as display:none. Asserting the attribute alone (hidden === true) would have
    // passed even with the broken markup where an author-origin `display: flex` on
    // .wizard-options beat the UA `[hidden] { display: none }` rule.
    const initialDisplays = await page.evaluate(() => ({
      named: getComputedStyle(document.getElementById('step1-panel-named')).display,
      sample: getComputedStyle(document.getElementById('step1-panel-sample')).display,
    }));
    assert.notStrictEqual(initialDisplays.named, 'none', 'the active named panel must actually render');
    assert.strictEqual(initialDisplays.sample, 'none', 'the inactive sample panel must be computed display:none while its tab is not selected');

    // Switch tabs; now the named panel must be the one computed as display:none.
    await page.click('#step1-tab-sample');
    const afterSwitchDisplays = await page.evaluate(() => ({
      named: getComputedStyle(document.getElementById('step1-panel-named')).display,
      sample: getComputedStyle(document.getElementById('step1-panel-sample')).display,
    }));
    assert.strictEqual(afterSwitchDisplays.named, 'none', 'the now-inactive named panel must become computed display:none');
    assert.notStrictEqual(afterSwitchDisplays.sample, 'none', 'the now-active sample panel must actually render');

    await page.close();
  });

  test('real Tab-key navigation skips every button in the inactive step-1 panel', async () => {
    const page = await openWelcome();

    // Named panel is active by default; sample panel is inactive. Focus the last named
    // option and press Tab once — if the sample panel's buttons were still in the tab
    // order (the display:flex-beats-[hidden] bug), focus would land on one of them next,
    // not on the wizard's Next button.
    await page.locator('#step1-panel-named .wizard-option').last().focus();
    await page.keyboard.press('Tab');
    const activeIdAfterNamed = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert.strictEqual(
      activeIdAfterNamed,
      'wizard-next',
      'Tab from the last named option must skip the entire hidden sample panel and land on Next'
    );

    // Switch tabs; now the sample panel is active and the named panel is inactive. Tabbing
    // past the last sample option must not land on any named-panel option either.
    await page.click('#step1-tab-sample');
    await page.locator('#step1-panel-sample .wizard-option').last().focus();
    await page.keyboard.press('Tab');
    const activeIdAfterSample = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert.strictEqual(
      activeIdAfterSample,
      'wizard-next',
      'Tab from the last sample option must skip the entire hidden named panel and land on Next'
    );

    await page.close();
  });

  test('every step 1 option, named or sample, is keyboard reachable with a descriptive accessible name', async () => {
    const page = await openWelcome();
    const client = await ctx.newCDPSession(page);
    await enableAccessibilityDomain(client);

    // Named panel: buttons are real <button> elements, inherently keyboard-reachable
    // (Tab-focusable, Enter/Space-activatable) with no tabindex overrides.
    const namedName = await computedAccessibleName(client, `document.querySelector('#step1-panel-named .wizard-option[data-value="amber-sky"]')`);
    assert.match(namedName, /Deuteranopia/, 'the named shortcut keeps its clinical accessible name');

    // Sample panel is hidden (via the `hidden` attribute, now correctly display:none) until
    // its tab is selected. Once shown, every sample button must expose a computed name
    // describing the visible result/decision rule, not just a color word, and must not
    // depend on discriminating the colors themselves.
    await page.click('#step1-tab-sample');
    await page.waitForSelector('#step1-panel-sample:not([hidden])');

    const sampleValues = ['none', 'amber-sky', 'amber-indigo', 'rose-cyan'];
    for (const value of sampleValues) {
      const name = await computedAccessibleName(
        client,
        `document.querySelector('#step1-panel-sample .wizard-option[data-value="${value}"]')`
      );
      assert.ok(name && name.length > 0, `sample option ${value} must have a non-empty accessible name`);
      assert.match(name, /Sample [A-Z]/, `sample option ${value} must identify itself by a non-color label (got: ${name})`);
      assert.match(
        name,
        /clearly separated|clearest separation/,
        `sample option ${value} must describe the visible result/decision rule, not just name a color (got: ${name})`
      );
    }

    // Tabs themselves must be keyboard reachable too — real <button role="tab"> elements.
    const tabName = await computedAccessibleName(client, `document.querySelector('#step1-tab-sample')`);
    assert.ok(tabName && tabName.length > 0, 'the "compare samples" tab must have a non-empty accessible name');

    await page.close();
  });

  test('running the wizard a second time works with no page error, and the banner reflects the new choice', async () => {
    const page = await openWelcome();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    // First run: pick the low-vision profile (step 2 "yes"), color-blind "none".
    await page.click('#step1-panel-named .wizard-option[data-value="none"]');
    await page.waitForTimeout(400);
    await page.waitForSelector('#step-2.active');
    await page.click('#step-2.active .wizard-option[data-value="true"]');
    await page.waitForTimeout(400);
    await clickFirstOptionAndWait(page, '#step-3');
    await finishWizard(page);

    const firstStored = await waitForSetupWizardCompleted(page);
    assert.strictEqual(firstStored.displayPreset, 'high-contrast', 'first run must persist the low-vision preset');

    const firstBannerText = await page.locator('#wizard-hero-banner').innerText();
    assert.match(firstBannerText, /Low.?Vision/i, 'the completion banner must reflect the first run\'s choice');

    // Second run, via the "Run Setup Again" affordance the completion banner adds. This is
    // exactly the path that threw (Cannot read properties of null (reading 'parentElement'))
    // when saveProfileAndFinish() re-queried #start-wizard after its own innerHTML rewrite
    // had already destroyed it.
    await page.click('#rerun-wizard');
    await page.waitForSelector('#step-1.active');

    // Re-opening must have reset step 1 back to the named tab and its default answer, not
    // silently inherited the prior run's "low-vision: yes" for step 2 if the user clicks
    // past it with Next.
    const namedTabActive = await page.evaluate(() => document.getElementById('step1-tab-named').classList.contains('active'));
    assert.strictEqual(namedTabActive, true, 're-opening the wizard must reset step 1 back to the named-condition tab');

    await page.click('#step1-panel-named .wizard-option[data-value="rose-cyan"]');
    await page.waitForTimeout(400);
    await clickFirstOptionAndWait(page, '#step-2');
    await clickFirstOptionAndWait(page, '#step-3');
    await finishWizard(page);

    const secondStored = await waitForCondition(
      () => readStoredSettings(page),
      (stored) => !!(stored && stored.displayPreset === 'by-adjust'),
      { timeout: POLL_TIMEOUT, message: 'second run never persisted the expected by-adjust preset' }
    );
    assert.strictEqual(secondStored.displayPreset, 'by-adjust', 'second run must persist its own (different) choice');
    // Second run's step 2 answer defaulted back to "no" (the reset default), so the profile
    // becomes the Tritanopia one chosen in step 1, not low-vision surviving from the first run.
    assert.strictEqual(secondStored.visionSettings.beaconSize, 'l', 'second run must not inherit first run\'s beaconSize (xl from low-vision)');

    const secondBannerText = await page.locator('#wizard-hero-banner').innerText();
    assert.match(secondBannerText, /Tritanopia/i, 'the completion banner must reflect the second run\'s choice, not the first');
    assert.doesNotMatch(secondBannerText, /Low.?Vision/i, 'the completion banner must not still advertise the first run\'s profile');

    assert.deepStrictEqual(pageErrors, [], `re-running the wizard must not throw: ${pageErrors.map((e) => e.message).join('; ')}`);

    await page.close();
  });
});
