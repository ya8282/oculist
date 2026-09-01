// oculist-4re: animateReducedMotion()'s spotlight overlay (the full-page dark mask with a
// radial-gradient "hole" over the match) used to be position:fixed, with the hole centred
// at a one-shot VIEWPORT-coordinate point (rect.left/rect.top) computed only once. Its
// siblings in the same function (glow, both arrows) use document coordinates (x/y, i.e.
// rect.left + window.scrollX) and track scroll correctly. On the first scroll, the fixed
// mask stayed put on screen while the match moved out from under it, so the hole pointed
// at whatever now happened to sit at those coordinates — a spotlight that lies to exactly
// the low-vision user relying on it to say "the match is HERE".
//
// The fix renders the overlay position:absolute, sized to the full document, with the
// gradient centred at the same document-coordinate x/y its siblings already use — so
// scrolling the page moves the overlay (and its hole) along with the match, the same way
// position:absolute already keeps the glow and arrows aligned.
//
// Geometric check, deliberately implementation-agnostic about fixed vs. absolute: read the
// overlay's own getBoundingClientRect() (viewport coordinates, whatever the position
// scheme) and add the gradient's "at Xpx Ypx" offset (relative to the overlay's own box).
// That sum is where the hole actually renders on screen. Compare it against the match's own
// current getBoundingClientRect() center. A position:fixed, viewport-sized overlay has
// obox.top/left pinned at 0 regardless of scroll, so this sum stays frozen at the original
// draw-time viewport position — exactly the bug. A position:absolute, document-sized overlay
// has obox.top/left shift by -scrollY/-scrollX as the page scrolls, which cancels the
// document-coordinate offset baked into the gradient and reproduces the match's live
// viewport position — the fix.
//
// oculist-di4 (in this same branch) added fadeActiveBeacons(): a real scroll now fades and
// removes .oc-beacon-transient elements (including this spotlight) ~50ms after the *first*
// scroll event fires. This test captures the overlay's geometry synchronously inside its own
// 'scroll' listener, in the same event dispatch as fadeActiveBeacons() — before that 50ms
// removal lands. fadeActiveBeacons() only ever sets style.opacity (which does not affect
// layout or the background string), so this capture is race-free with respect to removal.
//
// Browser-based for the same reasons as beacon_fade_persistent_overlays.test.js: reduced
// motion's spotlight, a real scroll event, and fadeActiveBeacons() are only reachable
// through the real content script's isolated execution context, in a real browser.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// Target sits near the top so it starts on screen, with a tall run of filler below it so a
// real scroll actually moves it a large, unambiguous distance under the 800px viewport.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>filler above the match. <span id="target">quarklet</span></p>
<div style="height:3000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('reduced-motion spotlight overlay tracks scroll (oculist-4re)', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless shell,
    // which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP before navigating so the isolated-world execution-context-created event is
    // never missed.
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
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });

    // displayPreset === 'reduced-motion' alone only picks the spotlight *rendering*
    // variant inside animateReducedMotion(); it is effectiveMotion() (driven by
    // visionSettings.motionSensitivity) that decides animate() calls animateReducedMotion()
    // at all. The real "Eye Strain" popup profile sets both together (extension/popup.js),
    // so do the same here rather than hand-picking just the field this test cares about.
    await setSettings({ displayPreset: 'reduced-motion', visionSettings: { motionSensitivity: 'reduced' } });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function openFinder() {
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        // Intentional unscaled sub-poll: the scaled waitForSelector below surfaces the
        // real timeout error if all 20 attempts fail.
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
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

  // Same reasoning as active_beacons_counter.test.js's armSettingsEcho/waitForSettingsEcho/
  // setSettings trio: chrome.storage.onChanged fires listeners in registration order, so
  // observing our own probe listener fire is a direct proxy for content.js's own listener
  // (registered earlier, at page load) having already applied the change.
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
      timeout: POLL_TIMEOUT,
      message: 'oc-settings change never echoed into the content script',
    });
  }

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

  // Finds the one .oc-beacon-transient element that paints the spotlight mask (the glow and
  // both arrows are transient too, but paint a solid color / text, never a radial-gradient).
  // Returns null if it is not there (e.g. already faded and removed).
  const SPOTLIGHT_FINDER = `
    (function () {
      var els = document.querySelectorAll('.oc-beacon-transient');
      for (var i = 0; i < els.length; i++) {
        var bg = els[i].style.backgroundImage || els[i].style.background || '';
        if (bg.indexOf('radial-gradient') !== -1) return els[i];
      }
      return null;
    })()
  `;

  // Reads, from the page's main world (not the content script's isolated world — plain
  // page.evaluate is enough here since none of this touches chrome.* APIs), the spotlight's
  // rendered on-screen (viewport) hole position plus the match's current on-screen center.
  // obox is the overlay's own getBoundingClientRect() — viewport coordinates regardless of
  // whether the overlay itself is position:fixed or position:absolute. cx/cy is the gradient's
  // "at Xpx Ypx" offset, which is relative to the overlay's own box. Their sum is therefore
  // where the hole actually paints on screen, independent of which positioning scheme drew it.
  const READ_SPOTLIGHT_JS = `
    (function () {
      var overlay = ${SPOTLIGHT_FINDER};
      var target = document.getElementById('target');
      if (!overlay || !target) return { missing: true, overlayFound: !!overlay };
      var bg = overlay.style.backgroundImage || overlay.style.background || '';
      var m = /at\\s+(-?[\\d.]+)px\\s+(-?[\\d.]+)px/.exec(bg);
      if (!m) return { missing: true, noMatch: true, bg: bg };
      var obox = overlay.getBoundingClientRect();
      var trect = target.getBoundingClientRect();
      return {
        missing: false,
        gradientViewportX: obox.left + parseFloat(m[1]),
        gradientViewportY: obox.top + parseFloat(m[2]),
        targetViewportCenterX: trect.left + trect.width / 2,
        targetViewportCenterY: trect.top + trect.height / 2,
      };
    })()
  `;

  test('the spotlight hole stays over the match after a real scroll', async () => {
    try {
      await openFinder();
      await page.locator(INPUT).type('quarklet', { delay: 30 });
      // Wait for the draft debounce to actually land a real match count before pressing
      // Enter, instead of guessing its duration.
      await page.waitForFunction(
        () => {
          const root = document.getElementById('oc-wrap');
          const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
          return !!count && /of \d+/.test(count.textContent);
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      // Confirm the beacon that is about to fire is actually the reduced-motion spotlight
      // variant, not the full-motion effect — otherwise this test would not mean anything.
      assert.strictEqual(
        await evalInContentScript('window.__ocTest.getEffectiveMotion()'),
        'reduced',
        'this test only means anything on the reduced-motion branch'
      );

      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (finderJs) => !!eval(finderJs),
        SPOTLIGHT_FINDER,
        { timeout: POLL_TIMEOUT }
      );

      // Sanity check while unscrolled: the hole should already sit on the match, otherwise
      // the geometry-reading logic itself is wrong and the post-scroll assertion below would
      // not mean anything.
      const beforeScroll = await page.evaluate(READ_SPOTLIGHT_JS);
      assert.strictEqual(beforeScroll.missing, false, `spotlight not readable before scroll: ${JSON.stringify(beforeScroll)}`);
      assert.ok(
        Math.abs(beforeScroll.gradientViewportX - beforeScroll.targetViewportCenterX) < 6,
        `hole should start centered on the match (x), got ${JSON.stringify(beforeScroll)}`
      );
      assert.ok(
        Math.abs(beforeScroll.gradientViewportY - beforeScroll.targetViewportCenterY) < 6,
        `hole should start centered on the match (y), got ${JSON.stringify(beforeScroll)}`
      );

      // Install a 'scroll' listener that captures the spotlight's geometry synchronously in
      // the same event dispatch that fadeActiveBeacons() (handleScroll's entry point) uses to
      // start fading it — i.e. before the 50ms removal timer that same event schedules can
      // possibly land. Whichever of the two window-level 'scroll' listeners runs first, this
      // one only ever reads style/geometry (fadeActiveBeacons only ever writes style.opacity),
      // so the read is accurate regardless of listener order.
      await page.evaluate(
        (readJs) => {
          window.__ocSpotlightCapture = null;
          window.addEventListener(
            'scroll',
            function onScroll() {
              window.removeEventListener('scroll', onScroll);
              // eslint-disable-next-line no-eval
              window.__ocSpotlightCapture = eval(readJs);
            },
            true
          );
        },
        READ_SPOTLIGHT_JS
      );

      // A real scroll, large enough (the page has 3000px of filler below the match) that a
      // spotlight frozen at its pre-scroll viewport position would be off by hundreds of
      // pixels, not a rounding error.
      await page.mouse.wheel(0, 500);

      const captured = await waitForCondition(() => page.evaluate(() => window.__ocSpotlightCapture), (v) => v !== null, {
        timeout: POLL_TIMEOUT,
        message: 'scroll event never fired (or was never observed) after page.mouse.wheel',
      });

      assert.strictEqual(captured.missing, false, `spotlight not readable at scroll time: ${JSON.stringify(captured)}`);

      // Confirm the scroll (and the wrapping test setup) actually moved the match a large,
      // unambiguous distance — otherwise a passing assertion below would not prove anything.
      assert.ok(
        Math.abs(captured.targetViewportCenterY - beforeScroll.targetViewportCenterY) > 200,
        `the scroll must actually move the match a large distance, got before=${beforeScroll.targetViewportCenterY} ` +
          `after=${captured.targetViewportCenterY}`
      );

      assert.ok(
        Math.abs(captured.gradientViewportX - captured.targetViewportCenterX) < 6,
        `spotlight hole drifted off the match on scroll (x): ${JSON.stringify(captured)}`
      );
      assert.ok(
        Math.abs(captured.gradientViewportY - captured.targetViewportCenterY) < 6,
        `spotlight hole drifted off the match on scroll (y) — it should track scroll like its ` +
          `glow/arrow siblings, not stay frozen at its pre-scroll viewport position: ${JSON.stringify(captured)}`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });
});
