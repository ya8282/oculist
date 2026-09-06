// Regression (oculist-l6m.40): touching a vision setting that no preset governs — the
// magnifier — used to unconditionally force visionProfile to 'custom', silently dropping
// whatever named profile (e.g. Low Vision) the user had selected and unlocking the
// effect/colour sections that profile is supposed to lock. See oculist-l6m.39: magnifier
// is deliberately absent from every PRESETS entry so a profile switch never clobbers an
// explicit magnifier choice; touching the magnifier must be equally harmless in the other
// direction — it must not clobber the active profile either.
//
// Needs a real browser — popup.html only boots against a real chrome.storage.sync/
// chrome.runtime, and this drives the actual popup UI (selectOption + real 'change'
// events) rather than seeding storage directly, so the listener wiring itself is under
// test, not just the merge logic it feeds.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForPopupReady, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { readStoredSettings } = require('./helpers/storage');

const EXTENSION = path.resolve(__dirname, '../extension');

describe('Vision profile survives ungoverned setting toggles', () => {
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

  async function openPopup() {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#vision-profile');

    // #vision-profile existing in the DOM is true from HTML parse time — it says nothing
    // about whether popup.js's DOMContentLoaded handler has finished wiring its `change`
    // listeners yet (that only happens after an internal chrome.storage.sync.get() round
    // trip resolves). Wait for that wiring to actually finish before driving any control
    // below: a driven `change` event that lands before its listener is attached is dropped
    // for good, with nothing to poll for afterwards — see waitForPopupReady()'s own comment.
    await waitForPopupReady(popup);

    // The custom-settings controls (magnifier, beacon size, ...) live inside a collapsed
    // <details> drawer — open it or selectOption() can never see them.
    await popup.evaluate(() => {
      document.getElementById('configure-drawer').open = true;
    });

    return popup;
  }

  test('toggling the magnifier leaves a named vision profile alone', async () => {
    const popup = await openPopup();

    // eye-strain is the one profile getProfileConstraints() locks both the effects AND
    // colours sections for, so a spurious drop to 'custom' is directly observable via
    // either lock badge, not just the dropdown's own value.
    //
    // No wait after this selectOption(): Playwright's injected selectOptions() sets the
    // <select>'s value directly and dispatches 'change' before resolving (see
    // node_modules/playwright-core's InjectedScript.selectOptions), so the dropdown's own
    // value is never dependent on any application listener having run — there's nothing to
    // wait for here.
    await popup.selectOption('#vision-profile', 'eye-strain');
    assert.strictEqual(await popup.locator('#vision-profile').inputValue(), 'eye-strain');

    // Magnifier is deliberately absent from every PRESETS entry (oculist-l6m.39) — toggling
    // it must not force the profile to 'custom' (oculist-l6m.40). Same reasoning as above:
    // the raw dropdown value is set directly by selectOption() itself, not by a listener.
    await popup.selectOption('#magnifier', 'true');

    assert.strictEqual(
      await popup.locator('#vision-profile').inputValue(),
      'eye-strain',
      'toggling the magnifier must not drop the active named vision profile'
    );

    // The lock badges are different: they are only ever written by updateOverridesUI(),
    // called from inside #vision-profile's and #magnifier's own 'change' listeners in
    // popup.js. Those DOM writes run synchronously within the listener, before its own
    // `await saveSettings()` — and openPopup()'s waitForPopupReady() call already proved
    // both listeners were attached before either selectOption() above ran. Playwright's
    // selectOption() dispatches 'change' and waits for the page-side call to return before
    // resolving, so by the time it resolves here the listener's synchronous portion (the
    // lock-badge writes) has already run too. No poll needed; assert directly.
    const locked = await popup.evaluate(() => ({
      effects: document.getElementById('effects-section').classList.contains('drawer-locked'),
      colors: document.getElementById('colors-section').classList.contains('drawer-locked')
    }));
    assert.strictEqual(locked.effects, true, 'the effects section must stay locked to the surviving Eye Strain profile');
    assert.strictEqual(locked.colors, true, 'the colours section must stay locked to the surviving Eye Strain profile');

    // Persisted storage must agree with the live dropdown, and the magnifier toggle itself
    // must still have taken effect — wait for the async chrome.storage.sync.set() write to
    // actually land before reading it back.
    const stored = await waitForCondition(
      () => readStoredSettings(popup),
      (d) => !!(d && d.visionSettings && d.visionSettings.magnifier === true),
      { timeout: POLL_TIMEOUT, message: 'oc-settings.visionSettings.magnifier never became true' }
    );
    // oculist-rnr.12: the persisted field is 'displayPreset' now, holding the functional
    // key 'reduced-motion' for what the #vision-profile dropdown still labels 'eye-strain'.
    assert.strictEqual(stored.displayPreset, 'reduced-motion', 'persisted displayPreset must still be reduced-motion');
    assert.strictEqual(stored.visionSettings.magnifier, true, 'the magnifier toggle itself must still take effect');

    await popup.close();
  });

  test('toggling a preset-governed setting still forces the profile to custom', async () => {
    const popup = await openPopup();

    await popup.selectOption('#vision-profile', 'low-vision');
    assert.strictEqual(await popup.locator('#vision-profile').inputValue(), 'low-vision');

    // beaconSize is a key every PRESETS entry sets, so touching it directly is a genuine
    // divergence from the preset and must still drop the profile to 'custom', exactly as
    // it did before this fix — proving the fix did not make forcing-to-custom a dead path.
    await popup.selectOption('#beacon-size', 's');

    // Unlike #vision-profile's own value (set directly by selectOption() itself), 'custom'
    // here only ever gets written by applyDirectSettingChange() inside #beacon-size's
    // 'change' listener in popup.js. openPopup()'s waitForPopupReady() call already proved
    // that listener was attached before this selectOption() ran, and — same reasoning as the
    // previous test — selectOption() only resolves after the listener's synchronous portion
    // (which is all of applyDirectSettingChange(), before its caller's own `await
    // saveSettings()`) has already run. No poll needed; assert directly.
    assert.strictEqual(
      await popup.locator('#vision-profile').inputValue(),
      'custom',
      'touching a preset-governed setting must still force the profile to custom'
    );

    // Wait for the async chrome.storage.sync.set() write to actually land before reading
    // it back.
    const stored = await waitForCondition(
      () => readStoredSettings(popup),
      (d) => !!(d && d.displayPreset === 'custom'),
      { timeout: POLL_TIMEOUT, message: "oc-settings.displayPreset never became 'custom'" }
    );
    assert.strictEqual(stored.displayPreset, 'custom');

    await popup.close();
  });
});
