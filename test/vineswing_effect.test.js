// Vine Swing beacon effect (oculist-nq1x.12): promotes fxVineSwing (artifacts/prototypes/
// effects-playground.html:6426) into extension/content.js as the eleventh entry in the
// Halloween pack. A figure swings in on a vine anchored off-screen above, releases near the
// bottom of the arc, and lands beside the match on a short ballistic hop while the riderless
// vine swings on and fades.
//
// Beats carrying real defect history / an explicit bead correction, tested directly rather
// than just documented:
//
// 1. NO ABOVE/BELOW DECISION (oculist-nq1x.12, corrected by oculist-8qrc 2026-09-23, after an
//    earlier version of the bead wrongly claimed one existed): the vine is UNCONDITIONALLY
//    anchored off-screen above. The only placement freedom is LEFT vs RIGHT landing side. When
//    the match sits near the viewport top, content.js does not switch sides -- it shortens the
//    vine length L toward L_FLOOR and, if that alone is insufficient, pushes PIVOT_Y further
//    off-screen so releaseFeetY (the deepest point of the whole arc) never exceeds
//    r.top - SAFE_MARGIN, for any r.top. This is the FIRST thing this suite asserts (the
//    'top-of-viewport clamp' test below), matching the bead's own amendment.
// 2. RULE 9 EXCEPTION (oculist-i8zu, the same class fxArrowShot/fxWandCast/fxBatFlight already
//    carry): the shipped lastMouseX/find-bar/viewport start-point cascade is deliberately NOT
//    used here -- the vine's own pivot (Px, PIVOT_Y) and length (L) are derived entirely from
//    #match's own rect and the viewport. Moving the cursor to an unrelated point on the page
//    must not move the pivot at all.
// 3. MIRRORED BRANCH (rule 9's other half): when the right side has no room, the figure must
//    actually land on the left -- exercised for real, not just compiled.
// 4. OCCLUSION ACROSS THE WHOLE ARC, not just arrival: a per-frame pixel diff of #match's own
//    rendered rect, sampled across the whole timeline (entry sweep, release, ballistic hop,
//    squash, hold, fade), which also exercises the vine's own paint since it shares the sweep.
// 5. RESIZE, measured, load-bearing: a resize that moves #match AWAY from the fixed landing
//    figure (a narrowing reflow) stays green with or without hardCutVineSwing() -- the gap only
//    widens, which proves nothing. The real case is WIDENING: fire at a narrower viewport, then
//    widen -- #resizeTarget's centred layout shifts #match ~40px toward the fixed, stale,
//    fire-time landing figure. With hardCutVineSwing() (extension/content.js) removed, this
//    closes the gap enough that the stale geometry paints over #match's own new position --
//    max painted-pixel delta 206 on #match's rect. With the hard cut in place, delta is 0.
//
// Modeled on test/arrowshot_effect.test.js and test/wandcast_effect.test.js (fixture/helper
// shape: real HTTP fixture, CDP isolated-world attach, tall-spacer layout, scrollBehavior
// 'instant', settleNavigation after navigation, per-frame screenshot occlusion sweep, resize
// hard-cut proof, resize-listener-leak proof via CDP getEventListeners, and the
// predict()-duplicates-the-product-formula idiom used only as a fixture sanity check).
//
// Needs a real browser for the same reasons as those: WAAPI and real layout only exist in real
// Chromium, and Lite Mode/Beacon Size/Animation Speed/pack toggles only exist for real through
// chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target: margin-left:400px, plenty of room on both sides, deep down the page -- scrolled to
// topOffset=300 (well past the ~230px threshold where content.js's own SAFE_MARGIN clamp stops
// engaging, see predict() below), so this is the ordinary, UNCLAMPED right-landing case.
//
// #topTarget: same word, scrolled to topOffset=30 -- close enough to the viewport top that
// releaseFeetY's own natural (unclamped) value would exceed r.top - SAFE_MARGIN, forcing the
// L_FLOOR clamp branch this bead's own amendment describes. This is the FIRST thing the suite
// below asserts.
//
// #leftFallbackTarget: margin-left:1090px with white-space:nowrap, the same "push rect.right
// past the viewport's own sideRight.fits threshold" technique test/wandcast_effect.test.js's
// own #leftFallbackTarget uses -- forces the real mirrored (left) landing branch.
//
// #resizeTarget: text-align:center within width:100%, the same technique test/arrowshot_
// effect.test.js's own #resizeTarget uses -- reflows purely horizontally on a viewport resize.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:400px;"><span id="target">vinewestward</span></div>
<div style="height:1600px"></div>
<div style="margin-left:400px;"><span id="topTarget">vinecanopy</span></div>
<div style="height:1600px"></div>
<div style="margin-left:1090px;white-space:nowrap;"><span id="leftFallbackTarget">vineeastward</span></div>
<div style="height:1000px"></div>
<div style="width:100%;text-align:center;"><span id="resizeTarget">vinedrift</span></div>
<div style="height:1000px"></div>`;

const TARGET_TERMS = {
  target: 'vinewestward',
  topTarget: 'vinecanopy',
  leftFallbackTarget: 'vineeastward',
  resizeTarget: 'vinedrift',
};

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const VINESWING_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:vineswing"]';

// DUR (raw, durFactor=1) = FADE_DELAY(1810) + FADE_DUR(300) = 2110ms; SWING_TOTAL itself
// (acos(-0.8)/omega) is ~1303ms, well inside that window. Used by every sweep/wait below.
const TOTAL_DUR_RAW = 2110;

describe('Vine Swing: a figure swings in on a vine, releases at the bottom of the arc, and lands beside the match', () => {
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

    await setSettings({ effect: 'vineswing', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

    await openFinder(page);
    await page.locator(INPUT).type('vinewestward', { delay: 30 });
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
  // main-world objectId for `window` (verified directly by the sibling suites: an isolated-
  // world-added listener reads back as 0 through a main-world handle). The objectId has to come
  // from Runtime.evaluate('window', ...) IN the isolated context itself for getEventListeners
  // to see it.
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
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-vineswing="vine"]') ? true : null)),
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

  // Mirrors content.js's own animateVineSwing() geometry verbatim (measured and derived exactly
  // the same way, not hand-picked -- same duplication-in-the-test idiom the sibling suites' own
  // predict() functions use). Used only to PREDICT the clamp/side outcome as a sanity check on
  // each fixture -- every real assertion below reads the live rendered DOM.
  const VB_W = 40, VB_H = 56, FACE_ANCHOR_Y = 16;
  const GAP = 14, SAFE_MARGIN = 12, L_FLOOR = 120, DROP = 56, PIVOT_Y_BASE = -70;
  const THETA0_MAG = 58, SWING_DUR = 820, FALL_DUR = 340;
  function predict(measured, beaconScale) {
    const figHeight = 1.2 * Math.max(36, Math.min(48, 2.0 * measured.height)) * beaconScale;
    const figWidth = figHeight * (VB_W / VB_H);
    const mcy = measured.top + measured.height / 2;
    let pivotY = PIVOT_Y_BASE;
    const Lraw = (mcy - DROP) - figHeight - pivotY;
    let L = Math.max(200, Lraw);
    let releaseFeetY = pivotY + L + figHeight;
    let clamped = false;
    if (releaseFeetY > measured.top - SAFE_MARGIN) {
      clamped = true;
      const Lsafe = (measured.top - SAFE_MARGIN) - pivotY - figHeight;
      if (Lsafe >= L_FLOOR) {
        L = Lsafe;
      } else {
        L = L_FLOOR;
        pivotY = (measured.top - SAFE_MARGIN) - L - figHeight;
      }
      releaseFeetY = pivotY + L + figHeight;
    }
    const corners = [
      [-figWidth / 2, L], [figWidth / 2, L],
      [-figWidth / 2, L + figHeight], [figWidth / 2, L + figHeight],
    ];
    let minRel = 0, maxRel = 0;
    for (let deg = -THETA0_MAG; deg <= 0; deg += 1) {
      const rad = (deg * Math.PI) / 180, cosT = Math.cos(rad), sinT = Math.sin(rad);
      corners.forEach((c) => {
        const rel = c[0] * cosT - c[1] * sinT;
        if (rel < minRel) minRel = rel;
        if (rel > maxRel) maxRel = rel;
      });
    }
    const reachToward = -minRel + 2;
    const omega = (Math.PI / 2) / SWING_DUR;
    const releaseRadius = L + (figHeight * FACE_ANCHOR_Y) / VB_H;
    const releaseSpeed = releaseRadius * ((THETA0_MAG * Math.PI) / 180) * omega;
    const runway = releaseSpeed * FALL_DUR;
    const desiredRightX = measured.right + GAP + figWidth / 2;
    const rightPx = Math.max(desiredRightX + runway, measured.right + GAP + reachToward);
    const sideRightX = rightPx - runway;
    const sideRightFits = sideRightX + figWidth / 2 <= measured.vw - 4;
    const desiredLeftX = measured.left - GAP - figWidth / 2;
    const leftPx = Math.min(desiredLeftX - runway, measured.left - GAP - reachToward);
    const sideLeftX = leftPx + runway;
    const sideLeftFits = sideLeftX - figWidth / 2 >= 4;
    const side = sideRightFits ? 'right' : (sideLeftFits ? 'left' : 'right');
    const Px = side === 'right' ? rightPx : leftPx;
    return { figHeight, figWidth, L, pivotY, releaseFeetY, clamped, side, Px, sideRightFits, sideLeftFits };
  }

  function vineswingSnapshot() {
    const vine = document.querySelector('.oc-beacon-transient[data-vineswing="vine"]');
    if (!vine) return null;
    const landing = document.querySelector('.oc-beacon-transient[data-vineswing="landing"]');
    // vineRect is vineWrap's own full-viewport rect (always left=0 -- NOT useful for pinning
    // Px; see the 'swingFig' fields below, which are the actual rendered swing figure this
    // suite's own geometry-sensitive tests read).
    const vineRect = vine.getBoundingClientRect();
    const landingRect = landing ? landing.getBoundingClientRect() : null;
    const swingFig = document.querySelector('[data-vs-pose="swing"]');
    const swingFigRect = swingFig ? swingFig.getBoundingClientRect() : null;
    // buildFigure()'s own mirror marker: a `<g transform="translate(VB_W,0) scale(-1,1)">`
    // only on the mirrored (left-landing) branch -- read directly off the live DOM rather than
    // re-derived, so a wrong mirror call (right art on the left branch or vice versa) is
    // caught even though it does not move the swing figure's own bounding box.
    const swingFigGroup = swingFig ? swingFig.querySelector('g') : null;
    const swingFigMirrored = !!(swingFigGroup && /scale\(\s*-1\s*,\s*1\s*\)/.test(swingFigGroup.getAttribute('transform') || ''));
    return {
      vinePresent: true,
      landingPresent: !!landing,
      side: vine.getAttribute('data-vineswing-side'),
      L: parseFloat(vine.getAttribute('data-vineswing-l')),
      pivotY: parseFloat(vine.getAttribute('data-vineswing-pivot-y')),
      releaseFeetY: parseFloat(vine.getAttribute('data-vineswing-release-feet-y')),
      Px: parseFloat(vine.getAttribute('data-vineswing-px')),
      vineLeft: vine.style.left,
      vineTop: vine.style.top,
      vineBox: { left: vineRect.left, right: vineRect.right, top: vineRect.top, bottom: vineRect.bottom },
      landingLeft: landing ? landing.style.left : null,
      landingTop: landing ? landing.style.top : null,
      landingBox: landingRect && { left: landingRect.left, right: landingRect.right, top: landingRect.top, bottom: landingRect.bottom, width: landingRect.width, height: landingRect.height },
      swingFigBox: swingFigRect && { left: swingFigRect.left, right: swingFigRect.right, top: swingFigRect.top, bottom: swingFigRect.bottom, width: swingFigRect.width },
      swingFigMirrored,
    };
  }

  test('top-of-viewport clamp (oculist-nq1x.12, oculist-8qrc): near the viewport top, L floors at L_FLOOR and PIVOT_Y is pushed further off-screen, keeping releaseFeetY at r.top - SAFE_MARGIN', async () => {
    await switchToTarget('topTarget')();
    try {
      await scrollTargetTo('topTarget', 30);
      const measured = await measure('topTarget');
      const predicted = predict(measured, 1);
      assert.ok(predicted.clamped, 'sanity check: fixture must actually force the clamp branch');
      assert.strictEqual(predicted.L, L_FLOOR, 'sanity check: predicted L must floor at L_FLOOR, not merely shorten');
      assert.ok(predicted.pivotY < PIVOT_Y_BASE, 'sanity check: predicted PIVOT_Y must be pushed further off-screen than the baseline');

      const geom = await replay(vineswingSnapshot);
      assert.ok(geom, 'expected a mounted vine swing');
      assert.ok(
        Math.abs(geom.L - L_FLOOR) < 0.01,
        `live L must floor at exactly L_FLOOR (${L_FLOOR}) near the viewport top, got ${geom.L}`
      );
      assert.ok(
        geom.pivotY < PIVOT_Y_BASE - 0.01,
        `live PIVOT_Y must be pushed further off-screen than the ${PIVOT_Y_BASE} baseline, got ${geom.pivotY}`
      );
      const expectedReleaseFeetY = measured.top - SAFE_MARGIN;
      assert.ok(
        Math.abs(geom.releaseFeetY - expectedReleaseFeetY) < 0.5,
        `releaseFeetY must be clamped to r.top - SAFE_MARGIN (${expectedReleaseFeetY}) by construction, got ${geom.releaseFeetY}`
      );
      // MUTATION PROOF (traced through the source, not run against a live mutant -- this
      // exact clamp is oculist-1ta.4's own finding 1, already re-verified live by its own
      // "min clearance 13.86px" probe): deleting the `if (releaseFeetY > r.top - SAFE_MARGIN)`
      // guard (or its body) in animateVineSwing() would leave L at its raw >=200 floor value
      // here (L=200, not 120) and PIVOT_Y at the -70 baseline, both of which the assertions
      // above catch directly -- geom.L would read 200 and geom.pivotY would read -70.

      await clearBeacons();
    } finally {
      await clearBeacons();
      await switchToTarget('target')();
    }
  });

  test('document-space correctness: on a scrolled page, both the vine and the landing figure carry a real "+ window.scrollX/scrollY" term, and both render visibly', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const measured = await measure('target');
      const predicted = predict(measured, 1);
      assert.ok(!predicted.clamped, 'sanity check: this fixture is meant to give the unclamped case room');

      const geom = await replay(vineswingSnapshot);
      assert.ok(geom, 'expected a mounted vine swing');

      // vineWrap spans the WHOLE viewport at document (scrollX, scrollY) -- its own style.left/
      // top are exactly the scroll offsets, a dropped or doubled term is directly visible here.
      assert.ok(
        Math.abs(parseFloat(geom.vineLeft) - scroll.x) <= 1,
        `vine wrap's style.left (${geom.vineLeft}) must equal window.scrollX exactly once -- expected ~${scroll.x}px`
      );
      assert.ok(
        Math.abs(parseFloat(geom.vineTop) - scroll.y) <= 1,
        `vine wrap's style.top (${geom.vineTop}) must equal window.scrollY exactly once -- expected ~${scroll.y}px`
      );

      // The LANDING figure is a separate top-level element with its own independent SCROLL_X/
      // SCROLL_Y term -- a dropped or doubled scroll offset there is invisible to the vine
      // wrap's own check above.
      const expectedLandingLeft = predicted.Px - predicted.figWidth / 2 + scroll.x;
      const expectedLandingTop = predicted.releaseFeetY - predicted.figHeight - 8 /* FALL_PAD */ + scroll.y;
      assert.ok(
        Math.abs(parseFloat(geom.landingLeft) - expectedLandingLeft) <= 2,
        `landing figure's style.left (${geom.landingLeft}) must include window.scrollX exactly once -- expected ~${expectedLandingLeft}px`
      );
      assert.ok(
        Math.abs(parseFloat(geom.landingTop) - expectedLandingTop) <= 2,
        `landing figure's style.top (${geom.landingTop}) must include window.scrollY exactly once -- expected ~${expectedLandingTop}px`
      );

      // Visible, not just correctly-labelled: the landing figure's own rendered viewport box
      // (getBoundingClientRect, independent of scroll) must land near the predicted VIEWPORT-
      // space box, proving the scrolled document-space math actually renders on screen at the
      // right spot rather than off in some scrolled-away part of the document.
      const expectedViewportLeft = predicted.Px - predicted.figWidth / 2;
      assert.ok(
        Math.abs(geom.landingBox.left - expectedViewportLeft) <= 3,
        `landing figure must render visibly at the predicted viewport position (left~${expectedViewportLeft}px), got ${geom.landingBox.left}px`
      );

      await clearBeacons();
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
      await scrollTargetTo('target', 200);
    }
  });

  test('normal placement (right landing): the vine and landing figure render clear of #match across the whole arc, and the match DOM is untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const measured = await measure('target');
    const predicted = predict(measured, 1);
    assert.strictEqual(predicted.side, 'right', 'sanity check: fixture must give the default right landing room');

    const geom = await replay(vineswingSnapshot);
    assert.ok(geom, 'expected a mounted vine swing');
    assert.strictEqual(geom.side, 'right', 'default landing must be the right side');
    assert.ok(geom.landingPresent, 'the landing figure must mount alongside the vine');

    // Right-landing branch must NOT carry buildFigure()'s own mirror transform (that belongs
    // to the left branch only) -- a bounding-box check alone cannot catch a wrong `mirrored`
    // argument, since mirroring only flips artwork INSIDE the figure's own (unchanged) box.
    // MUTATION PROOF (done during implementation, reverted before commit): swapping
    // buildFigure(figSwingSvg, !onRight, 'swing') to buildFigure(figSwingSvg, onRight, 'swing')
    // (so the right branch wrongly mirrors) turned this assertion red; restoring `!onRight`
    // returned it to green.
    assert.strictEqual(geom.swingFigMirrored, false, 'the right-landing swing figure must not carry buildFigure()\'s own mirror transform');

    // At mount (t=0, theta=theta0), the swing figure must sit on the FAR side of Px from
    // #match -- i.e. further right than the release point it will swing down to -- proving
    // theta0's own sign actually drove the entry frame, not just the release position.
    // MUTATION PROOF (done during implementation, reverted before commit): hardcoding
    // `var theta0 = -theta0Mag;` (always the right-branch sign) turned this assertion green by
    // accident on THIS (right-landing) fixture, but red on the left-fallback fixture below,
    // where the entry figure would wrongly sit on the match's own far side instead of the
    // pivot's; restoring the `onRight ? ... : ...` ternary returned both to green.
    const entryCenterX = (geom.swingFigBox.left + geom.swingFigBox.right) / 2;
    assert.ok(
      entryCenterX > geom.Px + 10,
      `right-landing entry figure must sit clearly to the right of Px (${geom.Px}), the far side from #match -- got center ${entryCenterX}`
    );

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

    // Sweeps the WHOLE animation (entry sweep, release, ballistic hop, squash, hold, fade),
    // not just the mount frame, and it also exercises the vine's own paint (it shares the
    // rotating group's transform with the figure across the whole sweep).
    // MUTATION PROOFS (done during implementation, reverted before commit):
    //  - Shrinking REACH_TOWARD by 40px (`-minRel + 2 - 40`) did NOT turn this fixture red.
    //    Measured directly: for every fixture in this suite, `rightPx = Math.max(desiredRightX
    //    + runway, r.right + GAP + REACH_TOWARD)` resolves via the ballistic-runway term
    //    (runway is ~143px here, REACH_TOWARD only ~23px) -- REACH_TOWARD is a defensive lower
    //    bound the runway term dominates in every geometry this suite's fixtures reach, not the
    //    everyday driver of sideRight.x. Recorded honestly (not silently dropped or papered
    //    over with a fixture that doesn't actually exercise it), the same way test/arrowshot_
    //    effect.test.js's own header comment records STRIKE_GAP=7 not reproducing its cliff on
    //    ITS fixture either.
    //  - Dropping the `GAP +` term from desiredRightX's own definition (so the figure's
    //    resting x moves GAP=14px closer to #match) DID turn this assertion red -- worst delta
    //    59 at t=1200ms (during the riderless far-side swing) -- proving GAP is load-bearing on
    //    this fixture. Restoring the term returned it to green.
    await assertNoOcclusionAcrossAnimation('target');

    await clearBeacons();
  });

  test('left fallback (rule 9\'s mirrored branch): when the right side has no room, the figure actually lands on the left, and never occludes the match', async () => {
    await switchToTarget('leftFallbackTarget')();
    try {
      await scrollTargetTo('leftFallbackTarget', 200);
      const measured = await measure('leftFallbackTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.side, 'left', 'sanity check: fixture must force the left-landing branch');
      assert.ok(!predicted.sideRightFits, 'sanity check: the right side must genuinely not fit');

      const before = await page.evaluate(() => document.getElementById('leftFallbackTarget').outerHTML);
      const geom = await replay(vineswingSnapshot);
      assert.ok(geom, 'expected a mounted vine swing');
      assert.strictEqual(geom.side, 'left', 'the figure must actually land on the left, not just compile a left branch');
      assert.ok(geom.landingPresent, 'the landing figure must mount on the mirrored branch too');
      assert.ok(
        geom.landingBox.right <= measured.left,
        `landing figure must sit clear to the LEFT of #match, got landingBox.right=${geom.landingBox.right} vs match.left=${measured.left}`
      );

      // The left branch MUST carry buildFigure()'s own mirror transform -- a bounding-box check
      // alone cannot catch a wrong `mirrored` argument here either (see the right-landing
      // test's own comment for the shared reasoning and mutation proof).
      assert.strictEqual(geom.swingFigMirrored, true, 'the left-landing swing figure must carry buildFigure()\'s own mirror transform (translate(VB_W,0) scale(-1,1))');

      // At mount (t=0, theta=theta0), the swing figure must sit on the FAR side of Px from
      // #match too -- here that means clearly to the LEFT of Px, proving theta0's own sign is
      // actually POSITIVE on this branch (mirroring the right-landing check), not just relying
      // on the release-point geometry. See the right-landing test's own mutation proof: this is
      // the fixture that catches `var theta0 = -theta0Mag;` hardcoded to the wrong (right-only)
      // sign, which the right-landing fixture alone cannot.
      const entryCenterX = (geom.swingFigBox.left + geom.swingFigBox.right) / 2;
      assert.ok(
        entryCenterX < geom.Px - 10,
        `left-landing entry figure must sit clearly to the left of Px (${geom.Px}), the far side from #match -- got center ${entryCenterX}`
      );

      const after = await page.evaluate(() => document.getElementById('leftFallbackTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect on the mirrored branch');

      await assertNoOcclusionAcrossAnimation('leftFallbackTarget');

      await clearBeacons();
    } finally {
      await clearBeacons();
      await switchToTarget('target')();
    }
  });

  test('cursor independence (rule 9 exception, oculist-i8zu): moving the mouse elsewhere on the page never moves the vine\'s own pivot, within +/-3px', async () => {
    await scrollTargetTo('target', 200);
    try {
      // Move the cursor to a point that would produce a wildly different start point under
      // animateTrail's own lastMouseX/lastMouseY cascade (far lower-right of the viewport).
      await page.mouse.move(1150, 780);
      const geom1 = await replay(vineswingSnapshot);
      assert.ok(geom1, 'expected a mounted vine swing');
      await clearBeacons();

      // A distant second cursor position (far upper-left).
      await page.mouse.move(20, 20);
      const geom2 = await replay(vineswingSnapshot);
      assert.ok(geom2, 'expected a mounted vine swing');

      assert.strictEqual(geom2.side, geom1.side, 'the landing side must not move with the cursor either');
      assert.ok(
        Math.abs(geom2.pivotY - geom1.pivotY) <= 3,
        `the vine's own PIVOT_Y must stay pinned regardless of cursor position, within +/-3px -- got ${geom1.pivotY} then ${geom2.pivotY}`
      );
      assert.ok(
        Math.abs(geom2.Px - geom1.Px) <= 3,
        `the vine's own pivot Px must stay pinned regardless of cursor position, within +/-3px -- got ${geom1.Px} then ${geom2.Px}`
      );
      // vineBox is deliberately NOT used here -- it is vineWrap's own full-viewport rect
      // (always left=0), which cannot move with the cursor regardless of Px and would pass
      // even under a cursor-driven Px. The load-bearing checks are the actual rendered swing
      // figure and landing figure boxes, which DO move with Px.
      // MUTATION PROOF (done during implementation, reverted before commit): replacing Px's own
      // assignment with `var Px = (lastMouseX != null ? lastMouseX : landing.px);` left the old
      // vineBox-only assertion green (proving it vacuous) but turned swingFigBox/landingBox red
      // here; restoring the real assignment returned both to green.
      assert.ok(
        Math.abs(geom2.swingFigBox.left - geom1.swingFigBox.left) <= 3,
        `the swing figure's own rendered box must stay pinned regardless of cursor position, within +/-3px -- got left=${geom1.swingFigBox.left} then ${geom2.swingFigBox.left}`
      );
      assert.ok(
        Math.abs(geom2.landingBox.left - geom1.landingBox.left) <= 3,
        `the landing figure's own rendered box must stay pinned regardless of cursor position, within +/-3px -- got left=${geom1.landingBox.left} then ${geom2.landingBox.left}`
      );

      await clearBeacons();
    } finally {
      await page.mouse.move(200, 120);
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
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-vineswing="vine"]'), null, { timeout: POLL_TIMEOUT });

      const SAMPLE_STEP = 75;
      let maxDelta = 0, worstT = -1;
      for (let t = 0; t <= TOTAL_DUR_RAW; t += SAMPLE_STEP) {
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

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on every element is actually canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-vineswing="vine"]')) return null;
      window.__vsTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__vsTestAnims.length;
    });
    // vine wrap: rotation(1) + swing-figure-hide(1) + wrap-fade(1) = 3, all hung off vineWrap's
    // own __waapiAnims (rule 4: child-node animations hang on the parent); landing figure:
    // reveal(1) + fall-translate(1) + squash(1) + fade-out(1) = 4, hung off fallOuter's own
    // __waapiAnims. Total = 3 + 4 = 7.
    assert.strictEqual(animCount, 7, `expected 7 live WAAPI animations before cancellation, got ${animCount}`);

    await clearBeacons();

    const states = await page.evaluate(() => window.__vsTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${[...new Set(states)].join(', ')}`);

    await page.evaluate(() => { delete window.__vsTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted, 'sanity check: the effect must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- a genuine leak surfaces as this wait's own TimeoutError.
    // Total raw duration is 2110ms; POLL_TIMEOUT comfortably covers it.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: a no-op -- same rendered geometry and the same animation count in both modes', async () => {
    async function snapshot() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted vine swing');
      return page.evaluate(() => {
        const vine = document.querySelector('.oc-beacon-transient[data-vineswing="vine"]');
        const landing = document.querySelector('.oc-beacon-transient[data-vineswing="landing"]');
        const lr = landing.getBoundingClientRect();
        return {
          landingBox: { w: Math.round(lr.width), h: Math.round(lr.height) },
          totalAnimCount: Array.from(document.querySelectorAll('.oc-beacon-transient'))
            .reduce((sum, el) => sum + el.getAnimations({ subtree: true }).length, 0),
        };
      });
    }

    await scrollTargetTo('target', 200);
    const full = await snapshot();
    assert.strictEqual(full.totalAnimCount, 7, 'sanity check: full mode must have all 7 animations');
    try {
      await setSettings({ performanceMode: true });
      const lite = await snapshot();
      assert.strictEqual(lite.totalAnimCount, full.totalAnimCount, 'Lite Mode must not drop or add any animation -- this effect has no glow/box-shadow/flicker to cut beyond the swing-release-hop sequence, which is the effect\'s own defining beat');
      assert.deepStrictEqual(lite.landingBox, full.landingBox, 'Lite Mode must render the landing figure at the exact same geometry');
    } finally {
      await setSettings({ performanceMode: false });
      await clearBeacons();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the landing figure\'s RENDERED box scales together with it', async () => {
    // Reads the inner figFallSvg (data-vs-pose="land"), not the fallOuter wrapper -- fallOuter's
    // own height also includes FALL_PAD, a fixed screen-px headroom constant deliberately
    // unaffected by beaconScale (same discipline as GAP/SAFE_MARGIN), so measuring the wrapper
    // itself would not scale linearly with beaconScale.
    async function renderedSize() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted vine swing');
      return page.evaluate(() => {
        const fig = document.querySelector('.oc-beacon-transient[data-vineswing="landing"] [data-vs-pose="land"]');
        return fig.getBoundingClientRect().height;
      });
    }

    await scrollTargetTo('target', 200);
    let currentSize = 'm';
    try {
      const base = await renderedSize();
      const SIZES = [['s', 0.7], ['l', 1.5], ['xl', 2.25]];
      for (const [size, factor] of SIZES) {
        currentSize = size;
        await setVisionSettings({ beaconSize: size });
        const sized = await renderedSize();
        const expected = base * factor;
        assert.ok(
          Math.abs(sized - expected) <= 2,
          `Beacon Size ${size}: landing figure height expected ~${expected}, got ${sized}`
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
    await page.setViewportSize({ width: 500, height: 300 });
    try {
      await scrollTargetTo('target', 60);

      const before = await page.evaluate(() => document.getElementById('target').outerHTML);

      const geom = await replay(vineswingSnapshot);
      assert.ok(geom, 'expected a mounted vine swing even at a tiny viewport');
      assert.ok(geom.landingPresent, 'the landing figure must render even at a tiny viewport');

      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect, even at a tiny viewport');
    } finally {
      await clearBeacons();
      await page.setViewportSize(VIEWPORT);
      await page.evaluate(() => window.scrollTo(0, 0));
      await scrollTargetTo('target', 200);
    }
  });

  // Decodes a PNG screenshot into raw RGBA bytes, factored out so the resize test below can
  // take a "clean" baseline and a "live" sample through the same pipeline.
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

  test('resize mid-swing, widening (measured, load-bearing): firing at a narrower viewport then widening moves #match ~40px TOWARD the fixed right-landing figure, closing the gap enough to paint over it without the hard cut', async () => {
    // A resize that moves #match AWAY from the landing figure (e.g. narrowing a centred
    // fixture, which was this test's own earlier, mistaken shape) stays green with or without
    // hardCutVineSwing(), because the gap only widens -- that proves nothing. The load-bearing
    // direction is WIDENING: fire at a NARROWER viewport (the landing figure's own Px is
    // computed from #match's narrower position), pause mid-hold, then widen -- #resizeTarget's
    // centred layout shifts #match to the RIGHT, toward the figure's own fixed, stale
    // fire-time position. content.js's own handleResize() only reaches cancelBeacons() through
    // repositionActiveOverlays(), gated behind a 100ms debounce (overlayResizeTimer), so this
    // resize alone, sampled before that debounce fires, is the window where the stale geometry
    // can paint over the newly-reflowed #match.
    let decodePage;
    try {
      decodePage = await ctx.newPage();

      // Measure the post-widen (live, "clip") position first, at a CLEAN page (no effect), so
      // the baseline/live comparison below is apples-to-apples at the same clip.
      await page.setViewportSize({ width: 1120, height: 800 });
      await switchToTarget('resizeTarget')();
      const beforeRect = await measure('resizeTarget');
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForTimeout(200);
      const afterRect = await measure('resizeTarget');
      assert.ok(
        afterRect.right - beforeRect.right > 20,
        `sanity check: widening must move #match right by a real margin, or this test proves nothing (before.right=${beforeRect.right}, after.right=${afterRect.right})`
      );
      assert.ok(
        Math.abs(afterRect.top - beforeRect.top) < 1,
        'sanity check: this fixture is meant to reflow horizontally only (text-align:center), not change line'
      );
      const clip = { x: Math.round(afterRect.left), y: Math.round(afterRect.top), width: Math.round(afterRect.width), height: Math.round(afterRect.height) };
      const baseline = await screenshotRgba(decodePage, clip);

      // Fire from the NARROWER viewport, so the figure's own Px is computed from #match's
      // narrower (further-left) position -- the stale geometry this resize will expose.
      await page.setViewportSize({ width: 1120, height: 800 });
      await page.waitForTimeout(200);
      const geom = await replay(vineswingSnapshot);
      assert.ok(geom, 'expected a mounted vine swing figure');
      assert.strictEqual(geom.side, 'right', 'sanity check: this fixture is meant to give the right-landing branch room');

      // Freeze every animation mid-hold (t=1300ms, past the squash, where the landing figure's
      // own static box sits right next to #match's fire-time position) BEFORE resizing, so the
      // comparison below is deterministic.
      await page.evaluate(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
          el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1300; });
        });
      });

      await page.setViewportSize({ width: 1200, height: 800 });
      const live = await screenshotRgba(decodePage, clip);

      const delta = maxRgbDelta(baseline, live);
      assert.strictEqual(
        delta, 0,
        `#match must show zero painted-pixel delta immediately after a mid-hold widening resize (within the 100ms debounce window) -- got max delta ${delta}.`
      );

      await clearBeacons();
    } finally {
      if (decodePage) await decodePage.close();
      await clearBeacons();
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(200);
      await switchToTarget('target')();
    }
  });

  test('resize listener leak: the window resize listener hardCutVineSwing() registers is removed after natural completion, and after a cancel -- not just when a resize actually fires', async () => {
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

    // Cancel mid-animation: destroyBeacon() cancels every __waapiAnims entry on BOTH top-level
    // elements, which settles vineDone/fallDone immediately -- the listener must come down
    // here too, not just on the natural-completion path above.
    const mounted2 = await replay();
    assert.ok(mounted2, 'sanity check: the effect must actually mount');
    await clearBeacons();
    const afterCancel = await countWindowResizeListeners();
    assert.strictEqual(
      afterCancel, baseline,
      `resize listener count must return to baseline (${baseline}) after a cancel, got ${afterCancel}`
    );
  });

  test('pack enumeration: absent from the picker with enabledPacks empty, present when halloween is enabled, stored selection NOT rewritten when the pack is disabled, runtime fallback safe, selection restored on re-enable', async () => {
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
      assert.strictEqual(keys.indexOf('vineswing'), -1, 'vineswing must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(VINESWING_EFFECT_ROW).count(),
        0,
        'vineswing must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('vineswing'), -1, 'vineswing must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(VINESWING_EFFECT_ROW).count(),
        1,
        'vineswing must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'vineswing' (a real, registered
      // -- just currently unavailable -- key), so firing must fall back to some other effect
      // rather than mount the wrapper.
      await setSettings({ effect: 'vineswing', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-vineswing="vine"]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the vine-swing elements');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Selection restored on re-enable: no explicit re-selection of 'vineswing' here.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-vineswing="vine"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored vineswing selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs -- route
      // through a sentinel value first so both writes are genuine changes regardless of which
      // line above (if any) threw.
      await setSettings({ enabledPacks: ['__oc_vineswing_test_reset__'] });
      await setSettings({ effect: 'vineswing', enabledPacks: ['halloween'] });
    }
  });
});
