// Black Cat Pounce beacon effect (oculist-l0bs.6): the first Haunted Hollow (pack II) effect.
// A black cat appears sitting beside the match (eyes a beat before the body), crouches,
// arches with a puffed tail, pounces, and holds a claw-swipe pose while three slash marks
// flash in BESIDE the match, then fades out. There is no prototype; the beat spec on the
// bead stands in for one.
//
// Beats carrying a real risk, tested directly rather than just documented:
//
// 1. PROTECTED RECT (promotion contract rule 10, no exceptions): neither the cat's box nor
//    the swipe-mark box may enter the match rect plus 6px of clearance in ANY sampled frame,
//    the pounce pose's claw tip stops at least 6px short of the glyph box, and the match's own
//    pixels never change.
// 2. DOCUMENT SPACE (rule 2): the wrapper's inline left/top carry the scroll offset, while the
//    side decision is made from the pre-scroll viewport rect.
// 3. MIRRORING is verified in code (a real right-side placement with the mirrored inner
//    group), not against the sheet, whose "mirrored proof" is a copy of pose 1.
// 4. SUPPRESSION when neither side fits.
//
// Modeled on test/batflight_effect.test.js and test/trail_effect.test.js (real HTTP fixture,
// CDP isolated-world attach, tall-spacer layout, scrollBehavior 'instant').

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

// #target: margin-left 600 -> more room on the left, so the cat sits on the LEFT.
// #rightTarget: margin-left 60 -> far more room on the right, so the cat sits on the RIGHT
// (the mirrored branch, exercised for real).
// #wideTarget: a 96px match ~526px wide: fits at 1200 wide, but wider than a 320px viewport,
// so neither side fits and the effect is suppressed.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:600px;overflow-wrap:anywhere;"><span id="target">vespertide</span> filler</div>
<div style="height:1600px"></div>
<div style="margin-left:60px;"><span id="rightTarget">duskwarden</span> filler</div>
<div style="height:1000px"></div>
<p style="font-size:96px;"><span id="wideTarget">shadowmoth</span> filler</p>
<div style="height:1200px"></div>`;

const TARGET_TERMS = { target: 'vespertide', rightTarget: 'duskwarden', wideTarget: 'shadowmoth' };

const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const CAT_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:blackcatpounce"]';

const FULL_DUR = 3700, LITE_DUR = 3200;
const CLEAR = 6;
const CAT_SEL = '.oc-beacon-transient[data-blackcat="cat"]';

describe('Black Cat Pounce: a cat sits, crouches, arches, pounces and swipes beside the match', () => {
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

    await setSettings({ effect: 'blackcatpounce', enabledPacks: ['halloween'], scrollBehavior: 'instant' });

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
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-blackcat="cat"]') ? true : null)),
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
      if (window.__bcFreeze) window.__bcFreeze.disconnect();
      window.__bcFreeze = new MutationObserver(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((root) => {
          root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        });
      });
      window.__bcFreeze.observe(document.documentElement, { childList: true, subtree: true });
    });
    try {
      return await replay();
    } finally {
      await page.evaluate(() => { window.__bcFreeze.disconnect(); delete window.__bcFreeze; });
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
    const catH = Math.max(64, Math.min(90, m.height * 3.4)) * beaconScale;
    const u = catH / 90;
    const catW = 134 * u;
    const markW = 36 * u * 0.9;
    const nearGap = CLEAR + 2 + markW - markW * 0.35;
    return { catH, catW, u, nearGap, hop: catW * 0.45 };
  }

  // Everything the cat paints, in viewport space, at the current (seeked) time.
  function paintBoxes() {
    const out = [];
    const cat = document.querySelector('.oc-beacon-transient[data-blackcat="cat"]');
    const marks = document.querySelector('.oc-beacon-transient[data-blackcat="swipe"]');
    [cat, marks].forEach((el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    });
    return out;
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
        const el = document.querySelector('.oc-beacon-transient[data-blackcat="cat"]');
        const mk = document.querySelector('.oc-beacon-transient[data-blackcat="swipe"]');
        return el && mk ? { left: el.style.left, top: el.style.top, side: el.getAttribute('data-bc-side'), position: el.style.position, mleft: mk.style.left, mtop: mk.style.top } : null;
      });
      assert.strictEqual(geom.position, 'absolute');
      assert.strictEqual(geom.side, 'left', 'fixture gives the left side more room, so the cat sits on the left');

      const expectedLeft = m.left - p.nearGap - p.catW + scroll.x;
      const expectedTop = m.bottom - 86 * p.u + scroll.y;
      assert.ok(Math.abs(parseFloat(geom.left) - expectedLeft) <= 2, `style.left (${geom.left}) must include scrollX -- expected ~${expectedLeft}`);
      assert.ok(Math.abs(parseFloat(geom.top) - expectedTop) <= 2, `style.top (${geom.top}) must include scrollY -- expected ~${expectedTop}`);
      // The swipe marks are positioned in document space too.
      assert.ok(parseFloat(geom.mtop) > scroll.y - 200, `marks' style.top (${geom.mtop}) must be in document space`);
      await cancelAndWaitClean();
    } finally {
      await scrollPageTo(page, 0);
    }
  });

  test('starting from a genuinely unscrolled page, Enter still finds and plays the effect', async () => {
    await scrollPageTo(page, 0);
    try {
      const mounted = await replay();
      assert.ok(mounted, 'expected a mounted black cat even from scrollY=0');
      await cancelAndWaitClean();
    } finally {
      await scrollTargetTo('target', 200);
    }
  });

  test('left placement: the cat faces right toward the match, the match DOM is untouched, and the claw tip stops at least 6px short of the glyph box', async () => {
    await scrollTargetTo('target', 200);
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);
    const m = await measure('target');

    await replayFrozen();
    const info = await page.evaluate(() => {
      const cat = document.querySelector('[data-blackcat="cat"]');
      return {
        side: cat.getAttribute('data-bc-side'),
        mirrored: !!cat.querySelector('[data-bc-mirrored]'),
        poses: Array.from(cat.querySelectorAll('[data-bc-pose]')).map((g) => g.getAttribute('data-bc-pose')),
      };
    });
    assert.strictEqual(info.side, 'left');
    assert.strictEqual(info.mirrored, false, 'the left-side cat is drawn unmirrored (facing right)');
    assert.deepStrictEqual(info.poses, ['sit', 'crouch', 'arch', 'pounce']);

    await seek(2600);
    const tip = await page.evaluate(() => document.querySelector('[data-bc-pose="pounce"]').getBoundingClientRect().right);
    assert.ok(m.left - tip >= CLEAR, `claw tip (${tip}) must stop at least ${CLEAR}px short of the glyph box (${m.left})`);

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM must never be mutated');
    await cancelAndWaitClean();
  });

  test('right placement (mirrored branch, exercised for real): when the right side has more room the cat sits on the right, mirrored, and stays clear of the match', async () => {
    await switchToTarget('rightTarget')();
    await scrollTargetTo('rightTarget', 200);
    const m = await measure('rightTarget');
    assert.ok(m.vw - m.right > m.left, 'sanity check: fixture must give the right side more room');

    await replayFrozen();
    const info = await page.evaluate(() => {
      const cat = document.querySelector('[data-blackcat="cat"]');
      return { side: cat.getAttribute('data-bc-side'), mirrored: !!cat.querySelector('[data-bc-mirrored]'), left: cat.getBoundingClientRect().left };
    });
    assert.strictEqual(info.side, 'right');
    assert.strictEqual(info.mirrored, true, 'the right-side cat must use the mirrored inner group');

    await seek(2600);
    const tipLeft = await page.evaluate(() => document.querySelector('[data-bc-pose="pounce"]').getBoundingClientRect().left);
    assert.ok(tipLeft - m.right >= CLEAR, `mirrored claw tip (${tipLeft}) must stop at least ${CLEAR}px short of the glyph box right edge (${m.right})`);
    const marks = await page.evaluate(() => document.querySelector('[data-blackcat="swipe"]').getBoundingClientRect().left);
    assert.ok(marks - m.right >= CLEAR, `mirrored swipe marks (${marks}) must stay beside the match, not over it`);
    await cancelAndWaitClean();
  });

  test('protected rect: across the whole sequence the cat and the swipe marks never enter the match rect plus 6px, on both sides', async () => {
    for (const id of ['target', 'rightTarget']) {
      await switchToTarget(id)();
      await scrollTargetTo(id, 200);
      const m = await measure(id);
      const prot = { left: m.left - CLEAR, right: m.right + CLEAR, top: m.top - CLEAR, bottom: m.bottom + CLEAR };
      await replayFrozen();
      for (let t = 0; t <= FULL_DUR; t += 100) {
        await seek(t);
        const boxes = await page.evaluate(paintBoxes);
        boxes.forEach((b) => assert.ok(!intersects(b, prot), `${id}: a painted box ${JSON.stringify(b)} entered the protected rect ${JSON.stringify(prot)} at t=${t}ms`));
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

      await cancelAndWaitClean();
      const base = await decode(await page.screenshot({ clip }));
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.oc-beacon-transient[data-blackcat="cat"]'), null, { timeout: POLL_TIMEOUT });
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

  test('beat order: eyes fade in before the body, then sit, crouch, arch, pounce; swipe marks flash only after the pounce lands', async () => {
    await scrollTargetTo('target', 200);
    await replayFrozen();
    const state = () => page.evaluate(() => {
      const op = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).opacity);
      const mk = document.querySelector('[data-blackcat="swipe"]');
      return {
        eyes: op('[data-bc-pose="sit"] [data-bc-part="eyes"]'),
        body: op('[data-bc-pose="sit"] [data-bc-part="body"]'),
        sit: op('[data-bc-pose="sit"]'), crouch: op('[data-bc-pose="crouch"]'),
        arch: op('[data-bc-pose="arch"]'), pounce: op('[data-bc-pose="pounce"]'),
        marks: parseFloat(getComputedStyle(mk).opacity),
      };
    });
    await seek(150);
    let s = await state();
    assert.ok(s.eyes > 0 && s.body === 0, `at 150ms the eyes are fading in while the body is still hidden: ${JSON.stringify(s)}`);
    await seek(600);
    s = await state();
    assert.strictEqual(s.body, 1); assert.strictEqual(s.sit, 1); assert.strictEqual(s.crouch, 0);
    await seek(1100);
    s = await state();
    assert.deepStrictEqual([s.sit, s.crouch, s.arch, s.pounce], [0, 1, 0, 0]);
    await seek(1700);
    s = await state();
    assert.deepStrictEqual([s.sit, s.crouch, s.arch, s.pounce], [0, 0, 1, 0]);
    assert.strictEqual(s.marks, 0, 'marks must not show before the pounce lands');
    await seek(2200);
    s = await state();
    assert.deepStrictEqual([s.sit, s.crouch, s.arch, s.pounce], [0, 0, 0, 1]);
    assert.strictEqual(s.marks, 0, 'marks must not show mid-arc');
    await seek(2800);
    s = await state();
    assert.strictEqual(s.pounce, 1);
    assert.strictEqual(s.marks, 1, 'swipe marks must be visible while the swipe pose is held');
    await cancelAndWaitClean();
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation is canceled', async () => {
    await scrollTargetTo('target', 200);
    const animCount = await replay(() => {
      if (!document.querySelector('.oc-beacon-transient[data-blackcat="cat"]')) return null;
      window.__bcTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__bcTestAnims.length;
    });
    // wrapper 1 + sit (parent, eyes, body) 3 + crouch 1 + arch 1 + pounce 1 + marks 1 = 8.
    assert.strictEqual(animCount, 8);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    const states = await page.evaluate(() => window.__bcTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got: ${[...new Set(states)].join(', ')}`);
    await page.evaluate(() => { delete window.__bcTestAnims; });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollTargetTo('target', 200);
    const mounted = await replay();
    assert.ok(mounted);
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: drops the eye-glow fade, glow halo and arch beat; keeps sit, crouch, pounce and swipe', async () => {
    await scrollTargetTo('target', 200);
    try {
      await setSettings({ performanceMode: true });
      await replayFrozen();
      const info = await page.evaluate(() => {
        const roots = Array.from(document.querySelectorAll('.oc-beacon-transient'));
        const count = (sel) => document.querySelector(sel).getAnimations({ subtree: false }).length;
        return {
          total: roots.reduce((n, el) => n + el.getAnimations({ subtree: true }).length, 0),
          glow: document.querySelectorAll('[data-bc-part="glow"]').length,
          eyesAnims: count('[data-bc-pose="sit"] [data-bc-part="eyes"]'),
          archAnims: count('[data-bc-pose="arch"]'),
          crouchAnims: count('[data-bc-pose="crouch"]'),
          pounceAnims: count('[data-bc-pose="pounce"]'),
          marks: !!document.querySelector('[data-blackcat="swipe"]'),
        };
      });
      assert.strictEqual(info.total, 5, 'wrapper + sit + crouch + pounce + marks');
      assert.strictEqual(info.glow, 0, 'no eye-glow halo in Lite Mode');
      assert.strictEqual(info.eyesAnims, 0, 'no separate eye fade-in in Lite Mode');
      assert.strictEqual(info.archAnims, 0, 'the arch beat is dropped in Lite Mode');
      assert.strictEqual(info.crouchAnims, 1);
      assert.strictEqual(info.pounceAnims, 1);
      assert.ok(info.marks, 'the claw-swipe marks (the defining beat) stay in Lite Mode');

      await seek(1100);
      let arch = await page.evaluate(() => getComputedStyle(document.querySelector('[data-bc-pose="crouch"]')).opacity);
      assert.strictEqual(arch, '1');
      await seek(1700);
      const s = await page.evaluate(() => ({
        arch: getComputedStyle(document.querySelector('[data-bc-pose="arch"]')).opacity,
        pounce: getComputedStyle(document.querySelector('[data-bc-pose="pounce"]')).opacity,
      }));
      assert.deepStrictEqual(s, { arch: '0', pounce: '1' }, 'Lite pounces straight from the crouch');
      const total = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('.oc-beacon-transient')).flatMap((el) => el.getAnimations({ subtree: true }).map((a) => a.effect.getComputedTiming().endTime))));
      assert.ok(total <= LITE_DUR + 1, `Lite sequence is shorter (${total}ms)`);
    } finally {
      await setSettings({ performanceMode: false });
      await cancelAndWaitClean();
    }
  });

  test('Beacon Size S/M/L/XL, set for real through chrome.storage.sync: the cat\'s rendered box scales', async () => {
    async function renderedHeight() {
      await replayFrozen();
      return page.evaluate(() => document.querySelector('[data-blackcat="cat"]').getBoundingClientRect().height);
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
      const mounted = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient[data-blackcat]').length);
      assert.strictEqual(mounted, 0, 'the cat must be suppressed rather than cover the match');
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

  test('viewport edges: at a small 500x300 viewport the cat either stays on screen or is suppressed, and the match DOM stays untouched', async () => {
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 500, height: 300 });
    try {
      await scrollTargetTo('target', 100);
      const before = await page.evaluate(() => document.getElementById('target').outerHTML);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 300));
      const box = await page.evaluate(() => {
        const el = document.querySelector('.oc-beacon-transient[data-blackcat="cat"]');
        if (!el) return null;
        el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      if (box) assert.ok(box.left >= 0 && box.right <= 500, `a mounted cat must start on screen, got ${JSON.stringify(box)}`);
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
    const start = src.indexOf('function animateBlackCatPounce(rect)');
    const end = src.indexOf('  function animateLightning(rect)', start);
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
      assert.strictEqual(keys.indexOf('blackcatpounce'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(CAT_EFFECT_ROW).count(), 0, 'absent from the picker while its pack is disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('blackcatpounce'), -1);

      await openSettings();
      assert.strictEqual(await page.locator(CAT_EFFECT_ROW).count(), 1, 'present in the picker once its pack is enabled');
      await closeSettings();

      // The stored selection is NOT rewritten while the pack is disabled.
      await setSettings({ effect: 'blackcatpounce', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'blackcatpounce', 'stored selection must not be rewritten when the pack is disabled');

      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        mounted: !!document.querySelector('.oc-beacon-transient[data-blackcat]'),
      } : null));
      assert.strictEqual(geom.mounted, false, 'while the pack is disabled, the runtime fallback must not render the cat');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-blackcat="cat"]') ? { mounted: true } : null));
      assert.strictEqual(geom.mounted, true, 'the stored selection must be restored on re-enable');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await setSettings({ enabledPacks: ['__oc_blackcat_test_reset__'] });
      await setSettings({ effect: 'blackcatpounce', enabledPacks: ['halloween'] });
    }
  });
});
