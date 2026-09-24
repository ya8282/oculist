// Fairy Cast beacon effect (oculist-nq1x.10): promotes fxWandCast (artifacts/prototypes/
// effects-playground.html) into extension/content.js as the ninth entry in the Halloween pack.
// A sparkling amber fairy lands beside the match (right by default, left if the right side has
// no room), casts through three wand poses, then launches six sparkles from the wand tip that
// swirl the match on an orbiting ellipse before fading.
//
// THIS EFFECT HAS THE WORST OCCLUSION HISTORY IN THE PLAYGROUND (oculist-nq1x.10's own
// effect-specific note): six separate prototype defects (oculist-tvqw, oculist-giy7,
// oculist-wkfc, oculist-73l6, oculist-3dd8, oculist-mbmy) were filed and fixed against this
// exact geometry. Beats carrying real defect history, tested directly rather than just
// documented:
//
// 1. NO ABOVE/BELOW FALLBACK (oculist-nq1x.10's own MISSING-REQUIREMENT note): unlike Bat
//    Flight's beside-then-above-then-below chooser, this effect has no above/below placement at
//    all. When neither side has full clearance it still tries sideRight, then suppresses
//    (mounts NOTHING at all) ONLY if the actual clamped painted bounds genuinely overlap
//    #match (oculist-giy7's own fix). A synthetic FORCED-LANDING full-width #match would
//    therefore suppress unconditionally and pass "clean" without ever proving placement --
//    exactly the vacuous-green risk Tentacle Rise's own census fix (oculist-ke53/4k8y)
//    addressed. Every test below that expects a real render asserts a live element census
//    (front-sparkle count, figure presence) alongside geometry/occlusion, and the two edge
//    tests below assert the OPPOSITE outcomes (a real, non-vacuous render vs genuine zero-element
//    suppression) from the exact "wide match at a narrow viewport at both edges" shape the bead
//    calls out as the shape that produced most of the six defects.
// 2. MIRRORED BRANCH (rule 9's other half): when the right side has no room, the figure must
//    actually land on the left -- exercised for real, not just compiled, including the wand
//    tip's own mirrored toScreen() formula (the travel bezier's start point).
// 3. RULE 9 EXCEPTION (oculist-i8zu): the shipped lastMouseX/find-bar/viewport start-point
//    cascade is deliberately NOT used here -- every sparkle launches from the wand tip, which is
//    pinned to the figure's own placement. Moving the cursor to an unrelated point on the page
//    must not move the sparkles' own launch point at all.
// 4. OCCLUSION ACROSS THE WHOLE ANIMATION, not just the mount frame: a per-frame pixel diff of
//    #match's own rendered rect, sampled across the wand-cast timeline (poses) and the full
//    sparkle orbit (travel + swirl), on both the normal-placement and mirrored-placement paths.
//
// Modeled on test/reanimate_effect.test.js and test/batflight_effect.test.js (fixture/helper
// shape: real HTTP fixture, CDP isolated-world attach, tall-spacer layout, scrollBehavior
// 'instant', settleNavigation after navigation, and the predict()-duplicates-the-product-formula
// idiom used as a sanity check on each fixture, never as the assertion itself).
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

// #target: plenty of room on both sides, 1600px down the page -- sideRight.fits trivially here,
// exercising the true default (right-first) landing.
//
// #leftFallbackTarget: measured (not guessed) at margin-left:1030px with white-space:nowrap
// against this fixture's own 40px body padding: rect.left=1070, rect.right=1162 at the default
// 1200px-wide viewport -- content.js's own animateWandCast() formula (mirrored below in
// predict()) puts sideRight.x + REACH_OUTWARD past vw-4 (no room on the right) while sideLeft
// still fits comfortably, forcing the real mirrored branch rather than merely compiling it.
// white-space:nowrap keeps the span on one line so its rect stays the single-line geometry the
// formula assumes, instead of wrapping in the narrow remaining width.
//
// #edgeLeftTarget / #edgeRightTarget: the bead's own "WIDE match at a NARROW viewport at both
// edges" shape, measured directly against the CURRENT geometry (not the prototype's pre-
// oculist-1ta.30 numbers) at a 320x900 viewport:
//   - "wandwidefairy" at font-size:68px, left-aligned: width ~219px, rect ~[40,259]. Both
//     sideRight.fits and sideLeft.fits are false, but the clamped painted bounds land CLEAR of
//     #match -- content.js must still render the figure (oculist-giy7's own fix: this fallback
//     is not "suppress whenever neither side fits", it is "suppress only on genuine overlap").
//     Stable across the whole 64-68.5px font-size plateau (measured), well clear of the 62px/70px
//     boundaries where it flips. 68px (not 66px) is the size specifically because it ALSO closes
//     the wand tip's own visual clearance to just under SPARK_VISUAL_REACH of #match's right
//     edge (measured: the wand-tip-clears check fails here, passes at 66px), which is what
//     oculist-wkfc's own travel-reveal delay exists to cover -- see its own test below.
//   - "fairywandwide" at font-size:60px, right-aligned (text-align:right): width ~214px, rect
//     ~[66,280]. Both fits flags are false AND the clamped painted bounds genuinely overlap
//     #match -- content.js must suppress entirely (zero elements), not drag the figure onto the
//     glyphs. Stable across a 50-74px font-size plateau (measured).
// Two different words (not the same word twice) so the finder's search term stays unambiguous
// between the two fixtures.
//
// #rxEdgeTarget: flush against the viewport's own left edge (margin-left:-38px cancels the
// body's own 40px padding) at 320x900, a MODEST 28px-font word -- narrow enough, and close
// enough to the edge, that rxViewportCap (the sparkle orbit's own viewport-edge clamp) undercuts
// matchClearanceFloor (the match-edge floor), so the floor -- and therefore its own cos(30deg)
// divisor (oculist-mbmy) and its ORBIT_EDGE_MARGIN=18 (oculist-73l6) -- is what actually
// determines the orbit's rx here, not rawRx. Deliberately a NORMAL, unsuppressed, unmirrored
// placement (sideRight fits trivially for a word this narrow) so the orbit-rx checks below are
// isolated from the separate side-selection/suppression geometry #edgeLeftTarget/#edgeRightTarget
// already cover.
// #resizeTarget: text-align:center within a width:100% container, at a normal (not narrow-edge)
// viewport -- measured: the whole rect shifts by exactly half the viewport-width delta (1200px vw
// -> rect=[561.9,638.1]; 1184px vw -> rect=[553.9,630.1]; 1160px vw -> rect=[541.9,618.1]), same
// small horizontal-only reflow the reviewer's own repro used (1200->1184 or 1200->1160), top/
// bottom unchanged (same line). Centered (not right-aligned) so sideRight.fits comfortably at
// EVERY one of these widths -- the figure and front sparkles keep a huge clearance budget (their
// own REACH_INWARD/REACH_OUTWARD/orbit-rx margins are 20-50px) that an 8px shift can never
// threaten, isolating the back-arc clip's own much tighter 2px CLIP_MARGIN as the only thing this
// test can observe going stale.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<p>filler text <span id="target">hexbloomspark</span></p>
<div style="height:1600px"></div>
<div style="margin-left:1030px;white-space:nowrap;"><span id="leftFallbackTarget">glimmerorbit</span></div>
<div style="height:1000px"></div>
<div style="width:100%;overflow-wrap:anywhere;"><span id="edgeLeftTarget" style="font-size:68px;">wandwidefairy</span></div>
<div style="height:600px"></div>
<div style="width:100%;overflow-wrap:anywhere;text-align:right;"><span id="edgeRightTarget" style="font-size:60px;">fairywandwide</span></div>
<div style="height:600px"></div>
<div style="margin:0 0 0 -38px;white-space:nowrap;"><span id="rxEdgeTarget" style="font-size:28px;">orbitedge</span></div>
<div style="height:1000px"></div>
<div style="height:200px"></div>
<div style="width:100%;text-align:center;"><span id="resizeTarget">emberdrift</span></div>
<div style="height:1000px"></div>`;

const TARGET_TERMS = {
  target: 'hexbloomspark',
  leftFallbackTarget: 'glimmerorbit',
  edgeLeftTarget: 'wandwidefairy',
  rxEdgeTarget: 'orbitedge',
  edgeRightTarget: 'fairywandwide',
  resizeTarget: 'emberdrift',
};

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const WANDCAST_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:wandcast"]';

describe('Fairy Cast: an amber fairy lands beside the match, casts, and launches six orbiting sparkles', () => {
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

    await setSettings({ effect: 'wandcast', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

    await openFinder(page);
    await page.locator(INPUT).type('hexbloomspark', { delay: 30 });
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

  // Same production cancellation path as the sibling suites: cancels any in-flight beacon
  // through window.__ocTest.cancelBeacons() (the exact function animate() itself calls first),
  // then presses Enter to (re-)fire.
  async function replay(predicate, arg) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    const handle = await page.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-wandcast="figure"]') ? true : null)),
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

  async function scrollTargetTo(id, topOffset) {
    const docTop = await page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return r.top + window.scrollY;
    }, id);
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, docTop - topOffset));
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

  // Mirrors content.js's own animateWandCast() figure-placement/suppression formula verbatim
  // (measured and derived exactly the same way, not hand-picked -- the same duplication-in-the-
  // test idiom the sibling suites' own predict() functions use). Used only to PREDICT the
  // landing side and the suppression outcome as a sanity check on each fixture -- every real
  // assertion below reads the live rendered DOM/census.
  const VB_W = 40, VB_H = 52;
  const TIP_BACK_Y = -10, TIP_CAST_X = -16, TIP_CAST_Y = 18, TIP_RADIUS_LOCAL = 2.5;
  const ANCHOR_X = 20;
  const REACH_INWARD_LOCAL = ANCHOR_X - (TIP_CAST_X - 1); // 37
  const REACH_OUTWARD_LOCAL = 30;
  const GAP = 14;
  function predict(measured, beaconScale) {
    const figHeight = Math.max(34, Math.min(48, 1.5 * measured.height)) * beaconScale;
    const scale = figHeight / VB_H;
    const figWidth = VB_W * scale;
    const reachInward = REACH_INWARD_LOCAL * scale + 3;
    const reachOutward = REACH_OUTWARD_LOCAL * scale + 3;
    const vw = measured.vw, vh = measured.vh;
    const sideRightX = measured.right + GAP + reachInward;
    const sideRightFits = sideRightX + reachOutward <= vw - 4;
    const sideLeftX = measured.left - GAP - reachInward;
    const sideLeftFits = sideLeftX - reachOutward >= 4;
    const landingX = sideRightFits ? sideRightX : sideLeftX; // fallback also uses sideRight's X
    const onRight = sideRightFits || !sideLeftFits;
    const mirrored = !onRight;
    const mcy = measured.top + measured.height / 2;
    const figLeft = Math.max(4, Math.min(vw - 4 - figWidth, (onRight ? sideRightX : landingX) - ANCHOR_X * scale));
    const figTop = Math.max(4, Math.min(vh - 4 - figHeight, mcy - figHeight / 2));
    const PAINT_MIN_X = TIP_CAST_X - TIP_RADIUS_LOCAL;
    const PAINT_MAX_X = 50;
    const PAINT_MIN_Y = TIP_BACK_Y - TIP_RADIUS_LOCAL;
    const PAINT_MAX_Y = 46;
    const paintLeft = figLeft + (mirrored ? VB_W - PAINT_MAX_X : PAINT_MIN_X) * scale;
    const paintRight = figLeft + (mirrored ? VB_W - PAINT_MIN_X : PAINT_MAX_X) * scale;
    const paintTop = figTop + PAINT_MIN_Y * scale;
    const paintBottom = figTop + PAINT_MAX_Y * scale;
    const suppressed = paintLeft < measured.right && paintRight > measured.left &&
      paintTop < measured.bottom && paintBottom > measured.top;
    // toScreen()'s own mirror formula (content.js ~5776): a mirrored local point reflects across
    // figWidth/2, it does not simply negate. Duplicated here (not just "left of #match") so the
    // mirrored-branch test can pin the sparkles' actual launch point, not merely its side.
    const ux = mirrored ? (figWidth - TIP_CAST_X * scale) : (TIP_CAST_X * scale);
    const wandTipX = figLeft + ux;
    const wandTipY = figTop + TIP_CAST_Y * scale;
    return { sideRightFits, sideLeftFits, side: onRight ? 'right' : 'left', suppressed, figWidth, figHeight, figLeft, figTop, scale, mirrored, wandTipX, wandTipY };
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

  // Reads the real rendered structure (presence, side, geometry, AND a live element census) in
  // one page-side tick -- folding all of it into the same predicate avoids the oculist-d5c
  // round-trip hazard (a transient element can self-clean between two separate round trips), and
  // the census is what oculist-nq1x.10's own MISSING-REQUIREMENT note demands: a mutation that
  // always suppresses cannot pass as "clean" merely because the match pixels stayed untouched.
  function wandcastSnapshot() {
    const fig = document.querySelector('.oc-beacon-transient[data-wandcast="figure"]');
    // null (not a falsy-but-truthy object) when not yet mounted -- page.waitForFunction()
    // resolves on ANY truthy return value, and a plain object literal is always truthy even
    // when its own `mounted` field is false, which would otherwise race ahead of the real
    // mount instead of waiting for it.
    if (!fig) return null;
    const sparkCount = document.querySelectorAll('.oc-beacon-transient[data-wandcast="spark-front"]').length;
    const backClipPresent = !!document.querySelector('.oc-beacon-transient[data-wandcast="back-clip"]');
    const figRect = fig.getBoundingClientRect();
    return {
      mounted: true,
      side: fig.getAttribute('data-wc-side'),
      figLeft: fig.style.left,
      figTop: fig.style.top,
      figBox: { left: figRect.left, right: figRect.right, top: figRect.top, bottom: figRect.bottom, width: figRect.width, height: figRect.height },
      sparkCount,
      backClipPresent,
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
      assert.strictEqual(predicted.suppressed, false, 'sanity check: this fixture must not be suppressed');

      const geom = await replay(wandcastSnapshot);
      assert.ok(geom, 'expected a mounted wandcast figure');
      assert.strictEqual(geom.sparkCount, 6, 'expected all 6 sparkle elements to mount (non-vacuous census)');

      // Figure's own document-space left/top.
      const expectedLeft = predicted.side === 'right'
        ? measured.right + GAP + (REACH_INWARD_LOCAL * (predicted.figHeight / VB_H) + 3) - ANCHOR_X * (predicted.figHeight / VB_H)
        : null;
      assert.ok(
        Math.abs(parseFloat(geom.figLeft) - (expectedLeft + scroll.x)) <= 2,
        `figure's style.left (${geom.figLeft}) must include window.scrollX -- expected ~${expectedLeft + scroll.x}px`
      );
      const expectedTop = measured.top + measured.height / 2 - predicted.figHeight / 2 + scroll.y;
      assert.ok(
        Math.abs(parseFloat(geom.figTop) - expectedTop) <= 2,
        `figure's style.top (${geom.figTop}) must include window.scrollY -- expected ~${expectedTop}px`
      );

      // The sparkles' own document-space correctness: read a front sparkle's rendered box at
      // t=0 (paused, right after cast start) against the SAME viewport-space wand-tip formula
      // content.js itself uses. On an unscrolled page the two coordinate spaces coincide
      // (scrollY=0) and this would stay green even with a dropped-scroll bug, which is exactly
      // why this test scrolls the page first.
      const sparkBox = await page.evaluate(() => {
        const spark = document.querySelector('.oc-beacon-transient[data-wandcast="spark-front"]');
        spark.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 460; }); // just after CAST_START=450
        const r = spark.getBoundingClientRect();
        return { left: r.left, top: r.top };
      });
      assert.ok(sparkBox.left > 0 && sparkBox.top > 0, 'sanity check: expected a real rendered sparkle box near the wand tip');

      await clearBeacons();
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('back-arc ghosts share the front sparkles\' own orbit path on a scrolled page (rule 2 regression: a double-added scroll offset)', async () => {
    // backEl is a CHILD of backWrap, and backWrap's own box is already anchored at document
    // (SCROLL_X, SCROLL_Y) -- adding the scroll offset a second time inside backEl's own
    // translate (routing it through the SAME helper frontEl uses) would walk every ghost
    // scrollY/scrollX px further than it should, off the clip-path's own punched hole entirely.
    // Reviewer's own repro measured this at scrollY=1668: front sparkles at viewport y~391-404,
    // ghosts at y~2054-2072 -- one whole scrollY off, and invisible (clipped, since 2054+ is far
    // outside the clip's viewport-sized box) regardless of the clip-path's own correctness.
    await scrollTargetTo('target', 300);
    try {
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 500, `sanity check: page must be scrolled substantially, got scrollY=${scroll.y}`);

      const geom = await replay(wandcastSnapshot);
      assert.ok(geom, 'expected a mounted wandcast figure');
      assert.ok(geom.backClipPresent, 'sanity check: expected the back-clip wrapper to mount');

      const boxes = await page.evaluate(() => {
        const front = document.querySelectorAll('.oc-beacon-transient[data-wandcast="spark-front"]')[0];
        const backWrap = document.querySelector('.oc-beacon-transient[data-wandcast="back-clip"]');
        const back = backWrap.firstElementChild; // same loop index (0) as the front sparkle above
        [front, back].forEach((el) => {
          el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 460; }); // just after CAST_START=450
        });
        const fr = front.getBoundingClientRect();
        const br = back.getBoundingClientRect();
        return { front: { left: fr.left, top: fr.top }, back: { left: br.left, top: br.top } };
      });
      assert.ok(
        Math.abs(boxes.front.left - boxes.back.left) <= 1 && Math.abs(boxes.front.top - boxes.back.top) <= 1,
        `the front sparkle and its own back-arc ghost must render at the SAME viewport-space position (both drive the identical orbit geometry, only the translate space should differ) -- front=${JSON.stringify(boxes.front)}, back=${JSON.stringify(boxes.back)}`
      );

      await clearBeacons();
    } finally {
      await clearBeacons();
      await scrollTargetTo('target', 200);
    }
  });

  test('normal placement: the figure lands on the right by default, clear of #match, and the match DOM is untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const measured = await measure('target');
    const predicted = predict(measured, 1);
    assert.strictEqual(predicted.side, 'right', 'sanity check: fixture must give the right side room');

    const geom = await replay(wandcastSnapshot);
    assert.ok(geom, 'expected a mounted wandcast figure');
    assert.strictEqual(geom.side, 'right', 'default landing must be the right side');
    assert.strictEqual(geom.sparkCount, 6, 'expected all 6 sparkle elements to mount');
    assert.ok(geom.figBox.left >= measured.right, `figure must sit clear of #match's own right edge, got figBox.left=${geom.figBox.left} vs match.right=${measured.right}`);

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

    // Sweeps the WHOLE animation (poses + full sparkle orbit), not just the mount frame.
    await assertNoOcclusionAcrossAnimation('target');

    await clearBeacons();
  });

  test('starting from a genuinely unscrolled page (scrollY=0), Enter still finds and plays the effect correctly, via the extension\'s own scroll-into-view', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    try {
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.strictEqual(scroll.y, 0, 'sanity check: page must start genuinely unscrolled');

      const geom = await replay(wandcastSnapshot);
      assert.ok(geom, 'expected a mounted wandcast figure even from scrollY=0');
      assert.strictEqual(geom.sparkCount, 6, 'expected all 6 sparkle elements to mount');

      await clearBeacons();
    } finally {
      await scrollTargetTo('target', 200);
    }
  });

  test('left fallback (rule 9\'s mirrored branch): when the right side has no room, the figure actually lands on the left, and never occludes the match', async () => {
    await switchToTarget('leftFallbackTarget')();
    try {
      const measured = await measure('leftFallbackTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.sideRightFits, false, 'sanity check: the right side must NOT fit for this fixture');
      assert.strictEqual(predicted.sideLeftFits, true, 'sanity check: the left side must fit -- a genuinely one-sided case');
      assert.strictEqual(predicted.side, 'left');

      const before = await page.evaluate(() => document.getElementById('leftFallbackTarget').outerHTML);
      const geom = await replay(wandcastSnapshot);
      assert.ok(geom, 'expected a mounted wandcast figure');
      assert.strictEqual(geom.side, 'left', 'must land on the left when the right side has no room');
      assert.strictEqual(geom.sparkCount, 6, 'expected all 6 sparkle elements to mount on the mirrored branch too');
      assert.ok(geom.figBox.right <= measured.left, `figure must sit clear of #match's own left edge, got figBox.right=${geom.figBox.right} vs match.left=${measured.left}`);
      const after = await page.evaluate(() => document.getElementById('leftFallbackTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

      // The mirrored wand tip is real: read a front sparkle's box CENTER at t=0 (paused right at
      // cast start) and pin it to the exact mirrored wand-tip formula (predicted.wandTipX/Y,
      // toScreen()'s own reflect-across-figWidth/2 math), not merely "somewhere left of #match".
      // A loose "left of #match" bound stays green even if the mirror math regresses to a bare
      // negation (or is dropped entirely) as long as the launch point still happens to land on
      // the correct side -- reviewer finding: sits within 60px of the wand tip on real content
      // and still reads as "left of match". Center, not box.left/right, because the wand tip is
      // the translate's own target point (centerTranslateDoc subtracts SPARK_HALF).
      const sparkBox = await page.evaluate(() => {
        const spark = document.querySelector('.oc-beacon-transient[data-wandcast="spark-front"]');
        spark.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 460; });
        const r = spark.getBoundingClientRect();
        return { centerX: r.left + r.width / 2, centerY: r.top + r.height / 2 };
      });
      assert.ok(
        Math.abs(sparkBox.centerX - predicted.wandTipX) <= 3,
        `mirrored branch must launch sparkles at the mirrored wand tip's own x (${predicted.wandTipX}), got ${sparkBox.centerX}`
      );
      assert.ok(
        Math.abs(sparkBox.centerY - predicted.wandTipY) <= 3,
        `mirrored branch must launch sparkles at the mirrored wand tip's own y (${predicted.wandTipY}), got ${sparkBox.centerY}`
      );
      assert.ok(
        sparkBox.centerX <= measured.left,
        `sanity check: the mirrored wand tip itself must still sit left of #match, got centerX=${sparkBox.centerX} vs match.left=${measured.left}`
      );

      // transform:scaleX(-1) on the figure wrapper is the mirror mechanism itself.
      const transform = await page.evaluate(() => getComputedStyle(document.querySelector('.oc-beacon-transient[data-wandcast="figure"]')).transform);
      const m = /matrix\(([-\d.,\s]+)\)/.exec(transform);
      assert.ok(m, `expected a matrix(...) transform on the figure wrapper, got "${transform}"`);
      const parts = m[1].split(',').map((s) => parseFloat(s));
      assert.ok(parts[0] < -0.9, `left landing must mirror the figure (matrix a-component negative, scaleX(-1)), got transform "${transform}"`);

      await assertNoOcclusionAcrossAnimation('leftFallbackTarget');

      await clearBeacons();
    } finally {
      await clearBeacons();
      await switchToTarget('target')();
    }
  });

  test('cursor independence (rule 9 exception, oculist-i8zu): moving the mouse elsewhere on the page never moves the sparkles\' own launch point', async () => {
    await scrollTargetTo('target', 200);
    try {
      // Move the cursor to a point that would produce a wildly different start point under
      // animateTrail's own lastMouseX/lastMouseY cascade (far lower-left of the viewport).
      await page.mouse.move(20, 780);

      const before = await page.evaluate(() => {
        const spark = document.querySelector('.oc-beacon-transient[data-wandcast="spark-front"]');
        return spark ? true : null;
      });
      assert.strictEqual(before, null, 'sanity check: no stale sparkle before firing');

      const launchBox = await replay(() => {
        const spark = document.querySelector('.oc-beacon-transient[data-wandcast="spark-front"]');
        if (!spark) return null;
        spark.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 460; });
        const r = spark.getBoundingClientRect();
        return { centerX: r.left + r.width / 2, centerY: r.top + r.height / 2 };
      });
      assert.ok(launchBox, 'expected a mounted sparkle');

      const measured = await measure('target');
      const predicted = predict(measured, 1);
      // Pinned to the exact predicted wand-tip position (the same formula the mirrored-branch
      // test above uses), not merely "somewhere right of #match" -- a loose "> match.right - 20"
      // bound stays green even for a launch point dragged dozens of px toward a cursor-driven
      // start (cursor is at x=20, ~1000+ px away), as long as it happens to still land right of
      // #match.
      assert.ok(
        Math.abs(launchBox.centerX - predicted.wandTipX) <= 3,
        `sparkle's launch point must stay pinned to the figure's own wand tip (${predicted.wandTipX}) regardless of cursor position, got centerX=${launchBox.centerX}`
      );
      assert.ok(
        Math.abs(launchBox.centerY - predicted.wandTipY) <= 3,
        `sparkle's launch point must stay pinned to the figure's own wand tip's y (${predicted.wandTipY}) regardless of cursor position, got centerY=${launchBox.centerY}`
      );

      await clearBeacons();
    } finally {
      await page.mouse.move(200, 120);
    }
  });

  // Per-pixel diff of the match's own rendered rect against a no-effect baseline, sampled at
  // many points across the WHOLE animation (poses + full sparkle orbit, not just the mount
  // frame) by pausing every WAAPI animation and seeking currentTime -- deterministic and fast,
  // unlike a real-time wait. DUR = ORBIT_STOP_T + FADE_DUR + 60 = 1700 + 200 + 60 = 1960ms.
  async function assertNoOcclusionAcrossAnimation(targetId) {
    const clip = await page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }, targetId);
    if (clip.width === 0 || clip.height === 0) return; // nothing painted at all -- vacuous by construction, callers check mounting separately

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
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-wandcast="figure"]'), null, { timeout: POLL_TIMEOUT });

      const SAMPLE_STEP = 100, TOTAL_DUR = 1960;
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

  test('edge case (non-vacuous fallback, oculist-giy7\'s own fix): a wide match at a narrow viewport where NEITHER side fits still renders the figure clear of #match, not suppressed', async () => {
    await page.setViewportSize({ width: 320, height: 900 });
    await switchToTarget('edgeLeftTarget')();
    try {
      const measured = await measure('edgeLeftTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.sideRightFits, false, 'sanity check: sideRight must not fit at this narrow viewport');
      assert.strictEqual(predicted.sideLeftFits, false, 'sanity check: sideLeft must not fit either -- both must fail');
      assert.strictEqual(predicted.suppressed, false, 'sanity check: this fixture must land in the non-suppressed fallback window, not genuine overlap');

      const before = await page.evaluate(() => document.getElementById('edgeLeftTarget').outerHTML);
      const geom = await replay(wandcastSnapshot);
      assert.ok(geom, 'expected a real, non-vacuous render even though neither side fit -- a mutation that always suppresses on "neither fits" must fail this');
      assert.strictEqual(geom.sparkCount, 6, 'expected all 6 sparkle elements to mount (non-vacuous census)');
      assert.strictEqual(geom.side, 'right', 'the fallback lands on sideRight, as content.js\'s own formula defaults');
      assert.ok(
        geom.figBox.left >= measured.right - 1,
        `figure must sit genuinely clear of #match's own right edge even in the fallback case, got figBox.left=${geom.figBox.left} vs match.right=${measured.right}`
      );
      const after = await page.evaluate(() => document.getElementById('edgeLeftTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

      await assertNoOcclusionAcrossAnimation('edgeLeftTarget');

      await clearBeacons();
    } finally {
      await clearBeacons();
      await page.setViewportSize(VIEWPORT);
      await switchToTarget('target')();
    }
  });

  test('wkfc travel-reveal: a sparkle whose wand-tip launch does not itself visually clear #match stays invisible until the sampled travel path first clears it', async () => {
    // edgeLeftTarget at font-size:68px is measured (probe: castStart+1ms opacity keyframes) to
    // put the wand tip within SPARK_VISUAL_REACH of #match's own right edge -- close enough that
    // visualClearsMatch(wandTipScreen, ...) returns false and revealTravelT genuinely engages
    // (revealOffset ~0.052, first opacity:1 keyframe at offset ~0.092). A slightly narrower match
    // (font-size:66px, the "non-vacuous fallback" test's own fixture) sits ~1.3px clear at the
    // wand tip itself and never engages this path at all (revealOffset stays 0) -- 68px is the
    // minimum bump inside the same non-suppressed plateau that actually exercises oculist-wkfc's
    // fix, not just its absence.
    await page.setViewportSize({ width: 320, height: 900 });
    await switchToTarget('edgeLeftTarget')();
    try {
      const measured = await measure('edgeLeftTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.suppressed, false, 'sanity check: this fixture must not be figure-suppressed');

      const geom = await replay(wandcastSnapshot);
      assert.ok(geom, 'expected a mounted wandcast figure');

      const revealOffset = await page.evaluate(() => {
        const spark = document.querySelector('.oc-beacon-transient[data-wandcast="spark-front"]');
        const anims = spark.getAnimations({ subtree: true });
        // The opacity animation has more than 2 explicit keyframes (position has one keyframe
        // per angle checkpoint too, but this fixture's own frontKF is identifiable as the one
        // whose keyframes carry an `opacity` property rather than `transform`).
        const opacityAnim = anims.find((a) => a.effect.getKeyframes()[0].opacity !== undefined);
        const kfs = opacityAnim.effect.getKeyframes();
        const firstVisible = kfs.find((k) => parseFloat(k.opacity) > 0);
        return firstVisible ? firstVisible.offset : null;
      });
      assert.ok(revealOffset !== null, 'sanity check: expected an opacity keyframe with opacity > 0');
      // oculist-wkfc: a mutation that forces revealTravelT to 0 collapses this to ~0.04 (the
      // fixed "reveal almost immediately" offset every OTHER sparkle uses when its wand tip
      // already clears cleanly). The real fix keeps it invisible measurably longer.
      assert.ok(
        revealOffset > 0.07,
        `wkfc's travel-reveal delay must actually engage on this fixture (first visible opacity keyframe expected offset > 0.07), got offset=${revealOffset} -- a mutation forcing revealTravelT=0 would collapse this to ~0.04`
      );

      await clearBeacons();
    } finally {
      await clearBeacons();
      await page.setViewportSize(VIEWPORT);
      await switchToTarget('target')();
    }
  });

  test('rx clearance floor (oculist-mbmy\'s cos(30deg) divisor, oculist-73l6\'s ORBIT_EDGE_MARGIN=18): the sparkle orbit\'s horizontal radius is pinned exactly, not just "roughly clear"', async () => {
    // rxEdgeTarget sits flush against the viewport's own left edge at 320x900 -- narrow enough
    // that rxViewportCap (the viewport-edge clamp) undercuts matchClearanceFloor (the match-edge
    // floor), so the floor -- and therefore its own cos(30deg) divisor and ORBIT_EDGE_MARGIN --
    // is what actually determines rx, not rawRx. Verified by the sanity check below (matchClearanceFloor >
    // min(rawRx, rxViewportCap)), computed from the SAME formula content.js uses (duplicated
    // here, not imported, same discipline as predict() above).
    await page.setViewportSize({ width: 320, height: 900 });
    await switchToTarget('rxEdgeTarget')();
    try {
      const measured = await measure('rxEdgeTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.side, 'right', 'sanity check: fixture must land on the right, unmirrored (THETA0 unmirrored)');
      assert.strictEqual(predicted.suppressed, false, 'sanity check: this fixture must not be figure-suppressed');

      const ecx = measured.left + measured.width / 2;
      const ORBIT_EDGE_MARGIN = 18;
      const rawRx = measured.width / 2 + 22;
      const rxViewportCap = Math.min(ecx - ORBIT_EDGE_MARGIN, (measured.vw - ORBIT_EDGE_MARGIN) - ecx);
      const matchClearanceFloor = measured.width / 2 + ORBIT_EDGE_MARGIN / Math.cos(30 * Math.PI / 180);
      assert.ok(
        matchClearanceFloor > Math.min(rawRx, rxViewportCap),
        `sanity check: this fixture must actually bind the rx FLOOR (${matchClearanceFloor}), not rawRx/cap (${Math.min(rawRx, rxViewportCap)}) -- otherwise this test cannot observe the floor's own formula at all`
      );
      const expectedRx = matchClearanceFloor;
      const expectedX = ecx + expectedRx * Math.cos(30 * Math.PI / 180);

      const geom = await replay(wandcastSnapshot);
      assert.ok(geom, 'expected a mounted wandcast figure');

      // Sparkle index 5 (THETA0_RIGHT[5] = 30deg, the landing angle closest to the horizontal --
      // cos(30deg) is the largest-magnitude cosine among the six landing angles, so this sparkle
      // is the most rx-sensitive one to check) reaches its own landing point -- ellipsePoint(30),
      // i.e. exactly (ecx + rx*cos(30deg), ecy + ry*sin(30deg)) -- at the instant its OWN travel
      // ends: castStart (CAST_START=450 + CAST_STAGGER[5]=230 = 680ms) + TRAVEL_DUR (260ms) =
      // 940ms, at default (normal) Animation Speed.
      const centerX = await page.evaluate(() => {
        const spark = document.querySelectorAll('.oc-beacon-transient[data-wandcast="spark-front"]')[5];
        spark.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 940; });
        const r = spark.getBoundingClientRect();
        return r.left + r.width / 2;
      });
      assert.ok(
        Math.abs(centerX - expectedX) <= 1,
        `sparkle 6's own landing x must match the exact rx floor formula (matchClearanceFloor = width/2 + ORBIT_EDGE_MARGIN/cos(30deg), ORBIT_EDGE_MARGIN=18) -- expected ~${expectedX}, got ${centerX}. Dropping the cos(30deg) divisor (oculist-mbmy) would land ~2.4px off; cutting ORBIT_EDGE_MARGIN from 18 to 12 (oculist-73l6) would land ~6px off.`
      );

      await clearBeacons();
    } finally {
      await clearBeacons();
      await page.setViewportSize(VIEWPORT);
      await switchToTarget('target')();
    }
  });

  // Decodes a PNG screenshot into raw RGBA bytes, the same helper shape assertNoOcclusionAcrossAnimation
  // uses, factored out so the resize test below can take a "clean" baseline and a "live" sample
  // through the same pipeline without duplicating the canvas plumbing.
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

  test('resize hard cut (oculist-3dd8, ported): a mid-orbit resize that reflows #match does not leave the back-arc clip stale during the 100ms debounce window', async () => {
    // content.js's own handleResize() only reaches cancelBeacons() through repositionActiveOverlays(),
    // gated behind a 100ms debounce (overlayResizeTimer) -- so a resize alone, sampled BEFORE that
    // debounce fires, is the exact window where backWrap's static clip-path (still punched at the
    // PRE-resize rect) can go stale against the NOW-reflowed #match. Every WAAPI animation is paused
    // and seeked to a fixed frame before either resize below, so this is a deterministic geometry
    // comparison, not a race against real time.
    let decodePage;
    try {
      decodePage = await ctx.newPage();

      // Baseline: the clean (no effect) appearance of #match AT THE POST-RESIZE geometry --
      // resize first, with nothing running, so this is genuinely "what #match should look like
      // there," not a stale pre-resize snapshot.
      await switchToTarget('resizeTarget')();
      const beforeRect = await measure('resizeTarget');
      await page.setViewportSize({ width: 1184, height: 800 });
      await page.waitForTimeout(200); // let the debounced overlay settle -- this baseline must be genuinely post-transition
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

      // Restore to the pre-resize viewport and fire the effect for real.
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(200);
      const geom = await replay(wandcastSnapshot);
      assert.ok(geom, 'expected a mounted wandcast figure');

      // Freeze every animation at a fixed mid-orbit frame BEFORE resizing, so the comparison
      // below is deterministic regardless of how long the resize + screenshot round trip takes.
      await page.evaluate(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
          el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 900; });
        });
      });

      // The real repro: resize WHILE the (now-frozen) effect is still mounted, then sample
      // immediately -- well inside the 100ms debounce window, before repositionActiveOverlays()
      // ever gets a chance to cancelBeacons().
      await page.setViewportSize({ width: 1184, height: 800 });
      const live = await screenshotRgba(decodePage, clip);

      const delta = maxRgbDelta(baseline, live);
      assert.strictEqual(
        delta, 0,
        `#match must show zero painted-pixel delta immediately after a mid-orbit resize (within the 100ms debounce window) -- got max delta ${delta}. Without the hard cut, the back-arc clip stays punched at the PRE-resize rect while #match has already moved to the POST-resize rect.`
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

  test('resize hard cut, front sparkles (oculist-01sj): a mid-orbit resize that reflows #match leaves zero dirty match pixels, checked at three frames of the orbit', async () => {
    // The test above (1200->1184, an 8px reflow) passes even without oculist-01sj's fix, because
    // this fixture's own front-sparkle clearance budget (20-50px, see the fixture's own
    // #resizeTarget comment) absorbs an 8px shift. A 1200->1160 resize (a 20px reflow -- the
    // reviewer's own repro) does not: unlike backWrap, the front sparkles (data-wandcast=
    // "spark-front") carry no per-effect hard-cut resize listener of their own -- cancelBeacons()
    // was their only teardown path, and content.js's own handleResize() used to reach it solely
    // through the 100ms debounce (overlayResizeTimer), which a continuous drag keeps resetting.
    // Checked at t=900/1100/1500ms (travel-to-landing, mid-orbit, late-orbit) -- the reviewer's
    // own three dirty frames.
    let decodePage;
    const TIMES = [900, 1100, 1500];
    try {
      decodePage = await ctx.newPage();

      await switchToTarget('resizeTarget')();
      const beforeRect = await measure('resizeTarget');
      await page.setViewportSize({ width: 1160, height: 800 });
      await page.waitForTimeout(200); // let the debounced overlay settle -- this baseline must be genuinely post-transition
      const afterRect = await measure('resizeTarget');
      assert.ok(
        Math.abs(afterRect.right - beforeRect.right) > 4,
        `sanity check: the resize must actually move #match, or this test proves nothing (before.right=${beforeRect.right}, after.right=${afterRect.right})`
      );
      const clip = { x: Math.round(afterRect.left), y: Math.round(afterRect.top), width: Math.round(afterRect.width), height: Math.round(afterRect.height) };
      const baseline = await screenshotRgba(decodePage, clip);

      for (const t of TIMES) {
        await page.setViewportSize(VIEWPORT);
        await page.waitForTimeout(200);
        const geom = await replay(wandcastSnapshot);
        assert.ok(geom, `expected a mounted wandcast figure before the t=${t} check`);

        // Freeze every animation at this frame BEFORE resizing, so the comparison below is
        // deterministic regardless of how long the resize + screenshot round trip takes.
        await page.evaluate((freezeT) => {
          document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
            el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = freezeT; });
          });
        }, t);

        // The real repro: resize WHILE the (now-frozen) effect is still mounted, then sample
        // immediately -- well inside the 100ms debounce window.
        await page.setViewportSize({ width: 1160, height: 800 });
        const live = await screenshotRgba(decodePage, clip);

        const delta = maxRgbDelta(baseline, live);
        assert.strictEqual(
          delta, 0,
          `#match must show zero painted-pixel delta immediately after a mid-orbit resize frozen at t=${t}ms -- got max delta ${delta}. Front sparkles have no per-effect hard cut of their own; only handleResize()'s own leading-edge cancelBeacons('.oc-beacon-transient') (oculist-01sj) tears them down before the reflow.`
        );

        await clearBeacons();
      }
    } finally {
      if (decodePage) await decodePage.close();
      await clearBeacons();
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(200);
      await switchToTarget('target')();
    }
  });

  test('edge case (genuine suppression, oculist-giy7\'s own guard): a wide match at a narrow viewport where the clamped painted bounds truly overlap #match suppresses entirely -- zero elements, proven by census', async () => {
    await page.setViewportSize({ width: 320, height: 900 });
    await switchToTarget('edgeRightTarget')();
    try {
      const measured = await measure('edgeRightTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.sideRightFits, false, 'sanity check: sideRight must not fit at this narrow viewport');
      assert.strictEqual(predicted.sideLeftFits, false, 'sanity check: sideLeft must not fit either -- both must fail');
      assert.strictEqual(predicted.suppressed, true, 'sanity check: this fixture must land in the genuine-overlap window');

      const before = await page.evaluate(() => document.getElementById('edgeRightTarget').outerHTML);

      // Cancel any leftover beacon, fire, then wait a real beat -- a suppressed render mounts
      // NOTHING, so there is no element to wait for; poll the DOM directly instead of routing
      // through replay()'s own "wait for figure" predicate, which would hang.
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);

      const census = await page.evaluate(() => ({
        figPresent: !!document.querySelector('.oc-beacon-transient[data-wandcast="figure"]'),
        sparkCount: document.querySelectorAll('.oc-beacon-transient[data-wandcast="spark-front"]').length,
        backClipPresent: !!document.querySelector('.oc-beacon-transient[data-wandcast="back-clip"]'),
        anyBeacon: document.querySelectorAll('.oc-beacon-transient').length,
      }));
      assert.strictEqual(census.figPresent, false, 'a genuinely overlapping placement must suppress the figure entirely');
      assert.strictEqual(census.sparkCount, 0, 'a genuinely overlapping placement must suppress every sparkle too -- no partial render');
      assert.strictEqual(census.backClipPresent, false, 'a genuinely overlapping placement must suppress the back-arc clip layer too');
      assert.strictEqual(census.anyBeacon, 0, 'a genuinely overlapping placement must mount NOTHING at all');

      const after = await page.evaluate(() => document.getElementById('edgeRightTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated, even when the effect suppresses itself');
    } finally {
      await clearBeacons();
      await page.setViewportSize(VIEWPORT);
      await switchToTarget('target')();
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on every element is actually canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-wandcast="figure"]')) return null;
      window.__wcTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__wcTestAnims.length;
    });
    // figure wrap (poseBack 1, poseMid 2, poseCast 1, fade 1) = 5; back-clip wrap (6 sparkles x
    // 2 back-arc animations each) = 12; 6 front sparkles x 2 animations each = 12. Total = 29.
    assert.strictEqual(animCount, 29, `expected 29 live WAAPI animations before cancellation, got ${animCount}`);

    await clearBeacons();

    const states = await page.evaluate(() => window.__wcTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${[...new Set(states)].join(', ')}`);

    await page.evaluate(() => { delete window.__wcTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted, 'sanity check: the effect must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- a genuine leak surfaces as this wait's own TimeoutError.
    // DUR is 1960ms; POLL_TIMEOUT comfortably covers it.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('resize listener leak: the window resize listener hardCutBackWrap() registers is removed after natural completion, and after a cancel -- not just when a resize actually fires', async () => {
    await scrollTargetTo('target', 200);
    const baseline = await countWindowResizeListeners();

    // Natural completion: no resize ever fires, so { once: true } alone never removes the
    // listener -- only the Promise.allSettled(...).then() cleanup does.
    const mounted1 = await replay();
    assert.ok(mounted1, 'sanity check: the effect must actually mount');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    const afterNatural = await countWindowResizeListeners();
    assert.strictEqual(
      afterNatural, baseline,
      `resize listener count must return to baseline (${baseline}) after natural completion with no resize firing, got ${afterNatural}`
    );

    // Cancel mid-animation: destroyBeacon() cancels every __waapiAnims entry, including
    // backWrap's, which settles the cleanup promise immediately -- the listener must come down
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

  test('Lite Mode, set for real through chrome.storage.sync: a no-op -- same rendered geometry and the same animation count in both modes', async () => {
    async function snapshot() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted wandcast figure');
      return page.evaluate(() => {
        const fig = document.querySelector('.oc-beacon-transient[data-wandcast="figure"]');
        const r = fig.getBoundingClientRect();
        return {
          figBox: { w: Math.round(r.width), h: Math.round(r.height) },
          sparkCount: document.querySelectorAll('.oc-beacon-transient[data-wandcast="spark-front"]').length,
          totalAnimCount: Array.from(document.querySelectorAll('.oc-beacon-transient'))
            .reduce((sum, el) => sum + el.getAnimations({ subtree: true }).length, 0),
        };
      });
    }

    await scrollTargetTo('target', 200);
    const full = await snapshot();
    assert.strictEqual(full.totalAnimCount, 29, 'sanity check: full mode must have all 29 animations');
    try {
      await setSettings({ performanceMode: true });
      const lite = await snapshot();
      assert.strictEqual(lite.totalAnimCount, full.totalAnimCount, 'Lite Mode must not drop or add any animation -- this effect has no glow/box-shadow layer to cut beyond the pose swap and sparkle swirl, which are the defining beats');
      assert.strictEqual(lite.sparkCount, full.sparkCount, 'Lite Mode must mount the same 6 sparkles');
      assert.deepStrictEqual(lite.figBox, full.figBox, 'Lite Mode must render the figure at the exact same geometry');
    } finally {
      await setSettings({ performanceMode: false });
      await clearBeacons();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the figure and sparkle RENDERED boxes scale together', async () => {
    async function renderedSizes() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted wandcast figure');
      return page.evaluate(() => {
        const fig = document.querySelector('.oc-beacon-transient[data-wandcast="figure"]');
        const spark = document.querySelector('.oc-beacon-transient[data-wandcast="spark-front"]');
        return { figHeight: fig.getBoundingClientRect().height, sparkWidth: spark.getBoundingClientRect().width };
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
        const expectedSparkWidth = base.sparkWidth * factor;
        assert.ok(
          Math.abs(sized.figHeight - expectedFigHeight) <= 2,
          `Beacon Size ${size}: figure height expected ~${expectedFigHeight}, got ${sized.figHeight}`
        );
        assert.ok(
          Math.abs(sized.sparkWidth - expectedSparkWidth) <= 2,
          `Beacon Size ${size}: sparkle width expected ~${expectedSparkWidth}, got ${sized.sparkWidth}`
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
      assert.strictEqual(keys.indexOf('wandcast'), -1, 'wandcast must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(WANDCAST_EFFECT_ROW).count(),
        0,
        'wandcast must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('wandcast'), -1, 'wandcast must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(WANDCAST_EFFECT_ROW).count(),
        1,
        'wandcast must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'wandcast' (a real, registered
      // -- just currently unavailable -- key), so firing must fall back to some other effect
      // rather than mount the wrapper.
      await setSettings({ effect: 'wandcast', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-wandcast]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the wandcast elements');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Selection restored on re-enable: no explicit re-selection of 'wandcast' here.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-wandcast="figure"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored wandcast selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs -- route
      // through a sentinel value first so both writes are genuine changes regardless of which
      // line above (if any) threw.
      await setSettings({ enabledPacks: ['__oc_wandcast_test_reset__'] });
      await setSettings({ effect: 'wandcast', enabledPacks: ['halloween'] });
    }
  });
});
