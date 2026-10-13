// Possessed Text beacon effect (oculist-l0bs.9, spike oculist-l0bs.8): a Haunted Hollow (pack II)
// effect. A possessed-red frame glitches around the match (jitter, warp, split) with a shadow
// echo frame, a jagged slice line in the margin and a spark cluster. The glyphs are never
// touched: the frame lives outside the glyph box plus 6px of clearance. No prototype exists;
// the beat spec on the bead stands in for one.
//
// Beats carrying a real risk, tested directly:
//
// 1. PROTECTED RECT (promotion contract rule 10): no painted shape enters the match rect plus
//    6px in ANY sampled frame, and the match's own pixels never change (pixel delta zero).
// 2. DOCUMENT SPACE (rule 2): inline left/top carry the scroll offset.
// 3. VIEWPORT EDGE: the box is clamped to the viewport width, so no horizontal scroll appears.
// 4. Lite Mode drops the echo, warp, split, slice and sparks.
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

// #target: mid-page. #edgeTarget: flush against the right edge of the viewport.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:100px;"><span id="target">vespertide</span> filler text around it</div>
<div style="height:1600px"></div>
<div style="margin-left:1050px;white-space:nowrap;"><span id="edgeTarget">duskwarden</span></div>
<div style="height:1200px"></div>`;

const TARGET_TERMS = { target: 'vespertide', edgeTarget: 'duskwarden' };

const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const PT_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:possessedtext"]';

const FULL_DUR = 1600, LITE_DUR = 1000;
const CLEAR = 6;

describe('Possessed Text: a glitching frame haunts the match without touching it', () => {
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

    await setSettings({ effect: 'possessedtext', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

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

  function evalInContentScript(expression) {
    return client
      .send('Runtime.evaluate', { expression, contextId: isolatedContextId, awaitPromise: true, returnByValue: true })
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
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-possessedtext="frame"]') ? true : null)),
      arg !== undefined ? arg : null,
      { timeout: POLL_TIMEOUT }
    );
    return handle.jsonValue();
  }

  // A main-world MutationObserver armed before Enter pauses every animation at t=0 in the
  // microtask after the mount, so the state stays put (and can be seeked).
  async function replayFrozen() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.evaluate(() => {
      if (window.__ptFreeze) window.__ptFreeze.disconnect();
      window.__ptFreeze = new MutationObserver(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((root) => {
          root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        });
      });
      window.__ptFreeze.observe(document.documentElement, { childList: true, subtree: true });
    });
    try {
      return await replay();
    } finally {
      await page.evaluate(() => { window.__ptFreeze.disconnect(); delete window.__ptFreeze; });
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

  // Everything the effect paints, in viewport space at the current (seeked) time. The overlay
  // box is a transparent clipped container (it necessarily surrounds the match), so the
  // painted shapes are measured; only the ones currently visible (opacity chain) count.
  // Strokes are sampled along their centerline (1px steps, through each element's current
  // screen transform, so the animated jitter and split shift count) and every sample is tested
  // against the protected rect inflated by the stroke's half-width. A frame's bounding box
  // would always enclose the match, so bounding boxes cannot be used for stroked outlines.
  // Returns { shapes, offenders } where offenders lists the samples inside the inflated rect.
  function paintViolations(prot) {
    const root = document.querySelector('.oc-beacon-transient[data-possessedtext="frame"]');
    const res = { shapes: 0, offenders: [] };
    if (!root) return res;
    const visible = (el) => {
      for (let n = el; n && n !== root.parentNode; n = n.parentElement || n.parentNode) {
        if (n.nodeType === 1 && parseFloat(getComputedStyle(n).opacity) === 0) return false;
      }
      return true;
    };
    const inside = (x, y, hw) => x > prot.left - hw && x < prot.right + hw && y > prot.top - hw && y < prot.bottom + hw;
    root.querySelectorAll('path, rect').forEach((el) => {
      if (!visible(el)) return;
      res.shapes++;
      if (el.tagName.toLowerCase() === 'rect') {
        const r = el.getBoundingClientRect();
        if (r.left < prot.right && r.right > prot.left && r.top < prot.bottom && r.bottom > prot.top) res.offenders.push({ rect: [r.left, r.top, r.right, r.bottom] });
        return;
      }
      const hw = parseFloat(el.getAttribute('stroke-width')) / 2;
      const ctm = el.getScreenCTM();
      const len = el.getTotalLength();
      for (let l = 0; l <= len; l += 1) {
        const p = el.getPointAtLength(l);
        const x = ctm.a * p.x + ctm.c * p.y + ctm.e, y = ctm.b * p.x + ctm.d * p.y + ctm.f;
        if (inside(x, y, hw)) { res.offenders.push({ x, y }); break; }
      }
    });
    return res;
  }

  test('document-space correctness: on a scrolled page, the wrapper\'s inline left/top carry the scroll offset', async () => {
    try {
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);
      const m = await measure('target');
      const geom = await replay(() => {
        const el = document.querySelector('.oc-beacon-transient[data-possessedtext="frame"]');
        return el ? { left: el.style.left, top: el.style.top, position: el.style.position } : null;
      });
      assert.strictEqual(geom.position, 'absolute');
      // The box is the match rect plus a margin M (> 6px, < 60px), converted to document space.
      const dx = (m.left + scroll.x) - parseFloat(geom.left);
      const dy = (m.top + scroll.y) - parseFloat(geom.top);
      assert.ok(dx > CLEAR && dx < 60, `style.left (${geom.left}) must include scrollX (margin ${dx})`);
      assert.ok(dy > CLEAR && dy < 60, `style.top (${geom.top}) must include scrollY (margin ${dy})`);
      await cancelAndWaitClean();
    } finally {
      await scrollPageTo(page, 0);
    }
  });

  test('starting from a genuinely unscrolled page, Enter still finds and plays the effect', async () => {
    await scrollPageTo(page, 0);
    try {
      assert.ok(await replay(), 'expected a mounted frame even from scrollY=0');
      await cancelAndWaitClean();
    } finally {
      await scrollTargetTo('target', 200);
    }
  });

  test('beat order: rest, jitter offsets, warp variant, then the top half shifted right with the slice line and sparks', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);
    await replayFrozen();
    const state = () => page.evaluate(() => {
      const op = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).opacity);
      const tx = (sel) => new DOMMatrix(getComputedStyle(document.querySelector(sel)).transform).m41;
      return {
        mainStraight: op('[data-pt-part="main"] [data-pt-state="straight"]'),
        mainWarp: op('[data-pt-part="main"] [data-pt-state="warp"]'),
        echoStraight: op('[data-pt-part="echo"] [data-pt-state="straight"]'),
        slice: op('[data-pt-part="slice"]'),
        mainShift: tx('[data-pt-part="main"] [data-pt-half="top"]'),
        mainJitter: tx('[data-pt-part="main"]'),
        echoJitter: tx('[data-pt-part="echo"]'),
        sparks: Array.from(document.querySelectorAll('[data-pt-part="spark"]')).map((s) => parseFloat(getComputedStyle(s).opacity)),
      };
    });
    await seek(80);
    let s = await state();
    assert.strictEqual(s.mainStraight, 1);
    assert.strictEqual(s.mainWarp, 0);
    assert.strictEqual(s.mainJitter, 0, 'rest: no offset yet');
    await seek(300);
    s = await state();
    assert.ok(s.mainJitter !== 0 && s.echoJitter !== 0 && s.mainJitter !== s.echoJitter, `jitter: echo offset differs from main (${s.mainJitter}/${s.echoJitter})`);
    assert.ok(Math.abs(s.mainJitter) <= 3.001, 'jitter never exceeds the clearance budget');
    assert.strictEqual(s.slice, 0);
    await seek(700);
    s = await state();
    assert.deepStrictEqual([s.mainStraight, s.mainWarp], [0, 1], 'warp swaps the frame variant');
    await seek(1250);
    s = await state();
    assert.deepStrictEqual([s.mainStraight, s.mainWarp], [1, 0]);
    assert.strictEqual(s.slice, 1, 'the slice line shows in the split state');
    assert.ok(Math.abs(s.mainShift - 5) < 0.01, `top half shifts 5px right (${s.mainShift})`);
    assert.strictEqual(s.mainJitter, 0, 'jitter has stopped before the split');
    assert.ok(s.sparks.some((o) => o > 0), 'sparks are showing');
    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated');
    await cancelAndWaitClean();
  });

  test('protected rect: across the whole sequence no painted shape enters the match rect plus 6px, at every sampled frame, mid-page and at the right edge', async () => {
    for (const id of ['target', 'edgeTarget']) {
      await switchToTarget(id)();
      await scrollTargetTo(id, 200);
      const m = await measure(id);
      const prot = { left: m.left - CLEAR, right: m.right + CLEAR, top: m.top - CLEAR, bottom: m.bottom + CLEAR };
      await replayFrozen();
      let sampled = 0;
      for (let t = 0; t <= FULL_DUR; t += 30) {
        await seek(t);
        const res = await page.evaluate(paintViolations, prot);
        sampled += res.shapes;
        assert.deepStrictEqual(res.offenders, [], `${id}: paint entered the protected rect ${JSON.stringify(prot)} at t=${t}ms`);
      }
      assert.ok(sampled > 50, 'the sweep actually saw painted shapes');
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

      const base = await decode(await page.screenshot({ clip }));
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-possessedtext="frame"]'), null, { timeout: POLL_TIMEOUT });
      let maxDelta = 0, worstT = -1;
      for (let t = 0; t <= FULL_DUR; t += 100) {
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

  test('viewport edge: a match flush with the right edge keeps the box inside the viewport width and adds no horizontal scroll', async () => {
    await switchToTarget('edgeTarget')();
    await scrollTargetTo('edgeTarget', 200);
    const m = await measure('edgeTarget');
    assert.ok(m.vw - m.right < 50, 'sanity check: fixture sits at the right edge');
    const scrollWidthBefore = await page.evaluate(() => document.documentElement.scrollWidth);
    await replayFrozen();
    const box = await page.evaluate(() => {
      const r = document.querySelector('.oc-beacon-transient[data-possessedtext="frame"]').getBoundingClientRect();
      return { left: r.left, right: r.right, sw: document.documentElement.scrollWidth };
    });
    assert.ok(box.right <= m.vw + 0.5, `box right (${box.right}) must stay within the viewport (${m.vw})`);
    assert.ok(box.sw <= scrollWidthBefore, 'no new horizontal scroll');
    await cancelAndWaitClean();
    await switchToTarget('target')();
    await scrollTargetTo('target', 200);
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation is canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-possessedtext="frame"]')) return null;
      window.__ptTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__ptTestAnims.length;
    });
    // wrapper 1 + jitter 2 + variant visibility 4 + top-half shifts 2 + slice 1 + sparks 5 = 15.
    assert.strictEqual(animCount, 15);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    const states = await page.evaluate(() => window.__ptTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got: ${[...new Set(states)].join(', ')}`);
    await page.evaluate(() => { delete window.__ptTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    assert.ok(await replay());
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: no echo, warp, split, slice or sparks; keeps the red frame and its jitter', async () => {
    await scrollTargetTo('target', 200);
    try {
      await setSettings({ performanceMode: true });
      await replayFrozen();
      const info = await page.evaluate(() => {
        const el = document.querySelector('[data-possessedtext="frame"]');
        return {
          total: el.getAnimations({ subtree: true }).length,
          echo: el.querySelectorAll('[data-pt-part="echo"]').length,
          warp: el.querySelectorAll('[data-pt-state="warp"]').length,
          slice: el.querySelectorAll('[data-pt-part="slice"]').length,
          sparks: el.querySelectorAll('[data-pt-part="spark"]').length,
          main: el.querySelectorAll('[data-pt-part="main"]').length,
          end: Math.max(...el.getAnimations({ subtree: true }).map((a) => a.effect.getComputedTiming().endTime)),
        };
      });
      // wrapper 1 + main jitter 1 = 2.
      assert.strictEqual(info.total, 2);
      assert.deepStrictEqual([info.echo, info.warp, info.slice, info.sparks, info.main], [0, 0, 0, 0, 1]);
      assert.ok(info.end <= LITE_DUR + 1, `Lite sequence is shorter (${info.end}ms)`);
      await seek(300);
      const jx = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('[data-pt-part="main"]')).transform).m41);
      assert.notStrictEqual(jx, 0, 'Lite still jitters');
    } finally {
      await setSettings({ performanceMode: false });
      await cancelAndWaitClean();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the frame stroke scales', async () => {
    async function strokeWidth() {
      await replayFrozen();
      return page.evaluate(() => parseFloat(document.querySelector('[data-pt-part="main"] path').getAttribute('stroke-width')));
    }
    await scrollTargetTo('target', 200);
    let currentSize = 'm';
    try {
      const base = await strokeWidth();
      for (const [size, factor] of [['s', 0.7], ['l', 1.5]]) {
        currentSize = size;
        await setVisionSettings({ beaconSize: size });
        const w = await strokeWidth();
        assert.ok(Math.abs(w - base * factor) <= 0.01, `Beacon Size ${size}: expected ~${base * factor}, got ${w}`);
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

  test('tiny viewport: at 500x300 the frame still mounts clamped inside the viewport width and the match DOM stays untouched', async () => {
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 500, height: 300 });
    try {
      await scrollTargetTo('target', 100);
      const before = await page.evaluate(() => document.getElementById('target').outerHTML);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 300));
      const box = await page.evaluate(() => {
        const el = document.querySelector('.oc-beacon-transient[data-possessedtext="frame"]');
        if (!el) return null;
        el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      if (box) assert.ok(box.right <= 500.5, `a mounted frame must stay within the viewport width, got ${JSON.stringify(box)}`);
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
    const start = src.indexOf('function animatePossessedText(rect)');
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
      assert.strictEqual(keys.indexOf('possessedtext'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(PT_EFFECT_ROW).count(), 0, 'absent from the picker while its pack is disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('possessedtext'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(PT_EFFECT_ROW).count(), 1, 'present in the picker once its pack is enabled');
      await closeSettings();

      // The stored selection is NOT rewritten while the pack is disabled.
      await setSettings({ effect: 'possessedtext', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'possessedtext', 'stored selection must not be rewritten when the pack is disabled');

      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-possessedtext]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the frame');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-possessedtext="frame"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored selection must be restored on re-enable');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await setSettings({ enabledPacks: ['__oc_possessedtext_test_reset__'] });
      await setSettings({ effect: 'possessedtext', enabledPacks: ['halloween'] });
    }
  });
});
