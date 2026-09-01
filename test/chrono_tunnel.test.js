// Chrono Tunnel beacon effect (oculist-dvt.2): a slit-scan tunnel of rotating polygons
// rushing outward past the match, additive-blended on a canvas, hue derived from
// getEffectiveColors().beacon and swept a bounded +/-60 degrees around that base — never
// the mockup's full 360-degree spectrum. Ported from the approved beacon-bench.html
// reference geometry (ring count, sides, radius curve, rotation, wobble, envelope); this
// suite is about the real-page colour adaptation and the beacon contract every effect
// must honour. Modelled directly on speed_lines.test.js.
//
// Needs a real browser for the same reasons as speed_lines.test.js: a real <canvas> and a
// real layout only exist in real Chromium, and Lite Mode can only be toggled for real
// through chrome.storage.sync.
//
// Deliberately does NOT trust window.__ocTest.lastChronoHueRun.baseHue as the expected
// value to grade against — that field is exactly what content.js's own hue derivation
// computed, so comparing samples to it would only ever prove "the samples agree with
// whatever the implementation happened to compute," even if that computation ignores the
// beacon colour entirely (e.g. a hardcoded hue). Instead this file carries its own
// independent hex-to-hue conversion and its own circular-distance/circular-mean math, and
// grades the actually-rendered hueSamples against that independently-computed value.
//
// One context, one finder session kept open across all five tests (mirroring
// speed_lines.test.js) — settings are changed via direct chrome.storage.sync writes from
// inside the content script's own isolated world, and each test that mutates shared state
// restores it in a `finally` so later tests start clean. The cancellation test is
// deliberately last: it presses Escape, which closes the finder for the rest of the suite.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { elementCenterInContainer } = require('./helpers/effect_anchor');

const EXTENSION = path.resolve(__dirname, '../extension');

// Generous enough to absorb sub-pixel float rounding between the effect's own local-canvas
// math and a real getBoundingClientRect() read, tight enough that the 150px whole-effect
// offset this test exists to catch (oculist-dvt.7) still fails it by two orders of
// magnitude.
const ANCHOR_TOLERANCE = 2;

// #target is the text the finder searches for and the beacon fires on.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; background:#06080D; color:#ccc; }</style>
<p>${'filler words to fill the page and give the tunnel room to rush past. '.repeat(30)} <span id="target">quarklet</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';

// Standard hex -> HSL hue conversion, written independently of content.js's own
// hexToHsl() (content.js:5340). If content.js's hue derivation regresses to ignore the
// beacon colour, or its sweep math breaks the wraparound case, this independent copy is
// what actually catches it — grading against content.js's own computed value would not.
function expectedHue(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substr(0, 2), 16) / 255;
  const g = parseInt(c.substr(2, 2), 16) / 255;
  const b = parseInt(c.substr(4, 2), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h;
  if (max === min) {
    h = 0;
  } else {
    const d = max - min;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return h * 360;
}

// Shortest angular distance between two hues on the 0-360 circle. Naive |a - b| is wrong
// exactly at the wraparound seam (e.g. 8 and 308 are 60 apart on the circle, not 300).
function circularDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Circular (vector) mean, not an arithmetic mean — an arithmetic mean of hues straddling
// the 0/360 seam (e.g. 350 and 10) would wrongly average to 180 instead of 0.
function circularMean(values) {
  let sinSum = 0, cosSum = 0;
  for (const v of values) {
    const rad = (v * Math.PI) / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
  }
  const meanRad = Math.atan2(sinSum / values.length, cosSum / values.length);
  return ((meanRad * 180) / Math.PI + 360) % 360;
}

function maxPairwiseCircularDist(values) {
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const d = circularDist(values[i], values[j]);
      if (d > max) max = d;
    }
  }
  return max;
}

describe('Chrono Tunnel: slit-scan ring field rushing past the match', () => {
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
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });

    // Select the Chrono Tunnel effect for the whole suite before ever opening the finder
    // — every test below assumes this baseline.
    await setSettings({ effect: 'chrono' });

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
      { timeout: POLL_TIMEOUT }
    );
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function openFinder() {
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        // Intentional unscaled sub-poll: the scaled waitForSelector below surfaces
        // the real timeout error if all 20 attempts fail.
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

  // Same reasoning as dispersion_bloom.test.js's armSettingsEcho/waitForSettingsEcho/
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

  // Clears any leftover .oc-beacon nodes, presses Enter to (re-)fire the active beacon
  // (goToNext()/replay path — the only match on the page, so every Enter re-fires the same
  // active match), and waits for a fresh .oc-beacon container to actually exist. animate()
  // calls cancelBeacons() first, so this never accumulates parts across calls.
  async function replay() {
    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  // Deliberately not pixel sampling, for the same reason speed_lines.test.js gives: a
  // second independent requestAnimationFrame poller racing the content script's own rAF
  // loop for a chance to rasterise the canvas at a lucky instant starved that suite 2/2
  // under parallel load. content.js's own frame() loop instead pushes every hue it
  // actually applies to a ring's strokeStyle into window.__ocTest.lastChronoHueRun
  // .hueSamples, and chronoDone flips once the run reaches its final frame — a plain
  // isolated-world value poll, not a page-side rAF race.
  async function waitForChronoDone() {
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.chronoDone', (v) => v === true, {
      timeout: LONG_TIMEOUT,
      message: 'chrono tunnel beacon never reached its final frame',
    });
  }

  test('ring hue tracks the beacon colour, not a fixed spectrum', async () => {
    const colorA = '#3355ff'; // hue ~230
    const colorB = '#ff8f1a'; // hue ~30.66
    const expA = expectedHue(colorA);
    const expB = expectedHue(colorB);
    // Sanity check on the fixture itself: the two colours must actually be far apart on
    // the hue circle, well beyond the +/-60 degree sweep either one gets, or a broken
    // implementation that ignores colour entirely could still land "close enough" to both
    // by accident.
    assert.ok(circularDist(expA, expB) > 100, `sanity check: fixture colours too close in hue (${expA} vs ${expB})`);

    try {
      await setSettings({ beaconColor: colorA });
      await replay();
      await waitForChronoDone();
      const runA = await evalInContentScript('window.__ocTest.lastChronoHueRun');
      assert.ok(runA.hueSamples.length > 20, `sanity check: expected many rendered ring hues, got ${runA.hueSamples.length}`);
      const meanA = circularMean(runA.hueSamples);

      await setSettings({ beaconColor: colorB });
      await replay();
      await waitForChronoDone();
      const runB = await evalInContentScript('window.__ocTest.lastChronoHueRun');
      assert.ok(runB.hueSamples.length > 20, `sanity check: expected many rendered ring hues, got ${runB.hueSamples.length}`);
      const meanB = circularMean(runB.hueSamples);

      // Each run's mean hue should sit close to that run's own independently-computed
      // expected hue — well inside the +/-60 degree sweep envelope averaging toward its
      // centre.
      assert.ok(
        circularDist(meanA, expA) < 40,
        `expected colour A's rendered hues to track its beacon colour (hue ~${expA}); got mean ${meanA}`
      );
      assert.ok(
        circularDist(meanB, expB) < 40,
        `expected colour B's rendered hues to track its beacon colour (hue ~${expB}); got mean ${meanB}`
      );
      // And the two runs' rendered hues must themselves differ correspondingly — this is
      // what actually fails if the implementation reverts to a fixed spectrum (both means
      // would collapse toward the same value regardless of beaconColor).
      assert.ok(
        circularDist(meanA, meanB) > 60,
        `expected rendered hues to differ between two different beacon colours; meanA=${meanA}, meanB=${meanB}`
      );
    } finally {
      await setSettings({ beaconColor: '#fbbf24' });
    }
  });

  test('the hue sweep stays within ~60 degrees of the beacon hue, respecting wraparound', async () => {
    // Base hue deliberately chosen near the 0/360 seam: a -60 degree sweep from hue 8
    // lands at 308, which the circular-distance math below must recognise as *in* range.
    const colorWrap = '#ff2200'; // hue 8
    const expWrap = expectedHue(colorWrap);

    try {
      await setSettings({ beaconColor: colorWrap });
      await replay();
      await waitForChronoDone();
      const run = await evalInContentScript('window.__ocTest.lastChronoHueRun');
      assert.ok(run.hueSamples.length > 20, `sanity check: expected many rendered ring hues, got ${run.hueSamples.length}`);

      let maxDist = 0;
      for (const hue of run.hueSamples) {
        const d = circularDist(hue, expWrap);
        if (d > maxDist) maxDist = d;
      }
      // A generous slack over the ~60 degree design bound to absorb floating-point
      // rounding — a full-spectrum implementation would blow this ceiling by more than
      // double, and a wraparound bug would show up as spuriously huge distances here too.
      assert.ok(
        maxDist <= 65,
        `expected every rendered hue to stay within ~60 degrees of the beacon hue (${expWrap}); max observed circular distance was ${maxDist}`
      );
    } finally {
      await setSettings({ beaconColor: '#fbbf24' });
    }
  });

  // The hue-tracking tests above are graded against an independently-computed expected
  // hue, but that only covers colour — the ring/core position (vpCx, offsetY) they're drawn
  // around is still only ever checked against itself. A shared internal anchor bug (e.g.
  // the ring centre offset by a constant, oculist-dvt.7) translates every ring, the wobble
  // and the core glow together, which leaves every hue-based assertion in this file
  // self-consistent while the whole tunnel is centred away from the word. This test grades
  // window.__ocTest.lastChronoAnchor against an independent source of truth instead: the
  // match's own rendered position, read straight off the DOM (see
  // test/helpers/effect_anchor.js).
  test("the effect's own reported anchor matches where the match actually renders", async () => {
    await replay();

    const anchor = await evalInContentScript('window.__ocTest.lastChronoAnchor');
    const independent = await elementCenterInContainer(page, '#target', '.oc-beacon');

    assert.ok(independent, 'sanity check: expected both #target and .oc-beacon to resolve to real elements');
    const dx = Math.abs(anchor.matchX - independent.x);
    const dy = Math.abs(anchor.matchY - independent.y);
    assert.ok(
      dx <= ANCHOR_TOLERANCE && dy <= ANCHOR_TOLERANCE,
      `expected the effect's own reported anchor to match the match's real rendered position within ${ANCHOR_TOLERANCE}px; ` +
        `anchor=${JSON.stringify(anchor)}, independent=${JSON.stringify(independent)} (dx=${dx}px, dy=${dy}px)`
    );
  });

  test('Lite Mode collapses to a single hue and materially fewer rings', async () => {
    try {
      await setSettings({ beaconColor: '#3355ff', performanceMode: false });
      await replay();
      await waitForChronoDone();
      const fullRun = await evalInContentScript('window.__ocTest.lastChronoHueRun');
      assert.ok(fullRun.ringCount > 15, `sanity check: expected a large full-mode ring count, got ${fullRun.ringCount}`);
      const fullSpread = maxPairwiseCircularDist(fullRun.hueSamples);
      assert.ok(fullSpread > 10, `sanity check: expected full-mode hues to actually vary, spread was ${fullSpread}`);

      await setSettings({ performanceMode: true });
      await replay();
      await waitForChronoDone();
      const liteRun = await evalInContentScript('window.__ocTest.lastChronoHueRun');

      assert.ok(
        liteRun.ringCount < fullRun.ringCount / 2,
        `expected Lite Mode to draw materially fewer rings; full=${fullRun.ringCount}, lite=${liteRun.ringCount}`
      );
      assert.ok(liteRun.hueSamples.length > 5, `sanity check: expected Lite Mode to still render some rings, got ${liteRun.hueSamples.length}`);
      const liteSpread = maxPairwiseCircularDist(liteRun.hueSamples);
      assert.ok(
        liteSpread < 1,
        `expected Lite Mode to render every ring at a single collapsed hue (no sweep); observed spread ${liteSpread} across hues ${JSON.stringify(liteRun.hueSamples.slice(0, 10))}`
      );
    } finally {
      await setSettings({ performanceMode: false, beaconColor: '#fbbf24' });
    }
  });

  test('every .oc-beacon element is removed once the effect finishes (no leak)', async () => {
    await replay();
    assert.ok(
      (await page.locator('.oc-beacon').count()) > 0,
      'sanity check: the beacon must actually render before checking it is cleaned up'
    );
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: LONG_TIMEOUT });
  });

  // oculist-3ae: animateChronoTunnel's early-return guard (rect missing or zero-sized)
  // used to sit BEFORE every __ocTest hook was touched, so a skipped run left all four
  // hooks holding whatever the previous real run had last written -- the same class of
  // bug oculist-47e fixed for animateSpeedLines (see that fix's identical test in
  // speed_lines.test.js, which this mirrors). Worse here than for speed lines:
  // lastChronoHueRun.hueSamples.push(...) runs inside the frame loop, so a stale object
  // left in place would keep ACCUMULATING samples across runs rather than merely being
  // read stale. This runs a real beacon first (so every hook holds genuine, non-default
  // data), captures that state, then drives the guard through the extension's own normal
  // call path -- no synthetic rect, no test-only export of the effect renderer itself.
  test("a skipped run (zero-size rect) resets every hook instead of leaving the previous run's data", async () => {
    await replay();
    await waitForChronoDone();

    const readHooks = `
      ({
        hueRun: window.__ocTest.lastChronoHueRun,
        anchor: window.__ocTest.lastChronoAnchor,
        frameCount: window.__ocTest.chronoFrameCount,
        done: window.__ocTest.chronoDone
      })
    `;

    const before = await evalInContentScript(readHooks);

    // Sanity check: the real run above must have actually left every hook holding real
    // data -- otherwise the assertions below could pass vacuously against an
    // already-default value instead of proving the guard resets anything.
    assert.ok(
      before.hueRun && Array.isArray(before.hueRun.hueSamples) && before.hueRun.hueSamples.length > 0,
      'sanity check: expected a real lastChronoHueRun with rendered hueSamples from the prior run'
    );
    assert.ok(before.anchor, 'sanity check: expected a lastChronoAnchor from the prior run');
    assert.ok(before.frameCount > 0, 'sanity check: expected a nonzero chronoFrameCount from the prior run');
    assert.strictEqual(before.done, true, 'sanity check: expected the prior run to have completed');

    // Drive the SAME early-return guard through the extension's real, normal call path
    // instead of a synthetic rect or an exported test-only closure. font-size:0 is
    // verified (in real Chromium) to yield a getBoundingClientRect of {width:0, height:0}
    // while the element stays display:inline/visibility:visible, so it remains indexed
    // and remains the active match; no chip/term change is needed.
    await page.evaluate(() => { document.getElementById('target').style.fontSize = '0'; });
    try {
      await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
      await page.keyboard.press('Enter');

      // No '.oc-beacon' will ever appear -- the guard returns before the container is
      // created -- so this cannot reuse replay()'s own waitForSelector('.oc-beacon'). Poll
      // chronoFrameCount specifically instead: it can only go from the prior run's
      // nonzero value back to 0 by this reset running, since no real run is possible once
      // the element is zero-sized.
      const after = await waitForContentScriptValue(evalInContentScript, readHooks, (v) => v.frameCount === 0, {
        timeout: POLL_TIMEOUT,
        message: 'the zero-size-match run never reset chronoFrameCount',
      });

      assert.strictEqual(
        after.hueRun,
        null,
        `expected a skipped run to null out lastChronoHueRun instead of leaving (or appending to) the prior run's ${before.hueRun.hueSamples.length}-sample data`
      );
      assert.strictEqual(
        after.anchor,
        null,
        `expected a skipped run to null out lastChronoAnchor instead of leaving the prior run's ${JSON.stringify(before.anchor)}`
      );
      assert.strictEqual(
        after.frameCount,
        0,
        `expected a skipped run to zero chronoFrameCount instead of leaving the prior run's ${before.frameCount}`
      );
      // The load-bearing assertion: a test that polls chronoDone === true to detect
      // completion must NOT be satisfied by a skipped run. Leaving this false means such a
      // wait times out loudly instead of resolving off the prior run's stale true.
      assert.strictEqual(
        after.done,
        false,
        "expected a skipped run to leave chronoDone false rather than reporting the prior run's stale completion"
      );
    } finally {
      await page.evaluate(() => { document.getElementById('target').style.fontSize = ''; });
    }
  });

  // oculist-qii: fadeActiveBeacons() (content.js, called from handleScroll()) is the
  // second of the two paths that remove a .oc-beacon element, and until this fix did so
  // without ever cancelling container.__rafId first — a container detached mid-flight was
  // permanently unreachable afterward (cancelBeacons() finds its targets via
  // document.querySelectorAll('.oc-beacon')), so the rAF loop it left running spun forever
  // against a detached canvas. This drives the real bug repro: a real scroll
  // (page.mouse.wheel, not a synthetic 'scroll' dispatch) while the beacon is live, and
  // asserts the frame loop actually stops rather than merely asserting the element is gone.
  test('a real scroll mid-flight stops the rAF loop via fadeActiveBeacons(), not just removes the element', async () => {
    // This suite's page is exactly one viewport tall (scrollHeight === innerHeight), so a
    // real wheel scroll has nothing to scroll — window.scrollY would stay 0 and this test
    // would silently pass for the wrong reason (the effect's own natural DUR completion
    // stopping the frame counter, not fadeActiveBeacons()). Padding the page taller makes
    // the scroll genuine before anything else runs.
    //
    // Centre the match first so this replay() never itself needs to auto-scroll the page
    // into view — highlightActiveRange() (content.js) only calls triggerAutoScrollFlag()
    // when the match is NOT already fully in the viewport, and that flag makes
    // handleScroll() ignore the very scroll this test is about to fire for 800ms. Centring
    // first guarantees replay()'s own Enter never sets it.
    await page.evaluate(() => {
      document.body.style.paddingBottom = '2000px';
      document.getElementById('target').scrollIntoView({ block: 'center', behavior: 'instant' });
    });

    await replay();

    // Let a couple of real frames render first, so a stuck-at-zero counter can't pass by
    // accident.
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.chronoFrameCount', (v) => v >= 2, {
      timeout: POLL_TIMEOUT,
      message: 'chrono tunnel never rendered its first frames',
    });

    // A real wheel scroll, exactly as the bug reproduction used — not a synthetic
    // dispatchEvent('scroll'), which would prove nothing about the real browser scroll
    // path handleScroll() is wired to.
    const scrollYBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction((y) => window.scrollY > y, scrollYBefore, { timeout: POLL_TIMEOUT });

    // fadeActiveBeacons() fades over 50ms, then removes on a setTimeout — wait past that
    // window for the container to actually be gone before reading the frame count.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });

    const afterRemoval = await evalInContentScript('window.__ocTest.chronoFrameCount');

    // Positively confirm the frame counter never grows again: wait (up to the same
    // POLL_TIMEOUT budget used everywhere else in this suite) for it to exceed its
    // post-removal value. If fadeActiveBeacons() actually cancelled the rAF loop, that wait
    // times out — which is the success case here — rather than resolving.
    let grew = false;
    try {
      await waitForContentScriptValue(
        evalInContentScript,
        'window.__ocTest.chronoFrameCount',
        (v) => v > afterRemoval,
        { timeout: POLL_TIMEOUT }
      );
      grew = true;
    } catch (e) {
      if (!/timed out/.test(e.message)) throw e;
    }
    assert.strictEqual(
      grew,
      false,
      `expected the rAF loop to have stopped after a scroll-driven fadeActiveBeacons() removal; frame count kept growing past ${afterRemoval}`
    );
  });

  // Deliberately last: Escape closes the finder for the rest of the suite (__ocDestroy()
  // calls cancelBeacons()), so no later test can reopen it within this shared session.
  test('cancelBeacons() stops the rAF loop mid-flight (proves container.__rafId is wired)', async () => {
    await replay();

    // Let a couple of real frames render first, so a stuck-at-zero counter can't pass by
    // accident.
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.chronoFrameCount', (v) => v >= 2, {
      timeout: POLL_TIMEOUT,
      message: 'chrono tunnel never rendered its first frames',
    });

    await page.keyboard.press('Escape'); // -> window.__ocDestroy() -> cancelBeacons()
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: POLL_TIMEOUT });

    const afterCancel = await evalInContentScript('window.__ocTest.chronoFrameCount');

    // Positively confirm the frame counter never grows again: wait (up to the same
    // POLL_TIMEOUT budget used everywhere else in this suite) for it to exceed its
    // post-cancellation value. If cancelBeacons() actually cancelled the rAF loop, that
    // wait times out — which is the success case here — rather than resolving.
    let grew = false;
    try {
      await waitForContentScriptValue(
        evalInContentScript,
        'window.__ocTest.chronoFrameCount',
        (v) => v > afterCancel,
        { timeout: POLL_TIMEOUT }
      );
      grew = true;
    } catch (e) {
      if (!/timed out/.test(e.message)) throw e;
    }
    assert.strictEqual(
      grew,
      false,
      `expected the rAF loop to have stopped after cancelBeacons(); frame count kept growing past ${afterCancel}`
    );
  });
});
