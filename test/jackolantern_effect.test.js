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
      const panelRect = panel.getBoundingClientRect();
      const targetRect = document.getElementById('target').getBoundingClientRect();
      return {
        panelFill: panel.getAttribute('fill'),
        panelFillOpacity: panel.getAttribute('fill-opacity'),
        panelLeft: panelRect.left,
        panelTop: panelRect.top,
        panelRight: panelRect.right,
        panelBottom: panelRect.bottom,
        targetLeft: targetRect.left,
        targetTop: targetRect.top,
        targetRight: targetRect.right,
        targetBottom: targetRect.bottom,
      };
    });
    assert.ok(geom, 'expected a mounted pumpkin in mouth mode');

    // Deliberate tint contract (oculist-xl8f's own close comment / oculist-nq1x.15's close
    // reason): fill stays the shell's own identity orange, fill-opacity stays exactly 0.18
    // -- neither fully opaque (which would occlude the match) nor fully transparent (which
    // would silently drop the deliberate tint the human decision requires).
    assert.strictEqual(geom.panelFill, '#E86F1C', `mouth panel fill: expected the shell's own identity orange, got ${geom.panelFill}`);
    assert.strictEqual(geom.panelFillOpacity, '0.18', `mouth panel fill-opacity: expected the accepted 0.18 tint, got ${geom.panelFillOpacity}`);

    // Containment: the panel (which spans the whole cavity) must contain the match rect
    // with slack on every side -- the real 6px clearance contract, read from the RENDERED
    // element, not recomputed geometry.
    assert.ok(geom.panelLeft <= geom.targetLeft, `cavity left (${geom.panelLeft}) must sit at or left of the match's own left edge (${geom.targetLeft})`);
    assert.ok(geom.panelTop <= geom.targetTop, `cavity top (${geom.panelTop}) must sit at or above the match's own top edge (${geom.targetTop})`);
    assert.ok(geom.panelRight >= geom.targetRight, `cavity right (${geom.panelRight}) must sit at or right of the match's own right edge (${geom.targetRight})`);
    assert.ok(geom.panelBottom >= geom.targetBottom, `cavity bottom (${geom.panelBottom}) must sit at or below the match's own bottom edge (${geom.targetBottom})`);

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

      // Real rendered clearance gap: the pumpkin's own rendered box must never reach the
      // match's own top edge -- read from getBoundingClientRect() of the mounted element,
      // not recomputed geometry.
      const rendered = await page.evaluate(() => {
        const el = document.querySelector('.oc-jackolantern');
        const rect = el.getBoundingClientRect();
        const target = document.getElementById('wideTarget').getBoundingClientRect();
        return { bottom: rect.bottom, targetTop: target.top };
      });
      assert.ok(
        rendered.bottom <= rendered.targetTop + 1,
        `the pumpkin's rendered bottom edge (${rendered.bottom}) must clear the match's own top edge ` +
          `(${rendered.targetTop}) -- it must never paint over the match's own glyphs`
      );

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

  test('Beacon Size M/L/XL, set for real through chrome.storage.sync: mouth mode never rescales (a hard containment requirement, not a stylistic one), and the cavity keeps clearing the match at every size', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));

    async function mouthRenderedBox() {
      await replay(() => (document.querySelector('.oc-jackolantern[data-jol-mode="mouth"]') ? true : null));
      await page.waitForFunction(() => {
        const el = document.querySelector('.oc-jackolantern');
        return el && parseFloat(getComputedStyle(el).opacity) > 0.98 ? true : null;
      }, null, { timeout: POLL_TIMEOUT });
      return page.evaluate(() => {
        const el = document.querySelector('.oc-jackolantern');
        const panel = el.querySelector('[data-jol-part="mouth-panel"]');
        const rect = el.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const target = document.getElementById('target').getBoundingClientRect();
        return { width: rect.width, height: rect.height, panelRect, target };
      });
    }

    try {
      const base = await mouthRenderedBox();
      const SIZES = ['l', 'xl'];
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

        // The 6px clearance contract still holds at every size.
        assert.ok(geom.panelRect.left <= geom.target.left, `Beacon Size ${size}: cavity left must still clear the match's left edge`);
        assert.ok(geom.panelRect.top <= geom.target.top, `Beacon Size ${size}: cavity top must still clear the match's top edge`);
        assert.ok(geom.panelRect.right >= geom.target.right, `Beacon Size ${size}: cavity right must still clear the match's right edge`);
        assert.ok(geom.panelRect.bottom >= geom.target.bottom, `Beacon Size ${size}: cavity bottom must still clear the match's bottom edge`);
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
