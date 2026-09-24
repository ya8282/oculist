// Jack-o'-Lantern Flicker beacon effect (oculist-4rso): promotes fxJackOLantern
// (artifacts/prototypes/effects-playground.html, the accepted geometry from oculist-xl8f/
// oculist-9r5k) into extension/content.js as the fourth entry in the Halloween pack. A
// hand-drawn pumpkin fades in centred on the match's own mouth cavity when the match is
// small enough to frame readably (mouth mode), or above the match with an 8px gap when it
// is not (below-pumpkin mode); if neither placement fits the physical viewport, the effect
// is suppressed rather than covering text. Its face-light flickers through three
// deterministic states (dim, warm, bright) while the shell itself never moves.
//
// Modeled on test/cheshire_effect.test.js (this Halloween pack's own most recent sibling —
// same fixture/helper shape, same placement-fallback and pack-enumeration idioms) and
// test/flappy_effect.test.js (Beacon Size measured from the RENDERED box, not recomputed
// geometry) -- against the REAL extension, since jackolantern is a genuine effectsRegistry
// entry under pack:'halloween', no fixture copy needed for either.
//
// Needs a real browser for the same reasons as those two: WAAPI, real layout, and
// chrome.storage.sync-driven settings only exist in real Chromium.
//
// MOUTH MODE'S DELIBERATE GLYPH TINT: a human decision recorded on oculist-xl8f's own close
// comment (2026-09-21) and operationalized by oculist-nq1x.15's close reason -- the
// translucent mouth panel deliberately warms the matched glyphs in mouth mode, so this
// effect's own "zero glyph pixel change" rule holds for above and suppressed modes only.
// The mouth-mode test below asserts the panel's own fixed 0.18 fill-opacity contract
// instead of a zero-pixel-change contract.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target: short, default-size text -- comfortably fits the mouth cavity at every Beacon
// Size (mouth mode never scales with beaconScale, see animateJackOLantern's own comment),
// with a shallow 200px lead-in so BOTH an unscrolled read and a modestly scrolled one
// (below) leave enough headroom above it for the mouth-cavity's own upward extent.
// #wideTarget: a large font size makes even a short word wider than the cavity can frame
// readably (161px+), forcing the below-pumpkin fallback -- the promotion contract's own
// "below-pumpkin" scenario ("a match too wide for a readable mouth frame"). Its 130px own
// lead-in puts its top at ~456px in the 800px-tall VIEWPORT (measured), which is BOTH
// entirely on screen unscrolled (leaving margin below, so activating it never triggers a
// browser/extension "scroll the match fully into view" nudge that would silently change
// window.scrollY between a pre-fire measurement and the actual fire -- verified: a taller
// lead-in that left its own bottom edge clipped at the fold did exactly that) AND, at ~456px,
// comfortably more headroom than the below-pumpkin figure's own tallest extent at Beacon
// Size XL (~298px needed).
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:200px"></div>
<p style="margin-left:420px;">filler text <span id="target">quarklet</span></p>
<div style="height:130px"></div>
<p style="margin-left:420px;"><span id="wideTarget" style="font-size:64px;font-weight:700;">zeptogram</span></p>
<div style="height:2000px"></div>`;

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const JOL_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:jackolantern"]';

// animateJackOLantern's own placement algorithm (extension/content.js), reproduced verbatim
// so the placement/edge tests below can predict mode+geometry from a REAL measured match
// rect and viewport, rather than hardcoding pixel expectations that would silently drift
// out of sync with the shipped formula. Mirrors test/cheshire_effect.test.js's own
// expectedCatHeight() idiom, one level more complete since this effect has two placement
// modes plus a suppression branch.
//
// Because this reproduces the shipped formula verbatim, a bug IN that formula cannot fail
// a test that only compares against expectedPlacement()'s own output (both sides would be
// wrong the same way) -- the rendered-geometry assertions below (mouthCavRect()'s CAV
// clearance, aboveModeContract()'s edge/clearance check), read straight off the mounted DOM
// with no recomputation, are what actually catch that class of bug.
function expectedPlacement(target, vw, vh, beaconScale) {
  const VB_W = 180, VB_H = 126;
  const CAV = { x: 32, y: 73, w: 116, h: 28 };
  const PAINT = { left: 8, top: 2, right: 172, bottom: 122 };
  const CLEAR = 6, ABOVE_GAP = 8, EDGE = 4, STROKE_MARGIN = 2;
  const ENTER_SCALE = 0.96;
  const MIN_SCALE = 72 / VB_H, MAX_FRAME_SCALE = 196 / VB_H;
  const cx = target.left + target.width / 2, cy = target.top + target.height / 2;

  function bounds(left, top, scale) {
    return {
      left: left + PAINT.left * scale - STROKE_MARGIN,
      top: top + PAINT.top * scale - STROKE_MARGIN,
      right: left + PAINT.right * scale + STROKE_MARGIN,
      bottom: top + PAINT.bottom * scale + STROKE_MARGIN,
    };
  }
  function onScreen(b) {
    return b.left >= EDGE && b.top >= EDGE && b.right <= vw - EDGE && b.bottom <= vh - EDGE;
  }

  const frameScale = Math.max(
    MIN_SCALE,
    (target.width + CLEAR * 2) / (CAV.w * ENTER_SCALE),
    (target.height + CLEAR * 2) / (CAV.h * ENTER_SCALE)
  );
  const frameLeft = cx - (CAV.x + CAV.w / 2) * frameScale;
  const frameTop = cy - (CAV.y + CAV.h / 2) * frameScale;
  const frameFits = frameScale <= MAX_FRAME_SCALE && onScreen(bounds(frameLeft, frameTop, frameScale));

  if (frameFits) {
    return { mode: 'mouth', scale: frameScale, left: frameLeft, top: frameTop };
  }

  const aboveScale = Math.max(MIN_SCALE, Math.min(1, (target.height * 2.8) / VB_H)) * beaconScale;
  const aboveLeft = cx - (VB_W * aboveScale) / 2;
  const aboveTop = target.top - ABOVE_GAP - PAINT.bottom * aboveScale - STROKE_MARGIN;
  if (!onScreen(bounds(aboveLeft, aboveTop, aboveScale))) {
    return { mode: 'suppressed' };
  }
  return { mode: 'above', scale: aboveScale, left: aboveLeft, top: aboveTop };
}

describe("Jack-o'-Lantern Flicker: a hand-drawn pumpkin frames or sits above the match and its face-light flickers", () => {
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

    await setSettings({ effect: 'jackolantern', enabledPacks: ['halloween'] });

    await openFinder(page);
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    await waitForMatchCount(page);
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

  // Same production cancellation path as cheshire_effect.test.js's own replay(): cancels
  // any in-flight beacon through window.__ocTest.cancelBeacons() (the exact function
  // animate() itself calls first), then presses Enter to (re-)fire.
  // `arg` (when passed) is handed to page.waitForFunction()'s own arg parameter, NOT
  // captured from this Node-side closure -- predicate is stringified and evaluated
  // in-page, so it can only see globals and whatever `arg` itself carries in, never a
  // Node-side function or variable (pumpkinSnapshot(targetId) below relies on this).
  async function replay(predicate, arg) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    const handle = await page.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient') ? true : null)),
      arg !== undefined ? arg : null,
      { timeout: POLL_TIMEOUT }
    );
    return handle.jsonValue();
  }

  // Fires (via the production cancel-then-Enter path), then asserts NO .oc-jackolantern
  // ever mounts -- used by the suppression test and the edge sweep's suppressed branch.
  // A fixed grace period rather than a wait-for-absence poll: absence has nothing to wait
  // FOR, since a genuine defect here would mean the element never appears at all, not that
  // it appears late.
  async function fireAndExpectSuppressed(description) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const present = await page.evaluate(() => !!document.querySelector('.oc-jackolantern'));
    assert.strictEqual(present, false, `${description}: expected suppression (neither placement mode fits), but a pumpkin mounted`);
  }

  function pumpkinSnapshot(targetId) {
    const el = document.querySelector('.oc-jackolantern');
    if (!el) return null;
    const target = document.getElementById(targetId).getBoundingClientRect();
    return {
      mode: el.getAttribute('data-jol-mode'),
      styleLeft: parseFloat(el.style.left),
      styleTop: parseFloat(el.style.top),
      styleWidth: parseFloat(el.style.width),
      styleHeight: parseFloat(el.style.height),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      targetLeft: target.left,
      targetTop: target.top,
      targetBottom: target.bottom,
      targetWidth: target.width,
      targetHeight: target.height,
    };
  }

  // CAV box (extension/content.js's own constant: x:32 y:73 w:116 h:28 in viewBox units)
  // mapped through the RENDERED svg's own getScreenCTM() -- not recomputed from
  // expectedPlacement()'s own geometry, so a formula bug there cannot cancel out against an
  // identical recomputation here. Self-contained (only browser globals) so it can be handed
  // directly to page.evaluate()/page.waitForFunction(), same idiom as pumpkinSnapshot()
  // above.
  function mouthCavRect(targetId) {
    const el = document.querySelector('.oc-jackolantern[data-jol-mode="mouth"]');
    if (!el) return null;
    const svg = el.querySelector('svg');
    const CAV = { x: 32, y: 73, w: 116, h: 28 };
    const ctm = svg.getScreenCTM();
    const p1 = svg.createSVGPoint();
    p1.x = CAV.x; p1.y = CAV.y;
    const p2 = svg.createSVGPoint();
    p2.x = CAV.x + CAV.w; p2.y = CAV.y + CAV.h;
    const c1 = p1.matrixTransform(ctm), c2 = p2.matrixTransform(ctm);
    const target = document.getElementById(targetId).getBoundingClientRect();
    return {
      cav: { left: c1.x, top: c1.y, right: c2.x, bottom: c2.y },
      target: { left: target.left, top: target.top, right: target.right, bottom: target.bottom },
    };
  }

  // Real 6px CAV clearance contract, +-0.05px subpixel tolerance for CTM float rounding.
  function assertCavClearance(cav, target, label) {
    const CLEAR = 6, TOL = 0.05;
    assert.ok(
      target.left - cav.left >= CLEAR - TOL,
      `${label}: CAV left clearance must be >= ${CLEAR}px, got ${(target.left - cav.left).toFixed(2)}`
    );
    assert.ok(
      target.top - cav.top >= CLEAR - TOL,
      `${label}: CAV top clearance must be >= ${CLEAR}px, got ${(target.top - cav.top).toFixed(2)}`
    );
    assert.ok(
      cav.right - target.right >= CLEAR - TOL,
      `${label}: CAV right clearance must be >= ${CLEAR}px, got ${(cav.right - target.right).toFixed(2)}`
    );
    assert.ok(
      cav.bottom - target.bottom >= CLEAR - TOL,
      `${label}: CAV bottom clearance must be >= ${CLEAR}px, got ${(cav.bottom - target.bottom).toFixed(2)}`
    );
  }

  // Formula-independent above-mode contract, read from the rendered DOM: the painted box
  // must sit fully above the match and stay inside the viewport's own 4px EDGE margin.
  // Self-contained, same idiom as pumpkinSnapshot()/mouthCavRect() above.
  function aboveModeContract(targetId) {
    const el = document.querySelector('.oc-jackolantern[data-jol-mode="above"]');
    if (!el) return null;
    const svg = el.querySelector('svg');
    // PAINT (extension/content.js's own conservative painted-bounds rectangle) mapped
    // through the rendered svg's own getScreenCTM(), then padded by the fixed 2px
    // STROKE_MARGIN in screen space (a flat px value, not scaled, same as content.js's own
    // bounds()) -- the actual protected paint region, not the element's own unpadded full
    // viewBox box (which is larger than what is actually painted).
    const PAINT = { left: 8, top: 2, right: 172, bottom: 122 };
    const STROKE_MARGIN = 2;
    const ctm = svg.getScreenCTM();
    const p1 = svg.createSVGPoint();
    p1.x = PAINT.left; p1.y = PAINT.top;
    const p2 = svg.createSVGPoint();
    p2.x = PAINT.right; p2.y = PAINT.bottom;
    const c1 = p1.matrixTransform(ctm), c2 = p2.matrixTransform(ctm);
    const target = document.getElementById(targetId).getBoundingClientRect();
    return {
      left: c1.x - STROKE_MARGIN, top: c1.y - STROKE_MARGIN,
      right: c2.x + STROKE_MARGIN, bottom: c2.y + STROKE_MARGIN,
      targetTop: target.top, vw: window.innerWidth, vh: window.innerHeight,
    };
  }

  function assertAboveModeContract(g, label) {
    const EDGE = 4, TOL = 1;
    assert.ok(
      g.bottom <= g.targetTop + TOL,
      `${label}: pumpkin's rendered bottom edge (${g.bottom}) must clear the match's own top edge (${g.targetTop})`
    );
    assert.ok(g.left >= EDGE - TOL, `${label}: pumpkin's rendered left (${g.left}) must stay within the ${EDGE}px viewport edge margin`);
    assert.ok(g.top >= EDGE - TOL, `${label}: pumpkin's rendered top (${g.top}) must stay within the ${EDGE}px viewport edge margin`);
    assert.ok(
      g.right <= g.vw - EDGE + TOL,
      `${label}: pumpkin's rendered right (${g.right}) must stay within the ${EDGE}px viewport edge margin (vw=${g.vw})`
    );
    assert.ok(
      g.bottom <= g.vh - EDGE + TOL,
      `${label}: pumpkin's rendered bottom (${g.bottom}) must stay within the ${EDGE}px viewport edge margin (vh=${g.vh})`
    );
  }

  // Waits for the whole-figure entrance WAAPI animation (scale+opacity, content.js) to
  // settle -- CAV/above-mode rects read via CTM/getBoundingClientRect would otherwise catch
  // a still-scaling entrance frame instead of the settled geometry these contracts describe.
  async function waitForEntranceSettled() {
    await page.waitForFunction(() => {
      const el = document.querySelector('.oc-jackolantern');
      return el && parseFloat(getComputedStyle(el).opacity) > 0.98 ? true : null;
    }, null, { timeout: POLL_TIMEOUT });
  }

  async function measureTarget(targetId) {
    return page.evaluate((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, vw: window.innerWidth, vh: window.innerHeight };
    }, targetId);
  }

  test('mouth-framing mode, UNSCROLLED: document-space geometry matches the shipped placement formula', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const measured = await measureTarget('target');
    const predicted = expectedPlacement(measured, measured.vw, measured.vh, 1);
    assert.strictEqual(predicted.mode, 'mouth');

    const geom = await replay(() => {
      const el = document.querySelector('.oc-jackolantern');
      if (!el) return null;
      return {
        mode: el.getAttribute('data-jol-mode'),
        left: parseFloat(el.style.left),
        top: parseFloat(el.style.top),
        width: parseFloat(el.style.width),
        height: parseFloat(el.style.height),
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      };
    });
    assert.ok(geom, 'expected a mounted pumpkin');
    assert.strictEqual(geom.scrollY, 0, 'sanity check: this is the UNSCROLLED case');
    assert.strictEqual(geom.mode, 'mouth', `expected mouth mode, got ${geom.mode}`);
    assert.ok(Math.abs(geom.left - predicted.left) <= 2, `left: expected ~${predicted.left}, got ${geom.left}`);
    assert.ok(Math.abs(geom.top - predicted.top) <= 2, `top: expected ~${predicted.top}, got ${geom.top}`);
    assert.ok(Math.abs(geom.width - 180 * predicted.scale) <= 2, `width: expected ~${180 * predicted.scale}, got ${geom.width}`);
    assert.ok(Math.abs(geom.height - 126 * predicted.scale) <= 2, `height: expected ~${126 * predicted.scale}, got ${geom.height}`);

    // Formula-independent contract: the rendered CAV box, read via the svg's own CTM, must
    // still clear the match with the real 6px margin -- see expectedPlacement()'s own
    // comment for why this catches a placement-formula bug that the checks above cannot.
    await waitForEntranceSettled();
    const cavGeom = await page.evaluate(mouthCavRect, 'target');
    assert.ok(cavGeom, 'expected a mounted mouth-mode pumpkin for the CAV clearance check');
    assertCavClearance(cavGeom.cav, cavGeom.target, 'mouth UNSCROLLED');
  });

  test('mouth-framing mode, SCROLLED: document coordinates carry a real "+ window.scrollY" term', async () => {
    // A modest 30px scroll -- enough for a real, non-zero scrollY to catch a missing
    // "+ window.scrollY" term (rule 2 of the promotion contract), while staying well
    // within the headroom the mouth cavity's own upward extent needs above #target.
    await page.evaluate(() => window.scrollTo(0, 30));
    try {
      const measured = await measureTarget('target');
      const predicted = expectedPlacement(measured, measured.vw, measured.vh, 1);
      assert.strictEqual(predicted.mode, 'mouth', `sanity check: still expected mouth mode at 30px scroll, got ${predicted.mode}`);

      const geom = await replay(pumpkinSnapshot, 'target');
      assert.ok(geom, 'expected a mounted pumpkin');
      assert.ok(geom.scrollY > 0, `sanity check: the page must actually be scrolled, got scrollY=${geom.scrollY}`);
      assert.strictEqual(geom.mode, 'mouth', `expected mouth mode, got ${geom.mode}`);

      const expectedDocLeft = predicted.left + geom.scrollX;
      const expectedDocTop = predicted.top + geom.scrollY;
      assert.ok(Math.abs(geom.styleLeft - expectedDocLeft) <= 2, `left: expected ~${expectedDocLeft}, got ${geom.styleLeft}`);
      assert.ok(
        Math.abs(geom.styleTop - expectedDocTop) <= 2,
        `top: expected ~${expectedDocTop} -- a missing "+ window.scrollY" term here is exactly what a scrolled-page ` +
          `assertion catches that an unscrolled one cannot -- got ${geom.styleTop}`
      );

      // Formula-independent contract, same as the UNSCROLLED case above: the rendered CAV
      // box must still clear the match with the real 6px margin.
      await waitForEntranceSettled();
      const cavGeom = await page.evaluate(mouthCavRect, 'target');
      assert.ok(cavGeom, 'expected a mounted mouth-mode pumpkin for the CAV clearance check');
      assertCavClearance(cavGeom.cav, cavGeom.target, 'mouth SCROLLED');
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('mouth mode: the cavity contains the match with the real 6px clearance, the mouth panel carries its exact deliberate 0.18-opacity tint contract, and the match DOM is never mutated', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const geom = await replay(() => {
      const el = document.querySelector('.oc-jackolantern');
      if (!el || el.getAttribute('data-jol-mode') !== 'mouth') return null;
      const panel = el.querySelector('[data-jol-part="mouth-panel"]');
      return {
        panelFill: panel.getAttribute('fill'),
        panelFillOpacity: panel.getAttribute('fill-opacity'),
      };
    });
    assert.ok(geom, 'expected a mounted pumpkin in mouth mode');

    // Deliberate tint contract (oculist-xl8f's own close comment / oculist-nq1x.15's close
    // reason): fill stays the shell's own identity orange, fill-opacity stays exactly 0.18
    // -- neither fully opaque (which would occlude the match) nor fully transparent (which
    // would silently drop the deliberate tint the human decision requires).
    assert.strictEqual(geom.panelFill, '#E86F1C', `mouth panel fill: expected the shell's own identity orange, got ${geom.panelFill}`);
    assert.strictEqual(geom.panelFillOpacity, '0.18', `mouth panel fill-opacity: expected the accepted 0.18 tint, got ${geom.panelFillOpacity}`);

    // Containment: the real 6px CAV-box clearance -- not the larger mouth PANEL rect, which
    // is looser than the actual contract -- read from the RENDERED svg via its own CTM.
    await waitForEntranceSettled();
    const cavGeom = await page.evaluate(mouthCavRect, 'target');
    assert.ok(cavGeom, 'expected a mounted mouth-mode pumpkin for the CAV clearance check');
    assertCavClearance(cavGeom.cav, cavGeom.target, 'mouth mode');

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM (#target outerHTML) must never be mutated by this effect, in any mode');
  });

  test('below-pumpkin mode, UNSCROLLED: the pumpkin sits above a match too wide for the mouth cavity, with a real clearance gap, and never touches the match DOM', async () => {
    // Switch the find bar to the wide match FIRST -- activating a match can itself scroll
    // the page (bringing the active match into view), so the rect measured below must be
    // taken AFTER that settles, or "UNSCROLLED" and the measured rect silently disagree.
    await page.locator(INPUT).fill('');
    await page.locator(INPUT).type('zeptogram', { delay: 30 });
    await waitForMatchCount(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    const before = await page.evaluate(() => document.getElementById('wideTarget').outerHTML);
    const measured = await measureTarget('wideTarget');
    const predicted = expectedPlacement(measured, measured.vw, measured.vh, 1);
    assert.strictEqual(predicted.mode, 'above', `sanity check: fixture must force below-pumpkin mode, got ${predicted.mode}`);

    try {
      const geom = await replay(pumpkinSnapshot, 'wideTarget');
      assert.ok(geom, 'expected a mounted pumpkin');
      assert.strictEqual(geom.mode, 'above', `expected below-pumpkin mode, got ${geom.mode}`);

      const expectedDocLeft = predicted.left + geom.scrollX;
      const expectedDocTop = predicted.top + geom.scrollY;
      assert.ok(Math.abs(geom.styleLeft - expectedDocLeft) <= 2, `left: expected ~${expectedDocLeft}, got ${geom.styleLeft}`);
      assert.ok(Math.abs(geom.styleTop - expectedDocTop) <= 2, `top: expected ~${expectedDocTop}, got ${geom.styleTop}`);

      // Formula-independent above-mode contract, read from the rendered DOM: the painted box
      // must never reach the match's own top edge, and must stay inside the viewport's own
      // 4px EDGE margin -- see expectedPlacement()'s own comment for why this check, not a
      // formula recomputation, is what actually catches a placement-formula bug.
      await waitForEntranceSettled();
      const rendered = await page.evaluate(aboveModeContract, 'wideTarget');
      assert.ok(rendered, 'expected a mounted above-mode pumpkin for the rendered-geometry check');
      assertAboveModeContract(rendered, 'below-pumpkin UNSCROLLED');

      const after = await page.evaluate(() => document.getElementById('wideTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM (#wideTarget outerHTML) must never be mutated by this effect');
    } finally {
      await page.locator(INPUT).fill('');
      await page.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page);
    }
  });

  test('below-pumpkin mode, SCROLLED: document coordinates carry a real "+ window.scrollY" term', async () => {
    await page.locator(INPUT).fill('');
    await page.locator(INPUT).type('zeptogram', { delay: 30 });
    await waitForMatchCount(page);

    // 150px scroll -- a real, non-zero scrollY, well within the below-pumpkin figure's own
    // headroom need above #wideTarget (its 400px own lead-in).
    await page.evaluate(() => window.scrollTo(0, 150));
    try {
      const measured = await measureTarget('wideTarget');
      const predicted = expectedPlacement(measured, measured.vw, measured.vh, 1);
      assert.strictEqual(predicted.mode, 'above', `sanity check: still expected below-pumpkin mode at 150px scroll, got ${predicted.mode}`);

      const geom = await replay(pumpkinSnapshot, 'wideTarget');
      assert.ok(geom, 'expected a mounted pumpkin');
      assert.ok(geom.scrollY > 0, `sanity check: the page must actually be scrolled, got scrollY=${geom.scrollY}`);
      assert.strictEqual(geom.mode, 'above');

      const expectedDocLeft = predicted.left + geom.scrollX;
      const expectedDocTop = predicted.top + geom.scrollY;
      assert.ok(Math.abs(geom.styleLeft - expectedDocLeft) <= 2, `left: expected ~${expectedDocLeft}, got ${geom.styleLeft}`);
      assert.ok(
        Math.abs(geom.styleTop - expectedDocTop) <= 2,
        `top: expected ~${expectedDocTop} -- a missing "+ window.scrollY" term here is exactly what a scrolled-page ` +
          `assertion catches that an unscrolled one cannot -- got ${geom.styleTop}`
      );

      // Formula-independent contract, same as the UNSCROLLED case above.
      await waitForEntranceSettled();
      const rendered = await page.evaluate(aboveModeContract, 'wideTarget');
      assert.ok(rendered, 'expected a mounted above-mode pumpkin for the rendered-geometry check');
      assertAboveModeContract(rendered, 'below-pumpkin SCROLLED');
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator(INPUT).fill('');
      await page.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page);
    }
  });

  test('suppression: with only 15px of headroom above the match, neither placement mode fits, and nothing mounts', async () => {
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY;
    });
    try {
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 15)), targetDocY);

      const measured = await measureTarget('target');
      const predicted = expectedPlacement(measured, measured.vw, measured.vh, 1);
      assert.strictEqual(predicted.mode, 'suppressed', `sanity check: fixture must force suppression, got ${predicted.mode}`);

      await fireAndExpectSuppressed('15px headroom');

      // No .oc-beacon count is left behind either (activeBeacons/cancelBeacons book-keeping
      // stays consistent with the DOM having nothing to clean up).
      const beaconCount = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient').length);
      assert.strictEqual(beaconCount, 0, 'no .oc-beacon-transient node of any kind should remain after a suppressed fire');
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('viewport edges: at a small 380x220 viewport, the actual render matches the same fit computation the effect itself uses', async () => {
    await page.setViewportSize({ width: 380, height: 220 });
    // Let the resize debounce settle (content.js's own 100ms overlayResizeTimer) before
    // replaying -- the scroll below is just page.evaluate() reads, fast enough that without
    // this wait the trailing repositionActiveOverlays() -> cancelBeacons() can still fire
    // AFTER replay()'s own fresh beacon mounts, tearing it down mid-flight (oculist-f7vx).
    await page.waitForTimeout(200);
    try {
      const targetDocY = await page.evaluate(() => {
        const r = document.getElementById('target').getBoundingClientRect();
        return r.top + window.scrollY;
      });
      // Centre #target vertically in the tiny 220px-tall viewport -- close to both the top
      // and the bottom edge at once, and (#target's own 420px left margin against a 380px
      // viewport) already close to the right edge horizontally.
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 100)), targetDocY);

      const measured = await measureTarget('target');
      const predicted = expectedPlacement(measured, measured.vw, measured.vh, 1);

      if (predicted.mode === 'suppressed') {
        await fireAndExpectSuppressed('380x220 viewport');
        return;
      }

      const geom = await replay(pumpkinSnapshot, 'target');
      assert.ok(geom, `expected a mounted pumpkin (predicted mode: ${predicted.mode})`);
      assert.strictEqual(geom.mode, predicted.mode, `expected ${predicted.mode} mode, got ${geom.mode}`);

      const expectedDocLeft = predicted.left + geom.scrollX;
      const expectedDocTop = predicted.top + geom.scrollY;
      assert.ok(Math.abs(geom.styleLeft - expectedDocLeft) <= 2, `left: expected ~${expectedDocLeft}, got ${geom.styleLeft}`);
      assert.ok(Math.abs(geom.styleTop - expectedDocTop) <= 2, `top: expected ~${expectedDocTop}, got ${geom.styleTop}`);

      // Regardless of which mode fired, the rendered box's PAINT-margin bounds must stay
      // within this tiny viewport -- the same onScreen() contract the effect itself enforces
      // before ever choosing to render, read here from the real rendered box.
      const withinViewport = await page.evaluate(() => {
        const el = document.querySelector('.oc-jackolantern');
        const rect = el.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, vw: window.innerWidth, vh: window.innerHeight };
      });
      assert.ok(withinViewport.right <= withinViewport.vw + 2, `pumpkin's right edge (${withinViewport.right}) must stay within the ${withinViewport.vw}px-wide viewport`);
      assert.ok(withinViewport.bottom <= withinViewport.vh + 2, `pumpkin's bottom edge (${withinViewport.bottom}) must stay within the ${withinViewport.vh}px-tall viewport`);
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.setViewportSize(VIEWPORT);
      await page.evaluate(() => window.scrollTo(0, 0));
      // A programmatic scrollTo() dispatches its own 'scroll' event asynchronously, on the
      // browser's own schedule -- not necessarily before this test function returns.
      // Without this wait, that event (which calls handleScroll() -> fadeActiveBeacons() in
      // extension/content.js) lands mid-flight in the NEXT test instead: verified directly
      // (a live pumpkin, freshly mounted with 4 running animations, is gone -- faded and
      // removed -- within 2s of the next test's own first replay(), with no cancelBeacons()
      // call of the next test's own). Giving the resize/scroll settle its own runway here,
      // before the next test starts, is test-isolation hygiene, not a production concern.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  test('Beacon Size S/L/XL, set for real through chrome.storage.sync: mouth mode never rescales (a hard containment requirement, not a stylistic one), and the CAV box keeps clearing the match at every size', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));

    async function mouthRenderedBox() {
      await replay(() => (document.querySelector('.oc-jackolantern[data-jol-mode="mouth"]') ? true : null));
      await waitForEntranceSettled();
      return page.evaluate(() => {
        const el = document.querySelector('.oc-jackolantern');
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    }

    try {
      const base = await mouthRenderedBox();
      // 's' exercises the cavity-shrink hazard animateJackOLantern's own comment names
      // directly: it is the Beacon Size that would shrink the cavity below containment if
      // getBeaconScale() ever leaked into frameScale, so mouth mode's size-invariance and
      // the 6px CAV clearance both need coverage at S, not just L/XL.
      const SIZES = ['s', 'l', 'xl'];
      for (const size of SIZES) {
        await setVisionSettings({ beaconSize: size });
        const geom = await mouthRenderedBox();

        // Mouth-framing scale is dictated entirely by the match's own real dimensions --
        // getBeaconScale() must NOT change it (see animateJackOLantern's own comment).
        assert.ok(
          Math.abs(geom.width - base.width) <= 2,
          `Beacon Size ${size}: mouth mode's rendered width must NOT change (base ${base.width}), got ${geom.width} -- ` +
            `containment is a hard geometric requirement, not a stylistic Beacon Size preference`
        );
        assert.ok(
          Math.abs(geom.height - base.height) <= 2,
          `Beacon Size ${size}: mouth mode's rendered height must NOT change (base ${base.height}), got ${geom.height}`
        );

        // The real 6px CAV-box clearance -- not the larger mouth PANEL rect, which is looser
        // than the actual contract -- still holds at every size.
        const cavGeom = await page.evaluate(mouthCavRect, 'target');
        assert.ok(cavGeom, `Beacon Size ${size}: expected a mounted mouth-mode pumpkin for the CAV clearance check`);
        assertCavClearance(cavGeom.cav, cavGeom.target, `Beacon Size ${size}`);
      }
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
    }
  });

  test('Beacon Size M/L/XL, set for real through chrome.storage.sync: below-pumpkin mode\'s RENDERED box grows and the gap stays clear', async () => {
    await page.locator(INPUT).fill('');
    await page.locator(INPUT).type('zeptogram', { delay: 30 });
    await waitForMatchCount(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    async function aboveRenderedBox() {
      await replay(() => (document.querySelector('.oc-jackolantern[data-jol-mode="above"]') ? true : null));
      await page.waitForFunction(() => {
        const el = document.querySelector('.oc-jackolantern');
        return el && parseFloat(getComputedStyle(el).opacity) > 0.98 ? true : null;
      }, null, { timeout: POLL_TIMEOUT });
      return page.evaluate(() => {
        const el = document.querySelector('.oc-jackolantern');
        const rect = el.getBoundingClientRect();
        const target = document.getElementById('wideTarget').getBoundingClientRect();
        return { width: rect.width, height: rect.height, bottom: rect.bottom, targetTop: target.top };
      });
    }

    try {
      // getBeaconScale() (content.js): 'm' -> 1, 'l' -> 1.5, 'xl' -> 2.25. Measured from the
      // RENDERED box, not recomputed from animateJackOLantern's own formula -- a bug in that
      // formula (e.g. forgetting to multiply by beaconScale, or double-scaling it) cannot
      // cancel out against an identical recomputation here.
      const base = await aboveRenderedBox();
      const SIZES = [['l', 1.5], ['xl', 2.25]];
      for (const [size, scale] of SIZES) {
        await setVisionSettings({ beaconSize: size });
        const geom = await aboveRenderedBox();

        assert.ok(
          Math.abs(geom.width / base.width - scale) < 0.05,
          `Beacon Size ${size}: rendered width must scale ~${scale}x the default's (${base.width}), got ${geom.width}`
        );
        assert.ok(
          Math.abs(geom.height / base.height - scale) < 0.05,
          `Beacon Size ${size}: rendered height must scale ~${scale}x the default's (${base.height}), got ${geom.height}`
        );
        assert.ok(
          geom.bottom <= geom.targetTop + 1,
          `Beacon Size ${size}: the pumpkin's rendered box (bottom ${geom.bottom}) must clear the match's top edge ` +
            `(${geom.targetTop}) -- it must never paint over the match's own glyphs`
        );
      }
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
      await page.locator(INPUT).fill('');
      await page.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page);
    }
  });

  test('Animation Speed, set for real through chrome.storage.sync: every rendered WAAPI duration AND delay scales by getBeaconDuration\'s own factor', async () => {
    // Full mode (performanceMode:false, the suite default) mounts 4 live animations off the
    // single pumpkinEl root: the whole-figure entrance/hold/exit, plus one per face state
    // (dim/warm/bright) -- see animateJackOLantern's own track() calls in content.js. Same
    // test/helpers/waapi_timings.js collection cheshire_effect.test.js's own equivalent
    // test uses.
    async function renderedTimings() {
      await replay();
      return page.evaluate(collectAnimationTimings);
    }

    // Tracks the last animationSpeed actually written, so the finally below can skip its
    // own reset when we're already back at 'normal' -- chrome.storage.sync only fires
    // onChanged on a genuine value change, so an unconditional reset risks masking a real
    // assertion failure under a "never echoed" timeout thrown while unwinding
    // (flappy_effect.test.js's own Beacon Size test, oculist-vqq1, fixed the identical
    // hazard the same way).
    let currentSpeed = 'normal';

    try {
      const base = await renderedTimings();
      assert.ok(base.length > 0, 'sanity check: expected at least one live WAAPI animation');

      const SPEEDS = [['fast', 0.5], ['slow', 1.75]];
      for (const [speed, factor] of SPEEDS) {
        currentSpeed = speed;
        await setVisionSettings({ animationSpeed: speed });
        const timings = await renderedTimings();
        assert.strictEqual(
          timings.length,
          base.length,
          `Animation Speed ${speed}: expected the same ${base.length} animations`
        );
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
    }
  });

  test('Lite Mode, set for real through chrome.storage.sync: the recognizable shell and a single static warm face are kept, the multi-state flicker is dropped', async () => {
    function snapshot() {
      const el = document.querySelector('.oc-jackolantern');
      if (!el) return null;
      const shell = el.querySelector('[data-jol-part="shell"]');
      const stateGroups = Array.from(el.querySelectorAll('[data-jol-state]'));
      return {
        hasShell: !!shell,
        stateNames: stateGroups.map((g) => g.getAttribute('data-jol-state')).sort(),
        warmOpacity: (() => {
          const warm = el.querySelector('[data-jol-state="warm"]');
          return warm ? parseFloat(getComputedStyle(warm).opacity) : null;
        })(),
        warmAnimCount: (() => {
          const warm = el.querySelector('[data-jol-state="warm"]');
          return warm ? warm.getAnimations({ subtree: true }).length : null;
        })(),
      };
    }

    await page.evaluate(() => window.scrollTo(0, 0));

    const full = await replay(snapshot);
    assert.ok(full, 'expected a mounted pumpkin in full mode');
    assert.strictEqual(full.hasShell, true, 'full mode must render the recognizable shell');
    assert.deepStrictEqual(full.stateNames, ['bright', 'dim', 'warm'], 'full mode must render all three flicker states');
    assert.ok(full.warmAnimCount > 0, 'full mode\'s warm face group must carry a live flicker animation');

    try {
      await setSettings({ performanceMode: true });
      const lite = await replay(snapshot);
      assert.ok(lite, 'expected a mounted pumpkin in Lite Mode');
      assert.strictEqual(lite.hasShell, true, 'Lite Mode must still render the recognizable shell');
      assert.deepStrictEqual(lite.stateNames, ['warm'], 'Lite Mode must drop the dim/bright flicker states -- only warm remains');
      assert.strictEqual(lite.warmOpacity, 1, 'Lite Mode\'s warm face must render at full, static opacity');
      assert.strictEqual(lite.warmAnimCount, 0, 'Lite Mode\'s warm face must carry NO animation of its own -- it is a static hold, not a flicker');
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on the pumpkin is actually canceled', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const mounted = await replay(() => (document.querySelector('.oc-jackolantern') ? true : null));
    assert.ok(mounted, 'sanity check: the pumpkin must actually mount before it can be cancelled');

    const animCount = await page.evaluate(() => {
      const el = document.querySelector('.oc-jackolantern');
      window.__jolTestAnims = el.getAnimations({ subtree: true });
      return window.__jolTestAnims.length;
    });
    // 1 whole-figure entrance/hold/exit + 3 flicker-state animations (dim/warm/bright) in
    // full mode.
    assert.strictEqual(animCount, 4, `expected 4 live WAAPI animations before cancellation (1 whole-figure + 3 flicker states), got ${animCount}`);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

    const states = await page.evaluate(() => window.__jolTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${states.join(', ')}`);
  });

  test('overlay close: pressing Escape with no dialog open tears down the whole finder, and no pumpkin or animation survives', async () => {
    const mounted = await replay(() => (document.querySelector('.oc-jackolantern') ? true : null));
    assert.ok(mounted, 'sanity check: the pumpkin must actually mount before the overlay closes');

    const animCount = await page.evaluate(() => {
      const el = document.querySelector('.oc-jackolantern');
      window.__jolOverlayTestAnims = el.getAnimations({ subtree: true });
      return window.__jolOverlayTestAnims.length;
    });
    assert.ok(animCount > 0, 'sanity check: the pumpkin must have live animations before the overlay closes');

    try {
      // No dialog (settings/lists panel) is open here, so the first Escape falls straight
      // through to window.__ocDestroy() (extension/content.js), which tears down the whole
      // finder -- and, via its own cancelBeacons() call, every in-flight beacon with it.
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });

      const states = await page.evaluate(() => window.__jolOverlayTestAnims.map((a) => a.playState));
      assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled after an overlay close, got: ${states.join(', ')}`);
      const remaining = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient').length);
      assert.strictEqual(remaining, 0, 'no .oc-beacon-transient node may survive an overlay close');
    } finally {
      // Reopen the finder and restore the shared 'quarklet' search for later tests.
      await openFinder(page);
      await page.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page);
    }
  });

  test('rapid refire: pressing Enter repeatedly, with no explicit cancel in between, never leaves more than one pumpkin mounted at once', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    // animate() itself calls cancelBeacons() as its own first statement (extension/
    // content.js) -- this drives the PRODUCTION re-fire path directly (no
    // window.__ocTest.cancelBeacons() call from the test), unlike replay()'s own idiom,
    // to prove that production call is what actually prevents a pile-up under rapid input.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Enter');
      const count = await page.evaluate(() => document.querySelectorAll('.oc-jackolantern').length);
      assert.ok(count <= 1, `expected at most one pumpkin mounted at once during rapid refire, got ${count} after press ${i + 1}`);
    }

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('natural completion: nothing remains in the DOM once the full flicker sequence finishes, with no cancel', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const mounted = await replay(() => (document.querySelector('.oc-jackolantern') ? true : null));
    assert.ok(mounted, 'sanity check: the pumpkin must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- this is the natural-completion path (entrance,
    // flicker hold, fade). A genuine leak surfaces as this wait's own TimeoutError.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
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

    try {
      // Disabled: absent from both availableEffects() and the picker DOM.
      await setSettings({ enabledPacks: [] });
      let keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.strictEqual(keys.indexOf('jackolantern'), -1, 'jackolantern must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(JOL_EFFECT_ROW).count(),
        0,
        'jackolantern must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      // Enabled: present in both.
      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('jackolantern'), -1, 'jackolantern must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(JOL_EFFECT_ROW).count(),
        1,
        'jackolantern must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'jackolantern' (a real,
      // registered -- just currently unavailable -- key, not a genuinely unknown one), so
      // firing must fall back to some other effect rather than mount a pumpkin or throw.
      await setSettings({ effect: 'jackolantern', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        pumpkinMounted: !!document.querySelector('.oc-jackolantern'),
      } : null));
      assert.strictEqual(geom.pumpkinMounted, false, 'while the pack is disabled, the runtime fallback must not render a pumpkin');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Selection restored on re-enable: no explicit re-selection of 'jackolantern' here --
      // if the disable step above had rewritten settings.effect, this would now fire
      // whatever it was rewritten to instead.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-jackolantern') ? { pumpkinMounted: true } : null));
      assert.strictEqual(geom.pumpkinMounted, true, 'the stored jackolantern selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs -- the
      // happy path above already leaves settings at exactly { effect: 'jackolantern',
      // enabledPacks: ['halloween'] }, so restoring straight to that value here would be a
      // no-op write that setSettings()'s echo-wait would hang on. Routing through a sentinel
      // value first guarantees both writes are genuine changes, regardless of which line
      // above (if any) actually threw.
      await setSettings({ enabledPacks: ['__oc_jackolantern_test_reset__'] });
      await setSettings({ effect: 'jackolantern', enabledPacks: ['halloween'] });
    }
  });
});
