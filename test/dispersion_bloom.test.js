// Dispersion Bloom beacon effect (oculist-dvv): reproduces shader-style radial chromatic
// dispersion (UV distortion -> channel offset -> radial attenuation -> additive
// recombination) as DOM + WAAPI rings, with hues DERIVED FROM THE ACTIVE PALETTE rather
// than a hardcoded RGB spectrum. A real rainbow split conveys information via hue, which
// is exactly what tritanopia/deuteranopia/protanopia users cannot separate — Oculist's
// vision profiles exist to prevent that, so this suite's central assertion is that the
// three ring hues track getEffectiveColors().beacon and move when the palette changes,
// not that they render some fixed spectrum.
//
// Needs a real browser for the same reasons as prefers_reduced_motion.test.js /
// lite_mode_restore.test.js: WAAPI + CSS.highlights + a real layout only exist in real
// Chromium, and Lite Mode/vision-profile settings can only be toggled for real through
// chrome.storage.sync.
//
// One context, one finder session kept open across all four tests (mirroring
// prefers_reduced_motion.test.js) — settings are changed via direct chrome.storage.sync
// writes from inside the content script's own isolated world (mirroring
// closed_overlay_settings_change.test.js / active_match_magnifier.test.js), and each test
// that mutates shared state restores it in a `finally` so later tests start clean.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${'filler words to fill the page. '.repeat(40)} <span id="target">quarklet</span></p>`;

const INPUT = '#oc-wrap >> .oc-input';

// --- Independent reimplementation of content.js's hexToHsl/hslToHex (same idiom
// dim_contrast.test.js uses for its contrast math) — this proves the real -22/0/+22 hue
// offset math against DOM output, rather than echoing content.js's own functions back at
// themselves. ---
function hexToHsl(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const r = parseInt(c.substr(0, 2), 16) / 255;
  const g = parseInt(c.substr(2, 2), 16) / 255;
  const b = parseInt(c.substr(4, 2), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

function hexToRgbArr(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const n = parseInt(c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const HUE_OFFSETS = [-22, 0, 22];

function expectedRingHexes(baseHex) {
  const [h, s, l] = hexToHsl(baseHex);
  return HUE_OFFSETS.map((off) => hslToHex(h + off, s, l));
}

describe('Dispersion Bloom: palette-derived radial chromatic dispersion', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP before navigating so the isolated-world execution-context-created event
    // is never missed.
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId = c.id;
      }
    });

    await page.goto(origin);
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: 5000,
      message: 'never observed the content script isolated execution context',
    });

    // Select the Dispersion Bloom effect for the whole suite before ever opening the
    // finder — every test below assumes this baseline.
    await setSettings({ effect: 'dispersion' });

    await openFinder();
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    // Wait for the draft debounce to actually land a real match count before any test
    // fires the beacon, instead of guessing its duration.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: 5000 }
    );
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // isolatedContextId existing only proves the content script's realm has been created,
  // not that its synchronous top-level init has reached the keydown-listener registration
  // yet — retry Control+f (a keypress a not-yet-attached listener would otherwise
  // silently swallow) until the input actually appears, instead of trusting one press.
  async function openFinder() {
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: 5000 }); // surfaces the real timeout error
  }

  function evalInContentScript(expression) {
    return client
      .send('Runtime.evaluate', {
        expression,
        contextId: isolatedContextId,
        awaitPromise: true,
        returnByValue: true,
      })
      .then((res) => {
        if (res.exceptionDetails) {
          throw new Error('content-script eval failed: ' + JSON.stringify(res.exceptionDetails));
        }
        return res.result.value;
      });
  }

  // Arm a probe listener inside the content script's own isolated world *before* writing
  // a settings change: chrome.storage.onChanged fires every listener registered against
  // that same document for the same event, in registration order — content.js's own
  // listener was registered at page load, long before this probe, so observing OUR
  // listener fire is a direct proxy for content.js's own listener (and its synchronous
  // `settings[k] = nv[k]` assignment) having already run.
  async function armSettingsEcho() {
    return evalInContentScript(`
      (function () {
        if (!window.__ocSettingsEchoInstalled) {
          window.__ocSettingsEchoInstalled = true;
          window.__ocSettingsEchoes = 0;
          chrome.storage.onChanged.addListener(function (changes) {
            if (changes['oc-settings']) window.__ocSettingsEchoes++;
          });
        }
        return window.__ocSettingsEchoes;
      })()
    `);
  }

  async function waitForSettingsEcho(before) {
    return waitForContentScriptValue(evalInContentScript, 'window.__ocSettingsEchoes', (v) => v > before, {
      timeout: 5000,
      message: 'oc-settings change never echoed into the content script',
    });
  }

  // Merges `patch` into the top-level persisted settings via chrome.storage.sync.set —
  // the same underlying write the popup/in-page settings panel makes — from inside the
  // content script's own isolated world, and waits for content.js's own onChanged
  // listener to actually apply it. Every call here must be a genuine value change: Chrome
  // only fires onChanged when the stored value differs, so a redundant write would hang
  // this wait forever.
  async function setSettings(patch) {
    const echoBefore = await armSettingsEcho();
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, ' + JSON.stringify(patch) + ');' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
    await waitForSettingsEcho(echoBefore);
  }

  // Same, but merges into the nested visionSettings object (e.g. colorPalette) instead of
  // clobbering it.
  async function setVisionSettings(patch) {
    const echoBefore = await armSettingsEcho();
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var vs = Object.assign({}, current.visionSettings || {}, ' + JSON.stringify(patch) + ');' +
        'var next = Object.assign({}, current, { visionSettings: vs });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
    await waitForSettingsEcho(echoBefore);
  }

  function getPersistedSettings() {
    return evalInContentScript(
      "new Promise(function (resolve) { chrome.storage.sync.get('oc-settings', function (d) { resolve(d['oc-settings']); }); })"
    );
  }

  // Clears any leftover .oc-beacon nodes, presses Enter to (re-)fire the active beacon
  // (goToNext()/replay path — the only match on the page, so every Enter re-fires the
  // same active match), and waits for a fresh .oc-beacon container to actually exist.
  // animate() calls cancelBeacons() first, so this never accumulates parts across calls.
  async function replay() {
    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: 5000 });
  }

  async function ringColors() {
    const raw = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.oc-dispersion-ring')).map((el) => getComputedStyle(el).borderTopColor)
    );
    return raw.map(rgbStringToArr);
  }

  function rgbStringToArr(str) {
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(str);
    assert.ok(m, `not an rgb()/rgba() colour string: ${str}`);
    return [Math.round(parseFloat(m[1])), Math.round(parseFloat(m[2])), Math.round(parseFloat(m[3]))];
  }

  // Order-independent: DOM order of the three rings is an implementation detail, only the
  // *set* of hues rendered is under test. A small per-channel tolerance absorbs any
  // rounding difference between this file's independent hslToHex and content.js's own.
  function assertColorsMatch(actualRgbArrays, expectedHexes) {
    const expectedRgbArrays = expectedHexes.map(hexToRgbArr);
    for (const expected of expectedRgbArrays) {
      const found = actualRgbArrays.some((actual) => actual.every((channel, i) => Math.abs(channel - expected[i]) <= 2));
      assert.ok(found, `expected a ring rendering ${JSON.stringify(expected)} among ${JSON.stringify(actualRgbArrays)}`);
    }
  }

  test('ring hues are the -22/0/+22 offsets of the effective beacon colour, and move when the palette changes', async () => {
    // 'default' palette passes settings.beaconColor straight through unchanged
    // (getEffectiveColors()) — read the real persisted value rather than hardcoding it.
    const before = await getPersistedSettings();
    const defaultBeacon = before.beaconColor || '#fbbf24';
    assert.strictEqual(
      (before.visionSettings && before.visionSettings.colorPalette) || 'default',
      'default',
      'sanity check: this test must start from the default palette'
    );

    await replay();
    let colors = await ringColors();
    assert.strictEqual(colors.length, 3, `expected 3 dispersion rings, got ${colors.length}`);
    assertColorsMatch(colors, expectedRingHexes(defaultBeacon));

    try {
      // Switch the vision profile's colour palette (default -> tritanopia). Its beacon
      // colour is injected as a live CSS custom property by the content script itself
      // (injectHighlightStyles()'s designTokensCss --oc-palette-tritanopia-beacon) — read
      // it out of the real page instead of hardcoding the value a second time.
      await setVisionSettings({ colorPalette: 'tritanopia' });
      const tritanopiaBeacon = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--oc-palette-tritanopia-beacon').trim()
      );
      assert.ok(
        /^#[0-9a-f]{6}$/i.test(tritanopiaBeacon),
        `unexpected tritanopia beacon custom property value: "${tritanopiaBeacon}"`
      );
      assert.notStrictEqual(
        tritanopiaBeacon.toLowerCase(),
        defaultBeacon.toLowerCase(),
        'sanity check: default and tritanopia beacon colours must actually differ for this test to prove anything'
      );

      await replay();
      colors = await ringColors();
      assert.strictEqual(colors.length, 3, `expected 3 dispersion rings, got ${colors.length}`);
      assertColorsMatch(colors, expectedRingHexes(tritanopiaBeacon));
    } finally {
      await setVisionSettings({ colorPalette: 'default' });
    }
  });

  test('every .oc-beacon element is removed once the effect finishes (no leak)', async () => {
    await replay();
    assert.ok(
      (await page.locator('.oc-beacon').count()) > 0,
      'sanity check: the beacon must actually render before checking it is cleaned up'
    );

    // animateDispersion() schedules its own container removal via
    // getBeaconDuration(2200) — poll for it to actually happen instead of guessing the
    // exact duration.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: 8000 });
  });

  test('reduced motion renders the reduced-motion beacon and never the dispersion rings', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      await replay();
      assert.ok((await page.locator('.oc-beacon').count()) > 0, 'the reduced-motion beacon must still render');
      assert.strictEqual(
        await page.locator('.oc-dispersion-ring').count(),
        0,
        'dispersion rings must never render under reduced motion'
      );
    } finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  });

  test('Lite Mode drops the ring count from 3 to 1', async () => {
    await replay();
    assert.strictEqual(await page.locator('.oc-dispersion-ring').count(), 3, 'full mode must render all 3 rings');

    try {
      await setSettings({ performanceMode: true });
      await replay();
      assert.strictEqual(await page.locator('.oc-dispersion-ring').count(), 1, 'Lite Mode must drop the ring count to 1');
    } finally {
      await setSettings({ performanceMode: false });
    }
  });
});
