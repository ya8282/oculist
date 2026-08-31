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

  async function waitForSetupWizardCompleted(page) {
    return waitForCondition(
      () => readStoredSettings(page),
      (stored) => !!(stored && stored.setupWizardCompleted),
      { timeout: POLL_TIMEOUT, message: 'oc-settings.setupWizardCompleted never became true' }
    );
  }

  async function clickAndAdvance(page, selector) {
    await page.click(selector);
    await page.waitForTimeout(400);
  }

  for (const { color, lowVision, expectedDisplayPreset, expectedVisionSettings } of CASES) {
    test(`color=${color}, lowVision=${lowVision} -> displayPreset=${expectedDisplayPreset}, colorPalette=${expectedVisionSettings.colorPalette}`, async () => {
      const page = await openWelcome();

      // Step 1: named-condition panel is the default-visible tab; every color value used
      // here (none/amber-sky/amber-indigo/rose-cyan) has a matching button there.
      await page.waitForSelector('#step-1.active');
      await clickAndAdvance(page, `#step1-panel-named .wizard-option[data-value="${color}"]`);

      // Step 2: low vision yes/no.
      await page.waitForSelector('#step-2.active');
      await clickAndAdvance(page, `#step-2.active .wizard-option[data-value="${lowVision}"]`);

      // Step 3: eye strain answer is irrelevant to this matrix; take the default (No).
      await page.waitForSelector('#step-3.active');
      await clickAndAdvance(page, '#step-3.active .wizard-option[data-value="false"]');

      // Step 4: save.
      await page.waitForSelector('#step-4.active');
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
