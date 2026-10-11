// Grave Hands beacon effect (oculist-l0bs.7), a Haunted Hollow (pack II) effect.
// A strip of soil appears BELOW the match; a zombie hand bursts through it (three clods fly
// off), the forearm and ragged sleeve rise and lean toward the match, a smaller mirrored
// second hand pops up a beat later, both curl into a clutching claw, hold, then sink back
// and the mound fades. There is no prototype; the beat spec on the bead stands in for one.
//
// Beats carrying a real risk, tested directly rather than just documented:
//
// 1. PROTECTED RECT (promotion contract rule 10, no exceptions): the effect's whole box
//    stays below the match rect plus 6px of clearance in EVERY sampled frame, and the match's
//    own pixels never change.
// 2. DOCUMENT SPACE (rule 2): the wrapper's inline left/top carry the scroll offset, while the
//    room-below decision is made from the pre-scroll viewport rect.
// 3. Exactly five digits per hand in every pose; the second hand is a real mirrored branch.
// 4. SUPPRESSION when there is no room below the match.
//
// Modeled on test/blackcatpounce_effect.test.js and test/trail_effect.test.js (real HTTP
// fixture, CDP isolated-world attach, tall-spacer layout, scrollBehavior 'instant').

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

// #target: mid-page match. #leftTarget / #rightTarget sit flush against the left / right
// viewport edges, so the box (wider than the match) must clamp on screen.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:600px;"><span id="target">vespertide</span> filler</div>
<div style="height:1600px"></div>
<div style="margin-left:-40px;"><span id="leftTarget">duskwarden</span> filler</div>
<div style="height:1000px"></div>
<div style="text-align:right;margin-right:-40px;"><span id="rightTarget">shadowmoth</span></div>
<div style="height:1200px"></div>`;

const TARGET_TERMS = { target: 'vespertide', leftTarget: 'duskwarden', rightTarget: 'shadowmoth' };

const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const ROW = '#oc-wrap >> [data-oc-key="effect:gravehands"]';

const FULL_DUR = 3500;
const CLEAR = 6;
const SEL = '.oc-beacon-transient[data-gravehands="hands"]';

describe('Grave Hands: zombie hands claw up from the ground below the match', () => {
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

    await setSettings({ effect: 'gravehands', enabledPacks: ['hollow'], scrollBehavior: 'instant' });

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
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-gravehands="hands"]') ? true : null)),
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
      if (window.__ghFreeze) window.__ghFreeze.disconnect();
      window.__ghFreeze = new MutationObserver(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((root) => {
          root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        });
      });
      window.__ghFreeze.observe(document.documentElement, { childList: true, subtree: true });
    });
    try {
      return await replay();
    } finally {
      await page.evaluate(() => { window.__ghFreeze.disconnect(); delete window.__ghFreeze; });
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


  function predictBox(m, beaconScale) {
    const figH = Math.max(64, Math.min(90, m.height * 3.4)) * beaconScale;
    const u = figH / 100;
    return { figH, figW: 136 * u, u };
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function wrapBox() {
    const el = document.querySelector('.oc-beacon-transient[data-gravehands="hands"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }

  const poseState = () => page.evaluate(() => {
    const op = (sel) => { const n = document.querySelector(sel); return n ? parseFloat(getComputedStyle(n).opacity) : null; };
    const rise = (h) => {
      const n = document.querySelector('[data-gh-hand="' + h + '"] [data-gh-part="rise"]');
      return n ? new DOMMatrixReadOnly(getComputedStyle(n).transform).m42 : null;
    };
    return {
      h1: [op('[data-gh-hand="1"] [data-gh-pose="burst"]'), op('[data-gh-hand="1"] [data-gh-pose="reach"]'), op('[data-gh-hand="1"] [data-gh-pose="grab"]')],
      h2: [op('[data-gh-hand="2"] [data-gh-pose="burst"]'), op('[data-gh-hand="2"] [data-gh-pose="reach"]'), op('[data-gh-hand="2"] [data-gh-pose="grab"]')],
      r1: rise(1), r2: rise(2),
      mound: op('[data-gh-part="mound"]'),
      clods: Array.from(document.querySelectorAll('[data-gh-clod]')).map((c) => parseFloat(getComputedStyle(c).opacity)),
    };
  });

  test('document-space correctness: on a scrolled page, the wrapper\'s inline left/top carry the scroll offset', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const m = await measure('target');
      const p = predictBox(m, 1);
      const geom = await replay(() => {
        const el = document.querySelector('.oc-beacon-transient[data-gravehands="hands"]');
        return el ? { left: el.style.left, top: el.style.top, position: el.style.position } : null;
      });
      assert.strictEqual(geom.position, 'absolute');
      const expectedLeft = m.left + m.width / 2 - p.figW / 2 + scroll.x;
      const expectedTop = m.bottom + CLEAR + 2 + scroll.y;
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
      assert.ok(mounted, 'expected mounted grave hands even from scrollY=0');
      await cancelAndWaitClean();
    } finally {
      await scrollTargetTo('target', 200);
    }
  });

  test('placement: the box sits below the match with at least 6px of clearance, centred on it, and the match DOM is untouched', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);
    const m = await measure('target');
    await replayFrozen();
    const box = await page.evaluate(wrapBox);
    assert.ok(box.top - m.bottom >= CLEAR, `box top (${box.top}) must be at least ${CLEAR}px below the glyph box bottom (${m.bottom})`);
    const centre = (box.left + box.right) / 2, mc = (m.left + m.right) / 2;
    assert.ok(Math.abs(centre - mc) <= 2, `box centre ${centre} should sit under the match centre ${mc}`);
    assert.ok(box.bottom <= m.vh, 'the whole box must be on screen');
    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated');
    await cancelAndWaitClean();
  });

  test('viewport edges: a match flush with the left or right edge clamps the box on screen, below the match', async () => {
    for (const id of ['leftTarget', 'rightTarget']) {
      await switchToTarget(id)();
      await scrollTargetTo(id, 200);
      const m = await measure(id);
      await replayFrozen();
      const box = await page.evaluate(wrapBox);
      assert.ok(box.left >= 0 && box.right <= m.vw, `${id}: box ${JSON.stringify(box)} must stay inside the ${m.vw}px viewport`);
      assert.ok(box.top - m.bottom >= CLEAR, `${id}: still below the match`);
      await cancelAndWaitClean();
    }
    await switchToTarget('target')();
    await scrollTargetTo('target', 200);
  });

  test('suppression: when there is no room below the match in the pre-scroll viewport, nothing mounts and the match is untouched', async () => {
    try {
      await scrollTargetTo('target', 740);
      const m = await measure('target');
      assert.ok(m.bottom > m.vh - 120, 'sanity check: the match must sit at the bottom of the viewport');
      const before = await page.evaluate(() => document.getElementById('target').outerHTML);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 600));
      const mounted = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient[data-gravehands]').length);
      assert.strictEqual(mounted, 0, 'grave hands must be suppressed rather than cover the match');
      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before);
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollTargetTo('target', 200);
    }
  });

  test('protected rect: across the whole sequence the box never enters the match rect plus 6px', async () => {
    for (const id of ['target', 'leftTarget', 'rightTarget']) {
      await switchToTarget(id)();
      await scrollTargetTo(id, 200);
      const m = await measure(id);
      const prot = { left: m.left - CLEAR, right: m.right + CLEAR, top: m.top - CLEAR, bottom: m.bottom + CLEAR };
      await replayFrozen();
      for (let t = 0; t <= FULL_DUR; t += 100) {
        await seek(t);
        const b = await page.evaluate(wrapBox);
        assert.ok(b, `${id}: wrapper must exist at t=${t}ms`);
        assert.ok(!intersects(b, prot), `${id}: box ${JSON.stringify(b)} entered the protected rect ${JSON.stringify(prot)} at t=${t}ms`);
      }
      await cancelAndWaitClean();
    }
    await switchToTarget('target')();
    await scrollTargetTo('target', 200);
  });

  test('protected rect (pixels): the match rect shows zero painted-pixel delta at every sampled frame', async () => {
    // Press Enter once first so the match is in its settled active-highlight state (and the
    // page is at its post-navigation scroll position) BEFORE the baseline screenshot.
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

      const base = await decode(await page.screenshot({ clip }));
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-gravehands="hands"]'), null, { timeout: POLL_TIMEOUT });
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

  test('every hand has exactly five digits in every pose, and the second hand is a real mirrored, smaller branch', async () => {
    await scrollTargetTo('target', 200);
    await replayFrozen();
    const info = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('[data-gh-hand]').forEach((h) => {
        const id = h.getAttribute('data-gh-hand');
        out[id] = {
          mirrored: h.hasAttribute('data-gh-mirrored'),
          transform: h.getAttribute('transform'),
          poses: Array.from(h.querySelectorAll('[data-gh-pose]')).map((p) => [p.getAttribute('data-gh-pose'), p.querySelectorAll('[data-gh-finger]').length]),
          sleeve: h.querySelectorAll('[data-gh-part="sleeve"]').length,
        };
      });
      return out;
    });
    assert.deepStrictEqual(Object.keys(info).sort(), ['1', '2']);
    for (const id of ['1', '2']) {
      assert.deepStrictEqual(info[id].poses, [['burst', 5], ['reach', 5], ['grab', 5]], `hand ${id}: exactly five digits per pose`);
    }
    assert.strictEqual(info['1'].mirrored, false);
    assert.strictEqual(info['2'].mirrored, true, 'the second hand uses the mirrored static group');
    assert.ok(/scale\(-0\.78 0\.78\)/.test(info['2'].transform), `second hand is smaller and mirrored: ${info['2'].transform}`);
    assert.strictEqual(info['1'].sleeve, 2, 'ragged sleeve on the reach and grab poses');
    await cancelAndWaitClean();
  });

  test('beat order: mound and clods, burst, reach (second hand a beat later), grab, then both sink and the mound fades', async () => {
    await scrollTargetTo('target', 200);
    await replayFrozen();
    await seek(60);
    let s = await poseState();
    assert.deepStrictEqual([s.h1, s.h2], [[0, 0, 0], [0, 0, 0]], 'no hand yet; the mound arrives first');
    assert.ok(s.mound > 0 && s.mound < 1, `mound fading in at 60ms: ${s.mound}`);

    await seek(500);
    s = await poseState();
    assert.deepStrictEqual(s.h1, [1, 0, 0], 'first hand bursting through');
    assert.deepStrictEqual(s.h2, [0, 0, 0], 'second hand not up yet');
    assert.ok(s.clods.length === 3 && s.clods.every((o) => o === 1), `three clods in flight: ${s.clods}`);

    await seek(1000);
    s = await poseState();
    assert.deepStrictEqual(s.h1, [0, 1, 0], 'first hand reaching');
    assert.deepStrictEqual(s.h2, [1, 0, 0], 'second hand pops up a beat later');
    assert.ok(s.clods.every((o) => o === 0), 'clods are gone by now');

    await seek(1500);
    s = await poseState();
    assert.deepStrictEqual(s.h1, [0, 1, 0]);
    assert.deepStrictEqual(s.h2, [0, 1, 0]);

    await seek(1850);
    s = await poseState();
    assert.deepStrictEqual(s.h1, [0, 0, 1], 'first hand clutches');
    assert.deepStrictEqual(s.h2, [0, 1, 0]);

    await seek(2500);
    s = await poseState();
    assert.deepStrictEqual([s.h1, s.h2], [[0, 0, 1], [0, 0, 1]], 'both clutch and hold');
    assert.strictEqual(s.r1, 0);
    assert.strictEqual(s.mound, 1);

    await seek(3450);
    s = await poseState();
    assert.ok(s.r1 > 80 && s.r2 > 80, `both hands have sunk back: ${s.r1}, ${s.r2}`);
    assert.ok(s.mound < 1, `the mound is fading: ${s.mound}`);
    await cancelAndWaitClean();
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation is canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-gravehands="hands"]')) return null;
      window.__ghTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__ghTestAnims.length;
    });
    // mound 1 + 2 hands x (rise + 3 poses) 8 + 3 clods = 12.
    assert.strictEqual(animCount, 12);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    const states = await page.evaluate(() => window.__ghTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got: ${[...new Set(states)].join(', ')}`);
    await page.evaluate(() => { delete window.__ghTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted);
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: drops the flying clods and the second hand; keeps mound, burst, reach, grab and sink', async () => {
    await scrollTargetTo('target', 200);
    try {
      await setSettings({ performanceMode: true });
      await replayFrozen();
      const info = await page.evaluate(() => ({
        total: Array.from(document.querySelectorAll('.oc-beacon-transient')).reduce((n, el) => n + el.getAnimations({ subtree: true }).length, 0),
        clods: document.querySelectorAll('[data-gh-clod]').length,
        hands: document.querySelectorAll('[data-gh-hand]').length,
        poses: Array.from(document.querySelectorAll('[data-gh-pose]')).map((p) => p.getAttribute('data-gh-pose')),
        mound: document.querySelectorAll('[data-gh-part="mound"]').length,
      }));
      assert.strictEqual(info.clods, 0, 'no flying clods in Lite Mode');
      assert.strictEqual(info.hands, 1, 'no second hand in Lite Mode');
      assert.deepStrictEqual(info.poses, ['burst', 'reach', 'grab']);
      assert.strictEqual(info.mound, 1);
      assert.strictEqual(info.total, 5, 'mound + rise + three poses');
      await seek(1000);
      let s = await poseState();
      assert.deepStrictEqual(s.h1, [0, 1, 0]);
      await seek(2500);
      s = await poseState();
      assert.deepStrictEqual(s.h1, [0, 0, 1]);
      await seek(3450);
      s = await poseState();
      assert.ok(s.r1 > 80, 'the hand still sinks back');
    } finally {
      await setSettings({ performanceMode: false });
      await cancelAndWaitClean();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the rendered box scales', async () => {
    async function renderedHeight() {
      await replayFrozen();
      return page.evaluate(() => document.querySelector('[data-gravehands="hands"]').getBoundingClientRect().height);
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

  test('determinism: the effect never calls Math.random', () => {
    const src = fs.readFileSync(path.join(EXTENSION, 'content.js'), 'utf8');
    const start = src.indexOf('function animateGraveHands(rect)');
    const end = src.indexOf('  function animateReanimate(rect)', start);
    assert.ok(start !== -1 && end > start);
    assert.ok(!/Math\.random/.test(src.slice(start, end)));
  });

  test('pack enumeration: absent while hollow is disabled, present once enabled, selection survives a disable/re-enable round trip, and the runtime falls back safely', async () => {
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
      assert.strictEqual(keys.indexOf('gravehands'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(ROW).count(), 0, 'absent from the picker while its pack is disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['hollow'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('gravehands'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(ROW).count(), 1, 'present in the picker once its pack is enabled');
      await closeSettings();

      // The stored selection is NOT rewritten while the pack is disabled.
      await setSettings({ effect: 'gravehands', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'gravehands', 'stored selection must not be rewritten when the pack is disabled');

      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-gravehands]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the hands');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      await setSettings({ enabledPacks: ['hollow'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-gravehands="hands"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored selection must be restored on re-enable');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await setSettings({ enabledPacks: ['__oc_gravehands_test_reset__'] });
      await setSettings({ effect: 'gravehands', enabledPacks: ['hollow'] });
    }
  });
});
