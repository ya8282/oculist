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
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    extId = sw.url().split('/')[2];
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  async function openPopup() {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#vision-profile');

    // The custom-settings controls (magnifier, beacon size, ...) live inside a collapsed
    // <details> drawer — open it or selectOption() can never see them.
    await popup.evaluate(() => {
      document.getElementById('configure-drawer').open = true;
    });

    return popup;
  }

  function readStoredSettings(popup) {
    return popup.evaluate(
      () => new Promise((resolve) => chrome.storage.sync.get('oc-settings', (d) => resolve(d['oc-settings'])))
    );
  }

  test('toggling the magnifier leaves a named vision profile alone', async () => {
    const popup = await openPopup();

    // eye-strain is the one profile getProfileConstraints() locks both the effects AND
    // colours sections for, so a spurious drop to 'custom' is directly observable via
    // either lock badge, not just the dropdown's own value.
    await popup.selectOption('#vision-profile', 'eye-strain');
    await popup.waitForTimeout(200);
    assert.strictEqual(await popup.locator('#vision-profile').inputValue(), 'eye-strain');

    // Magnifier is deliberately absent from every PRESETS entry (oculist-l6m.39) — toggling
    // it must not force the profile to 'custom' (oculist-l6m.40).
    await popup.selectOption('#magnifier', 'true');
    await popup.waitForTimeout(200);

    assert.strictEqual(
      await popup.locator('#vision-profile').inputValue(),
      'eye-strain',
      'toggling the magnifier must not drop the active named vision profile'
    );

    // The effects and colours sections must stay locked — they mirror the surviving named
    // profile, not a spurious drop to custom. updateOverridesUI() drives both lock badges.
    const locked = await popup.evaluate(() => ({
      effects: document.getElementById('effects-section').classList.contains('drawer-locked'),
      colors: document.getElementById('colors-section').classList.contains('drawer-locked')
    }));
    assert.strictEqual(locked.effects, true, 'the effects section must stay locked to the surviving Eye Strain profile');
    assert.strictEqual(locked.colors, true, 'the colours section must stay locked to the surviving Eye Strain profile');

    // Persisted storage must agree with the live dropdown, and the magnifier toggle itself
    // must still have taken effect.
    const stored = await readStoredSettings(popup);
    assert.strictEqual(stored.visionProfile, 'eye-strain', 'persisted visionProfile must still be eye-strain');
    assert.strictEqual(stored.visionSettings.magnifier, true, 'the magnifier toggle itself must still take effect');

    await popup.close();
  });

  test('toggling a preset-governed setting still forces the profile to custom', async () => {
    const popup = await openPopup();

    await popup.selectOption('#vision-profile', 'low-vision');
    await popup.waitForTimeout(200);
    assert.strictEqual(await popup.locator('#vision-profile').inputValue(), 'low-vision');

    // beaconSize is a key every PRESETS entry sets, so touching it directly is a genuine
    // divergence from the preset and must still drop the profile to 'custom', exactly as
    // it did before this fix — proving the fix did not make forcing-to-custom a dead path.
    await popup.selectOption('#beacon-size', 's');
    await popup.waitForTimeout(200);

    assert.strictEqual(
      await popup.locator('#vision-profile').inputValue(),
      'custom',
      'touching a preset-governed setting must still force the profile to custom'
    );

    const stored = await readStoredSettings(popup);
    assert.strictEqual(stored.visionProfile, 'custom');

    await popup.close();
  });
});
