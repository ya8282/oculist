// Regression coverage for oculist-336: answering yes to both a color-vision question and
// low vision used to silently discard the chosen palette, because buildPreviewSummary()
// resolved a single profile by strict priority (low-vision > color-blind > eye-strain) and
// PRESETS['low-vision'] carries colorPalette: 'default'. The agreed fix is a palette
// overlay: low-vision continues to govern sizing/contrast/motion/borders, but the user's
// chosen color palette overrides colorPalette. displayPreset stays 'high-contrast' — no new
// preset key, no new displayPreset value.
//
// This exercises all 4 (color) x 2 (low vision) = 8 combinations, asserting the PERSISTED
// oc-settings (displayPreset + the full visionSettings object), not just the on-screen
// summary — the whole point of the bug is that the summary and the persisted value could
// disagree.
//
// Needs a real browser: welcome.html only boots against a real chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { readStoredSettings } = require('./helpers/storage');

const EXTENSION = path.resolve(__dirname, '../extension');

const NONE_SETTINGS = {
  beaconSize: 'm',
  animationSpeed: 'normal',
  textLabels: false,
  motionSensitivity: 'full',
  colorPalette: 'default',
  borderStyle: 'none'
};

const LOW_VISION_BASE = {
  beaconSize: 'xl',
  animationSpeed: 'slow',
  textLabels: true,
  motionSensitivity: 'full',
  borderStyle: 'thick'
};

const COLOR_BLIND_SETTINGS = {
  'amber-sky': {
    beaconSize: 'l',
    animationSpeed: 'normal',
    textLabels: true,
    motionSensitivity: 'full',
    colorPalette: 'amber-sky',
    borderStyle: 'medium'
  },
  'amber-indigo': {
    beaconSize: 'l',
    animationSpeed: 'normal',
    textLabels: true,
    motionSensitivity: 'full',
    colorPalette: 'amber-indigo',
    borderStyle: 'medium'
  },
  'rose-cyan': {
    beaconSize: 'l',
    animationSpeed: 'normal',
    textLabels: true,
    motionSensitivity: 'full',
    colorPalette: 'rose-cyan',
    borderStyle: 'medium'
  }
};

const COLOR_DISPLAY_PRESET = {
  'amber-sky': 'rg-adjust-deut',
  'amber-indigo': 'rg-adjust-prot',
  'rose-cyan': 'by-adjust'
};

// Matrix: 4 color answers x 2 low-vision answers.
const CASES = [
  { color: 'none', lowVision: false, expectedDisplayPreset: null, expectedVisionSettings: NONE_SETTINGS },
  { color: 'amber-sky', lowVision: false, expectedDisplayPreset: 'rg-adjust-deut', expectedVisionSettings: COLOR_BLIND_SETTINGS['amber-sky'] },
  { color: 'amber-indigo', lowVision: false, expectedDisplayPreset: 'rg-adjust-prot', expectedVisionSettings: COLOR_BLIND_SETTINGS['amber-indigo'] },
  { color: 'rose-cyan', lowVision: false, expectedDisplayPreset: 'by-adjust', expectedVisionSettings: COLOR_BLIND_SETTINGS['rose-cyan'] },
  { color: 'none', lowVision: true, expectedDisplayPreset: 'high-contrast', expectedVisionSettings: { ...LOW_VISION_BASE, colorPalette: 'default' } },
  { color: 'amber-sky', lowVision: true, expectedDisplayPreset: 'high-contrast', expectedVisionSettings: { ...LOW_VISION_BASE, colorPalette: 'amber-sky' } },
  { color: 'amber-indigo', lowVision: true, expectedDisplayPreset: 'high-contrast', expectedVisionSettings: { ...LOW_VISION_BASE, colorPalette: 'amber-indigo' } },
  { color: 'rose-cyan', lowVision: true, expectedDisplayPreset: 'high-contrast', expectedVisionSettings: { ...LOW_VISION_BASE, colorPalette: 'rose-cyan' } }
];

describe('Low vision + color vision answers compose instead of discarding the palette (oculist-336)', () => {
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

  // oculist-leu: all 8 cases below run against ONE shared chrome.storage.sync blob (that's
  // deliberate -- it avoids paying launchPersistentContext's cost per case), and the
  // completion gate polls stored.setupWizardCompleted. That flag goes true on case 1's write
  // and STAYS true for every case after it, so without a reset the poll is vacuous from case 2
  // onward: it can return on its very first tick with whatever case N-1 left in storage,
  // before case N's own write has landed, and the test then asserts on stale data. Chose to
  // reset storage between cases (over gating on a per-case-unique expected value) because it
  // fixes the root cause -- each case starts from a genuinely blank blob -- rather than relying
  // on no two cases in CASES ever sharing an expected displayPreset/colorPalette pair, which
  // future edits to the matrix could silently break.
  async function resetStoredSettings() {
    await sw.evaluate(() => new Promise((resolve) => chrome.storage.sync.remove('oc-settings', resolve)));
  }

  async function waitForSetupWizardCompleted(page) {
    return waitForCondition(
      () => readStoredSettings(page),
      (stored) => !!(stored && stored.setupWizardCompleted),
      { timeout: POLL_TIMEOUT, message: 'oc-settings.setupWizardCompleted never became true' }
    );
  }

  // oculist-leu: welcome.js's click handler auto-advances via `setTimeout(navigateNext, 300)`.
  // The previous version of this helper padded that with a fixed page.waitForTimeout(400),
  // racing a hardcoded deadline against the extension's own internal delay. Every call site
  // was already followed by a real signal anyway (page.waitForSelector for the next step's
  // '.active' class), so this folds the click and that wait into one call instead of padding
  // the sleep further. The general move, replace a deadline with the signal you actually
  // mean, is the same one oculist-d5c made, though d5c's specific defect was different: a
  // Node-side round trip letting a transient element self-clean between the wait and the
  // read. It removed no waitForTimeout calls.
  async function clickAndAdvance(page, optionSelector, nextStepSelector) {
    await page.click(optionSelector);
    await page.waitForSelector(nextStepSelector);
  }

  for (const { color, lowVision, expectedDisplayPreset, expectedVisionSettings } of CASES) {
    test(`color=${color}, lowVision=${lowVision} -> displayPreset=${expectedDisplayPreset}, colorPalette=${expectedVisionSettings.colorPalette}`, async () => {
      // oculist-leu: must run before openWelcome() so this case never sees a prior case's
      // setupWizardCompleted=true (see resetStoredSettings() above for why that matters).
      await resetStoredSettings();

      const page = await openWelcome();

      // Step 1: named-condition panel is the default-visible tab; every color value used
      // here (none/amber-sky/amber-indigo/rose-cyan) has a matching button there.
      await page.waitForSelector('#step-1.active');
      await clickAndAdvance(page, `#step1-panel-named .wizard-option[data-value="${color}"]`, '#step-2.active');

      // Step 2: low vision yes/no.
      await clickAndAdvance(page, `#step-2.active .wizard-option[data-value="${lowVision}"]`, '#step-3.active');

      // Step 3: eye strain answer is irrelevant to this matrix; take the default (No).
      await clickAndAdvance(page, '#step-3.active .wizard-option[data-value="false"]', '#step-4.active');

      // Step 4: save.
      await page.click('#wizard-next');

      const stored = await waitForSetupWizardCompleted(page);
      assert.strictEqual(
        stored.displayPreset,
        expectedDisplayPreset,
        `displayPreset mismatch for color=${color}, lowVision=${lowVision}`
      );
      assert.deepStrictEqual(
        stored.visionSettings,
        expectedVisionSettings,
        `visionSettings mismatch for color=${color}, lowVision=${lowVision}`
      );

      await page.close();
    });
  }
});
