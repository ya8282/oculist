// Arrow Shot beacon effect (oculist-nq1x.11): promotes fxArrowShot (artifacts/prototypes/
// effects-playground.html) into extension/content.js as the tenth entry in the Halloween pack.
// An archer (a bycocket hat with a red feather) dissolves in at a viewport edge, draws and
// looses an arrow that arcs to the match, and concentric target rings bloom around the impact
// point as the arrow lands and quivers.
//
// Beats carrying real defect history, tested directly rather than just documented:
//
// 1. RULE 9 EXCEPTION (oculist-i8zu): the shipped lastMouseX/find-bar/viewport start-point
//    cascade is deliberately NOT used here -- the arrow launches from the archer's fixed grip.
//    Moving the cursor to an unrelated point on the page must not move the launch point at all.
// 2. IMPACT-PLAN CHOOSER (oculist-aouc, oculist-q4nl): 'left' is the common plan; 'top' and
//    'bottom' are forced by placing the match near the left viewport edge (so leftDx <= MARGIN)
//    at different vertical positions; the FORCED-LANDING fallback (when no plan clears MARGIN on
//    any axis) is forced by a small viewport with the match pinned near the top -- exercised for
//    real, not just documented, and proven clean by a real occlusion (per-pixel screenshot diff)
//    sweep of #match across the whole animation in every case.
// 3. CORNER STABILITY (oculist-1ta.9): the archer's corner (top-left vs bottom-left) on the
//    'left' plan must be the SAME across repeated fires on the same match -- content.js's own
//    scrollIntoView({block:'center'}) re-centers the match before every fire, which is exactly
//    the tie-adjacent zone the bead's own closed-form proof covers. Asserted by firing twice and
//    comparing the live corner attribute, per the bead's own instruction, not by reading the code.
// 4. STRIKE_GAP=8 CLIFF (oculist-1ta.15/oculist-uxa0): the occlusion sweep below is the assertion
//    that catches a regression here -- see the mutation note in the 'normal placement' test.
// 5. RESIZE (measured directly, not assumed): a mid-quiver resize that reflows #match by ~8px
//    horizontally showed a real nonzero painted-pixel delta before content.js's own resize hard
//    cut existed -- see 'resize mid-flight' below and the hardCutArrowShot() comment it proves.
//
// Modeled on test/batflight_effect.test.js and test/wandcast_effect.test.js (fixture/helper
// shape: real HTTP fixture, CDP isolated-world attach, tall-spacer layout, scrollBehavior
// 'instant', settleNavigation after navigation, per-frame screenshot occlusion sweep, and the
// predict()-duplicates-the-product-formula idiom used only as a fixture sanity check).
//
// test/arrowshot-forced-below.check.js (oculist-c6pk) already proves the PROTOTYPE's own painted
// silhouette clears the forced-below-1 scenario via the canonical occlusion-sweep sampler; that
// coverage is not duplicated here. This suite instead proves the SHIPPED port's own geometry
// directly against the live DOM.
//
// Needs a real browser for the same reasons as those: WAAPI and real layout only exist in real
// Chromium, and Lite Mode/Beacon Size/Animation Speed/pack toggles only exist for real through
// chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition, waitForOverlayResizeSettled } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target: margin-left:400px puts rect.left far past the ~186px threshold content.js's own
// leftDx > MARGIN gate needs at the default viewport (measured below), so this is the ordinary
// 'left' plan -- content.js's own highlightActiveRange() also re-centers it vertically
// (scrollIntoView({block:'center'})) before every fire, which is exactly the corner-stability
// tie zone oculist-1ta.9's own proof covers -- so this fixture doubles as both the normal-
// placement test and the corner-stability test.
//
// #edgeTarget: margin-left:4px keeps rect.left near the body's own padding, well under the
// leftDx > MARGIN threshold regardless of scroll -- forcing the 'top' or 'bottom' plan depending
// on where scrollTargetTo() below puts it vertically in the (unscrolled-by-default) viewport.
//
// #forcedTarget: a full-width, overflow-wrapping span -- at a small viewport (500x180, matching
// the canonical forced-below-1 scenario's own viewport in artifacts/prototypes/occlusion-
// sweep.js) with the match pinned near the top, none of leftDx/topDy/bottomDy clears MARGIN,
// forcing the painted-shape-oracle fallback (oculist-aouc/oculist-q4nl).
//
// #resizeTarget: text-align:center within width:100%, the same technique test/wandcast_
// effect.test.js's own #resizeTarget uses -- reflows purely horizontally on a viewport resize,
// isolating the resize measurement from any vertical-reflow noise.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:400px;"><span id="target">glimmerpath</span></div>
<div style="height:1600px"></div>
<div style="margin-left:4px;"><span id="edgeTarget">emberquail</span></div>
<div style="height:1000px"></div>
<div style="width:100%;overflow-wrap:anywhere;"><span id="forcedTarget">forcedlandingwide</span></div>
<div style="height:1000px"></div>
<div style="width:100%;text-align:center;"><span id="resizeTarget">emberdrift</span></div>
<div style="height:1000px"></div>`;

const TARGET_TERMS = {
  target: 'glimmerpath',
  edgeTarget: 'emberquail',
  forcedTarget: 'forcedlandingwide',
  resizeTarget: 'emberdrift',
};

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const ARROWSHOT_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:arrowshot"]';

describe('Arrow Shot: an archer draws and looses an arrow that arcs to the match, with target rings blooming at impact', () => {
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

    await setSettings({ effect: 'arrowshot', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

    await openFinder(page);
    await page.locator(INPUT).type('glimmerpath', { delay: 30 });
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

  async function clearBeacons() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  }

  // Content scripts run in an isolated JS world -- a listener content.js adds via
  // window.addEventListener() is invisible to DOMDebugger.getEventListeners when queried off a
  // main-world objectId for `window` (verified directly: an isolated-world-added listener reads
  // back as 0 through a main-world handle), even though it is a real listener on the shared DOM.
  // The objectId has to come from Runtime.evaluate('window', ...) IN the isolated context itself
  // (contextId: isolatedContextId) for getEventListeners to see it.
  async function countWindowResizeListeners() {
    const windowObj = await client.send('Runtime.evaluate', { expression: 'window', returnByValue: false, contextId: isolatedContextId });
    const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: windowObj.result.objectId });
    return listeners.filter((l) => l.type === 'resize').length;
  }

  // Same production cancellation path as the sibling suites: cancels any in-flight beacon
  // through window.__ocTest.cancelBeacons() (the exact function animate() itself calls first),
  // then presses Enter to (re-)fire.
  async function replay(predicate, arg) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    const handle = await page.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-arrowshot="archer"]') ? true : null)),
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

  function measure(id) {
    return page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    }, id);
  }

  // Mirrors content.js's own animateArrowShot() impact-plan chooser verbatim (measured and
  // derived exactly the same way, not hand-picked -- same duplication-in-the-test idiom
  // reanimate_effect.test.js's own predict() uses). Used only to PREDICT the plan/corner as a
  // sanity check on the fixture itself -- every real assertion below reads the live rendered DOM.
  const INSET = 40, STRIKE_GAP = 8, ARROW_LEN_BASE = 58, VB_W = 108, VB_H = 114;
  function predict(measured, beaconScale) {
    const archerH = Math.max(78, Math.min(112, 3.2 * measured.height)) * beaconScale;
    const scaleX = (archerH * (VB_W / VB_H)) / VB_W, scaleY = archerH / VB_H;
    const launchX = INSET + 100 * scaleX;
    const launchYTop = INSET + 54 * scaleY;
    const launchYBottom = (measured.vh - INSET - archerH) + 54 * scaleY;
    const MARGIN = ARROW_LEN_BASE * beaconScale + 8;
    const leftEndX = measured.left - STRIKE_GAP, leftEndY = measured.top + measured.height / 2;
    const topEndY = measured.top - STRIKE_GAP;
    const bottomEndY = measured.bottom + STRIKE_GAP;
    const leftDx = leftEndX - launchX;
    const topDy = topEndY - launchYTop;
    const bottomDy = launchYBottom - bottomEndY;
    let plan, corner, forced = false;
    if (leftDx > MARGIN) {
      plan = 'left';
      corner = Math.abs(leftEndY - launchYTop) <= Math.abs(leftEndY - launchYBottom) ? 'top-left' : 'bottom-left';
    } else if (topDy > MARGIN) {
      plan = 'top'; corner = 'top-left';
    } else if (bottomDy > MARGIN) {
      plan = 'bottom'; corner = 'bottom-left';
    } else {
      // FORCED-LANDING (oculist-aouc/oculist-q4nl): none of the three plans clears MARGIN --
      // content.js's own chooser still labels `plan`/`corner` as whichever axis gives the most
      // (least-bad) clearance, exactly like the guarded branches above; `forced` is this
      // predictor's own separate flag for "the painted-shape fallback ran", since content.js
      // itself has no distinct 'forced' plan string.
      forced = true;
      if (leftDx >= topDy && leftDx >= bottomDy) { plan = 'left'; corner = 'top-left'; }
      else if (topDy >= bottomDy) { plan = 'top'; corner = 'top-left'; }
      else { plan = 'bottom'; corner = 'bottom-left'; }
    }
    return { plan, corner, forced, archerH };
  }

  function arrowshotSnapshot() {
    const archer = document.querySelector('.oc-beacon-transient[data-arrowshot="archer"]');
    const arrow = document.querySelector('.oc-beacon-transient[data-arrowshot="arrow"]');
    const target = document.querySelector('.oc-beacon-transient[data-arrowshot="target"]');
    if (!archer && !arrow && !target) return null;
    const archerRect = archer ? archer.getBoundingClientRect() : null;
    return {
      archerPresent: !!archer,
      arrowPresent: !!arrow,
      targetPresent: !!target,
      plan: archer ? archer.getAttribute('data-arrowshot-plan') : null,
      corner: archer ? archer.getAttribute('data-arrowshot-corner') : null,
      archerLeft: archer ? archer.style.left : null,
      archerTop: archer ? archer.style.top : null,
      archerBox: archerRect && { left: archerRect.left, right: archerRect.right, top: archerRect.top, bottom: archerRect.bottom },
      targetLeft: target ? target.style.left : null,
      targetTop: target ? target.style.top : null,
    };
  }

  test('document-space correctness: on a scrolled page, the archer\'s own inline left/top carry a real "+ window.scrollX/scrollY" term', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const measured = await measure('target');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.plan, 'left', 'sanity check: fixture must give the left plan room');

      const geom = await replay(arrowshotSnapshot);
      assert.ok(geom, 'expected a mounted arrowshot');
      assert.strictEqual(geom.plan, predicted.plan, 'plan must match the predicted formula');
      assert.strictEqual(geom.corner, predicted.corner, 'corner must match the predicted formula');

      // archerLeft is always INSET (viewport space), so its document-space left must be exactly
      // INSET + scrollX; archerTop's own viewport-space value depends on the corner, so this
      // reads it back from the corner the live DOM itself reports rather than re-deriving it.
      const expectedLeft = INSET + scroll.x;
      assert.ok(
        Math.abs(parseFloat(geom.archerLeft) - expectedLeft) <= 2,
        `archer's style.left (${geom.archerLeft}) must include window.scrollX -- expected ~${expectedLeft}px`
      );
      const viewportTop = geom.corner === 'top-left' ? INSET : (measured.vh - INSET - predicted.archerH);
      const expectedTop = viewportTop + scroll.y;
      assert.ok(
        Math.abs(parseFloat(geom.archerTop) - expectedTop) <= 2,
        `archer's style.top (${geom.archerTop}) must include window.scrollY -- expected ~${expectedTop}px`
      );

      // The ARCHER's own left/top prove document-space correctness for archerWrap's own CSS
      // write, but the flight arrow travels via a separate offset-path built from launchX/
      // launchY/endX/endY -- dropping SCROLL_X/SCROLL_Y there alone (leaving archerWrap's own
      // math intact) would still pass the two assertions above. Reading the arrow's own
      // offset-path M command directly catches that independently.
      const pathM = await page.evaluate(() => {
        const arrow = document.querySelector('.oc-beacon-transient[data-arrowshot="arrow"]');
        const m = (getComputedStyle(arrow).offsetPath || '').match(/([-\d.]+)[, ]+([-\d.]+)/);
        return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
      });
      assert.ok(pathM, 'sanity check: expected a parseable offset-path M command on the flight arrow');
      // launchX is always INSET + 100*scaleX (viewport space); document space adds scroll.x once.
      const scaleX = (predicted.archerH * (VB_W / VB_H)) / VB_W;
      const expectedLaunchX = INSET + 100 * scaleX + scroll.x;
      assert.ok(
        Math.abs(pathM.x - expectedLaunchX) <= 2,
        `flight arrow's offset-path must add window.scrollX exactly once -- expected first path-point x ~${expectedLaunchX}px, got ${pathM.x}px`
      );
      // The x-only check above (scrollX=0 at the fixture's own horizontal position) cannot
      // catch a dropped or doubled window.scrollY on this same path string -- launchY is
      // (corner === 'top-left' ? launchYTop : launchYBottom), viewport space, plus scroll.y
      // added exactly once.
      const scaleY = predicted.archerH / VB_H;
      const launchYTop = INSET + 54 * scaleY;
      const launchYBottom = (measured.vh - INSET - predicted.archerH) + 54 * scaleY;
      const expectedLaunchY = (geom.corner === 'top-left' ? launchYTop : launchYBottom) + scroll.y;
      assert.ok(
        Math.abs(pathM.y - expectedLaunchY) <= 3,
        `flight arrow's offset-path must add window.scrollY exactly once -- expected first path-point y ~${expectedLaunchY}px, got ${pathM.y}px`
      );

      // Target rings (data-arrowshot="target"): left/top are mcx - boxHalfW + SCROLL_X and
      // mcy - boxHalfH + SCROLL_Y -- a dropped or doubled SCROLL_Y here is invisible to every
      // assertion above (the archer and flight arrow are independent elements), and the rings'
      // own hollow-container shape means a bounding-box occlusion check alone cannot catch a
      // vertical offset that still happens to leave the match inside the (now-mispositioned)
      // container. Read back left/top directly instead.
      const SQRT2 = Math.SQRT2;
      const w2 = measured.width / 2, h2 = measured.height / 2;
      const padOut = 48, ringStroke = 8; // beaconScale=1 (default) in this test
      const rxOut = w2 * SQRT2 + padOut, ryOut = h2 * SQRT2 + padOut;
      const boxHalfW = rxOut + ringStroke, boxHalfH = ryOut + ringStroke;
      const mcx = measured.left + measured.width / 2, mcy = measured.top + measured.height / 2;
      const expectedTargetLeft = mcx - boxHalfW + scroll.x;
      const expectedTargetTop = mcy - boxHalfH + scroll.y;
      assert.ok(
        Math.abs(parseFloat(geom.targetLeft) - expectedTargetLeft) <= 2,
        `target rings' style.left (${geom.targetLeft}) must include window.scrollX exactly once -- expected ~${expectedTargetLeft}px`
      );
      assert.ok(
        Math.abs(parseFloat(geom.targetTop) - expectedTargetTop) <= 2,
        `target rings' style.top (${geom.targetTop}) must include window.scrollY exactly once -- expected ~${expectedTargetTop}px`
      );

      await clearBeacons();
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
      await scrollTargetTo('target', 200);
    }
  });

  test('normal placement ("left" plan): the archer, arrow and target rings render clear of #match across the whole animation, and the match DOM is untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const measured = await measure('target');
    const predicted = predict(measured, 1);
    assert.strictEqual(predicted.plan, 'left', 'sanity check: fixture must give the left plan room');

    const geom = await replay(arrowshotSnapshot);
    assert.ok(geom, 'expected a mounted arrowshot');
    assert.strictEqual(geom.plan, 'left', 'default landing must be the left plan');
    assert.strictEqual(geom.corner, predicted.corner, 'corner must match the predicted formula');
    assert.ok(geom.archerPresent && geom.arrowPresent && geom.targetPresent, 'all three layers must mount');

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

    // Sweeps the WHOLE animation (draw, flight, strike-quiver, target-ring bloom, fade-out),
    // not just the mount frame -- this is the assertion that proves STRIKE_GAP=8 (oculist-1ta.15/
    // oculist-uxa0) and the ARC_HEIGHT/target-ring corner-containment math are load-bearing.
    // MUTATION PROOF (done during implementation, reverted before commit): setting STRIKE_GAP to
    // 7 in extension/content.js's animateArrowShot() and re-running this exact test on this exact
    // fixture did NOT reproduce the calibrated cliff (that cliff is specific to the prototype's
    // own 1280x900/font-22-26 geometry, not this fixture's) -- see the header comment's own note.
    // What this assertion DOES catch, proven by mutation: deleting the `- STRIKE_GAP` term from
    // leftEndX's own definition (so the arrow tip rests flush on the match's edge instead of
    // STRIKE_GAP clear of it) turns this red immediately.
    await assertNoOcclusionAcrossAnimation('target');

    await clearBeacons();
  });

  test('"top" plan: a match near the left viewport edge with room above (but not left) forces the top plan, landing the archer top-left', async () => {
    await switchToTarget('edgeTarget')();
    try {
      await scrollTargetTo('edgeTarget', 300);
      const measured = await measure('edgeTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.plan, 'top', 'sanity check: fixture must force the top plan');

      const before = await page.evaluate(() => document.getElementById('edgeTarget').outerHTML);
      const geom = await replay(arrowshotSnapshot);
      assert.ok(geom, 'expected a mounted arrowshot');
      assert.strictEqual(geom.plan, 'top', 'must land the top plan when only above has room');
      assert.strictEqual(geom.corner, 'top-left', 'top plan must always use the top-left corner');
      assert.ok(geom.archerBox.bottom <= measured.top, `archer must sit clear above #match, got archerBox.bottom=${geom.archerBox.bottom} vs match.top=${measured.top}`);
      const after = await page.evaluate(() => document.getElementById('edgeTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

      await assertNoOcclusionAcrossAnimation('edgeTarget');

      await clearBeacons();
    } finally {
      await clearBeacons();
      await switchToTarget('target')();
    }
  });

  test('"bottom" plan: a match near the left viewport edge with room below (but not left or above) forces the bottom plan, landing the archer bottom-left', async () => {
    await switchToTarget('edgeTarget')();
    try {
      await scrollTargetTo('edgeTarget', 40);
      const measured = await measure('edgeTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.plan, 'bottom', 'sanity check: fixture must force the bottom plan');

      const before = await page.evaluate(() => document.getElementById('edgeTarget').outerHTML);
      const geom = await replay(arrowshotSnapshot);
      assert.ok(geom, 'expected a mounted arrowshot');
      assert.strictEqual(geom.plan, 'bottom', 'must land the bottom plan when only below has room');
      assert.strictEqual(geom.corner, 'bottom-left', 'bottom plan must always use the bottom-left corner');
      assert.ok(geom.archerBox.top >= measured.bottom, `archer must sit clear below #match, got archerBox.top=${geom.archerBox.top} vs match.bottom=${measured.bottom}`);
      const after = await page.evaluate(() => document.getElementById('edgeTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

      await assertNoOcclusionAcrossAnimation('edgeTarget');

      await clearBeacons();
    } finally {
      await clearBeacons();
      await switchToTarget('target')();
    }
  });

  test('corner stability (oculist-1ta.9): firing twice on the same match picks the SAME corner both times', async () => {
    await scrollTargetTo('target', 200);
    try {
      const g1 = await replay(arrowshotSnapshot);
      assert.ok(g1, 'expected a mounted arrowshot on the first fire');
      await clearBeacons();

      const g2 = await replay(arrowshotSnapshot);
      assert.ok(g2, 'expected a mounted arrowshot on the second fire');

      assert.strictEqual(g1.plan, 'left', 'sanity check: this fixture is meant to exercise the left plan, where corner is actually chosen (not forced)');
      assert.strictEqual(g2.corner, g1.corner, `the archer's corner must be stable across repeated fires on the same match -- got ${g1.corner} then ${g2.corner}`);
      assert.strictEqual(g2.archerTop, g1.archerTop, 'a stable corner must also mean a byte-identical archerTop across both fires');

      await clearBeacons();
    } finally {
      await clearBeacons();
    }
  });

  test('"left" plan, mirrored branch: a match below viewport centre picks the "bottom-left" corner for real, not just "top-left" every time', async () => {
    // content.js's own highlightActiveRange() only calls scrollIntoView({block:'center'}) when
    // the match is NOT already fully in the viewport (isFullyInViewport check) -- so scrolling
    // #target's own top to 600px down an 800px-tall viewport (still fully visible, bottom=618)
    // BEFORE firing leaves it there instead of being recentred back toward vh/2. This is what the
    // corner-stability test above cannot exercise: every fixture that gets vertically recentred
    // by content.js's own navigation lands mcy near vh/2, which happens to resolve to 'top-left'
    // for every left-plan fixture in this suite -- so a corner selector that always returns
    // 'top-left' passes every other test in this file undetected.
    await scrollTargetTo('target', 600);
    try {
      const measured = await measure('target');
      assert.strictEqual(measured.top, 600, 'sanity check: the match must actually stay at the scrolled position, not get recentred by navigation');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.plan, 'left', 'sanity check: fixture must still give the left plan room');
      assert.strictEqual(predicted.corner, 'bottom-left', 'sanity check: this fixture is meant to force the bottom-left corner');

      const geom = await replay(arrowshotSnapshot);
      assert.ok(geom, 'expected a mounted arrowshot');
      assert.strictEqual(geom.plan, 'left', 'must still be the left plan');
      assert.strictEqual(geom.corner, 'bottom-left', 'a match below viewport centre must pick the bottom-left corner, not top-left');

      // Geometry, not just the label: bottom-left means archerTop is (vh - INSET - archerH), not
      // INSET. archer.style.top is document space (rule 2), so add scroll.y once.
      const scroll = await page.evaluate(() => ({ y: window.scrollY }));
      const expectedArcherTop = measured.vh - INSET - predicted.archerH + scroll.y;
      assert.ok(
        Math.abs(parseFloat(geom.archerTop) - expectedArcherTop) <= 2,
        `bottom-left archerTop expected ~${expectedArcherTop}px, got ${geom.archerTop}`
      );

      await clearBeacons();
    } finally {
      await clearBeacons();
      await scrollTargetTo('target', 200);
    }
  });

  // Reads the flight arrow's own offset-path M command (its launch point) -- the archer's left/
  // top alone cannot catch a cursor-driven launch: the archer sprite itself has no cursor-based
  // placement in this effect at all, only the flight's own launchX/launchY could plausibly be
  // rewired to lastMouseX/lastMouseY (animateTrail's own cascade) without moving the archer.
  function readArrowPathM() {
    const arrow = document.querySelector('.oc-beacon-transient[data-arrowshot="arrow"]');
    if (!arrow) return null;
    const m = (getComputedStyle(arrow).offsetPath || '').match(/([-\d.]+)[, ]+([-\d.]+)/);
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
  }

  test('cursor independence (rule 9 exception, oculist-i8zu): moving the mouse elsewhere on the page never moves the archer\'s own grip/launch point', async () => {
    await scrollTargetTo('target', 200);
    try {
      // Move the cursor to a point that would produce a wildly different start point under
      // animateTrail's own lastMouseX/lastMouseY cascade (far lower-right of the viewport).
      await page.mouse.move(1150, 780);

      const geom1 = await replay(arrowshotSnapshot);
      assert.ok(geom1, 'expected a mounted arrowshot');
      const pathM1 = await page.evaluate(readArrowPathM);
      assert.ok(pathM1, 'sanity check: expected a parseable offset-path M command on the flight arrow');
      await clearBeacons();

      await page.mouse.move(20, 20);
      const geom2 = await replay(arrowshotSnapshot);
      assert.ok(geom2, 'expected a mounted arrowshot');
      const pathM2 = await page.evaluate(readArrowPathM);
      assert.ok(pathM2, 'sanity check: expected a parseable offset-path M command on the flight arrow');

      assert.strictEqual(geom2.archerLeft, geom1.archerLeft, "the archer's own left must stay pinned to INSET regardless of cursor position");
      assert.strictEqual(geom2.archerTop, geom1.archerTop, "the archer's own top must stay pinned regardless of cursor position");
      assert.strictEqual(geom2.corner, geom1.corner, 'the corner must not move with the cursor either');

      // The load-bearing check: the flight arrow's own LAUNCH POINT (its offset-path M command)
      // must stay put too, at (1150,780) cursor vs (20,20) cursor -- a lastMouseX/lastMouseY-
      // driven launch would move this by roughly (1130, 760)px between the two mouse positions,
      // far outside this tolerance.
      assert.ok(
        Math.abs(pathM2.x - pathM1.x) <= 3,
        `flight arrow's launch point x must stay pinned regardless of cursor position -- got ${pathM1.x} then ${pathM2.x}`
      );
      assert.ok(
        Math.abs(pathM2.y - pathM1.y) <= 3,
        `flight arrow's launch point y must stay pinned regardless of cursor position -- got ${pathM1.y} then ${pathM2.y}`
      );

      await clearBeacons();
    } finally {
      await page.mouse.move(200, 120);
    }
  });

  test('forced fallback (oculist-aouc, oculist-q4nl): a full-width match at a small viewport, where no plan clears MARGIN on any axis, still renders with the archer and target rings clear of #match', async () => {
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 500, height: 180 });
    await switchToTarget('forcedTarget')();
    try {
      await scrollTargetTo('forcedTarget', 20);
      const measured = await measure('forcedTarget');
      const predicted = predict(measured, 1);
      assert.ok(predicted.forced, 'sanity check: fixture must force the painted-shape fallback (no plan clears MARGIN on any axis)');

      const before = await page.evaluate(() => document.getElementById('forcedTarget').outerHTML);
      const geom = await replay(arrowshotSnapshot);
      assert.ok(geom, 'expected a mounted arrowshot even in the forced-fallback branch');
      assert.ok(geom.archerPresent && geom.arrowPresent && geom.targetPresent, 'all three layers must still mount in the forced-fallback branch (a real, non-vacuous render, not a suppression)');
      const after = await page.evaluate(() => document.getElementById('forcedTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect, even in the forced-fallback branch');

      // Screenshot pixel-diff of #match's OWN rect -- catches paint that actually lands on
      // glyph ink.
      await assertNoOcclusionAcrossAnimation('forcedTarget');

      // Bounding-box sweep of the ARCHER's and FLIGHT ARROW's own rendered boxes (not the target
      // rings, whose container legitimately surrounds #match by design) against #match's rect,
      // sampled across the whole animation the same way. This is the stricter proof rule 10 asks
      // for ("no effect paint enters a protected rectangle") -- a screenshot diff alone can stay
      // green on a small, sparse font where the oracle's own overlap lands in the rect's
      // whitespace rather than on ink; the bounding-box sweep below cannot.
      //
      // MUTATION PROOF (done during implementation, reverted before commit): forcing
      // `takeCandidate = false` (disabling oculist-q4nl's own archer-clamp candidate) on this
      // exact fixture turned this assertion red at t=1275ms -- the FLIGHT ARROW's own bounding
      // box (its rotated footprint, mid strike-quiver) overlapped #forcedTarget's rect once the
      // candidate's archer-position shift (which also moves the flight's own launch point) was
      // taken out of the picture. Separately, short-circuiting pushFlightIfNeeded() to always
      // return the unpushed endX0/endY0 (disabling oculist-aouc's own capped push loop) alone did
      // NOT turn this fixture red, nor any of several other forced-fallback geometries probed
      // during implementation (varying viewport width/height and the match's vertical offset):
      // oculist-q4nl's candidate always independently cleared the same geometries push alone
      // would have fixed, because moving the archer also moves the flight's own launch point,
      // which incidentally satisfies pushFlightIfNeeded's own gate before the push loop's body
      // ever runs. This is a real, measured finding, not an unverified claim -- push's own code
      // still executes and its result still feeds the BASELINE vs CANDIDATE comparison (aouc's
      // push is what computes flightClearBase for the SELECT guard just above), so it is not
      // dead code, but no fixture within this suite's reach isolates it as the SOLE guard the
      // way it plausibly was before oculist-q4nl's own candidate existed.
      await assertNoBoxOcclusionAcrossAnimation('forcedTarget');

      await clearBeacons();
    } finally {
      await clearBeacons();
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await switchToTarget('target')();
    }
  });

  // Per-pixel diff of the match's own rendered rect against a no-effect baseline, sampled at
  // many points across the WHOLE animation (not just the mount frame) by pausing every WAAPI
  // animation and seeking currentTime -- deterministic and fast, unlike a real-time wait.
  async function assertNoOcclusionAcrossAnimation(targetId) {
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

      await clearBeacons();
      const base = await decode(await page.screenshot({ clip }));

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-arrowshot="archer"]'), null, { timeout: POLL_TIMEOUT });

      // DUR = FADE_OUT_DELAY(1870) + FADE_OUT_DUR(280) = 2150ms total; sampled every 75ms.
      const SAMPLE_STEP = 75, TOTAL_DUR = 2150;
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

  // Bounding-box (not pixel-ink) sweep of the archer's and flight arrow's own rendered boxes
  // against #match's rect, sampled across the whole animation by pausing every WAAPI animation
  // and seeking currentTime -- deliberately excludes the target-ring container (data-
  // arrowshot="target"), whose bounding box legitimately surrounds #match by design (the rings
  // themselves are a hollow stroke, not the container's own fill). getBoundingClientRect()
  // already reflects the flight arrow's live CSS transform:rotate() (the strike-quiver), so this
  // catches a rotated-footprint intrusion the same way the painted-shape oracle's own box gate
  // would, without needing to reimplement its rotated-corner math here.
  async function assertNoBoxOcclusionAcrossAnimation(targetId) {
    await page.evaluate((elId) => {
      window.__ocMatchId = elId;
    }, targetId);
    const SAMPLE_STEP = 75, TOTAL_DUR = 2150;
    for (let t = 0; t <= TOTAL_DUR; t += SAMPLE_STEP) {
      const result = await page.evaluate((tt) => {
        document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
          el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = tt; });
        });
        const m = document.getElementById(window.__ocMatchId).getBoundingClientRect();
        function overlaps(a, b) {
          return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
        }
        const archer = document.querySelector('.oc-beacon-transient[data-arrowshot="archer"]');
        const arrow = document.querySelector('.oc-beacon-transient[data-arrowshot="arrow"]');
        const out = {};
        if (archer) out.archer = overlaps(archer.getBoundingClientRect(), m);
        if (arrow) out.arrow = overlaps(arrow.getBoundingClientRect(), m);
        return out;
      }, t);
      assert.ok(!result.archer, `archer's own bounding box must never overlap #match's rect; overlapped at t=${t}ms`);
      assert.ok(!result.arrow, `flight arrow's own bounding box must never overlap #match's rect; overlapped at t=${t}ms`);
    }
    await page.evaluate(() => { delete window.__ocMatchId; });
  }

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on every element is actually canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-arrowshot="archer"]')) return null;
      window.__asTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__asTestAnims.length;
    });
    // archer (fade-in, fade-out) = 2; string rest/drawn (2) + nocked-arrow translate/opacity (2)
    // = 4, all hung on archerWrap's own __waapiAnims (rule 4: child-node animations hang on the
    // parent); flight arrow (appear, travel, quiver, fade-out) = 4; target rings (entrance,
    // fade-out) = 2. Total = 2 + 4 + 4 + 2 = 12.
    assert.strictEqual(animCount, 12, `expected 12 live WAAPI animations before cancellation, got ${animCount}`);

    await clearBeacons();

    const states = await page.evaluate(() => window.__asTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${[...new Set(states)].join(', ')}`);

    await page.evaluate(() => { delete window.__asTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted, 'sanity check: the effect must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- a genuine leak surfaces as this wait's own TimeoutError.
    // Total duration is 2150ms; POLL_TIMEOUT comfortably covers it.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: a no-op -- same rendered geometry and the same animation count in both modes', async () => {
    async function snapshot() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted arrowshot');
      return page.evaluate(() => {
        const archer = document.querySelector('.oc-beacon-transient[data-arrowshot="archer"]');
        const arrow = document.querySelector('.oc-beacon-transient[data-arrowshot="arrow"]');
        const target = document.querySelector('.oc-beacon-transient[data-arrowshot="target"]');
        const ar = archer.getBoundingClientRect();
        const arr = arrow.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        return {
          archerBox: { w: Math.round(ar.width), h: Math.round(ar.height) },
          arrowBox: { w: Math.round(arr.width), h: Math.round(arr.height) },
          targetBox: { w: Math.round(tr.width), h: Math.round(tr.height) },
          totalAnimCount: Array.from(document.querySelectorAll('.oc-beacon-transient'))
            .reduce((sum, el) => sum + el.getAnimations({ subtree: true }).length, 0),
        };
      });
    }

    await scrollTargetTo('target', 200);
    const full = await snapshot();
    assert.strictEqual(full.totalAnimCount, 12, 'sanity check: full mode must have all 12 animations');
    try {
      await setSettings({ performanceMode: true });
      const lite = await snapshot();
      assert.strictEqual(lite.totalAnimCount, full.totalAnimCount, 'Lite Mode must not drop or add any animation -- this effect has no glow/box-shadow/flicker to cut beyond the draw-release-strike sequence, which is the effect\'s own defining beat');
      assert.deepStrictEqual(lite.archerBox, full.archerBox, 'Lite Mode must render the archer at the exact same geometry');
      assert.deepStrictEqual(lite.arrowBox, full.arrowBox, 'Lite Mode must render the flight arrow at the exact same geometry');
      assert.deepStrictEqual(lite.targetBox, full.targetBox, 'Lite Mode must render the target rings at the exact same geometry');
    } finally {
      await setSettings({ performanceMode: false });
      await clearBeacons();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the archer and flight-arrow RENDERED boxes scale together', async () => {
    async function renderedSizes() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted arrowshot');
      return page.evaluate(() => {
        const archer = document.querySelector('.oc-beacon-transient[data-arrowshot="archer"]');
        const arrow = document.querySelector('.oc-beacon-transient[data-arrowshot="arrow"]');
        return { archerHeight: archer.getBoundingClientRect().height, arrowWidth: arrow.getBoundingClientRect().width };
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
        const expectedArcherHeight = base.archerHeight * factor;
        const expectedArrowWidth = base.arrowWidth * factor;
        assert.ok(
          Math.abs(sized.archerHeight - expectedArcherHeight) <= 2,
          `Beacon Size ${size}: archer height expected ~${expectedArcherHeight}, got ${sized.archerHeight}`
        );
        assert.ok(
          Math.abs(sized.arrowWidth - expectedArrowWidth) <= 2,
          `Beacon Size ${size}: arrow width expected ~${expectedArrowWidth}, got ${sized.arrowWidth}`
        );
      }
    } finally {
      if (currentSize !== 'm') {
        await setVisionSettings({ beaconSize: 'm' });
      }
      await clearBeacons();
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
      await clearBeacons();
    }
  });

  test('viewport edges: at a small 500x300 viewport, every rendered box stays reasonably placed and the match DOM stays untouched', async () => {
    // Waits out the resize debounce itself (content.js's own 100ms overlayResizeTimer) --
    // scrollTargetTo() below is just page.evaluate() reads, fast enough that without this
    // wait the trailing repositionActiveOverlays() -> cancelBeacons() can still fire AFTER
    // replay()'s own fresh beacon mounts, tearing it down mid-flight (oculist-f7vx).
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 500, height: 300 });
    try {
      await scrollTargetTo('target', 100);

      const before = await page.evaluate(() => document.getElementById('target').outerHTML);

      const geom = await replay(arrowshotSnapshot);
      assert.ok(geom, 'expected a mounted arrowshot even at a tiny viewport');
      assert.ok(geom.archerPresent && geom.arrowPresent && geom.targetPresent, 'every layer must render even at a tiny viewport');

      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect, even at a tiny viewport');
    } finally {
      await clearBeacons();
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await page.evaluate(() => window.scrollTo(0, 0));
      await scrollTargetTo('target', 200);
    }
  });

  // Decodes a PNG screenshot into raw RGBA bytes, the same helper shape
  // assertNoOcclusionAcrossAnimation uses, factored out so the resize test below can take a
  // "clean" baseline and a "live" sample through the same pipeline.
  async function screenshotRgba(decodePage, clip) {
    const buf = await page.screenshot({ clip });
    return decodePage.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(0, 0, c.width, c.height).data);
    }, buf.toString('base64'));
  }

  function maxRgbDelta(a, b) {
    let maxDelta = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > maxDelta) maxDelta = d;
    }
    return maxDelta;
  }

  test('resize mid-flight (measured, not assumed; oculist-3dd8 technique ported): a resize that reflows #match ~8px horizontally during the 100ms debounce window leaves zero painted-pixel delta on #match', async () => {
    // content.js's own handleResize() only reaches cancelBeacons() through
    // repositionActiveOverlays(), gated behind a 100ms debounce (overlayResizeTimer) -- so a
    // resize alone, sampled BEFORE that debounce fires, is the window where this effect's own
    // static (fire-time) positioning goes stale against a reflowed #match. Measured directly:
    // before hardCutArrowShot() existed, this exact test failed with a nonzero delta (an 8px
    // reflow was enough, given the target rings' own tight STRIKE_GAP/padIn clearance) -- see the
    // header comment's own RESIZE note. This is that measurement holding green now that the hard
    // cut (oculist-3dd8's own technique, ported) is in place, not an assumption.
    let decodePage;
    try {
      decodePage = await ctx.newPage();

      await switchToTarget('resizeTarget')();
      const beforeRect = await measure('resizeTarget');
      await waitForOverlayResizeSettled(page, evalInContentScript, { width: 1184, height: 800 });
      const afterRect = await measure('resizeTarget');
      assert.ok(
        Math.abs(afterRect.right - beforeRect.right) > 4,
        `sanity check: the resize must actually move #match, or this test proves nothing (before.right=${beforeRect.right}, after.right=${afterRect.right})`
      );
      assert.ok(
        Math.abs(afterRect.top - beforeRect.top) < 1,
        'sanity check: this fixture is meant to reflow horizontally only (text-align:center), not change line'
      );
      const clip = { x: Math.round(afterRect.left), y: Math.round(afterRect.top), width: Math.round(afterRect.width), height: Math.round(afterRect.height) };
      const baseline = await screenshotRgba(decodePage, clip);

      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      const geom = await replay(arrowshotSnapshot);
      assert.ok(geom, 'expected a mounted arrowshot figure');

      // Freeze every animation at a fixed mid-quiver frame (t=1400ms, inside the strike-quiver
      // phase where the flight arrow's own rotated footprint is closest to #match) BEFORE
      // resizing, so the comparison below is deterministic.
      await page.evaluate(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
          el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1400; });
        });
      });

      // Deliberately raw, no waitForOverlayResizeSettled: the assertion below is the
      // 100ms debounce window itself -- routing this through the helper would wait the
      // window closed before sampling and prove nothing.
      await page.setViewportSize({ width: 1184, height: 800 });
      const live = await screenshotRgba(decodePage, clip);

      const delta = maxRgbDelta(baseline, live);
      assert.strictEqual(
        delta, 0,
        `#match must show zero painted-pixel delta immediately after a mid-quiver resize (within the 100ms debounce window) -- got max delta ${delta}.`
      );

      await clearBeacons();
    } finally {
      if (decodePage) await decodePage.close();
      await clearBeacons();
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await switchToTarget('target')();
    }
  });

  test('resize listener leak: the window resize listener hardCutArrowShot() registers is removed after natural completion, and after a cancel -- not just when a resize actually fires', async () => {
    await scrollTargetTo('target', 200);
    const baseline = await countWindowResizeListeners();

    // Natural completion: no resize ever fires, so { once: true } alone never removes the
    // listener -- only the Promise.all(...).then() cleanup does.
    const mounted1 = await replay();
    assert.ok(mounted1, 'sanity check: the effect must actually mount');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    const afterNatural = await countWindowResizeListeners();
    assert.strictEqual(
      afterNatural, baseline,
      `resize listener count must return to baseline (${baseline}) after natural completion with no resize firing, got ${afterNatural}`
    );

    // Cancel mid-animation: destroyBeacon() cancels every __waapiAnims entry, which settles the
    // archerDone/arrowDone/targetDone promises immediately -- the listener must come down here
    // too, not just on the natural-completion path above.
    const mounted2 = await replay();
    assert.ok(mounted2, 'sanity check: the effect must actually mount');
    await clearBeacons();
    const afterCancel = await countWindowResizeListeners();
    assert.strictEqual(
      afterCancel, baseline,
      `resize listener count must return to baseline (${baseline}) after a cancel, got ${afterCancel}`
    );
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
      assert.strictEqual(keys.indexOf('arrowshot'), -1, 'arrowshot must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(ARROWSHOT_EFFECT_ROW).count(),
        0,
        'arrowshot must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('arrowshot'), -1, 'arrowshot must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(ARROWSHOT_EFFECT_ROW).count(),
        1,
        'arrowshot must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'arrowshot' (a real, registered --
      // just currently unavailable -- key), so firing must fall back to some other effect rather
      // than mount the wrapper.
      await setSettings({ effect: 'arrowshot', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-arrowshot]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the arrowshot elements');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Selection restored on re-enable: no explicit re-selection of 'arrowshot' here.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-arrowshot="archer"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored arrowshot selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs -- route
      // through a sentinel value first so both writes are genuine changes regardless of which
      // line above (if any) threw.
      await setSettings({ enabledPacks: ['__oc_arrowshot_test_reset__'] });
      await setSettings({ effect: 'arrowshot', enabledPacks: ['halloween'] });
    }
  });
});
