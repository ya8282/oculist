// Ouija Planchette beacon effect (oculist-l0bs.10): a Haunted Hollow (pack II) effect.
// A wooden planchette slides in horizontally just BELOW the match (tilted, motion ticks behind),
// settles with its narrow tip pointing up and its round lens centred under the match (attention
// ticks, one glyph glint), holds, then slides out the far side. There is no prototype; the beat
// spec on the bead stands in for one.
//
// Beats carrying a real risk, tested directly rather than just documented:
//
// 1. PROTECTED RECT (promotion contract rule 10, no exceptions): the planchette box never
//    enters the match rect plus 6px of clearance in ANY sampled frame, in either placement and
//    either slide direction, and the match's own pixels never change.
// 2. DOCUMENT SPACE (rule 2): the wrapper's inline left/top carry the scroll offset, while the
//    below/above decision is made from the pre-scroll viewport rect.
// 3. ABOVE FALLBACK (inverted figure, tip still pointing at the match) and SUPPRESSION when
//    neither fits.
// 4. START CASCADE: the slide-in side follows the mouse, in both directions.
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

// #target: mid-page, room below. #bottomTarget: the last line of the document, so the page
// scroll clamps and there is no room below it (the above fallback).
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:600px;overflow-wrap:anywhere;"><span id="target">vespertide</span> filler</div>
<div style="height:1600px"></div>
<div style="height:1200px"></div>
<p><span id="bottomTarget">revenantine</span> filler</p>`;

const TARGET_TERMS = { target: 'vespertide', bottomTarget: 'revenantine' };

const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const OP_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:ouijaplanchette"]';

const FULL_DUR = 2900, LITE_DUR = 2300;
const CLEAR = 6;

describe('Ouija Planchette: a planchette slides under the match, settles pointing at it, and slides out', () => {
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

    await setSettings({ effect: 'ouijaplanchette', enabledPacks: ['hollow'], scrollBehavior: 'instant' });

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
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-ouija="planchette"]') ? true : null)),
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
      if (window.__opFreeze) window.__opFreeze.disconnect();
      window.__opFreeze = new MutationObserver(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((root) => {
          root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        });
      });
      window.__opFreeze.observe(document.documentElement, { childList: true, subtree: true });
    });
    try {
      return await replay();
    } finally {
      await page.evaluate(() => { window.__opFreeze.disconnect(); delete window.__opFreeze; });
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

  // Mirrors content.js's own sizing formula for a SANITY check on the fixture only; every real
  // assertion reads the live rendered DOM.
  function predictBox(m, beaconScale) {
    const boxH = Math.max(76, Math.min(104, m.height * 3.6)) * beaconScale;
    const u = boxH / 132;
    return { boxH, boxW: 120 * u, u };
  }

  function moveMouse(x, y) {
    return page.mouse.move(x, y);
  }

  const OP_SEL = '.oc-beacon-transient[data-ouija="planchette"]';

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function wrapperBox() {
    const el = document.querySelector('.oc-beacon-transient[data-ouija="planchette"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }

  test('document-space correctness: on a scrolled page, the wrapper\'s inline left/top carry the scroll offset and the lens sits under the match centre', async () => {
    try {
      await moveMouse(40, 40);
      await scrollTargetTo('target', 300);
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      assert.ok(scroll.y > 0, `sanity check: page must actually be scrolled, got scrollY=${scroll.y}`);

      const m = await measure('target');
      const p = predictBox(m, 1);
      const geom = await replay(() => {
        const el = document.querySelector('.oc-beacon-transient[data-ouija="planchette"]');
        return el ? { left: el.style.left, top: el.style.top, place: el.getAttribute('data-op-place'), position: el.style.position } : null;
      });
      assert.strictEqual(geom.position, 'absolute');
      assert.strictEqual(geom.place, 'below');

      const expectedLeft = m.left + m.width / 2 - p.boxW / 2 + scroll.x;
      const expectedTop = m.bottom + CLEAR + scroll.y;
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
      assert.ok(mounted, 'expected a mounted planchette even from scrollY=0');
      await cancelAndWaitClean();
    } finally {
      await scrollTargetTo('target', 200);
    }
  });

  test('settle: poses are rest/slide/settle, the narrow tip points up, the lens is centred under the match, and the match DOM is untouched', async () => {
    await moveMouse(40, 40);
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);
    const m = await measure('target');

    await replayFrozen();
    const info = await page.evaluate(() => {
      const el = document.querySelector('[data-ouija="planchette"]');
      return {
        place: el.getAttribute('data-op-place'),
        inverted: !!el.querySelector('[data-op-inverted]'),
        poses: Array.from(el.querySelectorAll('[data-op-pose]')).map((g) => g.getAttribute('data-op-pose')),
        lensFill: el.querySelector('[data-op-part="lens"]').getAttribute('data-op-lens'),
        feet: el.querySelectorAll('[data-op-pose="rest"] [data-op-part="foot"]').length,
      };
    });
    assert.strictEqual(info.place, 'below');
    assert.strictEqual(info.inverted, false, 'below placement is upright: the tip points up at the match');
    assert.deepStrictEqual(info.poses, ['rest', 'slide', 'settle']);
    assert.strictEqual(info.lensFill, 'glass');
    assert.strictEqual(info.feet, 3);

    await seek(1500); // the hold: rest pose, wrapper at its final spot
    const geo = await page.evaluate(() => {
      const lens = document.querySelector('[data-op-pose="rest"] [data-op-part="lens"]').getBoundingClientRect();
      const body = document.querySelector('[data-op-pose="rest"] [data-op-part="body"]').getBoundingClientRect();
      return { lensCx: lens.left + lens.width / 2, lensCy: lens.top + lens.height / 2, bodyTop: body.top, bodyBottom: body.bottom };
    });
    assert.ok(Math.abs(geo.lensCx - (m.left + m.width / 2)) <= 2, `lens centre x ${geo.lensCx} must sit under the match centre ${m.left + m.width / 2}`);
    assert.ok(geo.bodyTop >= m.bottom + CLEAR, `the tip (${geo.bodyTop}) stays at least ${CLEAR}px below the glyph box (${m.bottom})`);
    assert.ok(geo.lensCy > m.bottom + CLEAR, 'the lens never overlays the match');

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated');
    await cancelAndWaitClean();
  });

  test('above fallback: when nothing fits below, the planchette is inverted above the match with the tip still pointing at it (decided from the pre-scroll viewport rect)', async () => {
    await switchToTarget('bottomTarget')();
    await moveMouse(40, 40);
    const geom = await replay(() => {
      const el = document.querySelector('.oc-beacon-transient[data-ouija="planchette"]');
      return el ? { place: el.getAttribute('data-op-place'), top: parseFloat(el.style.top), height: parseFloat(el.style.height), inverted: !!el.querySelector('[data-op-inverted]'), scrollY: window.scrollY } : null;
    });
    const m = await measure('bottomTarget');
    assert.ok(m.vh - m.bottom < CLEAR + geom.height + 4, 'sanity check: the fixture leaves no room below');
    assert.strictEqual(geom.place, 'above');
    assert.strictEqual(geom.inverted, true);
    assert.ok(Math.abs(geom.top + geom.height - (m.top + geom.scrollY - CLEAR)) <= 2, `bottom edge must sit ${CLEAR}px above the match in document space`);
    await cancelAndWaitClean();
    await switchToTarget('target')();
    await scrollTargetTo('target', 200);
  });

  test('slide side: the start cascade picks the side; tilt follows travel, and the motion ticks trail behind (both branches exercised for real)', async () => {
    await scrollTargetTo('target', 200);
    for (const [x, dir, tilt] of [[20, 'ltr', 'rotate(10 '], [1180, 'rtl', 'rotate(-10 ']]) {
      await moveMouse(x, 300);
      await replayFrozen();
      const info = await page.evaluate(() => {
        const el = document.querySelector('[data-ouija="planchette"]');
        const slide = el.querySelector('[data-op-pose="slide"]');
        const body = slide.querySelector('[data-op-part="body"]').getBoundingClientRect();
        const ticks = Array.from(slide.querySelectorAll('[data-op-part="motion-tick"]')).map((t) => t.getBoundingClientRect());
        return {
          dir: el.getAttribute('data-op-dir'),
          tilt: slide.firstElementChild.getAttribute('transform'),
          ticks: ticks.length,
          tickMid: ticks.map((t) => t.left + t.width / 2),
          bodyMid: body.left + body.width / 2,
        };
      });
      assert.strictEqual(info.dir, dir);
      assert.ok(info.tilt.indexOf(tilt) === 0, `slide tilt ${info.tilt}`);
      assert.strictEqual(info.ticks, 2);
      info.tickMid.forEach((mid) => assert.ok(dir === 'ltr' ? mid < info.bodyMid : mid > info.bodyMid, `ticks trail behind the travel direction (${dir})`));

      // The wrapper starts off to its slide-in side and arrives at x offset 0.
      await seek(0);
      const start = await page.evaluate(wrapperBox);
      await seek(800);
      const settled = await page.evaluate(wrapperBox);
      assert.ok(dir === 'ltr' ? start.left < settled.left : start.left > settled.left, `slides in from the ${dir === 'ltr' ? 'left' : 'right'}`);
      await cancelAndWaitClean();
    }
    await moveMouse(40, 40);
  });

  test('protected rect: across the whole sequence the planchette box never enters the match rect plus 6px, in every placement and direction', async () => {
    for (const id of ['target', 'bottomTarget']) {
      for (const x of [20, 1180]) {
        await switchToTarget(id)();
        await moveMouse(x, 300);
        const m = await measure(id);
        const prot = { left: m.left - CLEAR, right: m.right + CLEAR, top: m.top - CLEAR, bottom: m.bottom + CLEAR };
        await replayFrozen();
        for (let t = 0; t <= FULL_DUR; t += 100) {
          await seek(t);
          const b = await page.evaluate(wrapperBox);
          assert.ok(!intersects(b, prot), `${id}/${x}: box ${JSON.stringify(b)} entered the protected rect ${JSON.stringify(prot)} at t=${t}ms`);
        }
        await cancelAndWaitClean();
      }
    }
    await moveMouse(40, 40);
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
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-ouija="planchette"]'), null, { timeout: POLL_TIMEOUT });
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

  test('beat order: slide, settle with attention ticks and one glint, rest hold, then slide out the far side', async () => {
    await moveMouse(20, 300);
    await scrollTargetTo('target', 200);
    await replayFrozen();
    const state = () => page.evaluate(() => {
      const op = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).opacity);
      return {
        slide: op('[data-op-pose="slide"]'), settle: op('[data-op-pose="settle"]'), rest: op('[data-op-pose="rest"]'),
        glint: op('[data-op-part="glint"]'),
        ticks: document.querySelectorAll('[data-op-pose="settle"] [data-op-part="attention-tick"]').length,
      };
    });
    await seek(300);
    let s = await state();
    assert.deepStrictEqual([s.slide, s.settle, s.rest, s.glint], [1, 0, 0, 0]);
    await seek(700 + 10);
    s = await state();
    assert.deepStrictEqual([s.slide, s.settle, s.rest], [0, 1, 0]);
    assert.strictEqual(s.ticks, 4, 'four attention ticks in the settle pose');
    await seek(700 + 250);
    s = await state();
    assert.ok(s.glint > 0.9, `the glyph glints mid-settle (${s.glint})`);
    await seek(1200 + 50);
    s = await state();
    assert.deepStrictEqual([s.slide, s.settle, s.rest, s.glint], [0, 0, 1, 0]);
    await seek(2500);
    s = await state();
    assert.deepStrictEqual([s.slide, s.settle, s.rest], [1, 0, 0], 'slides out in the slide pose');
    // The wrapper hits its final spot at the end of the slide and leaves on the far side.
    await seek(1500);
    const hold = await page.evaluate(wrapperBox);
    await seek(2800);
    const out = await page.evaluate(wrapperBox);
    assert.ok(out.left > hold.left, 'exits toward the far (right) side when it entered from the left');
    await cancelAndWaitClean();
  });

  test('glyph cycle: crescent, sun, star in a fixed order across plays', async () => {
    await scrollTargetTo('target', 200);
    const order = ['crescent', 'sun', 'star'];
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await replayFrozen();
      seen.push(await page.evaluate(() => {
        const el = document.querySelector('[data-ouija="planchette"]');
        return { glyph: el.getAttribute('data-op-glyph'), engraved: el.querySelectorAll('[data-op-pose="rest"] [data-op-part="glyph"] > *').length };
      }));
      await cancelAndWaitClean();
    }
    seen.forEach((s) => assert.ok(s.engraved >= 1, 'a glyph is actually engraved'));
    const start = order.indexOf(seen[0].glyph);
    assert.ok(start !== -1);
    seen.forEach((s, i) => assert.strictEqual(s.glyph, order[(start + i) % 3]));
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation is canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-ouija="planchette"]')) return null;
      window.__opTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__opTestAnims.length;
    });
    // wrapper 1 + slide, settle, rest 3 + glint 1 = 5.
    assert.strictEqual(animCount, 5);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    const states = await page.evaluate(() => window.__opTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got: ${[...new Set(states)].join(', ')}`);
    await page.evaluate(() => { delete window.__opTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted);
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: drops motion ticks, attention ticks and the glint; keeps the silhouette, tilted slide, settle and slide out', async () => {
    await scrollTargetTo('target', 200);
    try {
      await setSettings({ performanceMode: true });
      await replayFrozen();
      const info = await page.evaluate(() => {
        const roots = Array.from(document.querySelectorAll('.oc-beacon-transient'));
        return {
          total: roots.reduce((n, el) => n + el.getAnimations({ subtree: true }).length, 0),
          motion: document.querySelectorAll('[data-op-part="motion-tick"]').length,
          attention: document.querySelectorAll('[data-op-part="attention-tick"]').length,
          glint: document.querySelectorAll('[data-op-part="glint"]').length,
          poses: Array.from(document.querySelectorAll('[data-op-pose]')).map((g) => g.getAttribute('data-op-pose')),
          lens: document.querySelectorAll('[data-op-part="lens"]').length,
          tilt: document.querySelector('[data-op-pose="slide"]').firstElementChild.getAttribute('transform'),
        };
      });
      assert.strictEqual(info.total, 4, 'wrapper + slide + settle + rest');
      assert.strictEqual(info.motion, 0);
      assert.strictEqual(info.attention, 0);
      assert.strictEqual(info.glint, 0);
      assert.deepStrictEqual(info.poses, ['rest', 'slide', 'settle']);
      assert.strictEqual(info.lens, 3, 'the lens (silhouette) stays in every pose');
      assert.ok(/^rotate\(-?10 /.test(info.tilt), 'the tilt stays');
      const total = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('.oc-beacon-transient')).flatMap((el) => el.getAnimations({ subtree: true }).map((a) => a.effect.getComputedTiming().endTime))));
      assert.ok(total <= LITE_DUR + 1, `Lite sequence is shorter (${total}ms)`);
    } finally {
      await setSettings({ performanceMode: false });
      await cancelAndWaitClean();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the planchette\'s rendered box scales', async () => {
    async function renderedHeight() {
      await replayFrozen();
      return page.evaluate(() => document.querySelector('[data-ouija="planchette"]').getBoundingClientRect().height);
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

  test('suppression: when neither below nor above fits, nothing mounts and the match is untouched', async () => {
    await switchToTarget('target')();
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 1200, height: 170 });
    try {
      await scrollTargetTo('target', 70);
      const before = await page.evaluate(() => document.getElementById('target').outerHTML);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 600));
      const mounted = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient[data-ouija]').length);
      assert.strictEqual(mounted, 0, 'the planchette must be suppressed rather than cover the match');
      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before);
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await scrollPageTo(page, 0);
      await scrollTargetTo('target', 200);
    }
  });

  test('viewport edges: at a narrow 300x500 viewport the settled planchette stays on screen or is suppressed, and the match DOM stays untouched', async () => {
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 300, height: 500 });
    try {
      await scrollTargetTo('target', 100);
      const before = await page.evaluate(() => document.getElementById('target').outerHTML);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 300));
      const box = await page.evaluate(() => {
        const el = document.querySelector('.oc-beacon-transient[data-ouija="planchette"]');
        if (!el) return null;
        el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1000; });
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      if (box) assert.ok(box.left >= 0 && box.right <= 300, `a mounted planchette must settle on screen, got ${JSON.stringify(box)}`);
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
    const start = src.indexOf('function animateOuijaPlanchette(rect)');
    const end = src.indexOf('  function animateLightning(rect)', start);
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
      assert.strictEqual(keys.indexOf('ouijaplanchette'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(OP_EFFECT_ROW).count(), 0, 'absent from the picker while its pack is disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['hollow'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('ouijaplanchette'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(OP_EFFECT_ROW).count(), 1, 'present in the picker once its pack is enabled');
      await closeSettings();

      // The stored selection is NOT rewritten while the pack is disabled.
      await setSettings({ effect: 'ouijaplanchette', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'ouijaplanchette', 'stored selection must not be rewritten when the pack is disabled');

      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-ouija]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the planchette');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      await setSettings({ enabledPacks: ['hollow'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-ouija="planchette"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored selection must be restored on re-enable');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await setSettings({ enabledPacks: ['__oc_ouija_test_reset__'] });
      await setSettings({ effect: 'ouijaplanchette', enabledPacks: ['hollow'] });
    }
  });
});
