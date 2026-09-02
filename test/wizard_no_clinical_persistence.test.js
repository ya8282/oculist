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
const { readStoredSettings } = require('./helpers/storage');
const { enableAccessibilityDomain, computedAccessibleName } = require('./helpers/accessible_name');

const EXTENSION = path.resolve(__dirname, '../extension');

// Any of these substrings appearing anywhere in the persisted 'oc-settings' object would
// mean a clinical label leaked into storage. Matched case-insensitively against the whole
// JSON blob, not field-by-field, so a leak into an unexpected key is still caught.
const CLINICAL_LEAK_PATTERN = /deuteranopia|protanopia|tritanopia|color[-_]?blind|eye[-_]?strain/i;

describe('Setup wizard does not persist the clinical selection (oculist-rnr.13)', () => {
  let ctx, extId, sw;

  before(async () => {
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 900 },
    });
    sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
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

  // oculist-l6g: setupWizardCompleted goes true on the first wizard run in this file (test
  // 1) and STAYS true, so waitForSetupWizardCompleted's poll is vacuous for every test after
  // it — it can return immediately with whatever a PRIOR test left in storage, before the
  // current test's own write has landed. Test 1 itself doesn't need this (storage is
  // genuinely empty on the file's first run). Same defect and same fix oculist-leu applied
  // to wizard_low_vision_palette_overlay.test.js: reset storage before the wizard run whose
  // completion the test is about to poll for, rather than gating the poll on a value unique
  // to the case (which would collapse the assertion into the wait predicate).
  async function resetStoredSettings() {
    await sw.evaluate(() => new Promise((resolve) => chrome.storage.sync.remove('oc-settings', resolve)));
  }

  // Step 2 and Step 3 answers don't matter for most of this file's assertions; clicking
  // each step's first option auto-advances (welcome.js's 300ms setTimeout after 'selected').
  // oculist-l6g: nextStepSelector replaces a page.waitForTimeout(400) pad with the real signal
  // for that auto-advance landing — the next step's .active class, the only rule that makes a
  // step render ('.wizard-step.active { display: flex }', welcome.html:117). Same move as
  // oculist-leu's clickAndAdvance().
  async function clickFirstOptionAndWait(page, stepSelector, nextStepSelector) {
    await page.waitForSelector(`${stepSelector}.active`);
    await page.click(`${stepSelector}.active .wizard-option`);
    await page.waitForSelector(nextStepSelector);
  }

  async function finishWizard(page) {
    await page.waitForSelector('#step-4.active');
    await page.click('#wizard-next');
  }

  test('named-condition shortcut (Deuteranopia) persists only the functional preset', async () => {
    const page = await openWelcome();

    // Named panel is the default-visible tab; click the Deuteranopia shortcut directly.
    await page.click('#step1-panel-named .wizard-option[data-value="amber-sky"]');
    await page.waitForSelector('#step-2.active');

    await clickFirstOptionAndWait(page, '#step-2', '#step-3.active');
    await clickFirstOptionAndWait(page, '#step-3', '#step-4.active');
    await finishWizard(page);

    const stored = await waitForSetupWizardCompleted(page);
    assert.strictEqual(stored.displayPreset, 'rg-adjust-deut', 'the named Deuteranopia shortcut must persist the functional preset key');
    assert.strictEqual(stored.visionSettings.colorPalette, 'amber-sky', 'colorPalette must persist as the functional value, not a clinical one');

    const blob = JSON.stringify(stored);
    assert.doesNotMatch(blob, CLINICAL_LEAK_PATTERN, `persisted oc-settings must contain no clinical string, got: ${blob}`);

    await page.close();
  });

  test('sample-comparison path reaches the same preset as its matching named condition, without persisting a clinical string', async () => {
    // oculist-l6g: must run before openWelcome() so the completion poll below never reads
    // test 1's setupWizardCompleted=true (see resetStoredSettings() for why that matters).
    await resetStoredSettings();

    const page = await openWelcome();

    // Switch to the sample tab and pick "Sample D" (rose against cyan), which is wired to
    // the same data-value ('rose-cyan') as the named Tritanopia shortcut.
    await page.click('#step1-tab-sample');
    await page.waitForSelector('#step1-panel-sample:not([hidden])');
    await page.click('#step1-panel-sample .wizard-option[data-value="rose-cyan"]');
    await page.waitForSelector('#step-2.active');

    await clickFirstOptionAndWait(page, '#step-2', '#step-3.active');
    await clickFirstOptionAndWait(page, '#step-3', '#step-4.active');
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

    // This only checks the tab's accessible name, not its keyboard reachability — under
    // roving tabindex (oculist-rnr.19) the unselected tab has no Tab stop of its own; see the
    // ArrowRight/ArrowLeft, Home/End, and arrow-then-Tab tests below for that guarantee.
    const tabName = await computedAccessibleName(client, `document.querySelector('#step1-tab-sample')`);
    assert.ok(tabName && tabName.length > 0, 'the "compare samples" tab must have a non-empty accessible name');

    await page.close();
  });

  test('ArrowRight/ArrowLeft on the step-1 tablist move focus, selection, roving tabindex, and panel visibility, wrapping between the two tabs (oculist-rnr.19)', async () => {
    const page = await openWelcome();

    async function tabState() {
      return page.evaluate(() => ({
        activeId: document.activeElement && document.activeElement.id,
        namedSelected: document.getElementById('step1-tab-named').getAttribute('aria-selected'),
        sampleSelected: document.getElementById('step1-tab-sample').getAttribute('aria-selected'),
        namedTabIndex: document.getElementById('step1-tab-named').getAttribute('tabindex'),
        sampleTabIndex: document.getElementById('step1-tab-sample').getAttribute('tabindex'),
        namedDisplay: getComputedStyle(document.getElementById('step1-panel-named')).display,
        sampleDisplay: getComputedStyle(document.getElementById('step1-panel-sample')).display,
      }));
    }

    // Named tab is selected (and is the tablist's sole tabindex="0" stop) by default; focus
    // it directly the way a real Tab keypress into the tablist would land here.
    await page.locator('#step1-tab-named').focus();

    await page.keyboard.press('ArrowRight');
    let state = await tabState();
    assert.strictEqual(state.activeId, 'step1-tab-sample', 'ArrowRight must move DOM focus to the sample tab');
    assert.strictEqual(state.sampleSelected, 'true', 'ArrowRight must select the sample tab');
    assert.strictEqual(state.namedSelected, 'false', 'ArrowRight must deselect the named tab');
    assert.strictEqual(state.sampleTabIndex, '0', 'the newly selected sample tab must become the roving tabindex="0" stop');
    assert.strictEqual(state.namedTabIndex, '-1', 'the newly deselected named tab must become tabindex="-1"');
    assert.notStrictEqual(state.sampleDisplay, 'none', 'the sample panel must actually render once ArrowRight selects its tab');
    assert.strictEqual(state.namedDisplay, 'none', 'the named panel must become computed display:none once ArrowRight deselects its tab');

    // Only two tabs exist, so ArrowRight again must wrap back around to the named tab.
    await page.keyboard.press('ArrowRight');
    state = await tabState();
    assert.strictEqual(state.activeId, 'step1-tab-named', 'ArrowRight from the last tab must wrap around to the first tab');
    assert.strictEqual(state.namedSelected, 'true');
    assert.strictEqual(state.namedTabIndex, '0');
    assert.strictEqual(state.sampleTabIndex, '-1');
    assert.notStrictEqual(state.namedDisplay, 'none');
    assert.strictEqual(state.sampleDisplay, 'none');

    // ArrowLeft from the first tab must wrap the other direction, to the last (sample) tab —
    // this is also the only way the sample tab remains keyboard-reachable at all under the
    // roving-tabindex model, since it no longer has its own Tab stop.
    await page.keyboard.press('ArrowLeft');
    state = await tabState();
    assert.strictEqual(state.activeId, 'step1-tab-sample', 'ArrowLeft from the first tab must wrap around to the last tab');
    assert.strictEqual(state.sampleSelected, 'true');
    assert.strictEqual(state.sampleTabIndex, '0');
    assert.strictEqual(state.namedTabIndex, '-1');
    assert.notStrictEqual(state.sampleDisplay, 'none');
    assert.strictEqual(state.namedDisplay, 'none');

    await page.close();
  });

  test('Home/End on the step-1 tablist jump to the first/last tab with focus, selection, and roving tabindex (oculist-rnr.25)', async () => {
    const page = await openWelcome();

    async function tabState() {
      return page.evaluate(() => ({
        activeId: document.activeElement && document.activeElement.id,
        namedSelected: document.getElementById('step1-tab-named').getAttribute('aria-selected'),
        sampleSelected: document.getElementById('step1-tab-sample').getAttribute('aria-selected'),
        namedTabIndex: document.getElementById('step1-tab-named').getAttribute('tabindex'),
        sampleTabIndex: document.getElementById('step1-tab-sample').getAttribute('tabindex'),
      }));
    }

    // Named tab is selected/focused by default; End must jump straight to the last tab
    // (sample), not merely step one position like ArrowRight would.
    await page.locator('#step1-tab-named').focus();
    await page.keyboard.press('End');
    let state = await tabState();
    assert.strictEqual(state.activeId, 'step1-tab-sample', 'End must move focus to the last (sample) tab');
    assert.strictEqual(state.sampleSelected, 'true', 'End must select the last tab');
    assert.strictEqual(state.namedSelected, 'false', 'End must deselect the named tab');
    assert.strictEqual(state.sampleTabIndex, '0', 'End must make the last tab the roving tabindex="0" stop');
    assert.strictEqual(state.namedTabIndex, '-1', 'End must leave the first tab at tabindex="-1"');

    // From the last tab, Home must jump straight back to the first tab.
    await page.keyboard.press('Home');
    state = await tabState();
    assert.strictEqual(state.activeId, 'step1-tab-named', 'Home must move focus to the first (named) tab');
    assert.strictEqual(state.namedSelected, 'true', 'Home must select the first tab');
    assert.strictEqual(state.sampleSelected, 'false', 'Home must deselect the last tab');
    assert.strictEqual(state.namedTabIndex, '0', 'Home must make the first tab the roving tabindex="0" stop');
    assert.strictEqual(state.sampleTabIndex, '-1', 'Home must leave the last tab at tabindex="-1"');

    await page.close();
  });

  test('Tab passes through the step-1 tablist untouched, and Enter/Space still activate the focused tab natively (oculist-rnr.25)', async () => {
    const page = await openWelcome();

    // Tab is not one of the handled keys, so the keydown handler must return before calling
    // preventDefault() and let focus move OUT of the tablist under the browser's own tab
    // order, rather than being trapped or redirected to the other tab.
    await page.locator('#step1-tab-named').focus();
    await page.keyboard.press('Tab');
    const afterTab = await page.evaluate(() => ({
      tag: document.activeElement && document.activeElement.tagName,
      inTablist: !!(document.activeElement && document.activeElement.closest('.wizard-tabs')),
    }));
    assert.strictEqual(afterTab.tag, 'BUTTON', 'Tab must land on a real focusable element outside the tablist');
    assert.strictEqual(afterTab.inTablist, false, 'Tab must move focus OUT of the tablist, not to the other tab or nowhere');

    // Enter is likewise unhandled by the keydown handler; the named tab's own <button>
    // element must still activate it natively. Start from the sample tab selected so
    // activating the named tab via Enter is a real, observable state change.
    await page.click('#step1-tab-sample');
    await page.waitForSelector('#step1-panel-sample:not([hidden])');
    await page.locator('#step1-tab-named').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#step1-panel-named:not([hidden])');
    let namedSelected = await page.evaluate(() => document.getElementById('step1-tab-named').getAttribute('aria-selected'));
    assert.strictEqual(namedSelected, 'true', 'Enter on a focused tab must still activate it via native <button> behavior');

    // Same check for Space, the other native activation key.
    await page.click('#step1-tab-sample');
    await page.waitForSelector('#step1-panel-sample:not([hidden])');
    await page.locator('#step1-tab-named').focus();
    await page.keyboard.press(' ');
    await page.waitForSelector('#step1-panel-named:not([hidden])');
    namedSelected = await page.evaluate(() => document.getElementById('step1-tab-named').getAttribute('aria-selected'));
    assert.strictEqual(namedSelected, 'true', 'Space on a focused tab must still activate it via native <button> behavior');

    await page.close();
  });

  test('a keyboard-only user can arrow to the sample tab and then Tab straight into its panel to reach a well-named option (oculist-rnr.25)', async () => {
    const page = await openWelcome();
    const client = await ctx.newCDPSession(page);
    await enableAccessibilityDomain(client);

    // Roving tabindex removes the sample tab's own Tab stop (oculist-rnr.19), so the tab is
    // reached by arrow key instead -- ArrowRight from the named tab, or equally End or a
    // wrapping ArrowLeft. This test walks that whole path end to end: arrow across, then Tab
    // into the revealed panel and land on a well-named option. The existing tests cover the
    // two halves separately and neither joins them -- the rnr.19 ArrowRight test asserts the
    // arrow moves focus and selection, while the accessible-name test reaches the sample
    // panel by CLICK, so nothing else presses Tab from a tab into the panel it just revealed.
    await page.locator('#step1-tab-named').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('#step1-panel-sample:not([hidden])');
    const sampleSelected = await page.evaluate(() => document.getElementById('step1-tab-sample').getAttribute('aria-selected'));
    assert.strictEqual(sampleSelected, 'true', 'test setup: ArrowRight must select the sample tab before Tab is exercised');

    await page.keyboard.press('Tab');
    const afterTab = await page.evaluate(() => ({
      tag: document.activeElement && document.activeElement.tagName,
      inSamplePanel: !!(document.activeElement && document.activeElement.closest('#step1-panel-sample')),
    }));
    assert.strictEqual(afterTab.tag, 'BUTTON', 'Tab from the arrowed-to sample tab must land on a real button');
    assert.strictEqual(afterTab.inSamplePanel, true, 'Tab from the arrowed-to sample tab must land inside the sample panel it just revealed');

    const reachedOptionName = await computedAccessibleName(client, 'document.activeElement');
    assert.ok(reachedOptionName && reachedOptionName.length > 0, 'the option reached by arrow-then-Tab must have a non-empty accessible name');
    assert.match(reachedOptionName, /Sample [A-Z]/, `the option reached by arrow-then-Tab must describe itself, not just a color (got: ${reachedOptionName})`);

    await page.close();
  });

  test('running the wizard a second time works with no page error, and the banner reflects the new choice', async () => {
    // oculist-l6g: must run before openWelcome() so firstStored's completion poll below never
    // reads test 2's rose-cyan/by-adjust blob (see resetStoredSettings() for why that
    // matters). The second run's own completion signal further down (secondStored) doesn't
    // need this — it already waits on wizard-modal display, which is genuinely non-sticky.
    await resetStoredSettings();

    const page = await openWelcome();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    // First run: set a NON-DEFAULT answer on every step that has one (oculist-rnr.18), so any
    // answer resetWizardState() fails to clear is unambiguously distinguishable from the
    // second run's defaults below. Step 1: switch to the sample tab (itself non-default —
    // the wizard always reopens on the named tab) and pick the amber-indigo sample. Step 2:
    // opt into the low-vision profile. Step 3: opt into the non-default answer too. Low-vision
    // (step 2) outranks the color-blind choice (step 1) in buildPreviewSummary, so the
    // resulting persisted profile is 'low-vision' (displayPreset 'high-contrast', beaconSize
    // 'xl') regardless of the step-1/step-3 answers — but those answers must still be set to
    // non-default values here, since they're exactly the "masked" state that could otherwise
    // leak into a second run without ever being caught by this test's own first-run
    // assertions.
    await page.click('#step1-tab-sample');
    await page.waitForSelector('#step1-panel-sample:not([hidden])');
    await page.click('#step1-panel-sample .wizard-option[data-value="amber-indigo"]');
    // oculist-l6g: page.waitForTimeout(400) removed here — the very next line already waits
    // on the real signal (welcome.js's auto-advance landing on '#step-2.active'), so the sleep
    // was pure padding on top of a genuine wait, not a distinct gate. Same for the two sleeps
    // below it against '#step-3.active' and finishWizard()'s own '#step-4.active' wait.
    await page.waitForSelector('#step-2.active');
    await page.click('#step-2.active .wizard-option[data-value="true"]');
    await page.waitForSelector('#step-3.active');
    await page.click('#step-3.active .wizard-option[data-value="true"]');
    await finishWizard(page);

    const firstStored = await waitForSetupWizardCompleted(page);
    assert.strictEqual(firstStored.displayPreset, 'high-contrast', 'first run must persist the low-vision preset');
    assert.strictEqual(firstStored.visionSettings.beaconSize, 'xl', 'first run must persist the low-vision beaconSize');

    const firstBannerText = await page.locator('#wizard-hero-banner').innerText();
    assert.match(firstBannerText, /Low.?Vision/i, 'the completion banner must reflect the first run\'s choice');

    // Sanity check on the setup itself: the tab-reset assertion after reopening is only
    // meaningful if the first run genuinely left step 1 on the sample tab, not the named tab
    // it would already be on by default.
    const sampleTabStillActiveAfterFirstRun = await page.evaluate(
      () => document.getElementById('step1-tab-sample').classList.contains('active')
    );
    assert.strictEqual(
      sampleTabStillActiveAfterFirstRun,
      true,
      'test setup: first run must end on the sample tab or the reopen assertion below would be vacuous'
    );

    // Second run, via the "Run Setup Again" affordance the completion banner adds. This is
    // exactly the path that threw (Cannot read properties of null (reading 'parentElement'))
    // when saveProfileAndFinish() re-queried #start-wizard after its own innerHTML rewrite
    // had already destroyed it.
    await page.click('#rerun-wizard');
    await page.waitForSelector('#step-1.active');

    // Re-opening must have reset step 1 back to the named tab, with the sample panel
    // genuinely computed display:none (not merely carrying the `hidden` attribute — same
    // computed-style idiom as the "genuinely display:none" test above), not silently left on
    // the sample tab the first run ended on.
    const reopenedTabState = await page.evaluate(() => ({
      namedActive: document.getElementById('step1-tab-named').classList.contains('active'),
      sampleActive: document.getElementById('step1-tab-sample').classList.contains('active'),
      namedDisplay: getComputedStyle(document.getElementById('step1-panel-named')).display,
      sampleDisplay: getComputedStyle(document.getElementById('step1-panel-sample')).display,
      namedTabIndex: document.getElementById('step1-tab-named').getAttribute('tabindex'),
      sampleTabIndex: document.getElementById('step1-tab-sample').getAttribute('tabindex'),
    }));
    assert.strictEqual(reopenedTabState.namedActive, true, 're-opening the wizard must reset step 1 back to the named-condition tab');
    assert.strictEqual(reopenedTabState.sampleActive, false, 're-opening the wizard must deactivate the sample tab left active by the first run');
    assert.notStrictEqual(reopenedTabState.namedDisplay, 'none', 're-opened named panel must actually render');
    assert.strictEqual(reopenedTabState.sampleDisplay, 'none', 're-opened sample panel (left active by the first run) must be computed display:none');
    // oculist-rnr.25: resetWizardState() goes through selectStep1Tab(), the same function the
    // click/keyboard paths use, so reopening must also restore the roving tabindex (the named
    // tab regains the tablist's sole tabindex="0" stop, the sample tab reverts to "-1") — not
    // just the .active class and computed display checked above.
    assert.strictEqual(reopenedTabState.namedTabIndex, '0', 're-opening the wizard must restore the named tab as the roving tabindex="0" stop');
    assert.strictEqual(reopenedTabState.sampleTabIndex, '-1', 're-opening the wizard must restore the sample tab to tabindex="-1", not leave it as the roving stop the first run left it as');

    // Drive the second run through with Next only — no option is clicked on any step. This is
    // the only way to actually exercise resetWizardState(): re-clicking an option on the
    // second run would overwrite whatever the first run left behind, masking exactly the
    // inheritance bug this test exists to catch (oculist-rnr.18). navigateNext() has no
    // selection guard (see welcome.js), so clicking Next past an unselected step is permitted.
    await page.click('#wizard-next'); // step 1 -> step 2
    await page.waitForSelector('#step-2.active');
    await page.click('#wizard-next'); // step 2 -> step 3
    await page.waitForSelector('#step-3.active');
    await page.click('#wizard-next'); // step 3 -> step 4
    await finishWizard(page); // waits for #step-4.active, then Next triggers saveProfileAndFinish()

    // Wait for the second run's async save to actually land before reading storage back.
    // wizardModal.style.display is flipped to 'flex' by openWizard() on reopen and is only set
    // back to 'none' by saveProfileAndFinish() after its `await chrome.storage.sync.set(...)`
    // resolves, so this predicate is genuinely false the instant the last Next click returns
    // and only becomes true once the write has landed — it is not decoration (oculist-66m).
    // wizard-modal's state lives in the page's main world, so page.waitForFunction() is used
    // directly per this suite's convention (test/helpers/wait.js), rather than the Node-side
    // waitForCondition helper reserved for isolated-world/Node-side state.
    await page.waitForFunction(() => document.getElementById('wizard-modal').style.display === 'none');

    const secondStored = await readStoredSettings(page);

    // The second run clicked no option anywhere, so every answer must have come from
    // resetWizardState()'s defaults, not anything the first run set: displayPreset null and
    // visionSettings exactly equal to PRESETS['none']. Asserting the whole preset object (not
    // just one field) so a leak into any single field — beaconSize, colorPalette, or
    // otherwise — is caught, not just the one the first test happened to check.
    assert.strictEqual(secondStored.displayPreset, null, 'second run must persist the default (none) preset, not the first run\'s low-vision choice it never re-selected');
    assert.deepStrictEqual(
      secondStored.visionSettings,
      {
        beaconSize: 'm',
        animationSpeed: 'normal',
        textLabels: false,
        motionSensitivity: 'full',
        colorPalette: 'default',
        borderStyle: 'none'
      },
      'second run must persist the default visionSettings, not any value inherited from the first run'
    );

    const secondBannerText = await page.locator('#wizard-hero-banner').innerText();
    assert.match(secondBannerText, /Standard/i, 'the completion banner must reflect the second run\'s default (Standard) profile');
    assert.doesNotMatch(secondBannerText, /Low.?Vision/i, 'the completion banner must not still advertise the first run\'s profile');

    assert.deepStrictEqual(pageErrors, [], `re-running the wizard must not throw: ${pageErrors.map((e) => e.message).join('; ')}`);

    await page.close();
  });
});
