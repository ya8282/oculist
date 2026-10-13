// Trick-or-Treat beacon effect (oculist-l0bs.14): a Haunted Hollow (pack II) effect. A glossy
// plastic candy bucket with a visible rim and arched handle appears beside the match; five
// candies (wrapped square, wrapped round, striped swirl, lollipop, candy corn) drop one at a
// time into it, each with a small squash and a rim bounce; the bucket tilts 5 degrees while
// catching and ends full, heaped above the rim, with a stretched smile. There is no
// prototype; the beat spec on the bead stands in for one.
//
// Beats carrying a real risk, tested directly rather than just documented:
//
// 1. PROTECTED RECT (promotion contract rule 10, no exceptions): nothing the bucket paints
//    (overlay box, shell, candies) may enter the match rect plus 6px of clearance in ANY
//    sampled frame, and the match's own pixels never change.
// 2. DOCUMENT SPACE (rule 2): inline left/top carry the scroll offset, while the side
//    decision (right first, then left, else suppress) is made from the pre-scroll viewport.
// 3. The candy column stays inside the bucket's x-range, never above the match.
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

// #target: margin-left 100 -> plenty of room on the right, so the bucket sits on the RIGHT.
// #leftTarget: pushed against the right edge -> no room on the right, so it falls back LEFT
// (the mirrored branch, exercised for real).
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
const CAT_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:trickortreat"]';

// Last landing 300 + 4*400 + 480 = 2380 (full), 300 + 2*400 + 480 = 1580 (Lite); plus 1200.
const FULL_DUR = 3580, LITE_DUR = 2780;
const CLEAR = 6;

describe('Trick-or-Treat: candy falls into a pumpkin bucket beside the match', () => {
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

    await setSettings({ effect: 'trickortreat', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

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
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-trickortreat="bucket"]') ? true : null)),
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


  // Mirrors content.js's own sizing/placement formula for a SANITY check on the fixture only;
  // every real assertion reads the live rendered DOM.
  function predictBox(m, beaconScale) {
    const figH = Math.max(56, Math.min(80, m.height * 3.2)) * beaconScale;
    const u = figH / 72;
    return { u, boxW: 84 * u, boxH: 150 * u };
  }

  // Everything the bucket paints, in viewport space, at the current (seeked) time: the
  // overlay box plus every candy and the shell.
  function paintBoxes() {
    const out = [];
    const root = document.querySelector('.oc-beacon-transient[data-trickortreat="bucket"]');
    if (!root) return out;
    const sel = ['[data-ot-part="shell"]', '[data-ot-part="back"]', '[data-ot-candy]'];
    out.push(root.getBoundingClientRect());
    sel.forEach((s) => root.querySelectorAll(s).forEach((el) => out.push(el.getBoundingClientRect())));
    return out.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  test('document-space correctness: on a scrolled page, the wrapper\'s inline left/top carry the scroll offset', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const m = await measure('target');
      const p = predictBox(m, 1);
      const geom = await replay(() => {
        const el = document.querySelector('.oc-beacon-transient[data-trickortreat="bucket"]');
        return el ? { left: el.style.left, top: el.style.top, side: el.getAttribute('data-ot-side'), position: el.style.position } : null;
      });
      assert.strictEqual(geom.position, 'absolute');
      assert.strictEqual(geom.side, 'right', 'the bucket defaults to the right side');
      const expectedLeft = m.right + 8 + scroll.x;
      const expectedTop = m.bottom - 146 * p.u + scroll.y;
      assert.ok(Math.abs(parseFloat(geom.left) - expectedLeft) <= 2, `style.left (${geom.left}) must include scrollX -- expected ~${expectedLeft}`);
      assert.ok(Math.abs(parseFloat(geom.top) - expectedTop) <= 2, `style.top (${geom.top}) must include scrollY -- expected ~${expectedTop}`);
      await cancelAndWaitClean();
    } finally {
      await scrollPageTo(page, 0);
    }
  });

  test('starting from a genuinely unscrolled page, Enter still finds and plays the effect', async () => {
    await scrollPageTo(page, 0);
    try {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted bucket even from scrollY=0');
      await cancelAndWaitClean();
    } finally {
      await scrollTargetTo('target', 200);
    }
  });

  test('right placement (default): unmirrored, baseline-aligned with the match, clear of the glyph box by at least 6px, match DOM untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);
    const m = await measure('target');
    await replayFrozen();
    const info = await page.evaluate(() => {
      const el = document.querySelector('[data-trickortreat="bucket"]');
      const r = el.getBoundingClientRect();
      const base = el.querySelector('[data-ot-part="shell"]').getBoundingClientRect();
      return {
        side: el.getAttribute('data-ot-side'), mirrored: !!el.querySelector('[data-ot-mirrored]'),
        left: r.left, shellBottom: base.bottom,
        poses: Array.from(el.querySelectorAll('[data-ot-pose]')).map((g) => g.getAttribute('data-ot-pose')),
        candies: el.querySelectorAll('[data-ot-candy]').length,
      };
    });
    assert.strictEqual(info.side, 'right');
    assert.strictEqual(info.mirrored, false);
    assert.deepStrictEqual(info.poses, ['empty', 'catching', 'full']);
    assert.strictEqual(info.candies, 5);
    assert.ok(info.left - m.right >= CLEAR, `bucket box (${info.left}) must clear the glyph box (${m.right}) by ${CLEAR}px`);
    assert.ok(Math.abs(info.shellBottom - m.bottom) <= 6, `bucket base (${info.shellBottom}) is on the match's line (${m.bottom})`);
    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated');
    await cancelAndWaitClean();
  });

  test('left placement (fallback, mirrored branch exercised for real): when the right side has no room the bucket sits on the left, decided from the PRE-SCROLL viewport rect', async () => {
    await switchToTarget('leftTarget')();
    await scrollTargetTo('leftTarget', 200);
    const scrollY = await page.evaluate(() => window.scrollY);
    assert.ok(scrollY > 0, 'sanity check: scrolled page');
    const m = await measure('leftTarget');
    assert.ok(m.vw - m.right < 90, 'sanity check: fixture leaves no room on the right');
    await replayFrozen();
    const info = await page.evaluate(() => {
      const el = document.querySelector('[data-trickortreat="bucket"]');
      const r = el.getBoundingClientRect();
      return { side: el.getAttribute('data-ot-side'), mirrored: !!el.querySelector('[data-ot-mirrored]'), right: r.right, left: r.left };
    });
    assert.strictEqual(info.side, 'left');
    assert.strictEqual(info.mirrored, true);
    assert.ok(m.left - info.right >= CLEAR, `bucket box right (${info.right}) must clear the glyph box (${m.left}) by ${CLEAR}px`);
    assert.ok(info.left >= 0, 'stays on screen');
    await cancelAndWaitClean();
  });

  test('candy column: five candies in the fixed order, one every 400ms, each falling in an x column inside the bucket box (never above the match), with squash and rim bounce in full mode', async () => {
    await switchToTarget('target')();
    await scrollTargetTo('target', 200);
    const m = await measure('target');
    await replayFrozen();
    const info = await page.evaluate(() => {
      const el = document.querySelector('[data-trickortreat="bucket"]');
      const box = el.getBoundingClientRect();
      return {
        delays: Array.from(el.querySelectorAll('[data-ot-candy]')).map((c) => c.getAnimations()[0].effect.getComputedTiming().delay),
        order: Array.from(el.querySelectorAll('[data-ot-candy]')).map((c) => c.getAttribute('data-ot-candy')),
        boxLeft: box.left, boxRight: box.right,
        squash: Array.from(el.querySelectorAll('[data-ot-candy] g g')).filter((g) => g.getAnimations().length === 1).length,
        bounce: el.querySelector('[data-ot-part="shell"]').getAnimations().length,
      };
    });
    assert.deepStrictEqual(info.order, ['0', '1', '2', '3', '4']);
    assert.deepStrictEqual(info.delays, [300, 700, 1100, 1500, 1900]);
    assert.strictEqual(info.squash, 5, 'one landing squash per candy');
    assert.strictEqual(info.bounce, 1, 'one rim-bounce animation');
    assert.ok(info.boxLeft > m.right, 'the whole candy column sits beside the match, never above its x-range');
    for (let t = 0; t <= FULL_DUR; t += 200) {
      await seek(t);
      const xs = await page.evaluate(() => Array.from(document.querySelectorAll('[data-ot-candy]')).filter((c) => getComputedStyle(c).opacity !== '0').map((c) => { const r = c.getBoundingClientRect(); return [r.left, r.right]; }));
      xs.forEach(([l, r]) => assert.ok(l >= info.boxLeft - 0.5 && r <= info.boxRight + 0.5, `candy [${l}, ${r}] left the bucket's column at t=${t}ms`));
    }
    await cancelAndWaitClean();
  });

  test('protected rect: across the whole sequence nothing the bucket paints enters the match rect plus 6px, on both sides', async () => {
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
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-trickortreat="bucket"]'), null, { timeout: POLL_TIMEOUT });
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

  test('beat order: empty face, candies land one by one, 5-degree tilt while catching, then full with the stretched smile and an upright bucket', async () => {
    await scrollTargetTo('target', 200);
    await replayFrozen();
    const state = () => page.evaluate(() => {
      const op = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).opacity);
      const candies = Array.from(document.querySelectorAll('[data-ot-candy]')).map((c) => parseFloat(getComputedStyle(c).opacity));
      const tilt = (sel) => {
        const m = new DOMMatrix(getComputedStyle(document.querySelector(sel)).transform);
        return Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI * 100) / 100;
      };
      return {
        empty: op('[data-ot-pose="empty"]'), catching: op('[data-ot-pose="catching"]'), full: op('[data-ot-pose="full"]'),
        candies, tiltFront: tilt('[data-ot-part="front"]'), tiltBack: tilt('[data-ot-part="back"]'),
      };
    });
    await seek(200);
    let s = await state();
    assert.deepStrictEqual([s.empty, s.catching, s.full], [1, 0, 0]);
    assert.ok(s.candies.every((o) => o === 0), 'no candy has started falling yet');
    assert.strictEqual(s.tiltFront, 0);
    await seek(500);
    s = await state();
    assert.ok(s.candies[0] > 0 && s.candies[1] === 0, `the first candy is falling alone at 500ms: ${s.candies}`);
    await seek(1500);
    s = await state();
    assert.deepStrictEqual([s.empty, s.catching, s.full], [0, 1, 0]);
    assert.ok(Math.abs(s.tiltFront - 5) < 0.01 && Math.abs(s.tiltBack - 5) < 0.01, `bucket tilts 5 degrees while catching: ${s.tiltFront}/${s.tiltBack}`);
    assert.ok(s.candies[0] > 0 && s.candies[2] > 0, 'earlier candies stay');
    await seek(3200);
    s = await state();
    assert.deepStrictEqual([s.empty, s.catching, s.full], [0, 0, 1]);
    assert.ok(s.candies.every((o) => o === 1), 'the whole heap is in the bucket when full');
    assert.strictEqual(s.tiltFront, 0, 'upright again when full');
    await cancelAndWaitClean();
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation is canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-trickortreat="bucket"]')) return null;
      window.__otTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__otTestAnims.length;
    });
    // wrapper 1 + faces 3 + tilt 2 + candy falls 5 + squashes 5 + rim bounce 1 = 17.
    assert.strictEqual(animCount, 17);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    const states = await page.evaluate(() => window.__otTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got: ${[...new Set(states)].join(', ')}`);
    await page.evaluate(() => { delete window.__otTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted);
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: three candies, no squash or bounce; keeps the bucket, the tilt and the three face states', async () => {
    await scrollTargetTo('target', 200);
    try {
      await setSettings({ performanceMode: true });
      await replayFrozen();
      const info = await page.evaluate(() => {
        const el = document.querySelector('[data-trickortreat="bucket"]');
        return {
          total: el.getAnimations({ subtree: true }).length,
          candies: el.querySelectorAll('[data-ot-candy]').length,
          bounce: el.querySelector('[data-ot-part="shell"]').getAnimations().length,
          tilt: el.querySelector('[data-ot-part="front"]').getAnimations().length,
          poses: el.querySelectorAll('[data-ot-pose]').length,
          end: Math.max(...el.getAnimations({ subtree: true }).map((a) => a.effect.getComputedTiming().endTime)),
        };
      });
      // wrapper 1 + faces 3 + tilt 2 + candy falls 3 = 9.
      assert.strictEqual(info.total, 9);
      assert.strictEqual(info.candies, 3);
      assert.strictEqual(info.bounce, 0, 'no rim bounce in Lite Mode');
      assert.strictEqual(info.tilt, 1, 'the tilt stays');
      assert.strictEqual(info.poses, 3);
      assert.ok(info.end <= LITE_DUR + 1, `Lite sequence is shorter (${info.end}ms)`);
      await seek(LITE_DUR - 400);
      const full = await page.evaluate(() => getComputedStyle(document.querySelector('[data-ot-pose="full"]')).opacity);
      assert.strictEqual(full, '1', 'Lite still ends full');
    } finally {
      await setSettings({ performanceMode: false });
      await cancelAndWaitClean();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the bucket\'s rendered box scales', async () => {
    async function renderedHeight() {
      await replayFrozen();
      return page.evaluate(() => document.querySelector('[data-trickortreat="bucket"]').getBoundingClientRect().height);
    }
    await scrollTargetTo('target', 200);
    let currentSize = 'm';
    try {
      const base = await renderedHeight();
      for (const [size, factor] of [['s', 0.7], ['l', 1.5]]) {
        currentSize = size;
        await setVisionSettings({ beaconSize: size });
        const h = await renderedHeight();
        assert.ok(Math.abs(h - base * factor) <= 2, `Beacon Size ${size}: expected ~${base * factor}, got ${h}`);
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
      const mounted = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient[data-trickortreat]').length);
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

  test('viewport edges: at a small 500x300 viewport the bucket either stays on screen or is suppressed, and the match DOM stays untouched', async () => {
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 500, height: 300 });
    try {
      await scrollTargetTo('target', 100);
      const before = await page.evaluate(() => document.getElementById('target').outerHTML);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 300));
      const box = await page.evaluate(() => {
        const el = document.querySelector('.oc-beacon-transient[data-trickortreat="bucket"]');
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
    const start = src.indexOf('function animateTrickOrTreat(rect)');
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
      assert.strictEqual(keys.indexOf('trickortreat'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(CAT_EFFECT_ROW).count(), 0, 'absent from the picker while its pack is disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('trickortreat'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(CAT_EFFECT_ROW).count(), 1, 'present in the picker once its pack is enabled');
      await closeSettings();

      // The stored selection is NOT rewritten while the pack is disabled.
      await setSettings({ effect: 'trickortreat', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'trickortreat', 'stored selection must not be rewritten when the pack is disabled');

      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-trickortreat]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the bucket');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-trickortreat="bucket"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored selection must be restored on re-enable');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await setSettings({ enabledPacks: ['__oc_trickortreat_test_reset__'] });
      await setSettings({ effect: 'trickortreat', enabledPacks: ['halloween'] });
    }
  });
});
