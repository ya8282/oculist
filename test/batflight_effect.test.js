// Vampire Bat beacon effect (oculist-nq1x.9): promotes fxBatFlight (artifacts/prototypes/
// effects-playground.html) into extension/content.js as the eighth entry in the Halloween
// pack. A bat flies in along an erratic weave, vanishes into a rising mist column, and a
// cloaked head-and-shoulders figure fades in beside the match (right by default, left if
// the right side has no room), or -- when neither side fits -- above it, or -- last resort
// -- below it, never over it.
//
// Beats carrying real defect history, tested directly rather than just documented:
//
// 1. RULE 9 EXCEPTION (oculist-i8zu): the shipped lastMouseX/find-bar/viewport start-point
//    cascade is deliberately NOT used here -- the bat's launch point is pinned to the chosen
//    landing side. Moving the cursor to an unrelated point on the page must not move the
//    bat's own start point at all.
// 2. MIRRORED BRANCH (rule 9's other half): when the right side has no room, the figure must
//    actually land on the left -- exercised for real, not just compiled.
// 3. ABOVE/BELOW FALLBACK (oculist-1ta.8's own coverage gap, oculist-nq1x.9's own
//    MISSING-REQUIREMENT note): the standard occlusion sweep never exercises an above or
//    below landing at all, because scrollIntoView keeps the match centered so a side always
//    fits. This suite forces both directly with a full-width match near the viewport top.
// 4. MIST FADE-ANCHOR (oculist-1ta.8): the fade-out's transform-origin flips to 50% 0% ONLY
//    for the 'below' landing, so the scaleY(1.25) overshoot grows away from the match instead
//    of tinting it. Verified both by reading the live keyframe and by a per-frame pixel diff
//    of the match rect across the whole animation.
// 5. WING FLAP (oculist-1ta.1's own "a flap that never fired" defect): the discrete
//    wings-out/wings-tucked swap must actually alternate, not get stuck on one frame.
//
// Modeled on test/reanimate_effect.test.js and test/tentaclerise_effect.test.js (fixture/
// helper shape: real HTTP fixture, CDP isolated-world attach, tall-spacer layout,
// scrollBehavior 'instant', settleNavigation after navigation) and test/horseman_effect.test.js
// / test/flappy_effect.test.js for the travelling-effect idioms (offset-path travel geometry,
// pause+currentTime frame seeking for a deterministic multi-frame occlusion proof).
//
// Needs a real browser for the same reasons as those: WAAPI and real layout only exist in
// real Chromium, and Lite Mode/Beacon Size/Animation Speed/pack toggles only exist for real
// through chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target: margin-left:600px against this fixture's own 40px body padding puts the match's
// own horizontal center (mcx) just past vw/2 at the default 1200px-wide viewport (measured
// mcx ~678), and plenty of room on the right -- content.js's own useRight = mcx >= vw/2
// picks sideRight as the PREFERRED side (unlike animateReanimate, which always tries right
// first regardless of mcx), so this is the fixture that actually exercises the true default
// landing rather than assuming it.
//
// #leftFallbackTarget: margin-left:1000px pushes mcx well past vw/2 too (so sideRight is
// still preferred), but rect.right lands close enough to the viewport's own right edge that
// sideRight's own fit check fails while sideLeft's still passes -- forcing the real mirrored
// branch (rule 9's other half) rather than merely compiling it.
//
// #wideTarget: a 96px font renders "shadowmoth" ~526px wide -- comfortably clear of both
// viewport edges at the default 1200px width, but WIDER than the whole viewport once resized
// to 320px (the same "match wider than the viewport" technique reanimate_effect.test.js's own
// degenerateTarget uses), which fails sideRight's and sideLeft's own fit checks regardless of
// vertical scroll position -- and, because it is then never "fully in viewport", forces
// content.js's own highlightActiveRange() to scrollIntoView({block:'center'}) on every Enter
// press, vertically re-centering it regardless of any scrollTo() the test itself issues first
// (see batflightSnapshotWithMatch's own comment). The two above/below tests below drive that
// recenter with two different VIEWPORT HEIGHTS instead of a scroll offset: a tall one leaves
// real room above the centered match (forcing 'above'), a short one leaves none (forcing
// 'below', the unconditional last resort) -- the exact recipe oculist-1ta.8's own reviewer
// used to force a real below landing.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:600px;overflow-wrap:anywhere;"><span id="target">vespertide</span> filler</div>
<div style="height:1600px"></div>
<div style="margin-left:1000px;overflow-wrap:anywhere;"><span id="leftFallbackTarget">duskwarden</span> filler</div>
<div style="height:1000px"></div>
<p style="font-size:96px;"><span id="wideTarget">shadowmoth</span> filler</p>
<div style="height:1200px"></div>`;

const TARGET_TERMS = { target: 'vespertide', leftFallbackTarget: 'duskwarden', wideTarget: 'shadowmoth' };

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const BATFLIGHT_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:batflight"]';

describe('Vampire Bat: a bat flies in, vanishes into a mist column, and a cloaked figure fades in beside (or above/below) the match', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing -- the default bundled build is the headless shell,
    // which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: VIEWPORT,
    });

    page = await ctx.newPage();

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

    // scrollBehavior: 'instant' routes every scroll-into-view this suite triggers through
    // content.js's own 'auto' (instant) branch instead of a real multi-hundred-ms native
    // smooth-scroll animation, so settleNavigation() below has a real, short async window to
    // wait out rather than an open-ended one.
    await setSettings({ effect: 'batflight', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

    await openFinder(page);
    await page.locator(INPUT).type('vespertide', { delay: 30 });
    await waitForMatchCount(page);
    await settleNavigation();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function openFinder(pg) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await pg.keyboard.press('Control+f');
      try {
        await pg.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await pg.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  async function waitForMatchCount(pg) {
    await pg.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
  }

  // Same reasoning as reanimate_effect.test.js's own settleNavigation(): every target below
  // sits far down the page, so navigation triggers content.js's own native smooth
  // scroll-into-view before animate() ever fires -- wait for 'scrollend' (falling back to a
  // fixed ceiling) AND for any beacon that settle triggered to finish naturally.
  async function settleNavigation() {
    await page.evaluate(() => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      window.addEventListener('scrollend', finish, { once: true });
      setTimeout(finish, 750);
    }));
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  }

  function evalInContentScript(expression, target) {
    const c = (target && target.client) || client;
    const ctxId = (target && target.contextId) || isolatedContextId;
    return c
      .send('Runtime.evaluate', { expression, contextId: ctxId, awaitPromise: true, returnByValue: true })
      .then((res) => {
        if (res.exceptionDetails) {
          throw new Error('content-script eval failed: ' + JSON.stringify(res.exceptionDetails));
        }
        return res.result.value;
      });
  }

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
    return waitForCondition(() => evalInContentScript('window.__ocSettingsEchoes'), (v) => v > before, {
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

  // Same production cancellation path as the sibling suites: cancels any in-flight beacon
  // through window.__ocTest.cancelBeacons() (the exact function animate() itself calls
  // first), then presses Enter to (re-)fire.
  async function replay(predicate, arg) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    const handle = await page.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-batflight="bat"]') ? true : null)),
      arg !== undefined ? arg : null,
      { timeout: POLL_TIMEOUT }
    );
    return handle.jsonValue();
  }

  function switchToTarget(id) {
    return async () => {
      await page.locator(INPUT).fill('');
      await page.locator(INPUT).type(TARGET_TERMS[id], { delay: 30 });
      await waitForMatchCount(page);
      await settleNavigation();
    };
  }

  // Scrolls so #id's own TOP lands `topOffset` px below the viewport's top edge --
  // deterministic positioning from the element's real measured document position.
  async function scrollTargetTo(id, topOffset) {
    const docTop = await page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return r.top + window.scrollY;
    }, id);
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, docTop - topOffset));
  }

  // Mirrors content.js's own animateBatFlight() placement formula verbatim (measured and
  // derived exactly the same way, not hand-picked -- same duplication-in-the-test idiom
  // reanimate_effect.test.js's own predict() uses). Used only to PREDICT the landing side (or
  // the figure's expected document-space position) as a sanity check on the fixture itself --
  // every real assertion below reads the live rendered DOM.
  const FIG_ASPECT = 90 / 110;
  const BAT_W_BASE = 90;
  const GAP = 10, MIST_PAD = 10, INSET = 40;
  function predict(measured, beaconScale) {
    const figHeight = Math.max(56, Math.min(100, 3.0 * measured.height)) * beaconScale;
    const figWidth = figHeight * FIG_ASPECT;
    const batW = BAT_W_BASE * beaconScale;
    const clearHalfX = Math.max(figWidth / 2 + MIST_PAD, batW / 2);
    const clearHalfY = figHeight / 2 + MIST_PAD;
    const mcx = measured.left + measured.width / 2;
    const sideRightX = measured.right + GAP + clearHalfX;
    const sideRightFits = sideRightX + clearHalfX <= measured.vw - 4;
    const sideLeftX = measured.left - GAP - clearHalfX;
    const sideLeftFits = sideLeftX - clearHalfX >= 4;
    const vCenterX = Math.max(clearHalfX + 4, Math.min(measured.vw - clearHalfX - 4, mcx));
    const aboveY = measured.top - GAP - clearHalfY;
    const aboveFits = aboveY - clearHalfY >= 4;
    const belowY = measured.bottom + GAP + clearHalfY;
    const belowFits = belowY + clearHalfY <= measured.vh - 4;
    const useRight = mcx >= measured.vw / 2;
    const preferred = useRight ? { x: sideRightX, fits: sideRightFits, side: 'right' } : { x: sideLeftX, fits: sideLeftFits, side: 'left' };
    const secondary = useRight ? { x: sideLeftX, fits: sideLeftFits, side: 'left' } : { x: sideRightX, fits: sideRightFits, side: 'right' };
    const landing = preferred.fits ? preferred : secondary.fits ? secondary : aboveFits ? { x: vCenterX, y: aboveY, side: 'above' } : { x: vCenterX, y: belowY, side: 'below' };
    return { side: landing.side, endX: landing.x !== undefined ? landing.x : vCenterX, endY: landing.y, figWidth, figHeight, clearHalfX, clearHalfY };
  }

  function measure(id) {
    return page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    }, id);
  }

  // Reads the real rendered structure in one page-side tick -- folding presence and geometry
  // into the same predicate avoids the oculist-d5c round-trip hazard (a transient element can
  // self-clean between two separate round trips).
  function batflightSnapshot() {
    const batEl = document.querySelector('.oc-beacon-transient[data-batflight="bat"]');
    const mistEl = document.querySelector('.oc-beacon-transient[data-batflight="mist"]');
    const figEl = document.querySelector('.oc-beacon-transient[data-batflight="figure"]');
    if (!batEl && !mistEl && !figEl) return null;
    const figRect = figEl ? figEl.getBoundingClientRect() : null;
    return {
      batPresent: !!batEl,
      mistPresent: !!mistEl,
      figLeft: figEl ? figEl.style.left : null,
      figTop: figEl ? figEl.style.top : null,
      side: figEl ? figEl.getAttribute('data-bf-side') : null,
      figBox: figRect && { left: figRect.left, right: figRect.right, top: figRect.top, bottom: figRect.bottom, width: figRect.width, height: figRect.height },
    };
  }

  test('document-space correctness: on a scrolled page, the figure\'s own inline left/top carry a real "+ window.scrollX/scrollY" term', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const measured = await measure('target');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.side, 'right', 'sanity check: fixture must give the right side room');

      const geom = await replay(batflightSnapshot);
      assert.ok(geom, 'expected a mounted batflight');
      assert.ok(geom.figBox, 'the figure must mount with plenty of room');

      const expectedLeft = predicted.endX - predicted.figWidth / 2 + scroll.x;
      const expectedTop = measured.top + measured.height / 2 - predicted.figHeight / 2 + scroll.y;
      assert.ok(
        Math.abs(parseFloat(geom.figLeft) - expectedLeft) <= 2,
        `figure's style.left (${geom.figLeft}) must include window.scrollX -- expected ~${expectedLeft}px`
      );
      assert.ok(
        Math.abs(parseFloat(geom.figTop) - expectedTop) <= 2,
        `figure's style.top (${geom.figTop}) must include window.scrollY -- expected ~${expectedTop}px`
      );

      // The FIGURE's own left/top prove document-space correctness for figWrap's own CSS
      // write, but the bat travels via an offset-path built as a separate list of points
      // (pathPts) -- dropping window.scrollY there alone (leaving figWrap's own math intact)
      // would still pass the two assertions above. Reading the bat's own rendered box at
      // t=0 (paused, before any travel) against the SAME viewport-space startY formula
      // content.js itself uses catches that independently: on an unscrolled page the two
      // coordinate spaces coincide (scrollY=0) and this would stay green even with the bug,
      // which is exactly why this test scrolls the page first.
      // Reads the bat's own offset-path string directly -- its first "M x y" point is the
      // exact pathPts[0] content.js builds, in DOCUMENT space if SCROLL_Y was added there (as
      // rule 2 requires) or missing it entirely if dropped. WEAVE_AMP/JITTER_AMP/PHASE mirror
      // content.js's own path-point formula (evaluated at frac=0, before any damping reaches
      // zero -- the point is NOT bare startY).
      const firstPathY = await page.evaluate(() => {
        const bat = document.querySelector('.oc-beacon-transient[data-batflight="bat"]');
        const m = (bat.getAttribute('style') || '').match(/M\s*([-\d.]+)\s+([-\d.]+)/);
        return m ? parseFloat(m[2]) : null;
      });
      assert.ok(firstPathY !== null, 'sanity check: expected a parseable offset-path M command on the bat element');
      const mcy = measured.top + measured.height / 2;
      const predictedStartYViewport = Math.max(INSET, mcy - 130);
      const WEAVE_AMP = 22, WEAVE_PHASE = 0.6, JITTER_AMP = 8, JITTER_PHASE = 1.3;
      const weave0 = WEAVE_AMP * Math.sin(WEAVE_PHASE);
      const jitter0 = JITTER_AMP * Math.sin(JITTER_PHASE);
      const expectedFirstPathY = predictedStartYViewport + weave0 + jitter0 + scroll.y;
      assert.ok(
        Math.abs(firstPathY - expectedFirstPathY) <= 2,
        `bat's offset-path must add window.scrollY exactly once when building pathPts (document space) -- expected first path-point y ~${expectedFirstPathY}px (scrollY=${scroll.y}), got ${firstPathY}px`
      );

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('normal placement: the figure lands on the right by default, clear of #match, and the match DOM is untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const measured = await measure('target');
    const predicted = predict(measured, 1);
    assert.strictEqual(predicted.side, 'right', 'sanity check: fixture must give the right side room');

    const geom = await replay(batflightSnapshot);
    assert.ok(geom, 'expected a mounted batflight');
    assert.strictEqual(geom.side, 'right', 'default landing must be the right side');
    assert.ok(geom.figBox.left >= measured.right, `figure must sit clear of #match's own right edge, got figBox.left=${geom.figBox.left} vs match.right=${measured.right}`);

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

    // Sweeps the WHOLE flight, not just the landed frame -- a launch point on the wrong side
    // of the match (rule 9's own landing-side constraint) would fly the bat across #match
    // mid-transit even though the FIGURE still lands correctly clear of it.
    await assertNoOcclusionAcrossFlight('target');

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('starting from a genuinely unscrolled page (scrollY=0), Enter still finds and plays the effect correctly, via the extension\'s own scroll-into-view', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    try {
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.strictEqual(scroll.y, 0, 'sanity check: page must start genuinely unscrolled');

      const geom = await replay(batflightSnapshot);
      assert.ok(geom, 'expected a mounted batflight even from scrollY=0');
      assert.ok(geom.figBox, 'the figure must render');

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await scrollTargetTo('target', 200);
    }
  });

  test('left fallback (rule 9\'s mirrored branch): when the right side has no room, the figure actually lands on the left, and never occludes the match', async () => {
    await switchToTarget('leftFallbackTarget')();
    try {
      const measured = await measure('leftFallbackTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.side, 'left', 'sanity check: fixture must force the left-fallback branch');

      const before = await page.evaluate(() => document.getElementById('leftFallbackTarget').outerHTML);
      const geom = await replay(batflightSnapshot);
      assert.ok(geom, 'expected a mounted batflight');
      assert.strictEqual(geom.side, 'left', 'must land on the left when the right side has no room');
      assert.ok(geom.figBox.right <= measured.left, `figure must sit clear of #match's own left edge, got figBox.right=${geom.figBox.right} vs match.left=${measured.left}`);
      const after = await page.evaluate(() => document.getElementById('leftFallbackTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

      // The mirrored branch must launch from the LEFT edge too, not just land there --
      // reading the bat's own box at t=0 (paused, before any travel) catches a launch point
      // that stayed on the right (which would fly the bat across #match to reach this same
      // left landing) even though the final landing side alone reads as correct.
      const launchBox = await page.evaluate(() => {
        const bat = document.querySelector('.oc-beacon-transient[data-batflight="bat"]');
        bat.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        const r = bat.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      assert.ok(
        launchBox.right <= measured.left,
        `mirrored branch must LAUNCH from the left of #match too, not cross over from the right, got launch box right=${launchBox.right} vs match.left=${measured.left}`
      );

      // Sweeps the WHOLE flight -- the figure landing on the correct side does not by itself
      // prove the bat's PATH to get there stayed clear of #match the whole way.
      await assertNoOcclusionAcrossFlight('leftFallbackTarget');

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // Unconditional, so an assertion failure above (which skips the try block's own
      // cancel) can't leave a beacon alive to hang the NEXT test's own navigation-triggered
      // settleNavigation() with a stale .oc-beacon-transient it can't account for.
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
      await switchToTarget('target')();
    }
  });

  test('cursor independence (rule 9 exception, oculist-i8zu): moving the mouse elsewhere on the page never moves the bat\'s own start point', async () => {
    await scrollTargetTo('target', 200);
    try {
      // Move the cursor to a point that would produce a wildly different start point under
      // animateTrail's own lastMouseX/lastMouseY cascade (far lower-left of the viewport).
      await page.mouse.move(20, 780);

      const startBox = await replay(() => {
        const bat = document.querySelector('.oc-beacon-transient[data-batflight="bat"]');
        if (!bat) return null;
        bat.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        const r = bat.getBoundingClientRect();
        return { left: r.left, top: r.top };
      });
      assert.ok(startBox, 'expected a mounted bat sprite');

      const measured = await measure('target');
      // The right-landing start point (box center) stays within [vw-INSET, vw-4] on x, so the
      // box's own left edge (center - BAT_W/2) stays within
      // [vw-INSET-BAT_W/2, vw-4-BAT_W/2] -- nowhere near the cursor's x=20. A
      // lastMouseX-driven start would land near x=20 instead.
      const expectedLeftMin = measured.vw - INSET - BAT_W_BASE / 2;
      const expectedLeftMax = measured.vw - 4 - BAT_W_BASE / 2;
      assert.ok(
        startBox.left >= expectedLeftMin - 1 && startBox.left <= expectedLeftMax + 1,
        `bat's start point must stay pinned to the landing side's own viewport edge regardless of cursor position, got left=${startBox.left} (expected within [${expectedLeftMin}, ${expectedLeftMax}], viewport width ${measured.vw})`
      );

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await page.mouse.move(200, 120);
    }
  });

  // Folds the match's OWN live rect into the same page-side tick as the fired snapshot --
  // load-bearing here, not just the usual oculist-d5c round-trip hazard: pressing Enter
  // re-fires highlightActiveRange(), and #wideTarget is (deliberately) too wide to ever read
  // as "fully in viewport" at these narrow widths, so EVERY Enter press re-runs
  // scrollIntoView({block:'center'}) and recenters it vertically first. A `measured` rect
  // captured before that keypress is stale by the time the effect actually computes its own
  // landing math against the post-scroll rect.
  function batflightSnapshotWithMatch(targetId) {
    const bat = document.querySelector('.oc-beacon-transient[data-batflight="bat"]');
    const fig = document.querySelector('.oc-beacon-transient[data-batflight="figure"]');
    if (!bat || !fig) return null;
    const figRect = fig.getBoundingClientRect();
    const matchRect = document.getElementById(targetId).getBoundingClientRect();
    return {
      side: fig.getAttribute('data-bf-side'),
      figBox: { left: figRect.left, right: figRect.right, top: figRect.top, bottom: figRect.bottom },
      matchBox: { left: matchRect.left, right: matchRect.right, top: matchRect.top, bottom: matchRect.bottom, width: matchRect.width, height: matchRect.height },
      vw: window.innerWidth, vh: window.innerHeight,
    };
  }

  test('above fallback (oculist-1ta.8\'s own coverage gap): a full-width match with room above but not beside forces the above landing, never occluding the match across the whole flight', async () => {
    // Narrowing the viewport to 320x900 (same technique reanimate_effect.test.js's own
    // degenerate-fallback test uses) is what actually fails BOTH sideRight and sideLeft --
    // #wideTarget's own 526px rendered width already exceeds it outright -- while staying
    // tall enough that the mandatory scrollIntoView({block:'center'}) recenter (see
    // batflightSnapshotWithMatch's own comment) still leaves real room above the match.
    await page.setViewportSize({ width: 320, height: 900 });
    await switchToTarget('wideTarget')();
    try {
      const geom = await replay(batflightSnapshotWithMatch, 'wideTarget');
      assert.ok(geom, 'expected a mounted batflight');
      assert.ok(geom.matchBox.width > geom.vw, 'sanity check: the match itself must render wider than the viewport, forcing both sides to fail regardless of scroll');
      assert.strictEqual(geom.side, 'above', 'must land above when neither side fits but above does');
      assert.ok(geom.figBox.bottom <= geom.matchBox.top, `figure must sit clear above #match, got figBox.bottom=${geom.figBox.bottom} vs match.top=${geom.matchBox.top}`);

      await assertNoOcclusionAcrossFlight('wideTarget');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
      await page.setViewportSize(VIEWPORT);
      await switchToTarget('target')();
    }
  });

  test('below fallback (oculist-1ta.8\'s own fix): a full-width match with no room above either forces the below landing, with the mist fade-out anchored so it cannot grow toward the match', async () => {
    // A much shorter viewport than the 'above' test above: the same mandatory
    // scrollIntoView({block:'center'}) recenter now leaves no room above the match either
    // (half of a 220px-tall viewport, minus the figure's own clearance, is negative), forcing
    // the below branch as the unconditional last resort.
    await page.setViewportSize({ width: 320, height: 220 });
    await switchToTarget('wideTarget')();
    try {
      const geom = await replay(batflightSnapshotWithMatch, 'wideTarget');
      assert.ok(geom, 'expected a mounted batflight');
      assert.ok(geom.matchBox.width > geom.vw, 'sanity check: the match itself must render wider than the viewport, forcing both sides to fail regardless of scroll');
      assert.strictEqual(geom.side, 'below', 'must land below when neither side nor above fits');
      assert.ok(geom.figBox.top >= geom.matchBox.bottom, `figure must sit clear below #match, got figBox.top=${geom.figBox.top} vs match.bottom=${geom.matchBox.bottom}`);

      // oculist-1ta.8: read the mist's own fade-out keyframe transformOrigin directly --
      // must be 50% 0% for 'below' (anchored so the overshoot grows downward, away from the
      // match), not the base 50% 100%.
      const fadeOrigin = await page.evaluate(() => {
        const mist = document.querySelector('.oc-beacon-transient[data-batflight="mist"]');
        const anim = mist.getAnimations()[0];
        const kfs = anim.effect.getKeyframes();
        return kfs[kfs.length - 1].transformOrigin;
      });
      assert.strictEqual(fadeOrigin, '50% 0%', "the below landing's mist fade-out must anchor at the box's top edge, not the default 50% 100%");

      await assertNoOcclusionAcrossFlight('wideTarget');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
      await page.setViewportSize(VIEWPORT);
      await switchToTarget('target')();
    }
  });

  // Per-pixel diff of the match's own rendered rect against a no-effect baseline, sampled at
  // many points across the WHOLE animation (not just the mount frame) by pausing every WAAPI
  // animation and seeking currentTime -- deterministic and fast, unlike a real-time wait.
  // This is the direct, shipped-suite proof oculist-nq1x.9's own MISSING-REQUIREMENT note
  // demands: the prototype's own occlusion sweep never exercised an above/below landing (0 of
  // 96 scenarios, oculist-1ta.8's own close reason), so this suite forces it itself.
  async function assertNoOcclusionAcrossFlight(targetId) {
    const clip = await page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }, targetId);

    let decodePage;
    try {
      decodePage = await ctx.newPage();
      const decode = (buf) => decodePage.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return Array.from(g.getImageData(0, 0, c.width, c.height).data);
      }, buf.toString('base64'));

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
      const base = await decode(await page.screenshot({ clip }));

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-batflight="bat"]'), null, { timeout: POLL_TIMEOUT });

      // DUR = 2080ms total (FLY_DUR 900 + mist/figure tail); sampled every 100ms.
      const SAMPLE_STEP = 100, TOTAL_DUR = 2080;
      let maxDelta = 0, worstT = -1;
      for (let t = 0; t <= TOTAL_DUR; t += SAMPLE_STEP) {
        await page.evaluate((tt) => {
          document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
            el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = tt; });
          });
        }, t);
        const shot = await decode(await page.screenshot({ clip }));
        for (let i = 0; i < base.length; i += 4) {
          const d = Math.max(Math.abs(base[i] - shot[i]), Math.abs(base[i + 1] - shot[i + 1]), Math.abs(base[i + 2] - shot[i + 2]));
          if (d > maxDelta) { maxDelta = d; worstT = t; }
        }
      }
      assert.strictEqual(maxDelta, 0, `match rect must show zero painted-pixel delta at every sampled frame; worst delta ${maxDelta} at t=${worstT}ms`);
    } finally {
      if (decodePage) await decodePage.close();
    }
  }

  test('wing flap (oculist-1ta.1\'s own "a flap that never fired" defect): the discrete wings-out/wings-tucked frames actually alternate', async () => {
    await scrollTargetTo('target', 200);
    async function frameState(t) {
      return page.evaluate((tt) => {
        document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
          el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = tt; });
        });
        const out = document.querySelector('[data-bf-part="wing-out"]');
        const tucked = document.querySelector('[data-bf-part="wing-tucked"]');
        return { out: getComputedStyle(out).opacity, tucked: getComputedStyle(tucked).opacity };
      }, t);
    }

    const mounted = await replay();
    assert.ok(mounted, 'expected a mounted bat sprite');

    const atStart = await frameState(0);
    assert.strictEqual(atStart.out, '1', 'wings-out frame must be visible at t=0');
    assert.strictEqual(atStart.tucked, '0', 'wings-tucked frame must be hidden at t=0');

    const atHalfPeriod = await frameState(65); // FLAP_PERIOD/2, just past the 0.5 swap offset
    assert.strictEqual(atHalfPeriod.out, '0', 'wings-out frame must swap to hidden mid-period');
    assert.strictEqual(atHalfPeriod.tucked, '1', 'wings-tucked frame must swap to visible mid-period -- the flap must actually fire');

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on every element is actually canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-batflight="bat"]')) return null;
      window.__bfTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__bfTestAnims.length;
    });
    // bat (offsetDistance travel, fade-out) = 2; wing frames (out, tucked) = 2; mist (one
    // combined grow/hold/fade call) = 1; figure (one combined fade-in/hold/fade-out call) = 1.
    // Total = 6.
    assert.strictEqual(animCount, 6, `expected 6 live WAAPI animations before cancellation, got ${animCount}`);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

    const states = await page.evaluate(() => window.__bfTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${[...new Set(states)].join(', ')}`);

    await page.evaluate(() => { delete window.__bfTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted, 'sanity check: the effect must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- a genuine leak surfaces as this wait's own
    // TimeoutError. Total duration is 2080ms; POLL_TIMEOUT comfortably covers it.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: a no-op -- same rendered geometry and the same animation count in both modes', async () => {
    async function snapshot() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted batflight');
      return page.evaluate(() => {
        const fig = document.querySelector('.oc-beacon-transient[data-batflight="figure"]');
        const bat = document.querySelector('.oc-beacon-transient[data-batflight="bat"]');
        const r = fig.getBoundingClientRect();
        const br = bat.getBoundingClientRect();
        return {
          figBox: { w: Math.round(r.width), h: Math.round(r.height) },
          batBox: { w: Math.round(br.width), h: Math.round(br.height) },
          totalAnimCount: Array.from(document.querySelectorAll('.oc-beacon-transient'))
            .reduce((sum, el) => sum + el.getAnimations({ subtree: true }).length, 0),
        };
      });
    }

    await scrollTargetTo('target', 200);
    const full = await snapshot();
    assert.strictEqual(full.totalAnimCount, 6, 'sanity check: full mode must have all 6 animations');
    try {
      await setSettings({ performanceMode: true });
      const lite = await snapshot();
      assert.strictEqual(lite.totalAnimCount, full.totalAnimCount, 'Lite Mode must not drop or add any animation -- this effect has no glow/box-shadow/flicker to cut beyond the wing flap, which is the defining beat');
      assert.deepStrictEqual(lite.figBox, full.figBox, 'Lite Mode must render the figure at the exact same geometry');
      assert.deepStrictEqual(lite.batBox, full.batBox, 'Lite Mode must render the bat at the exact same geometry');
    } finally {
      await setSettings({ performanceMode: false });
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the bat and figure RENDERED boxes scale together', async () => {
    async function renderedSizes() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted batflight');
      return page.evaluate(() => {
        const fig = document.querySelector('.oc-beacon-transient[data-batflight="figure"]');
        const bat = document.querySelector('.oc-beacon-transient[data-batflight="bat"]');
        return { figHeight: fig.getBoundingClientRect().height, batWidth: bat.getBoundingClientRect().width };
      });
    }

    await scrollTargetTo('target', 200);
    let currentSize = 'm';
    try {
      const base = await renderedSizes();
      const SIZES = [['s', 0.7], ['l', 1.5], ['xl', 2.25]];
      for (const [size, factor] of SIZES) {
        currentSize = size;
        await setVisionSettings({ beaconSize: size });
        const sized = await renderedSizes();
        const expectedFigHeight = base.figHeight * factor;
        const expectedBatWidth = base.batWidth * factor;
        assert.ok(
          Math.abs(sized.figHeight - expectedFigHeight) <= 2,
          `Beacon Size ${size}: figure height expected ~${expectedFigHeight}, got ${sized.figHeight}`
        );
        assert.ok(
          Math.abs(sized.batWidth - expectedBatWidth) <= 2,
          `Beacon Size ${size}: bat width expected ~${expectedBatWidth}, got ${sized.batWidth}`
        );
      }
    } finally {
      if (currentSize !== 'm') {
        await setVisionSettings({ beaconSize: 'm' });
      }
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    }
  });

  test('Animation Speed, set for real through chrome.storage.sync: every rendered WAAPI duration AND delay scales by getBeaconDuration\'s own factor', async () => {
    async function renderedTimings() {
      await replay();
      return page.evaluate(collectAnimationTimings);
    }

    await scrollTargetTo('target', 200);
    let currentSpeed = 'normal';
    try {
      const base = await renderedTimings();
      assert.ok(base.length > 0, 'sanity check: expected at least one live WAAPI animation');

      const SPEEDS = [['fast', 0.5], ['slow', 1.75]];
      for (const [speed, factor] of SPEEDS) {
        currentSpeed = speed;
        await setVisionSettings({ animationSpeed: speed });
        const timings = await renderedTimings();
        assert.strictEqual(timings.length, base.length, `Animation Speed ${speed}: expected the same ${base.length} animations`);
        timings.forEach((t, i) => {
          const expectedDuration = base[i].duration * factor;
          const expectedDelay = base[i].delay * factor;
          assert.ok(
            Math.abs(t.duration - expectedDuration) <= 1,
            `Animation Speed ${speed}: duration[${i}] expected ~${expectedDuration}ms (base ${base[i].duration}ms x ${factor}), got ${t.duration}ms`
          );
          assert.ok(
            Math.abs(t.delay - expectedDelay) <= 1,
            `Animation Speed ${speed}: delay[${i}] expected ~${expectedDelay}ms (base ${base[i].delay}ms x ${factor}), got ${t.delay}ms`
          );
        });
      }
    } finally {
      if (currentSpeed !== 'normal') {
        await setVisionSettings({ animationSpeed: 'normal' });
      }
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    }
  });

  test('viewport edges: at a small 500x300 viewport, every rendered box stays reasonably placed and the match DOM stays untouched', async () => {
    await page.setViewportSize({ width: 500, height: 300 });
    // Let the resize debounce settle (content.js's own 100ms overlayResizeTimer) before
    // replaying -- scrollTargetTo() below is just page.evaluate() reads, fast enough that
    // without this wait the trailing repositionActiveOverlays() -> cancelBeacons() can still
    // fire AFTER replay()'s own fresh beacon mounts, tearing it down mid-flight and hanging
    // the waitForFunction below (oculist-f7vx).
    await page.waitForTimeout(200);
    try {
      await scrollTargetTo('target', 100);

      const before = await page.evaluate(() => document.getElementById('target').outerHTML);

      const geom = await replay(batflightSnapshot);
      assert.ok(geom, 'expected a mounted batflight even at a tiny viewport');
      assert.ok(geom.figBox, 'the figure must render even at a tiny viewport');

      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect, even at a tiny viewport');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.setViewportSize(VIEWPORT);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
      await scrollTargetTo('target', 200);
    }
  });

  test('pack enumeration: absent while halloween is disabled, present once enabled, selection survives a disable/re-enable round trip, and the runtime falls back safely while disabled', async () => {
    async function openSettings() {
      await page.locator(GEAR_BTN).click();
      await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
    }
    async function closeSettings() {
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => !document.getElementById('oc-wrap').shadowRoot.querySelector('#oc-settings-panel'),
        null,
        { timeout: POLL_TIMEOUT }
      );
    }

    await scrollTargetTo('target', 200);
    try {
      await setSettings({ enabledPacks: [] });
      let keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.strictEqual(keys.indexOf('batflight'), -1, 'batflight must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(BATFLIGHT_EFFECT_ROW).count(),
        0,
        'batflight must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('batflight'), -1, 'batflight must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(BATFLIGHT_EFFECT_ROW).count(),
        1,
        'batflight must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'batflight' (a real,
      // registered -- just currently unavailable -- key), so firing must fall back to some
      // other effect rather than mount the wrapper.
      await setSettings({ effect: 'batflight', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-batflight]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the batflight elements');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Selection restored on re-enable: no explicit re-selection of 'batflight' here.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-batflight="bat"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored batflight selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs -- route
      // through a sentinel value first so both writes are genuine changes regardless of
      // which line above (if any) threw.
      await setSettings({ enabledPacks: ['__oc_batflight_test_reset__'] });
      await setSettings({ effect: 'batflight', enabledPacks: ['halloween'] });
    }
  });
});
