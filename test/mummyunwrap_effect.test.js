// Mummy Unwrap beacon effect (oculist-l0bs.13): a Haunted Hollow (pack II) effect. A short,
// friendly mummy (wrapped / unwinding / collapse poses) stands beside the match and pulls a
// bandage strip off its shoulder in a loose spiral; the strip travels a path that frames the
// match at 7px clearance (underline, up the far side, across the top, frayed leading edge),
// then unspools, and the mummy collapses into a pile with its eyes still visible. There is
// no prototype; the beat spec on the bead stands in for one.
//
// Beats carrying a real risk, tested directly rather than just documented:
//
// 1. PROTECTED RECT (promotion contract rule 10, no exceptions): nothing the effect paints
//    (the mummy box, its poses, the three strip segments) may enter the match rect plus 6px
//    of clearance in ANY sampled frame, and the match's own pixels never change.
// 2. DOCUMENT SPACE (rule 2): inline left/top carry the scroll offset, while the side
//    decision (roomier side first, then the other, else suppress) is made from the
//    pre-scroll viewport.
// 3. The strip really frames the match: three lanes, each clear of the glyph box.
// 4. SUPPRESSION when neither side fits.
//
// Modeled on test/trickortreat_effect.test.js and test/trail_effect.test.js.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { scrollPageTo, POLL_TIMEOUT, waitForCondition, waitForOverlayResizeSettled } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');
const { waitForHalloweenSeedSettled } = require('./helpers/halloween_seed');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target: margin-left 100 -> the right side is roomier, so the mummy stands on the RIGHT.
// #leftTarget: pushed against the right edge -> the left side is roomier, so the mummy stands
// on the LEFT (the mirrored branch, exercised for real).
// #wideTarget: a 96px match ~526px wide: fits at 1200 wide, but wider than a 320px viewport,
// so neither side fits and the effect is suppressed.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:100px;overflow-wrap:anywhere;"><span id="target">vespertide</span> filler</div>
<div style="height:1600px"></div>
<div style="margin-left:1040px;white-space:nowrap;"><span id="leftTarget">duskwarden</span></div>
<div style="height:1000px"></div>
<p style="font-size:96px;"><span id="wideTarget">shadowmoth</span> filler</p>
<div style="height:1200px"></div>`;

const TARGET_TERMS = { target: 'vespertide', leftTarget: 'duskwarden', wideTarget: 'shadowmoth' };

const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const CAT_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:mummyunwrap"]';

// U 350, framing 500..1800, unspool 2050..3150, collapse 3150; full ends 3150 + 900 + 400,
// Lite ends 3150 + 400.
const FULL_DUR = 4450, LITE_DUR = 3550;
const CLEAR = 6;

describe('Mummy Unwrap: a friendly mummy frames the match with its bandage', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

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
    await waitForHalloweenSeedSettled(evalInContentScript);

    await setSettings({ effect: 'mummyunwrap', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

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

  async function cancelAndWaitClean() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  }

  async function replay(predicate, arg) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    const handle = await page.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-mummyunwrap="mummy"]') ? true : null)),
      arg !== undefined ? arg : null,
      { timeout: POLL_TIMEOUT }
    );
    return handle.jsonValue();
  }

  // A main-world MutationObserver armed before Enter pauses every animation at t=0 in the
  // microtask after the mount, so the state stays put (and can be seeked) until
  // cancelBeacons().
  async function replayFrozen() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.evaluate(() => {
      if (window.__otFreeze) window.__otFreeze.disconnect();
      window.__otFreeze = new MutationObserver(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((root) => {
          root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        });
      });
      window.__otFreeze.observe(document.documentElement, { childList: true, subtree: true });
    });
    try {
      return await replay();
    } finally {
      await page.evaluate(() => { window.__otFreeze.disconnect(); delete window.__otFreeze; });
    }
  }

  function seek(t) {
    return page.evaluate((tt) => {
      document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
        el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = tt; });
      });
    }, t);
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
    await scrollPageTo(page, Math.max(0, docTop - topOffset));
  }

  function measure(id) {
    return page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, vw: window.innerWidth, vh: window.innerHeight };
    }, id);
  }


  // Mirrors content.js's own sizing formula for a SANITY check on the fixture only; every
  // real assertion reads the live rendered DOM.
  function predictBox(m, beaconScale) {
    const figH = Math.max(56, Math.min(80, m.height * 3.2)) * beaconScale;
    const u = figH / 78;
    return { u, bt: Math.max(5, Math.round(figH * 0.09)), boxW: 64 * u };
  }

  // Everything the effect paints, in viewport space, at the current (seeked) time: every
  // overlay box plus the mummy's poses and ribbons and every strip's band group.
  function paintBoxes() {
    const out = [];
    document.querySelectorAll('.oc-beacon-transient[data-mummyunwrap]').forEach((root) => {
      out.push(root.getBoundingClientRect());
      root.querySelectorAll('[data-mw-pose], [data-mw-ribbon]').forEach((el) => out.push(el.getBoundingClientRect()));
    });
    return out.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  const MUMMY = '.oc-beacon-transient[data-mummyunwrap="mummy"]';

  test('document-space correctness: on a scrolled page, every overlay\'s inline left/top carry the scroll offset', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const m = await measure('target');
      const p = predictBox(m, 1);
      const geom = await replay(() => {
        const els = Array.from(document.querySelectorAll('.oc-beacon-transient[data-mummyunwrap]'));
        if (els.length < 4) return null;
        const mummy = document.querySelector('.oc-beacon-transient[data-mummyunwrap="mummy"]');
        return {
          left: mummy.style.left, top: mummy.style.top, side: mummy.getAttribute('data-mw-side'),
          positions: els.map((e) => e.style.position),
          strips: Array.from(document.querySelectorAll('[data-mw-seg]')).map((e) => ({ seg: e.getAttribute('data-mw-seg'), left: e.style.left, top: e.style.top })),
        };
      });
      assert.ok(geom.positions.every((x) => x === 'absolute'));
      assert.strictEqual(geom.side, 'right', 'the mummy stands on the roomier (right) side');
      assert.ok(Math.abs(parseFloat(geom.left) - (m.right + 8 + scroll.x)) <= 2, `style.left (${geom.left}) must include scrollX`);
      const expectedTop = m.bottom - 84 * p.u + scroll.y;
      assert.ok(Math.abs(parseFloat(geom.top) - expectedTop) <= 2, `style.top (${geom.top}) must include scrollY -- expected ~${expectedTop}`);
      const bottom = geom.strips.find((s) => s.seg === 'bottom');
      assert.ok(Math.abs(parseFloat(bottom.top) - (m.bottom + 7 + scroll.y)) <= 1, `underline lane top (${bottom.top}) must include scrollY`);
      const top = geom.strips.find((s) => s.seg === 'top');
      assert.ok(Math.abs(parseFloat(top.top) - (m.top - 7 - p.bt + scroll.y)) <= 1.5, `top lane (${top.top}) must include scrollY`);
      await cancelAndWaitClean();
    } finally {
      await scrollPageTo(page, 0);
    }
  });

  test('starting from a genuinely unscrolled page, Enter still finds and plays the effect', async () => {
    await scrollPageTo(page, 0);
    try {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted mummy even from scrollY=0');
      await cancelAndWaitClean();
    } finally {
      await scrollTargetTo('target', 200);
    }
  });

  test('right placement (default): unmirrored, baseline-aligned, three poses, a strip in three lanes, clear of the glyph box, match DOM untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);
    const m = await measure('target');
    await replayFrozen();
    const info = await page.evaluate(() => {
      const el = document.querySelector('[data-mummyunwrap="mummy"]');
      const r = el.getBoundingClientRect();
      return {
        side: el.getAttribute('data-mw-side'), mirrored: !!el.querySelector('[data-mw-mirrored]'),
        left: r.left, boxBottom: r.bottom,
        poses: Array.from(el.querySelectorAll('[data-mw-pose]')).map((g) => g.getAttribute('data-mw-pose')),
        ribbons: Array.from(el.querySelectorAll('[data-mw-ribbon]')).map((g) => g.getAttribute('data-mw-ribbon')),
        segs: Array.from(document.querySelectorAll('[data-mw-seg]')).map((s) => s.getAttribute('data-mw-seg')),
      };
    });
    assert.strictEqual(info.side, 'right');
    assert.strictEqual(info.mirrored, false);
    assert.deepStrictEqual(info.poses, ['wrapped', 'unwinding', 'collapse']);
    assert.deepStrictEqual(info.ribbons, ['spiral', 'scurve']);
    assert.deepStrictEqual(info.segs, ['bottom', 'side', 'top']);
    assert.ok(info.left - m.right >= CLEAR, `mummy box (${info.left}) must clear the glyph box (${m.right}) by ${CLEAR}px`);
    assert.ok(info.boxBottom - m.bottom >= CLEAR, 'the box carries the underline lane below the match line');
    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated');
    await cancelAndWaitClean();
  });

  test('left placement (fallback, mirrored branch exercised for real): when the right side has no room the mummy sits on the left and the strip runs the other way, decided from the PRE-SCROLL viewport rect', async () => {
    await switchToTarget('leftTarget')();
    await scrollTargetTo('leftTarget', 200);
    const scrollY = await page.evaluate(() => window.scrollY);
    assert.ok(scrollY > 0, 'sanity check: scrolled page');
    const m = await measure('leftTarget');
    assert.ok(m.vw - m.right < m.left, 'sanity check: the left side is the roomier one');
    await replayFrozen();
    const info = await page.evaluate(() => {
      const el = document.querySelector('[data-mummyunwrap="mummy"]');
      const r = el.getBoundingClientRect();
      const side = document.querySelector('[data-mw-seg="side"]').getBoundingClientRect();
      return { side: el.getAttribute('data-mw-side'), mirrored: !!el.querySelector('[data-mw-mirrored]'), right: r.right, left: r.left, sideLeft: side.left };
    });
    assert.strictEqual(info.side, 'left');
    assert.strictEqual(info.mirrored, true);
    assert.ok(m.left - info.right >= CLEAR, `mummy box right (${info.right}) must clear the glyph box (${m.left}) by ${CLEAR}px`);
    assert.ok(info.left >= 0, 'stays on screen');
    assert.ok(info.sideLeft - m.right >= CLEAR, 'the far-side lane runs up the RIGHT of the match when the mummy is on the left');
    await cancelAndWaitClean();
  });

  test('framing run: the strip is an underline, then up the far side, then across the top, ending in a frayed leading edge, then unspools tail-first', async () => {
    await switchToTarget('target')();
    await scrollTargetTo('target', 200);
    const m = await measure('target');
    await replayFrozen();
    const info = await page.evaluate(() => {
      const get = (n) => {
        const el = document.querySelector('[data-mw-seg="' + n + '"]');
        const r = el.getBoundingClientRect();
        const band = el.querySelector('[data-mw-band]');
        return { r: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, kf: band.getAnimations()[0].effect.getKeyframes().length, frays: band.querySelectorAll('path[stroke-linejoin="round"]').length };
      };
      return { bottom: get('bottom'), side: get('side'), top: get('top') };
    });
    assert.ok(info.bottom.r.top - m.bottom >= CLEAR && info.bottom.r.left < m.left && info.bottom.r.right > m.right, 'underline lane spans the width below the match');
    assert.ok(m.left - info.side.r.right >= CLEAR && info.side.r.top < m.top && info.side.r.bottom > m.bottom, 'side lane runs the height on the far side');
    assert.ok(m.top - info.top.r.bottom >= CLEAR && info.top.r.right > m.right, 'top lane crosses above the match');
    assert.strictEqual(info.bottom.frays, 0);
    assert.strictEqual(info.side.frays, 0);
    assert.strictEqual(info.top.frays, 1, 'only the leading (last) segment carries the frayed end');
    // The leading edge reaches each lane in order: bottom, then side, then top.
    const ends = await page.evaluate(() => ['bottom', 'side', 'top'].map((n) => {
      const b = document.querySelector('[data-mw-seg="' + n + '"] [data-mw-band]');
      const kf = b.getAnimations()[0].effect.getKeyframes();
      return kf[2].offset;
    }));
    assert.ok(ends[0] < ends[1] && ends[1] < ends[2], `head offsets must be in order: ${ends}`);
    // At the end of the run the strip is fully drawn in its lane; after the unspool nothing is left.
    await seek(1900);
    const drawn = await page.evaluate(() => Array.from(document.querySelectorAll('[data-mw-seg] [data-mw-band]')).map((b) => new DOMMatrix(getComputedStyle(b).transform).e));
    drawn.forEach((e, i) => assert.ok(e > 0, `segment ${i} content must be in its lane at the hold (tx=${e})`));
    await seek(FULL_DUR - 420);
    const gone = await page.evaluate(() => Array.from(document.querySelectorAll('[data-mw-seg] [data-mw-band]')).map((b) => new DOMMatrix(getComputedStyle(b).transform).e));
    gone.forEach((e, i) => assert.ok(e > 0 && e >= drawn[i], `segment ${i} content has been pulled through (tx=${e})`));
    await cancelAndWaitClean();
  });

  test('protected rect: across the whole sequence nothing the effect paints enters the match rect plus 6px, on both sides', async () => {
    for (const id of ['target', 'leftTarget']) {
      await switchToTarget(id)();
      await scrollTargetTo(id, 200);
      const m = await measure(id);
      const prot = { left: m.left - CLEAR, right: m.right + CLEAR, top: m.top - CLEAR, bottom: m.bottom + CLEAR };
      await replayFrozen();
      for (let t = 0; t <= FULL_DUR; t += 100) {
        await seek(t);
        const boxes = await page.evaluate(paintBoxes);
        assert.ok(boxes.length > 0);
        boxes.forEach((b) => assert.ok(!intersects(b, prot), `${id}: a painted box ${JSON.stringify(b)} entered the protected rect ${JSON.stringify(prot)} at t=${t}ms`));
      }
      await cancelAndWaitClean();
    }
    await switchToTarget('target')();
    await scrollTargetTo('target', 200);
  });

  test('protected rect (pixels): the match rect shows zero painted-pixel delta at every sampled frame', async () => {
    await replay();
    await cancelAndWaitClean();
    const clip = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    });
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

      await cancelAndWaitClean();
      const base = await decode(await page.screenshot({ clip }));
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-mummyunwrap="mummy"]'), null, { timeout: POLL_TIMEOUT });
      let maxDelta = 0, worstT = -1;
      for (let t = 0; t <= FULL_DUR; t += 150) {
        await seek(t);
        const shot = await decode(await page.screenshot({ clip }));
        for (let i = 0; i < base.length; i += 4) {
          const d = Math.max(Math.abs(base[i] - shot[i]), Math.abs(base[i + 1] - shot[i + 1]), Math.abs(base[i + 2] - shot[i + 2]));
          if (d > maxDelta) { maxDelta = d; worstT = t; }
        }
      }
      assert.strictEqual(maxDelta, 0, `match rect must show zero painted-pixel delta; worst delta ${maxDelta} at t=${worstT}ms`);
    } finally {
      if (decodePage) await decodePage.close();
      await cancelAndWaitClean();
    }
  });

  test('beat order: wrapped, then unwinding (spiral strip), then the S-curve while it unspools, then the collapsed pile with eyes visible', async () => {
    await scrollTargetTo('target', 200);
    await replayFrozen();
    const state = () => page.evaluate(() => {
      const op = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).opacity);
      return {
        wrapped: op('[data-mw-pose="wrapped"]'), unwinding: op('[data-mw-pose="unwinding"]'), collapse: op('[data-mw-pose="collapse"]'),
        spiral: op('[data-mw-ribbon="spiral"]'), scurve: op('[data-mw-ribbon="scurve"]'),
      };
    });
    await seek(200);
    let s = await state();
    assert.deepStrictEqual([s.wrapped, s.unwinding, s.collapse], [1, 0, 0]);
    await seek(1000);
    s = await state();
    assert.deepStrictEqual([s.wrapped, s.unwinding, s.collapse], [0, 1, 0]);
    assert.deepStrictEqual([s.spiral, s.scurve], [1, 0], 'the strip leaves the shoulder in the loose spiral phase');
    await seek(2500);
    s = await state();
    assert.deepStrictEqual([s.spiral, s.scurve], [0, 1], 'the strip is in the S-curve phase while it unspools');
    await seek(3700);
    s = await state();
    assert.deepStrictEqual([s.wrapped, s.unwinding, s.collapse], [0, 0, 1]);
    const eyes = await page.evaluate(() => document.querySelectorAll('[data-mw-pose="collapse"] circle[fill="#FFD45A"]').length);
    assert.strictEqual(eyes, 2, 'two eyes still visible in the pile');
    await cancelAndWaitClean();
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation is canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (document.querySelectorAll('.oc-beacon-transient[data-mummyunwrap]').length < 4) return null;
      window.__mwTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__mwTestAnims.length;
    });
    // mummy: wrapper 1 + poses 3 + spiral 1 + S-curve 1 + sway 1 + settle 1 = 8; strips 3 x (wrapper + band) = 6.
    assert.strictEqual(animCount, 14);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    const states = await page.evaluate(() => window.__mwTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got: ${[...new Set(states)].join(', ')}`);
    await page.evaluate(() => { delete window.__mwTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted);
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: straight band only, no pile, no sway; keeps the mummy, the framing run and the frayed edge', async () => {
    await scrollTargetTo('target', 200);
    try {
      await setSettings({ performanceMode: true });
      await replayFrozen();
      const info = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.oc-beacon-transient'));
        return {
          total: els.flatMap((e) => e.getAnimations({ subtree: true })).length,
          poses: Array.from(document.querySelectorAll('[data-mw-pose]')).map((g) => g.getAttribute('data-mw-pose')),
          ribbons: Array.from(document.querySelectorAll('[data-mw-ribbon]')).map((g) => g.getAttribute('data-mw-ribbon')),
          segs: document.querySelectorAll('[data-mw-seg]').length,
          sway: document.querySelector('[data-mw-part="sway"]').getAnimations().length,
          frays: document.querySelectorAll('[data-mw-seg="top"] [data-mw-band] path[stroke-linejoin="round"]').length,
          end: Math.max(...els.flatMap((e) => e.getAnimations({ subtree: true })).map((a) => a.effect.getComputedTiming().endTime)),
        };
      });
      // mummy wrapper 1 + poses 2 + straight ribbon 1 = 4; strips 6.
      assert.strictEqual(info.total, 10);
      assert.deepStrictEqual(info.poses, ['wrapped', 'unwinding']);
      assert.deepStrictEqual(info.ribbons, ['straight']);
      assert.strictEqual(info.segs, 3);
      assert.strictEqual(info.sway, 0);
      assert.strictEqual(info.frays, 1, 'the frayed leading edge stays');
      assert.ok(info.end <= LITE_DUR + 1, `Lite sequence is shorter (${info.end}ms)`);
    } finally {
      await setSettings({ performanceMode: false });
      await cancelAndWaitClean();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the mummy\'s rendered box scales', async () => {
    async function renderedHeight() {
      await replayFrozen();
      return page.evaluate(() => document.querySelector('[data-mummyunwrap="mummy"]').getBoundingClientRect().height);
    }
    await scrollTargetTo('target', 200);
    let currentSize = 'm';
    try {
      const base = await renderedHeight();
      for (const [size, factor] of [['s', 0.7], ['l', 1.5]]) {
        currentSize = size;
        await setVisionSettings({ beaconSize: size });
        const h = await renderedHeight();
        assert.ok(Math.abs(h - base * factor) <= 4, `Beacon Size ${size}: expected ~${base * factor}, got ${h}`);
      }
    } finally {
      if (currentSize !== 'm') await setVisionSettings({ beaconSize: 'm' });
      await cancelAndWaitClean();
    }
  });

  test('Animation Speed, set for real through chrome.storage.sync: every rendered WAAPI duration AND delay scales', async () => {
    async function renderedTimings() {
      await replayFrozen();
      return page.evaluate(collectAnimationTimings);
    }
    await scrollTargetTo('target', 200);
    let currentSpeed = 'normal';
    try {
      const base = await renderedTimings();
      assert.ok(base.length > 0);
      for (const [speed, factor] of [['fast', 0.5], ['slow', 1.75]]) {
        currentSpeed = speed;
        await setVisionSettings({ animationSpeed: speed });
        const timings = await renderedTimings();
        assert.strictEqual(timings.length, base.length);
        timings.forEach((t, i) => {
          assert.ok(Math.abs(t.duration - base[i].duration * factor) <= 1, `${speed}: duration[${i}] ${t.duration} vs ${base[i].duration * factor}`);
          assert.ok(Math.abs(t.delay - base[i].delay * factor) <= 1, `${speed}: delay[${i}] ${t.delay} vs ${base[i].delay * factor}`);
        });
      }
    } finally {
      if (currentSpeed !== 'normal') await setVisionSettings({ animationSpeed: 'normal' });
      await cancelAndWaitClean();
    }
  });

  test('suppression: when neither side has room, nothing mounts and the match is untouched', async () => {
    await switchToTarget('wideTarget')();
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 320, height: 800 });
    try {
      await scrollTargetTo('wideTarget', 200);
      const before = await page.evaluate(() => document.getElementById('wideTarget').outerHTML);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 600));
      const mounted = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient[data-mummyunwrap]').length);
      assert.strictEqual(mounted, 0, 'the bucket must be suppressed rather than cover the match');
      const after = await page.evaluate(() => document.getElementById('wideTarget').outerHTML);
      assert.strictEqual(after, before);
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await scrollPageTo(page, 0);
      await switchToTarget('target')();
      await scrollTargetTo('target', 200);
    }
  });

  test('viewport edges: at a small 500x300 viewport the mummy either stays on screen or is suppressed, and the match DOM stays untouched', async () => {
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 500, height: 300 });
    try {
      await scrollTargetTo('target', 100);
      const before = await page.evaluate(() => document.getElementById('target').outerHTML);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 300));
      const box = await page.evaluate(() => {
        const el = document.querySelector('.oc-beacon-transient[data-mummyunwrap="mummy"]');
        if (!el) return null;
        el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      if (box) assert.ok(box.left >= 0 && box.right <= 500, `a mounted bucket must start on screen, got ${JSON.stringify(box)}`);
      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before);
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await scrollPageTo(page, 0);
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
      await scrollTargetTo('target', 200);
    }
  });

  test('determinism: the effect never calls Math.random', () => {
    const src = fs.readFileSync(path.join(EXTENSION, 'content.js'), 'utf8');
    const start = src.indexOf('function animateMummyUnwrap(rect)');
    const end = src.indexOf('  // Companion overlay to drawActiveMatchLabel', start);
    assert.ok(start !== -1 && end > start);
    assert.ok(!/Math\.random/.test(src.slice(start, end)));
  });

  test('pack enumeration: absent while halloween is disabled, present once enabled, selection survives a disable/re-enable round trip, and the runtime falls back safely', async () => {
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
      assert.strictEqual(keys.indexOf('mummyunwrap'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(CAT_EFFECT_ROW).count(), 0, 'absent from the picker while its pack is disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('mummyunwrap'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(CAT_EFFECT_ROW).count(), 1, 'present in the picker once its pack is enabled');
      await closeSettings();

      // The stored selection is NOT rewritten while the pack is disabled.
      await setSettings({ effect: 'mummyunwrap', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'mummyunwrap', 'stored selection must not be rewritten when the pack is disabled');

      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-mummyunwrap]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the bucket');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-mummyunwrap="mummy"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored selection must be restored on re-enable');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await setSettings({ enabledPacks: ['__oc_mummyunwrap_test_reset__'] });
      await setSettings({ effect: 'mummyunwrap', enabledPacks: ['halloween'] });
    }
  });
});
