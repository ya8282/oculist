// Tentacle Rise beacon effect (oculist-nq1x.7): promotes fxTentacleRise (artifacts/
// prototypes/effects-playground.html, the oculist-ke53 tentacles-v2 redraw integrated by
// oculist-4k8y) into extension/content.js as the sixth entry in the Halloween pack. Two
// tentacles rise from a hidden waterline just below the match's own line, curl their tips
// inward like a pair of brackets around the word, a small dark dome with a pair of
// chartreuse eyes opens beneath it, blinks once, then everything uncurls and sinks back
// out of sight.
//
// oculist-8qrc's amendment to this bead corrects the effect-specific notes: there is no
// below-fallback (tentacles always rise from below, there is no other side to fall back
// to). The two real placement risks this suite targets directly are (a) LEFT/RIGHT edge
// overlap -- either tentacle overlapping #match suppresses BOTH together, never a lone
// surviving limb (the exact G6 collision with Vine Swing oculist-1ta.24's own
// reviewer-retry found and fixed) and (b) the VIEWPORT-BOTTOM edge case, which suppresses
// only the dome+eyes beat, independently of the tentacles, which still rise/curl/sink in
// full.
//
// Modeled on test/trail_effect.test.js (fixture/helper shape: real HTTP fixture, CDP
// isolated-world attach, tall-spacer layout, helpers/wait) and test/horseman_effect.test.js
// / test/jackolantern_effect.test.js (Beacon Size / pack-enumeration idioms -- the
// character-effect precedent this effect follows architecturally, unlike Trail's own
// cursor-to-match travel).
//
// Needs a real browser for the same reasons as those: WAAPI, clip-path and real layout
// only exist in real Chromium, and Lite Mode/Beacon Size/pack toggles only exist for real
// through chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition, waitForOverlayResizeSettled } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target: plenty of room on every side, with generous scrollable space both before and
// after it so every test below can scroll it to a PRECISE position (top offset or bottom
// offset from the viewport edge) rather than assuming "unscrolled" means "visible" --
// its own absolute position is 1600px down the page, deliberately far from both the top
// and bottom of the document.
// #edgeTarget: a huge 96px font forces its own rendered width (measured ~382px) past a
// 320px viewport -- the exact "the match itself is wider than the viewport" edge-placement
// scenario oculist-1ta.24's own close reason describes, the one case this geometry still
// suppresses.
// #oneOverlapTarget: measured, not guessed -- margin-left:-28.5px against this fixture's
// own 40px body padding lands its rect.left at EXACTLY 11.5px, and its own font-size:96px
// forces figHeight to the 72px clamp (scale=1), the same derivation the "one-sided overlap"
// test below verifies against content.js's own planTentacle() formula. At rect.left=11.5,
// with vw=1200, the LEFT tentacle's clamped far edge is 11.291105449407574 -- inside
// #match's own left edge without STROKE_BULGE, and 0.7px OUTSIDE it (11.991...) with it, so
// this ONE placement is the exact boundary the promotion contract's STROKE_BULGE term (see
// oculist-tlg2) decides, while the RIGHT tentacle has the whole rest of a 1200px viewport
// and never overlaps regardless -- a genuinely one-sided case, unlike the already-two-sided
// #edgeTarget above (oculist-nq1x.7's own review round 1 finding: #edgeTarget's rect is
// wider than ANY viewport that fits it, so it overlaps on both sides and cannot
// distinguish the paired suppression rule from suppressing each side independently). No
// preceding text inside its own div, so nothing shifts its rect.left off the div's own
// content edge; "filler" comes AFTER so it does not affect the match's own box.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<p>filler text <span id="target">quarklet</span></p>
<div style="height:1600px"></div>
<p style="font-size:96px;">filler <span id="edgeTarget">gorgonite</span></p>
<div style="height:1000px"></div>
<div style="margin-left:-28.5px;font-size:96px;"><span id="oneOverlapTarget">krakenpod</span> filler</div>
<div style="height:1000px"></div>`;

// Search term for each fixture target, used by switchToTarget() below.
const TARGET_TERMS = { target: 'quarklet', edgeTarget: 'gorgonite', oneOverlapTarget: 'krakenpod' };

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const TENTACLERISE_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:tentaclerise"]';

describe('Tentacle Rise: a pair of tentacles rise from below the match, curl inward, and a dome of eyes opens beneath it', () => {
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

    // scrollBehavior: 'instant' (a real, user-selectable setting -- see
    // test/instant_scroll_close_reopen_no_stale_draw.test.js) routes every scroll-into-view
    // this suite triggers through content.js's own 'auto' (instant) branch instead of a
    // real multi-hundred-ms native smooth-scroll animation, so settleNavigation() below has
    // a real, short async window to wait out rather than an open-ended one.
    await setSettings({ effect: 'tentaclerise', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

    await openFinder(page);
    await page.locator(INPUT).type('quarklet', { delay: 30 });
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

  // #target sits 1600px down the page, so the FIRST match found (while typing, or after a
  // switchToTarget()/viewport resize changes what "in viewport" means) triggers content.js's
  // own native smooth scroll-into-view (highlightActiveRange(), extension/content.js) before
  // its own animate() ever fires -- real wall-clock browser scroll animation, unrelated to
  // what any test here proves, and (same failure family as oculist-d5c's round-trip hazard,
  // one step earlier) a manual window.scrollTo()/measurement made before it settles races that
  // native scroll and can silently be overridden by it a moment later. Wait for the native
  // 'scrollend' event (falling back to content.js's own 600ms onScrollEnd ceiling, plus
  // margin, if 'scrollend' never fires because nothing needed to scroll) AND for any beacon
  // that settle triggered to finish naturally, so every test below starts from a fully
  // quiescent state instead of racing it.
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
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-tentaclerise]') ? true : null)),
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
  // deterministic positioning from the element's real measured document position, rather
  // than assuming any particular scroll state means "visible" (this fixture deliberately
  // keeps #target far from both the top and bottom of the document).
  async function scrollTargetTo(id, topOffset) {
    const docTop = await page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return r.top + window.scrollY;
    }, id);
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, docTop - topOffset));
  }

  // Scrolls so #id's own BOTTOM lands `gap` px above the viewport's bottom edge -- used to
  // land squarely inside or outside the dome's own DOME_H+DOME_MARGIN suppression band.
  async function scrollTargetBottomTo(id, gap) {
    const docBottom = await page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return r.bottom + window.scrollY;
    }, id);
    const vh = await page.evaluate(() => window.innerHeight);
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, docBottom - vh + gap));
  }

  // Mirrors content.js's own planTentacle()/domeVisible formula verbatim (see
  // oculist-tlg2/oculist-4k8y for the derivation of REACH_MIN_X/REACH_MAX_X, MARGIN,
  // STROKE_BULGE, EDGE_ALLOW -- the same duplication-in-the-test idiom
  // jackolantern_effect.test.js's own expectedPlacement() uses for its CAV/PAINT/CLEAR
  // constants). Used only to PREDICT which scenario below should suppress which piece, as
  // a sanity check on the fixture itself -- every actual assertion reads the real rendered
  // DOM, never this prediction alone.
  const VB_W = 36, VB_H = 72;
  const MARGIN = 2, STROKE_BULGE = 0.7, EDGE_ALLOW = 20;
  const DOME_H_BASE = 18, DOME_MARGIN = 4;

  // REACH_MIN_X/REACH_MAX_X are DERIVED in content.js (PAINT_X, from the ribbon/shadow/
  // highlight/sucker geometry across all three poses), not hand-picked -- so this test
  // derives them the identical way, verbatim from content.js's own SPINE_*/POSE_ART/
  // ribbonPoints()/PAINT_X, rather than hard-coding the two resulting numbers where they
  // could silently drift out of sync with a future redraw of the art.
  const SPINE_RISE = [[15, 72], [15, 58], [14, 43], [14.5, 28], [16, 14], [18.5, 3]];
  const SPINE_CURL_HALF = [[15, 72], [15, 58], [15.5, 43], [18, 29], [22, 18], [26, 11], [28, 9.5], [28.5, 12]];
  const SPINE_CURL_FULL = [[15, 72], [15, 58], [16, 43], [19, 29], [23, 18], [26.5, 11], [27.8, 7], [27, 4], [23.5, 3], [21, 5]];
  const BASE_W = 12, TIP_W = 4.5;
  function ribbonPoints(spine, baseW, tipW) {
    const n = spine.length;
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const w = baseW + (tipW - baseW) * (i / (n - 1));
      const p = spine[i];
      const prev = spine[Math.max(0, i - 1)];
      const next = spine[Math.min(n - 1, i + 1)];
      const dx = next[0] - prev[0], dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      left.push([p[0] + nx * w / 2, p[1] + ny * w / 2]);
      right.push([p[0] - nx * w / 2, p[1] - ny * w / 2]);
    }
    return left.concat(right.reverse());
  }
  const POSE_ART = [
    {
      spine: SPINE_RISE, suckers: [],
      shadow: [[15, 72], [16.2, 58], [16.1, 43], [16.8, 28], [18.3, 14], [20.3, 4.2], [20.7, 5.4], [19.2, 16], [18.7, 29], [18.6, 43], [19.1, 58], [21, 72]],
      highlight: [[10.2, 69], [10.8, 57], [11, 44], [11.7, 31], [13, 18], [15.7, 7], [17, 6], [15.5, 18], [14.3, 31], [13.8, 44], [13.7, 57], [13.5, 69]]
    },
    {
      spine: SPINE_CURL_HALF,
      suckers: [[25.6, 13, 2.1, 3, -35], [21.7, 19.2, 2.1, 3, -35], [18.7, 27.2, 2.1, 3, -22]],
      shadow: [[15, 72], [16.2, 58], [17, 43], [19.3, 30], [23.4, 20], [27, 14], [29.7, 11.4], [29.1, 14], [26, 16.3], [22.6, 22], [20.4, 31], [19.5, 44], [19.2, 58], [21, 72]],
      highlight: [[10.2, 69], [10.8, 57], [11.4, 44], [13.1, 31], [16, 21], [20.4, 13.8], [24.8, 9.5], [26.1, 9.2], [22, 14.4], [18, 22], [15.4, 32], [14, 45], [13.6, 58], [13.5, 69]]
    },
    {
      spine: SPINE_CURL_FULL,
      suckers: [[27.1, 10.2, 2.1, 3, -55], [23.8, 16.8, 2.1, 3, -42], [20.6, 23.5, 2.1, 3, -30], [18.2, 32, 2.1, 3, -15]],
      shadow: [[15, 72], [16.2, 58], [17.6, 43], [20.5, 30], [24.5, 20], [28.1, 14], [30.4, 9], [30.2, 6.6], [28.9, 4.8], [27.6, 5.2], [28.3, 7.4], [27.1, 11.3], [23.4, 18.4], [21.1, 25], [19.5, 32], [19.3, 44], [19.2, 58], [21, 72]],
      highlight: [[10.2, 69], [10.8, 57], [11.8, 44], [14.1, 31], [17.3, 21], [21.5, 13], [25.4, 7.4], [27.3, 5.4], [27.8, 4.8], [25.3, 5.6], [21.1, 11], [17.3, 19], [14.8, 30], [13.8, 44], [13.6, 58], [13.5, 69]]
    }
  ];
  POSE_ART.forEach((art) => { art.body = ribbonPoints(art.spine, BASE_W, TIP_W); });
  const PAINT_X = (() => {
    const xs = [];
    POSE_ART.forEach((art) => {
      art.body.concat(art.shadow, art.highlight).forEach((p) => xs.push(p[0]));
      art.suckers.forEach((s) => {
        const a = s[4] * Math.PI / 180;
        const xr = Math.hypot(s[2] * Math.cos(a), s[3] * Math.sin(a));
        xs.push(s[0] - xr, s[0] + xr);
      });
    });
    return { min: Math.min(...xs), max: Math.max(...xs) };
  })();
  const REACH_MIN_X = PAINT_X.min, REACH_MAX_X = PAINT_X.max;

  // `bulge` defaults to the real STROKE_BULGE (0.7) -- overridden only by the mutation
  // red-proof below (bulge:0), never by any scenario-sanity-check call, so a mistaken call
  // site can't silently stop exercising the real constant.
  function predict(measured, beaconScale, bulge) {
    const strokeBulge = bulge === undefined ? STROKE_BULGE : bulge;
    const figHeight = Math.max(46, Math.min(72, 2.1 * measured.height)) * beaconScale;
    const scale = figHeight / VB_H;
    const figWidth = VB_W * scale;
    function overlaps(mirrored) {
      const reachLocal = mirrored ? (VB_W - REACH_MAX_X) : REACH_MAX_X;
      const farLocal = mirrored ? (VB_W - REACH_MIN_X) : REACH_MIN_X;
      const idealLeft = mirrored
        ? (measured.right + MARGIN - reachLocal * scale)
        : (measured.left - MARGIN - reachLocal * scale);
      const clampedLeft = Math.max(-EDGE_ALLOW, Math.min(measured.vw + EDGE_ALLOW - figWidth, idealLeft));
      const near = clampedLeft + Math.min(reachLocal, farLocal) * scale;
      const far = clampedLeft + Math.max(reachLocal, farLocal) * scale;
      return near - strokeBulge < measured.right && far + strokeBulge > measured.left;
    }
    const domeH = DOME_H_BASE * beaconScale;
    const leftOverlaps = overlaps(false);
    const rightOverlaps = overlaps(true);
    return {
      leftOverlaps,
      rightOverlaps,
      tentaclesSuppressed: leftOverlaps || rightOverlaps,
      domeVisible: (measured.bottom + domeH + DOME_MARGIN) <= measured.vh,
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
  // left/top (rule 2's document-space term), which tentacle sides actually mounted, and
  // whether the dome mounted -- folding presence and geometry into the same predicate
  // avoids the oculist-d5c round-trip hazard every sibling suite documents (a transient
  // element can self-clean between two separate round trips).
  function tentacleSnapshot() {
    const root = document.querySelector('.oc-beacon-transient[data-tentaclerise]');
    if (!root) return null;
    const tentacles = Array.from(root.querySelectorAll('[data-tr-tentacle]'));
    const dome = root.querySelector('[data-tr-dome-wrap]');
    return {
      rootLeft: root.style.left,
      rootTop: root.style.top,
      tentacleCount: tentacles.length,
      tentacleSides: tentacles.map((t) => t.getAttribute('data-tr-tentacle')).sort(),
      domePresent: !!dome,
    };
  }

  test('document-space correctness: on a scrolled page, the wrapper carries a real "+ window.scrollX/scrollY" term', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const geom = await replay(tentacleSnapshot);
      assert.ok(geom, 'expected a mounted tentaclerise wrapper');
      assert.strictEqual(parseFloat(geom.rootLeft), scroll.x, `wrapper left must equal window.scrollX (${scroll.x}), got ${geom.rootLeft}`);
      assert.strictEqual(parseFloat(geom.rootTop), scroll.y, `wrapper top must equal window.scrollY (${scroll.y}), got ${geom.rootTop}`);
      assert.strictEqual(geom.tentacleCount, 2, 'both tentacles must mount with plenty of room');
      assert.deepStrictEqual(geom.tentacleSides, ['left', 'right'], 'must be exactly one left and one right tentacle, never two of the same side');
      assert.ok(geom.domePresent, 'the dome must mount with plenty of vertical headroom');

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('normal placement: both tentacles bracket the match, the dome mounts below it, and the match DOM is untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const measured = await measure('target');
    const predicted = predict(measured, 1);
    assert.strictEqual(predicted.tentaclesSuppressed, false, 'sanity check: fixture must give both tentacles room');
    assert.strictEqual(predicted.domeVisible, true, 'sanity check: fixture must give the dome headroom');

    const geom = await replay(tentacleSnapshot);
    assert.ok(geom, 'expected a mounted tentaclerise wrapper');
    assert.strictEqual(geom.tentacleCount, 2, 'both tentacles must mount together');
    assert.deepStrictEqual(geom.tentacleSides, ['left', 'right']);
    assert.ok(geom.domePresent, 'the dome must mount');

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM (#target outerHTML) must never be mutated by this effect');

    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('starting from a genuinely unscrolled page (scrollY=0), Enter still finds and plays the effect correctly, via the extension\'s own scroll-into-view', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    assert.strictEqual(scrollBefore, 0, 'sanity check: page must start genuinely unscrolled');

    const geom = await replay(tentacleSnapshot);
    assert.ok(geom, 'expected a mounted tentaclerise wrapper after the page auto-scrolled the match into view');
    assert.strictEqual(geom.tentacleCount, 2, 'both tentacles must mount once the match settles into view');
    assert.deepStrictEqual(geom.tentacleSides, ['left', 'right']);
    assert.ok(geom.domePresent, 'the dome must mount once the match settles into view');

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  // NOTE: #edgeTarget's own rect is wider than a 320px viewport, so BOTH sides overlap
  // #match here -- this test alone cannot distinguish the paired suppression rule from
  // suppressing each side independently (an independent-sides mutation still yields 0
  // tentacles for this exact fixture, since neither side alone would fit either). The
  // "one-sided overlap" test below, with a fixture where only ONE side genuinely overlaps,
  // is what actually isolates the pairing rule; this test still covers the real, separate
  // "match wider than the viewport" scenario oculist-1ta.24's own close reason names.
  test('both-or-neither pairing (both sides overlap): a match wider than a 320px viewport suppresses BOTH tentacles together, while the dome still mounts on its own merits', async () => {
    await switchToTarget('edgeTarget')();
    // No settleNavigation() here -- switchToTarget() already settled its own navigation
    // above; a pure viewport resize afterward triggers neither a scroll-into-view nor a
    // beacon, so waiting again would only add settleNavigation()'s own fixed dead time.
    // Waits out the resize debounce itself (content.js's own 100ms overlayResizeTimer) --
    // scrollTargetTo()/measure() below are just page.evaluate() reads, fast enough that
    // without this wait the trailing repositionActiveOverlays() -> cancelBeacons() can still
    // fire AFTER replay()'s own fresh beacon mounts, tearing it down mid-flight (oculist-f7vx).
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 320, height: 900 });
    try {
      await scrollTargetTo('edgeTarget', 100);
      const before = await page.evaluate(() => document.getElementById('edgeTarget').outerHTML);

      const measured = await measure('edgeTarget');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.tentaclesSuppressed, true, 'sanity check: fixture must force tentacle suppression');
      assert.strictEqual(predicted.domeVisible, true, 'sanity check: this scenario must still leave the dome its own headroom');

      const geom = await replay(tentacleSnapshot);
      assert.ok(geom, 'expected a mounted tentaclerise wrapper (the dome alone)');
      assert.strictEqual(geom.tentacleCount, 0, 'neither tentacle may mount when either side would overlap the match -- never a lone surviving limb');
      assert.ok(geom.domePresent, 'the dome/eyes beat is independent of the horizontal tentacle suppression and must still mount');

      const after = await page.evaluate(() => document.getElementById('edgeTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      // switchToTarget() already settles its own navigation (see settleNavigation()'s own
      // comment) before returning.
      await switchToTarget('target')();
    }
  });

  test('one-sided overlap: only the LEFT tentacle would overlap #match -- the pairing rule suppresses BOTH, not just the overlapping side, and STROKE_BULGE is what makes the left side overlap at all', async () => {
    await switchToTarget('oneOverlapTarget')();
    try {
      // #oneOverlapTarget's rect.left never needs a horizontal scroll-into-view (it fits
      // fully inside the 1200px-wide default viewport by construction -- see the fixture's
      // own comment). Only vertical position is adjusted here, at the default viewport
      // size, so nothing triggers content.js's own scrollIntoView at all -- the exact
      // review finding this test is designed to not race: a live scroll can shift rect.left
      // out from under a pre-fire measurement.
      await scrollTargetTo('oneOverlapTarget', 200);

      const before = await page.evaluate(() => document.getElementById('oneOverlapTarget').outerHTML);

      const preFire = await measure('oneOverlapTarget');
      const predictedPreFire = predict(preFire, 1);
      assert.strictEqual(predictedPreFire.leftOverlaps, true, `sanity check: LEFT must overlap pre-fire, got rect.left=${preFire.left}`);
      assert.strictEqual(predictedPreFire.rightOverlaps, false, 'sanity check: RIGHT must NOT overlap pre-fire -- this must be a genuinely one-sided case');
      assert.strictEqual(predictedPreFire.domeVisible, true, 'sanity check: fixture must leave the dome its own headroom');
      // Confirms this placement actually depends on STROKE_BULGE (oculist-tlg2): without it,
      // the SAME rect would predict LEFT as clear too, i.e. no overlap on either side.
      const withoutBulge = predict(preFire, 1, 0);
      assert.strictEqual(withoutBulge.leftOverlaps, false, 'sanity check: dropping STROKE_BULGE must flip LEFT to non-overlapping for this exact rect -- otherwise this fixture is not actually exercising it');

      // Reads the match's OWN rect in the SAME page-side tick as the mount check -- "at fire
      // time", not from the pre-fire measurement above -- so a scroll-into-view this test
      // did not anticipate would show up here as a loud sanity-check failure rather than a
      // silently-vacuous pass (the exact class of bug this test replaces).
      const result = await replay(() => {
        const root = document.querySelector('.oc-beacon-transient[data-tentaclerise]');
        if (!root) return null;
        const r = document.getElementById('oneOverlapTarget').getBoundingClientRect();
        const tentacles = Array.from(root.querySelectorAll('[data-tr-tentacle]'));
        const dome = root.querySelector('[data-tr-dome-wrap]');
        return {
          fireLeft: r.left, fireRight: r.right, fireTop: r.top, fireBottom: r.bottom, fireHeight: r.height,
          vw: window.innerWidth, vh: window.innerHeight,
          tentacleCount: tentacles.length,
          tentacleSides: tentacles.map((t) => t.getAttribute('data-tr-tentacle')).sort(),
          domePresent: !!dome,
        };
      });
      assert.ok(result, 'expected a mounted tentaclerise wrapper (the dome alone)');

      const predictedFireTime = predict(
        { left: result.fireLeft, right: result.fireRight, bottom: result.fireBottom, height: result.fireHeight, vw: result.vw, vh: result.vh },
        1
      );
      assert.strictEqual(predictedFireTime.leftOverlaps, true, `fire-time sanity check: LEFT must still overlap at the exact rect fired, got left=${result.fireLeft} right=${result.fireRight}`);
      assert.strictEqual(predictedFireTime.rightOverlaps, false, 'fire-time sanity check: RIGHT must still NOT overlap at the exact rect fired -- a scroll drift here would make this a two-sided (or zero-sided) case instead');

      assert.strictEqual(result.tentacleCount, 0, 'neither tentacle may mount when only ONE side would overlap -- suppression is a PAIRED decision (oculist-1ta.24), not per-side');
      assert.ok(result.domePresent, 'the dome/eyes beat is independent of the horizontal tentacle suppression and must still mount');

      const after = await page.evaluate(() => document.getElementById('oneOverlapTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await switchToTarget('target')();
    }
  });

  test('one-sided overlap, mirrored: the right tentacle is a real CSS mirror (scaleX(-1)), not a second independent drawing', async () => {
    await switchToTarget('target')();
    try {
      await scrollTargetTo('target', 200);
      const geom = await replay(() => {
        const left = document.querySelector('[data-tr-tentacle="left"] svg[data-tr-art]');
        const right = document.querySelector('[data-tr-tentacle="right"] svg[data-tr-art]');
        if (!left || !right) return null;
        return {
          leftTransform: getComputedStyle(left.parentElement).transform,
          rightTransform: getComputedStyle(right.parentElement).transform,
        };
      });
      assert.ok(geom, 'expected both tentacles to mount with plenty of room');
      // A 2D scaleX(-1) matrix is matrix(-1, 0, 0, 1, 0, 0) (with whatever translateY the
      // rise/sink animation has reached folded into the same matrix) -- the left tentacle's
      // own 'a' component (matrix[0]) must be positive (no mirror) and the right tentacle's
      // must be negative (mirrored), never the same sign as each other.
      function scaleXSign(transform) {
        const m = /matrix\(([-\d.]+)/.exec(transform);
        assert.ok(m, `expected a matrix(...) transform, got "${transform}"`);
        return Math.sign(parseFloat(m[1]));
      }
      assert.strictEqual(scaleXSign(geom.leftTransform), 1, `left tentacle must not be mirrored, got transform "${geom.leftTransform}"`);
      assert.strictEqual(scaleXSign(geom.rightTransform), -1, `right tentacle must be mirrored (negative scaleX), got transform "${geom.rightTransform}"`);
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    }
  });

  test('viewport-bottom edge case: with the match close to the viewport\'s bottom edge, the dome/eyes beat is suppressed on its own, while both tentacles still rise, curl, and sink in full', async () => {
    try {
      // Lands #target's own bottom edge 10px above the viewport's bottom edge -- (bottom +
      // DOME_H(18) + DOME_MARGIN(4)) = vh + 12 > vh, so domeVisible is false by this bead's
      // own AMENDED threshold (22px) -- while the match's horizontal position (and so the
      // tentacle placement) is unaffected.
      await scrollTargetBottomTo('target', 10);

      const measured = await measure('target');
      const predicted = predict(measured, 1);
      assert.ok(measured.vh - measured.bottom < 22, `sanity check: fixture must land the match within 22px of the viewport bottom, got ${measured.vh - measured.bottom}px`);
      assert.strictEqual(predicted.domeVisible, false, 'sanity check: fixture must force dome suppression');
      assert.strictEqual(predicted.tentaclesSuppressed, false, 'sanity check: the tentacles must still have room at this viewport width');

      const geom = await replay(tentacleSnapshot);
      assert.ok(geom, 'expected a mounted tentaclerise wrapper (tentacles alone)');
      assert.strictEqual(geom.tentacleCount, 2, 'both tentacles must still rise/curl/sink even when the dome is suppressed');
      assert.deepStrictEqual(geom.tentacleSides, ['left', 'right']);
      assert.ok(!geom.domePresent, 'the dome/eyes beat must be suppressed this close to the viewport bottom');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('viewport-bottom edge case, contrast: with more headroom below the match, the dome/eyes beat mounts normally', async () => {
    try {
      await scrollTargetBottomTo('target', 100);

      const measured = await measure('target');
      const predicted = predict(measured, 1);
      assert.strictEqual(predicted.domeVisible, true, 'sanity check: fixture must give the dome headroom here');

      const geom = await replay(tentacleSnapshot);
      assert.ok(geom, 'expected a mounted tentaclerise wrapper');
      assert.ok(geom.domePresent, 'the dome/eyes beat must mount with real headroom below the match');

      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('viewport edges: at a small 500x300 viewport, every rendered box stays on screen and the match DOM stays untouched', async () => {
    // No settleNavigation() here -- a pure viewport resize (unlike switchToTarget()'s own
    // navigation) never triggers content.js's own scroll-into-view or creates a beacon, so
    // waiting out settleNavigation()'s own scrollend-or-750ms floor here would only burn
    // fixed dead time against this test's own POLL_TIMEOUT budget for no reason (measured:
    // this was the test that once brushed a ~5045ms near-miss against the unscaled 5000ms
    // POLL_TIMEOUT).
    // A much cheaper, separate wait than settleNavigation() above: let content.js's own
    // 100ms resize debounce (overlayResizeTimer) settle before replaying. scrollTargetTo()/
    // measure() below are just page.evaluate() reads, fast enough that without this wait the
    // trailing repositionActiveOverlays() -> cancelBeacons() can still fire AFTER replay()'s
    // own fresh beacon mounts, tearing it down mid-flight (oculist-f7vx).
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 500, height: 300 });
    try {
      await scrollTargetTo('target', 100);

      const before = await page.evaluate(() => document.getElementById('target').outerHTML);
      const measured = await measure('target');
      const predicted = predict(measured, 1);
      assert.ok(
        !predicted.tentaclesSuppressed || predicted.domeVisible,
        'sanity check: this fixture must render at least the dome even if the tentacles are suppressed'
      );

      // Folds presence AND the box read into the same page-side predicate (oculist-d5c's
      // own round-trip hazard: a transient piece could self-clean between replay()
      // returning and a later, separate page.evaluate() read).
      const boxes = await replay(() => {
        const root = document.querySelector('.oc-beacon-transient[data-tentaclerise]');
        if (!root) return null;
        const vw = window.innerWidth, vh = window.innerHeight;
        const nodes = Array.from(root.querySelectorAll('[data-tr-tentacle], [data-tr-dome-wrap]'));
        return nodes.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw, vh };
        });
      });
      assert.ok(boxes, 'expected a mounted tentaclerise wrapper even at a tiny viewport');
      assert.ok(boxes.length > 0, 'sanity check: at least one piece must render even at a tiny viewport');
      boxes.forEach((b, i) => {
        assert.ok(b.right <= b.vw + 2, `box ${i} right (${b.right}) must stay within the ${b.vw}px-wide viewport`);
        assert.ok(b.bottom <= b.vh + 2, `box ${i} bottom (${b.bottom}) must stay within the ${b.vh}px-tall viewport`);
      });

      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect, even at a tiny viewport');
    } finally {
      // cancelBeacons() removes every .oc-beacon-transient node synchronously (destroyBeacon()
      // calls .remove() directly, no fade delay) -- so the wait below resolves on its very
      // first poll tick; settleNavigation()'s own scrollend-or-750ms floor would only add
      // dead time here for no reason (same reasoning as this test's own opening, above).
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      // Waits out the restore resize's own 100ms debounce (overlayResizeTimer) too -- the
      // NEXT test's replay() can otherwise mount its own fresh beacon inside this window and
      // have it torn down by this restore's trailing repositionActiveOverlays() (oculist-f7vx).
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on every element is actually canceled', async () => {
    await scrollTargetTo('target', 200);
    // Folds the presence check AND the animation-collection into replay()'s own predicate
    // (oculist-d5c's own round-trip hazard: a transient piece could self-clean between
    // replay() returning and a later, separate page.evaluate() read) -- window.__trTestAnims
    // is stashed in the SAME page-side tick that proves the wrapper mounted.
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-tentaclerise]')) return null;
      window.__trTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__trTestAnims.length;
    });
    // 10 per tentacle (rise, sink, 8 pose hard-cuts) x2 + 5 on the dome/eyes (rise, sink,
    // fade-in, blink, fade-out) = 25, with plenty of room in this fixture/viewport.
    assert.strictEqual(animCount, 25, `expected 25 live WAAPI animations before cancellation, got ${animCount}`);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

    const states = await page.evaluate(() => window.__trTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${[...new Set(states)].join(', ')}`);

    await page.evaluate(() => { delete window.__trTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted, 'sanity check: the wrapper must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- a genuine leak surfaces as this wait's own
    // TimeoutError. DUR is ~1740ms; POLL_TIMEOUT comfortably covers it.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: a no-op -- same rendered geometry and the same animation count in both modes', async () => {
    async function snapshot() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted tentaclerise wrapper');
      return page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[data-tr-tentacle], [data-tr-dome-wrap]'));
        return {
          boxes: nodes.map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
          totalAnimCount: Array.from(document.querySelectorAll('.oc-beacon-transient'))
            .reduce((sum, el) => sum + el.getAnimations({ subtree: true }).length, 0),
        };
      });
    }

    await scrollTargetTo('target', 200);
    const full = await snapshot();
    try {
      await setSettings({ performanceMode: true });
      const lite = await snapshot();
      assert.strictEqual(lite.totalAnimCount, full.totalAnimCount, 'Lite Mode must render the exact same animation count -- this effect has no glow/box-shadow/flicker to drop');
      assert.deepStrictEqual(lite.boxes, full.boxes, 'Lite Mode must render the exact same geometry');
    } finally {
      await setSettings({ performanceMode: false });
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the tentacle and dome RENDERED boxes scale together', async () => {
    async function renderedSizes() {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted tentaclerise wrapper');
      return page.evaluate(() => {
        const tentacle = document.querySelector('[data-tr-tentacle]');
        const dome = document.querySelector('[data-tr-dome-wrap]');
        return { tentacleHeight: tentacle.getBoundingClientRect().height, domeWidth: dome.getBoundingClientRect().width };
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
        const expectedTentacleHeight = base.tentacleHeight * factor;
        const expectedDomeWidth = base.domeWidth * factor;
        assert.ok(
          Math.abs(sized.tentacleHeight - expectedTentacleHeight) <= 2,
          `Beacon Size ${size}: tentacle height expected ~${expectedTentacleHeight}, got ${sized.tentacleHeight}`
        );
        assert.ok(
          Math.abs(sized.domeWidth - expectedDomeWidth) <= 2,
          `Beacon Size ${size}: dome width expected ~${expectedDomeWidth}, got ${sized.domeWidth}`
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
      assert.strictEqual(keys.indexOf('tentaclerise'), -1, 'tentaclerise must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(TENTACLERISE_EFFECT_ROW).count(),
        0,
        'tentaclerise must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('tentaclerise'), -1, 'tentaclerise must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(TENTACLERISE_EFFECT_ROW).count(),
        1,
        'tentaclerise must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'tentaclerise' (a real,
      // registered -- just currently unavailable -- key), so firing must fall back to some
      // other effect rather than mount the wrapper.
      await setSettings({ effect: 'tentaclerise', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-tentaclerise]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the tentaclerise wrapper');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Selection restored on re-enable: no explicit re-selection of 'tentaclerise' here.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-tentaclerise]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored tentaclerise selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs -- route
      // through a sentinel value first so both writes are genuine changes regardless of
      // which line above (if any) threw.
      await setSettings({ enabledPacks: ['__oc_tentaclerise_test_reset__'] });
      await setSettings({ effect: 'tentaclerise', enabledPacks: ['halloween'] });
    }
  });
});
