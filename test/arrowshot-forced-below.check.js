'use strict';

// Regression: Arrow's painted silhouette must clear the short, full-width match.
// Reuse the canonical sampler unchanged, including its sidebar exclusion mask.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { chromium } = require('playwright');
const prototypes = path.resolve(__dirname, '../../artifacts/prototypes');
const harnessPath = path.join(prototypes, 'occlusion-sweep.js');
const loaded = new Module(harnessPath, module);
loaded.filename = harnessPath;
loaded.paths = Module._nodeModulePaths(prototypes);
loaded._compile(fs.readFileSync(harnessPath, 'utf8') +
  '\nmodule.exports.probe = { runForcedScenario, FORCED_PLACEMENTS, installSeededRandomHook };', harnessPath);
const harness = loaded.exports;

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    await page.addInitScript(harness.installTimerNeutralizationHook);
    await page.addInitScript(harness.probe.installSeededRandomHook);
    await page.goto('file://' + path.join(prototypes, 'effects-playground.html'));
    const result = await harness.probe.runForcedScenario(page, 'arrowshot',
      harness.probe.FORCED_PLACEMENTS.find(row => row.name === 'forced-below-1'));
    console.log(JSON.stringify(result));
    assert.equal(result.ok, true, 'canonical sampler must complete');
    assert.equal(result.maxCount, 0, 'Arrow paint must not change any visible match pixel');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
