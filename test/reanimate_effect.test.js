// Reanimation Jolt beacon effect (oculist-nq1x.8): promotes fxReanimate (artifacts/
// prototypes/effects-playground.html) into extension/content.js as the seventh entry in the
// Halloween pack. A stiff-armed figure lies flanked by two conductor posts, is jolted
// upright by two brief electrode arcs, opens its eyes, holds, then fades.
//
// Two beats carry real defect history and are tested directly, not just documented:
//
// 1. PLACEMENT (right by default, mirrored left ONLY if the right side does not fit, never
//    above/below -- oculist-1ta.22's own close reason independently confirms "only right and
//    left landings, with an explicit never-above/below comment"). The degenerate case --
//    NEITHER side fits -- falls back to sideRight rather than suppressing, unlike Tentacle
//    Rise's both-or-neither pairing; oculist-nq1x.8's own MISSING-REQUIREMENT note flags this
//    as "a scenario to exercise... rather than assume it's safe", so the suite below proves
//    (not assumes) that the fallback stays match-safe by construction: sideRight.x is always
//    rect.right + GAP + REACH_INWARD, so the near edge never moves toward #match regardless
//    of whether the far edge fits inside the viewport.
// 2. FOREARM LEGIBILITY (oculist-1ta.22, re-confirmed at the shipped 40px floor by
//    oculist-20qz/oculist-4v2u): oculist-1ta.22's own original fix paired a geometry change
//    with an "ARM ramp at or below COAT's own ramp" palette rule, but outer-repo commit 2c78974
//    (oculist-20qz) re-derived both ramps from the v2 character sheet and that numeric rule
//    no longer holds (ARM_HI luminance .0837 > COAT_HI .0681) -- it is NOT tested here.
//    What IS tested is the actual current guarantee: both forearms render with real,
//    non-zero screen-space area at the smallest Beacon Size (the 28px floor), so the defect
//    class oculist-1ta.22 first found (a forearm collapsing to nothing) can't return quietly.
//
// Also tested: the G4 flicker gate (WCAG 2.3.1) -- exactly two opacity pulses exist in the
// whole clip, at every Animation Speed the user can pick, since durFactor scales delay and
// duration together rather than adding pulses -- and Lite Mode's specific, stated drop (the
// arc's own glow layer, arcGlow, while the defining two-pulse jolt beat plays identically
// through arcCore in both modes).
//
// Modeled on test/tentaclerise_effect.test.js (fixture/helper shape: real HTTP fixture, CDP
// isolated-world attach, tall-spacer layout, helpers/wait) and test/horseman_effect.test.js /
// test/jackolantern_effect.test.js (Beacon Size / pack-enumeration idioms). Unlike Tentacle
// Rise (which mounts both sides together or neither), this effect mounts exactly one side per
// fire, so the suite below exercises the LEFT-fallback branch with its own dedicated fixture
// rather than a shared both-sides check.
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

// #target: plenty of room on every side, 1600px down the page, for every baseline test
// (document-space, cancellation, natural completion, Lite Mode, Beacon Size, Animation
// Speed, pack enumeration) -- sideRight fits trivially here (measured rect.left ~107,
// rect.width ~99, rect.height 18 at the default 1200-wide viewport).
//
// #leftFallbackTarget: measured (not guessed) at margin-left:1000px against this fixture's
// own 40px body padding, its rect.left lands at EXACTLY 1040 in the default 1200px-wide
// viewport -- content.js's own planReanimate()-equivalent formula (mirrored below in
// predict()) puts sideRight.x + REACH_OUTWARD past vw-4 (no room on the right) while
// sideLeft still fits, a genuinely one-sided case that forces the real mirrored branch
// (LIE's sign flip, landing.side, the figure's own rendered position) rather than merely
// compiling it. No preceding text inside its own div, so nothing shifts its rect.left off
// the div's own content edge; "filler" comes AFTER so it does not affect the match's own box
// (same fixture discipline as tentaclerise_effect.test.js's own #oneOverlapTarget).
//
// #degenerateTarget: the same "match wider than the viewport" technique as
// tentaclerise_effect.test.js's own #edgeTarget -- a 96px font forces the match's own
// rendered width (measured ~382px) past a 320px viewport. Measured at both the default
// 1200px viewport and after resizing to 320px: rect.left stays 40 either way (first content
// in its own paragraph), and at 320px width BOTH sideRight and sideLeft read as
// non-fitting -- the exact degenerate scenario oculist-nq1x.8's own MISSING-REQUIREMENT note
// asks this suite to exercise directly.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<p>filler text <span id="target">wraithmarrow</span></p>
<div style="height:1600px"></div>
<div style="margin-left:1000px;overflow-wrap:anywhere;"><span id="leftFallbackTarget">voltcadaver</span> filler</div>
<div style="height:1000px"></div>
<p style="font-size:96px;"><span id="degenerateTarget">gorgonite</span> filler</p>
<div style="height:1000px"></div>`;

// Search term for each fixture target, used by switchToTarget() below.
const TARGET_TERMS = { target: 'wraithmarrow', leftFallbackTarget: 'voltcadaver', degenerateTarget: 'gorgonite' };

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const REANIMATE_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:reanimate"]';

describe('Reanimation Jolt: a jolted figure rises upright beside the match, flanked by two conductor posts and a pair of electrode arcs', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing -- the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: VIEWPORT,
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

    // scrollBehavior: 'instant' routes every scroll-into-view this suite triggers through
    // content.js's own 'auto' (instant) branch instead of a real multi-hundred-ms native
    // smooth-scroll animation, so settleNavigation() below has a real, short async window
    // to wait out rather than an open-ended one.
    await setSettings({ effect: 'reanimate', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

    await openFinder(page);
    await page.locator(INPUT).type('wraithmarrow', { delay: 30 });
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
    await pg.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
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

  // Same reasoning as tentaclerise_effect.test.js's own settleNavigation(): #target sits
  // 1600px down the page, so navigation triggers content.js's own native smooth
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
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-reanimate]') ? true : null)),
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

  // Mirrors content.js's own animateReanimate() placement formula verbatim (measured and
  // derived exactly the same way, not hand-picked -- the same duplication-in-the-test idiom
  // tentaclerise_effect.test.js's own predict() uses). Used only to PREDICT which side (or
  // neither) should fit, as a sanity check on the fixture itself -- every actual assertion
  // below reads the real rendered DOM, never this prediction alone.
  const VB_W = 70, VB_H = 90;
  const GAP = 10;
  function predict(measured, beaconScale) {
    const figHeight = Math.max(40, Math.min(60, 2.0 * measured.height)) * beaconScale;
    const figWidth = figHeight * (VB_W / VB_H);
    const postW = 7 * beaconScale, postH = 28 * beaconScale, postGap = 9 * beaconScale;
    const postBaseOverhang = 2 * beaconScale, postNeckW = 2 * beaconScale, terminalR = 3 * beaconScale;
    const ARC_CY_FRAC = 0.32;
    const terminalCy = 11 * beaconScale;
    const elecHalfW = figWidth / 2 + postGap + terminalR * 2 + postNeckW + postW + postBaseOverhang;
    const elecTopY = -figHeight + figHeight * ARC_CY_FRAC - terminalCy;
    const elecBottomY = elecTopY + postH;
    const LIE_MAG = 90, STEP1_MAG = 40, OVERSHOOT_MAG = 8;
    const outwardCorners = [
      [figWidth / 2, -figHeight], [-figWidth / 2, -figHeight],
      [elecHalfW, elecTopY], [-elecHalfW, elecTopY],
      [elecHalfW, elecBottomY], [-elecHalfW, elecBottomY],
    ];
    let REACH_OUTWARD = 0;
    outwardCorners.forEach(([x, y]) => { REACH_OUTWARD = Math.max(REACH_OUTWARD, Math.sqrt(x * x + y * y)); });
    REACH_OUTWARD += 2;
    const sweepMin = -OVERSHOOT_MAG, sweepMax = LIE_MAG;
    const topCorners = [[figWidth / 2, -figHeight], [-figWidth / 2, -figHeight]];
    let inwardFig = 0;
    for (let deg = sweepMin; deg <= sweepMax; deg += 1) {
      const rad = deg * Math.PI / 180, cosT = Math.cos(rad), sinT = Math.sin(rad);
      topCorners.forEach(([x, y]) => {
        const xr = x * cosT - y * sinT;
        if (-xr > inwardFig) inwardFig = -xr;
      });
    }
    const REACH_INWARD = Math.max(inwardFig, elecHalfW) + 2;
    const sideRightX = measured.right + GAP + REACH_INWARD;
    const sideRightFits = sideRightX + REACH_OUTWARD <= measured.vw - 4;
    const sideLeftX = measured.left - GAP - REACH_INWARD;
    const sideLeftFits = sideLeftX - REACH_OUTWARD >= 4;
    return {
      sideRightFits, sideLeftFits,
      landingSide: sideRightFits ? 'right' : (sideLeftFits ? 'left' : 'right'),
      figHeight, figWidth, REACH_INWARD, REACH_OUTWARD,
    };
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

  // Reads the real rendered structure in one page-side tick: the wrapper's own inline
  // left/top (rule 2's document-space term), which side actually mounted, and the figure/
  // electrode boxes -- folding presence and geometry into the same predicate avoids the
  // oculist-d5c round-trip hazard every sibling suite documents (a transient element can
  // self-clean between two separate round trips).
  function reanimateSnapshot() {
    const root = document.querySelector('.oc-beacon-transient[data-reanimate]');
    if (!root) return null;
    const figWrap = root.querySelector('[data-rj-figwrap]');
    const elecWrap = root.querySelector('[data-rj-elecwrap]');
    const figRect = figWrap ? figWrap.getBoundingClientRect() : null;
    const elecRect = elecWrap ? elecWrap.getBoundingClientRect() : null;
    return {
      rootLeft: root.style.left,
      rootTop: root.style.top,
      side: figWrap ? figWrap.getAttribute('data-rj-side') : null,
      figBox: figRect && { left: figRect.left, right: figRect.right, top: figRect.top, bottom: figRect.bottom },
      elecBox: elecRect && { left: elecRect.left, right: elecRect.right, top: elecRect.top, bottom: elecRect.bottom },
      arcUnderPresent: !!root.querySelector('[data-rj-part="arc-under"]'),
      arcCorePresent: !!root.querySelector('[data-rj-part="arc-core"]'),
    };
  }

  test('document-space correctness: on a scrolled page, the wrapper carries a real "+ window.scrollX/scrollY" term', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const geom = await replay(reanimateSnapshot);
      assert.ok(geom, 'expected a mounted reanimate wrapper');
      assert.strictEqual(parseFloat(geom.rootLeft), scroll.x, `wrapper left must equal window.scrollX (${scroll.x}), got ${geom.rootLeft}`);
      assert.strictEqual(parseFloat(geom.rootTop), scroll.y, `wrapper top must equal window.scrollY (${scroll.y}), got ${geom.rootTop}`);
      assert.ok(geom.figBox, 'the figure must mount with plenty of room');
      assert.ok(geom.elecBox, 'the electrode posts must mount with plenty of room');

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('normal placement: the figure lands on the right by default, vertically centered on the match, and the match DOM is untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const measured = await measure('target');
    const predicted = predict(measured, 1);
    assert.strictEqual(predicted.landingSide, 'right', 'sanity check: fixture must give the right side room');

    const geom = await replay(reanimateSnapshot);
    assert.ok(geom, 'expected a mounted reanimate wrapper');
    assert.strictEqual(geom.side, 'right', 'default landing must be the right side');
    assert.ok(geom.figBox.left >= measured.right, `figure must sit clear of #match's own right edge, got figBox.left=${geom.figBox.left} vs match.right=${measured.right}`);

    // The figure never covers the word from above or below (rule of the promotion
    // contract): the figure's own UNROTATED pivot (top + height, read from the wrapper's
    // own inline style rather than getBoundingClientRect(), which is currently skewed by
    // the still-"lying" 90deg rotation the figure is held at before JERK_DELAY elapses)
    // sits at the match's own vertical centre, never above rect.top or below rect.bottom.
    // figWrap.style.top/height are wrapper-LOCAL viewport-space values (rule 2: only the
    // outer reanimateWrap itself carries the +scrollX/scrollY document-space term), the
    // same space measure()'s own getBoundingClientRect() reads are in -- so this compares
    // directly against measured.top/height with no scroll term needed on either side.
    const pivot = await page.evaluate(() => {
      const el = document.querySelector('[data-rj-figwrap]');
      return parseFloat(el.style.top) + parseFloat(el.style.height);
    });
    const matchMidY = measured.top + measured.height / 2;
    assert.ok(Math.abs(pivot - matchMidY) < 2, `figure's own unrotated pivot must sit at the match's vertical centre (${matchMidY}), got ${pivot}`);

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM (#target outerHTML) must never be mutated by this effect');

    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('starting from a genuinely unscrolled page (scrollY=0), Enter still finds and plays the effect correctly, via the extension\'s own scroll-into-view', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    assert.strictEqual(scrollBefore, 0, 'sanity check: page must start genuinely unscrolled');

    const geom = await replay(reanimateSnapshot);
    assert.ok(geom, 'expected a mounted reanimate wrapper after the page auto-scrolled the match into view');
    assert.ok(geom.figBox, 'the figure must mount once the match settles into view');
    assert.ok(geom.elecBox, 'the electrode posts must mount once the match settles into view');

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  test('left fallback: the mirrored branch is real, not just compiled -- when the right side has no room, the figure lands on the left, rotates the mirrored direction, and never occludes the match', async () => {
    await switchToTarget('leftFallbackTarget')();
    try {
      const before = await page.evaluate(() => document.getElementById('leftFallbackTarget').outerHTML);

      const preFire = await measure('leftFallbackTarget');
      const predicted = predict(preFire, 1);
      assert.strictEqual(predicted.sideRightFits, false, `sanity check: the right side must NOT fit for this fixture, got rect.right=${preFire.right} vw=${preFire.vw}`);
      assert.strictEqual(predicted.sideLeftFits, true, 'sanity check: the left side must fit -- this must be a genuinely one-sided case');
      assert.strictEqual(predicted.landingSide, 'left');

      // Reads #match's OWN rect in the SAME page-side tick as the mount check -- "at fire
      // time", not from the pre-fire measurement above -- so an unanticipated scroll/reflow
      // would show up as a loud sanity-check failure rather than a silently vacuous pass.
      const result = await replay(() => {
        const root = document.querySelector('.oc-beacon-transient[data-reanimate]');
        if (!root) return null;
        const figWrap = root.querySelector('[data-rj-figwrap]');
        const elecWrap = root.querySelector('[data-rj-elecwrap]');
        if (!figWrap || !elecWrap) return null;
        const r = document.getElementById('leftFallbackTarget').getBoundingClientRect();
        const figRect = figWrap.getBoundingClientRect();
        const elecRect = elecWrap.getBoundingClientRect();
        return {
          fireLeft: r.left, fireRight: r.right, vw: window.innerWidth,
          side: figWrap.getAttribute('data-rj-side'),
          transform: getComputedStyle(figWrap).transform,
          figRight: figRect.right, elecRight: elecRect.right,
        };
      });
      assert.ok(result, 'expected a mounted reanimate wrapper');
      assert.strictEqual(result.side, 'left', 'landing must be the left side for this fixture');

      const predictedFireTime = predict({ left: result.fireLeft, right: result.fireRight, height: preFire.height, vw: result.vw }, 1);
      assert.strictEqual(predictedFireTime.landingSide, 'left', 'fire-time sanity check: the left landing must still be predicted at the exact rect fired');

      // Occlusion safety: the figure and electrode boxes must stay clear of #match's own
      // LEFT edge (they sit to the left of it), never invading the match rectangle.
      assert.ok(result.figRight <= result.fireLeft + 1, `figure must sit clear of #match's own left edge, got figRight=${result.figRight} vs match.left=${result.fireLeft}`);
      assert.ok(result.elecRight <= result.fireLeft + 1, `electrode posts must sit clear of #match's own left edge, got elecRight=${result.elecRight} vs match.left=${result.fireLeft}`);

      // The mirrored branch is real: a 2D rotate(deg) transform is matrix(cos,sin,-sin,cos,0,0);
      // the LEFT landing uses LIE=-90deg (sin=-1, matrix[1]<0) while a RIGHT landing (see the
      // "normal placement" test above) uses LIE=+90deg (sin=+1, matrix[1]>0) -- opposite signs,
      // not merely "some rotation".
      const m = /matrix\(([-\d.,\s]+)\)/.exec(result.transform);
      assert.ok(m, `expected a matrix(...) transform on the figure wrapper, got "${result.transform}"`);
      const parts = m[1].split(',').map((s) => parseFloat(s));
      assert.ok(parts[1] < -0.9, `left landing must rotate the mirrored direction (matrix b-component negative, LIE=-90deg), got transform "${result.transform}"`);

      const after = await page.evaluate(() => document.getElementById('leftFallbackTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await switchToTarget('target')();
    }
  });

  test('degenerate fallback (neither side fits): an extreme narrow-viewport/wide-match scenario still lands on the right and never occludes the match', async () => {
    await switchToTarget('degenerateTarget')();
    await page.setViewportSize({ width: 320, height: 900 });
    // Let the resize debounce settle (content.js's own 100ms overlayResizeTimer) before
    // replaying -- scrollTargetTo()/measure() below are just page.evaluate() reads, fast
    // enough that without this wait the trailing repositionActiveOverlays() ->
    // cancelBeacons() can still fire AFTER replay()'s own fresh beacon mounts, tearing it
    // down mid-flight (oculist-f7vx).
    await page.waitForTimeout(200);
    try {
      await scrollTargetTo('degenerateTarget', 100);
      const before = await page.evaluate(() => document.getElementById('degenerateTarget').outerHTML);

      const measured = await measure('degenerateTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.sideRightFits, false, 'sanity check: the right side must NOT fit in this scenario');
      assert.strictEqual(predicted.sideLeftFits, false, 'sanity check: the left side must NOT fit either -- this must be the genuinely degenerate case');
      assert.strictEqual(predicted.landingSide, 'right', 'sanity check: the fallback formula itself defaults to the right side');

      const result = await replay(() => {
        const root = document.querySelector('.oc-beacon-transient[data-reanimate]');
        if (!root) return null;
        const figWrap = root.querySelector('[data-rj-figwrap]');
        const elecWrap = root.querySelector('[data-rj-elecwrap]');
        if (!figWrap || !elecWrap) return null;
        const r = document.getElementById('degenerateTarget').getBoundingClientRect();
        const figRect = figWrap.getBoundingClientRect();
        const elecRect = elecWrap.getBoundingClientRect();
        return {
          fireLeft: r.left, fireRight: r.right,
          side: figWrap.getAttribute('data-rj-side'),
          figLeft: figRect.left, elecLeft: elecRect.left,
        };
      });
      assert.ok(result, 'expected a mounted reanimate wrapper even in the degenerate case');
      assert.strictEqual(result.side, 'right', 'the degenerate fallback lands on the right, as content.js\'s own formula defaults');

      // THE FLAGGED GAP, RESOLVED: even though neither side "fits" the viewport, the near
      // (inward) edge of both the figure and the electrode posts stays clear of #match's own
      // right edge -- occlusion safety is a property of REACH_INWARD, independent of whether
      // the far (outward) edge bleeds past the browser window's own edge.
      assert.ok(result.figLeft >= result.fireRight - 1, `figure must not occlude #match even in the degenerate case, got figLeft=${result.figLeft} vs match.right=${result.fireRight}`);
      assert.ok(result.elecLeft >= result.fireRight - 1, `electrode posts must not occlude #match even in the degenerate case, got elecLeft=${result.elecLeft} vs match.right=${result.fireRight}`);

      const after = await page.evaluate(() => document.getElementById('degenerateTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect, even in the degenerate case');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.setViewportSize(VIEWPORT);
      await switchToTarget('target')();
    }
  });

  test('forearm legibility at the smallest Beacon Size (oculist-1ta.22/oculist-20qz): both forearms render with real, non-vanishing screen-space area at the shipped 28px floor (40px x 0.7 beaconScale), not just at playground size', async () => {
    // "Re-check them at the shipped getBeaconScale() range, not at playground size --
    // this defect class returns quietly" (oculist-nq1x.8's own effect-specific note).
    // Reads each forearm's own rendered getBoundingClientRect() at the smallest size the
    // user can pick -- exact SVG geometry, not a screenshot pixel-color scan, which (measured
    // directly) turns out too noisy at this size: antialiasing on the SURROUNDING shapes
    // (hair, skin outline, coat outline) blends toward the same dark, low-saturation
    // neighbourhood as ARM_BASE/ARM_HI/ARM_SHADOW within any tolerance loose enough to
    // survive antialiasing at all, so a global pixel-color count cannot tell "the forearm
    // rendered" from "something else nearby happened to blend close to that color". A
    // zero-area path (this test's own red-proof mutation) still yields a nonzero
    // getBoundingClientRect() width/height ONLY if some other geometry occupies that exact
    // rect, which real SVG geometry does not do here, so this is the decisive check.
    await scrollTargetTo('target', 200);
    try {
      await setVisionSettings({ beaconSize: 's' });
      await replay();

      const boxes = await page.evaluate(() => {
        const root = document.querySelector('.oc-beacon-transient[data-reanimate]');
        root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1600; });
        const left = document.querySelector('[data-rj-part="forearm-left"]').getBoundingClientRect();
        const right = document.querySelector('[data-rj-part="forearm-right"]').getBoundingClientRect();
        return {
          left: { width: left.width, height: left.height, area: left.width * left.height },
          right: { width: right.width, height: right.height, area: right.width * right.height },
        };
      });

      const MIN_AREA = 3; // px^2 -- comfortably above 0, comfortably below the real ~30-40px^2 this shape renders at the 28px floor
      assert.ok(boxes.left.area >= MIN_AREA, `left forearm must render with real screen-space area at the 28px floor, got ${JSON.stringify(boxes.left)}`);
      assert.ok(boxes.right.area >= MIN_AREA, `right forearm must render with real screen-space area at the 28px floor, got ${JSON.stringify(boxes.right)}`);

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
    }
  });

  test('G4 flicker gate (WCAG 2.3.1): exactly two opacity pulses exist on the arc core, at every Animation Speed the user can pick', async () => {
    async function pulseCount() {
      await replay();
      return page.evaluate(() => {
        const core = document.querySelector('[data-rj-part="arc-core"]');
        return core ? core.getAnimations().length : -1;
      });
    }

    await scrollTargetTo('target', 200);
    let currentSpeed = 'normal';
    try {
      const base = await pulseCount();
      assert.strictEqual(base, 2, `expected exactly 2 pulse animations on the arc core at normal speed, got ${base}`);

      for (const speed of ['fast', 'slow']) {
        currentSpeed = speed;
        await setVisionSettings({ animationSpeed: speed });
        const count = await pulseCount();
        assert.strictEqual(count, 2, `Animation Speed ${speed}: pulse count must stay 2, never more or fewer, got ${count}`);
      }
    } finally {
      if (currentSpeed !== 'normal') {
        await setVisionSettings({ animationSpeed: 'normal' });
      }
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on every element is actually canceled', async () => {
    await scrollTargetTo('target', 200);
    // Folds the presence check AND the animation-collection into replay()'s own predicate
    // (oculist-d5c's own round-trip hazard) -- window.__rjTestAnims is stashed in the SAME
    // page-side tick that proves the wrapper mounted.
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-reanimate]')) return null;
      window.__rjTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__rjTestAnims.length;
    });
    // elecWrap (appear, fade-out) = 2; arcCore (2 pulses) = 2; arcGlow (2 pulses, full mode)
    // = 2; figWrap (appear-to-dim, jerk-rotate, dim-to-full, fade-out) = 4; glintL/glintR
    // (1 each) = 2. Total = 12 in full (non-Lite) mode.
    assert.strictEqual(animCount, 12, `expected 12 live WAAPI animations before cancellation, got ${animCount}`);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

    const states = await page.evaluate(() => window.__rjTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${[...new Set(states)].join(', ')}`);

    await page.evaluate(() => { delete window.__rjTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted, 'sanity check: the wrapper must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- a genuine leak surfaces as this wait's own
    // TimeoutError. DUR is 2330ms; POLL_TIMEOUT comfortably covers it.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: drops the arc\'s own glow layer (arcGlow) while the defining two-pulse jolt beat (arcCore) and the figure\'s full motion stay identical', async () => {
    async function snapshot() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted reanimate wrapper');
      return page.evaluate(() => {
        const figWrap = document.querySelector('[data-rj-figwrap]');
        const elecWrap = document.querySelector('[data-rj-elecwrap]');
        return {
          figBox: (() => { const r = figWrap.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
          elecBox: (() => { const r = elecWrap.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
          arcUnderPresent: !!document.querySelector('[data-rj-part="arc-under"]'),
          arcCorePresent: !!document.querySelector('[data-rj-part="arc-core"]'),
          totalAnimCount: Array.from(document.querySelectorAll('.oc-beacon-transient'))
            .reduce((sum, el) => sum + el.getAnimations({ subtree: true }).length, 0),
        };
      });
    }

    await scrollTargetTo('target', 200);
    const full = await snapshot();
    assert.strictEqual(full.arcUnderPresent, true, 'sanity check: full mode must render the glow layer');
    assert.strictEqual(full.totalAnimCount, 12, 'sanity check: full mode must have all 12 animations');
    try {
      await setSettings({ performanceMode: true });
      const lite = await snapshot();
      assert.strictEqual(lite.arcUnderPresent, false, 'Lite Mode must drop the arc\'s own glow layer (arc-under)');
      assert.strictEqual(lite.arcCorePresent, true, 'Lite Mode must keep the arc\'s core flash (arc-core) -- the effect\'s defining beat');
      assert.strictEqual(lite.totalAnimCount, 10, 'Lite Mode must drop exactly the glow layer\'s 2 pulse animations (12 -> 10)');
      assert.deepStrictEqual(lite.figBox, full.figBox, 'Lite Mode must render the figure at the exact same geometry');
      assert.deepStrictEqual(lite.elecBox, full.elecBox, 'Lite Mode must render the electrode posts at the exact same geometry');
    } finally {
      await setSettings({ performanceMode: false });
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the figure and electrode RENDERED boxes scale together', async () => {
    async function renderedSizes() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted reanimate wrapper');
      return page.evaluate(() => {
        const figWrap = document.querySelector('[data-rj-figwrap]');
        const elecWrap = document.querySelector('[data-rj-elecwrap]');
        return { figHeight: figWrap.getBoundingClientRect().height, elecWidth: elecWrap.getBoundingClientRect().width };
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
        const expectedElecWidth = base.elecWidth * factor;
        assert.ok(
          Math.abs(sized.figHeight - expectedFigHeight) <= 2,
          `Beacon Size ${size}: figure height expected ~${expectedFigHeight}, got ${sized.figHeight}`
        );
        assert.ok(
          Math.abs(sized.elecWidth - expectedElecWidth) <= 2,
          `Beacon Size ${size}: electrode width expected ~${expectedElecWidth}, got ${sized.elecWidth}`
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
    // fire AFTER replay()'s own fresh beacon mounts, tearing it down mid-flight (oculist-f7vx).
    await page.waitForTimeout(200);
    try {
      await scrollTargetTo('target', 100);

      const before = await page.evaluate(() => document.getElementById('target').outerHTML);

      const boxes = await replay(() => {
        const root = document.querySelector('.oc-beacon-transient[data-reanimate]');
        if (!root) return null;
        const vw = window.innerWidth, vh = window.innerHeight;
        const nodes = Array.from(root.querySelectorAll('[data-rj-figwrap], [data-rj-elecwrap]'));
        return nodes.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw, vh };
        });
      });
      assert.ok(boxes, 'expected a mounted reanimate wrapper even at a tiny viewport');
      assert.ok(boxes.length > 0, 'sanity check: at least one piece must render even at a tiny viewport');

      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect, even at a tiny viewport');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.setViewportSize(VIEWPORT);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
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
      assert.strictEqual(keys.indexOf('reanimate'), -1, 'reanimate must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(REANIMATE_EFFECT_ROW).count(),
        0,
        'reanimate must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('reanimate'), -1, 'reanimate must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(REANIMATE_EFFECT_ROW).count(),
        1,
        'reanimate must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'reanimate' (a real,
      // registered -- just currently unavailable -- key), so firing must fall back to some
      // other effect rather than mount the wrapper.
      await setSettings({ effect: 'reanimate', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-reanimate]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the reanimate wrapper');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Selection restored on re-enable: no explicit re-selection of 'reanimate' here.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-reanimate]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored reanimate selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs -- route
      // through a sentinel value first so both writes are genuine changes regardless of
      // which line above (if any) threw.
      await setSettings({ enabledPacks: ['__oc_reanimate_test_reset__'] });
      await setSettings({ effect: 'reanimate', enabledPacks: ['halloween'] });
    }
  });
});
