// Ghost Sweep beacon effect (oculist-l0bs.3), the Haunted Hollow pack ('hollow'). A bedsheet
// ghost drifts across the page on an S-curve along a lane ABOVE the match (BELOW if no room
// above in the pre-scroll viewport; suppressed if neither fits), trailing a wavy ribbon. It
// switches to a wail pose and breathes once (~8%) as it passes the match's centre x, then
// returns to the lean pose and exits. The fade-through pose is only for the entry/exit fade.
//
// Beats carrying real risk, tested directly:
//  1. PROTECTED RECT (contract rule 10): in every sampled frame no painted descendant box
//     enters the match's glyph box plus 6px, and the glyph pixels never change.
//  2. DOCUMENT SPACE: on a scrolled page the root's inline top carries the scrollY term.
//  3. LANE FALLBACK: above, then below, then suppress -- decided from the pre-scroll viewport.
//  4. START-POINT CASCADE (rule 9): the entry side follows lastMouse, else the find bar
//     centre; the mirrored (right-to-left) branch is exercised for real.
//  5. POSES and HEM WOBBLE: wail only over the match, fade only at the ends, hem variants
//     cycle on a fixed beat.
//
// Modeled on test/batflight_effect.test.js (fixture, CDP isolated-world attach, frozen
// replay). Needs real Chromium for WAAPI/layout, and chrome.storage.sync for settings.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { scrollPageTo, POLL_TIMEOUT, waitForCondition, waitForOverlayResizeSettled } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:2400px"></div>
<div style="margin-left:500px"><span id="target">wraithling</span> filler text</div>
<div style="height:2400px"></div>`;

const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const ROW = '#oc-wrap >> [data-oc-key="effect:ghostsweep"]';
const MOUNTED = '.oc-beacon-transient[data-ghostsweep="ghost"]';

describe('Ghost Sweep: a ghost drifts past the match on a lane above (or below) it', () => {
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
    await setSettings({ effect: 'ghostsweep', enabledPacks: ['halloween'], scrollBehavior: 'instant' });
    await openFinder(page);
    await page.locator(INPUT).type('wraithling', { delay: 30 });
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
      } catch (e) { /* retry */ }
    }
    await pg.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  async function waitForMatchCount(pg) {
    await pg.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
      return !!count && /of \d+/.test(count.textContent);
    }, null, { timeout: POLL_TIMEOUT });
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
        if (res.exceptionDetails) throw new Error('content-script eval failed: ' + JSON.stringify(res.exceptionDetails));
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

  async function setSettings(patch, vision) {
    const echoBefore = await armSettingsEcho();
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, ' + JSON.stringify(patch) + ');' +
        (vision
          ? 'next.visionSettings = Object.assign({}, current.visionSettings || {}, ' + JSON.stringify(vision) + ');'
          : '') +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
    await waitForSettingsEcho(echoBefore);
  }

  // Cancels any in-flight beacon, arms a main-world observer that pauses every animation at
  // t=0 the moment the ghost mounts, then presses Enter. The state stays put until
  // cancelBeacons(); seek() then scrubs it deterministically.
  async function replayFrozen() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.evaluate(() => {
      if (window.__gsFreeze) window.__gsFreeze.disconnect();
      window.__gsFreeze = new MutationObserver(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((root) => {
          root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        });
      });
      window.__gsFreeze.observe(document.documentElement, { childList: true, subtree: true });
    });
    try {
      await page.keyboard.press('Enter');
      await page.waitForSelector(MOUNTED, { state: 'attached', timeout: POLL_TIMEOUT });
    } finally {
      await page.evaluate(() => { window.__gsFreeze.disconnect(); delete window.__gsFreeze; });
    }
  }

  async function replayLive() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    await page.waitForSelector(MOUNTED, { state: 'attached', timeout: POLL_TIMEOUT });
  }

  async function settleBeacons() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  }

  async function scrollTargetTo(id, topOffset) {
    const docTop = await page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return r.top + window.scrollY;
    }, id);
    await scrollPageTo(page, Math.max(0, docTop - topOffset));
  }

  // Scrubs every animation of the frozen ghost to fraction f of the travel duration, then
  // reports the ghost's painted boxes against the match's protected rectangle.
  function seek(f) {
    return page.evaluate((frac) => {
      const root = document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]');
      const anims = root.getAnimations({ subtree: true });
      const D = root.getAnimations({ subtree: false })[0].effect.getComputedTiming().duration;
      anims.forEach((a) => { a.pause(); a.currentTime = frac * D; });
      const m = document.getElementById('target').getBoundingClientRect();
      const prot = { l: m.left - 6, t: m.top - 6, r: m.right + 6, b: m.bottom + 6 };
      const boxes = [root].concat(Array.from(root.querySelectorAll('*'))).map((n) => n.getBoundingClientRect())
        .filter((r) => r.width > 0 || r.height > 0);
      const hits = boxes.filter((r) => r.left < prot.r && r.right > prot.l && r.top < prot.b && r.bottom > prot.t).length;
      const rr = root.getBoundingClientRect();
      const vis = (sel) => { const e = root.querySelector(sel); return e ? Number(getComputedStyle(e).opacity) : null; };
      const pulse = root.querySelector('[data-part="pulse"]');
      return {
        hits,
        D,
        cx: rr.left + rr.width / 2,
        matchCx: m.left + m.width / 2,
        bottom: Math.max.apply(null, boxes.map((r) => r.bottom)),
        top: Math.min.apply(null, boxes.map((r) => r.top)),
        matchTop: m.top, matchBottom: m.bottom,
        lean: vis('[data-pose="lean"]'), wail: vis('[data-pose="wail"]'), fade: vis('[data-pose="fade"]'),
        hems: [0, 1, 2].map((i) => vis('[data-hem="' + i + '"]')),
        pulseScale: new DOMMatrixReadOnly(getComputedStyle(pulse).transform).a,
        rootOpacity: Number(getComputedStyle(root).opacity),
        left: boxes.reduce((a, r) => Math.min(a, r.left), 1e9),
        right: boxes.reduce((a, r) => Math.max(a, r.right), -1e9),
      };
    }, f);
  }

  const FRAMES = [0, 0.03, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97, 1];

  async function assertProtectedAcrossFlight(label) {
    const matchHtml = await page.evaluate(() => document.getElementById('target').outerHTML);
    for (const f of FRAMES) {
      const s = await seek(f);
      assert.strictEqual(s.hits, 0, `${label}: effect paint entered the match's protected rect (glyph box + 6px) at t=${f}`);
    }
    assert.strictEqual(await page.evaluate(() => document.getElementById('target').outerHTML), matchHtml, `${label}: match DOM mutated`);
  }

  test('document-space correctness: on a scrolled page the root\'s inline top carries the scrollY term', async () => {
    await scrollTargetTo('target', 400);
    await replayFrozen();
    const g = await page.evaluate(() => {
      const root = document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]');
      const r = root.getBoundingClientRect();
      return { sy: window.scrollY, top: parseFloat(root.style.top), rectTop: r.top, pos: getComputedStyle(root).position, z: root.style.zIndex, pe: root.style.pointerEvents };
    });
    assert.ok(g.sy > 500, `fixture must actually be scrolled, scrollY=${g.sy}`);
    assert.strictEqual(g.pos, 'absolute');
    assert.ok(Math.abs(g.top - (g.rectTop + g.sy)) < 1, `inline top ${g.top} must equal viewport top ${g.rectTop} + scrollY ${g.sy}`);
    assert.strictEqual(g.z, '2147483642');
    assert.strictEqual(g.pe, 'none');
    await settleBeacons();
  });

  test('above lane: the ghost stays clear of the glyph box + 6px in every sampled frame, and the glyph pixels never change', async () => {
    await scrollTargetTo('target', 400);
    await replayFrozen();
    const lane = await page.evaluate(() => document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]').getAttribute('data-ghost-lane'));
    assert.strictEqual(lane, 'above');
    await assertProtectedAcrossFlight('above');
    for (const f of FRAMES) {
      const s = await seek(f);
      assert.ok(s.bottom <= s.matchTop - 6, `above lane: ghost bottom ${s.bottom} must stay at least 6px above the match top ${s.matchTop} at t=${f}`);
    }

    // Glyph pixels: the match's own box is pixel-identical at every sampled frame.
    const clip = await page.evaluate(() => {
      const m = document.getElementById('target').getBoundingClientRect();
      return { x: Math.floor(m.left), y: Math.floor(m.top), width: Math.ceil(m.width), height: Math.ceil(m.height) };
    });
    await seek(0);
    const base = await page.screenshot({ clip });
    for (const f of [0.3, 0.5, 0.7]) {
      await seek(f);
      assert.ok(base.equals(await page.screenshot({ clip })), `glyph pixels changed at t=${f}`);
    }
    await settleBeacons();
  });

  test('poses: wail only over the match with a single ~8% breathe, fade only at the ends, hem variants cycle on a fixed beat', async () => {
    await scrollTargetTo('target', 400);
    await replayFrozen();
    const samples = [];
    for (let i = 0; i <= 50; i++) samples.push(Object.assign({ f: i / 50 }, await seek(i / 50)));

    assert.ok(samples[0].fade === 1 && samples[0].lean === 0, 'starts in the fade-through pose');
    assert.ok(samples[50].fade === 1 && samples[50].lean === 0, 'ends in the fade-through pose');
    assert.ok(samples[0].rootOpacity === 0 && samples[50].rootOpacity === 0, 'fully faded in/out at the ends');
    for (const s of samples) {
      if (s.f > 0.14 && s.f < 0.86) assert.strictEqual(s.fade, 0, `fade pose must not appear mid-flight (t=${s.f})`);
      if (s.wail === 1) {
        assert.ok(Math.abs(s.cx - s.matchCx) < 0.12 * VIEWPORT.width, `wail pose only while passing the match centre x (t=${s.f}, dx=${s.cx - s.matchCx})`);
      }
    }
    const wailing = samples.filter((s) => s.wail === 1);
    assert.ok(wailing.length >= 3, 'the wail pose must actually play');
    const scales = samples.map((s) => s.pulseScale);
    assert.ok(Math.max.apply(null, scales) > 1.05 && Math.max.apply(null, scales) <= 1.081, `single ~8% breathe, peak ${Math.max.apply(null, scales)}`);
    const peaks = scales.filter((v, i) => v > 1.001 && (i === 0 || scales[i - 1] <= v) && (i === 50 || scales[i + 1] < v)).length;
    assert.strictEqual(peaks, 1, 'exactly one breathe');
    assert.ok(samples.some((s) => s.f > 0.15 && s.f < 0.3 && s.lean === 1), 'lean pose before the wail');
    assert.ok(samples.some((s) => s.f > 0.7 && s.f < 0.85 && s.lean === 1), 'returns to lean after the wail');

    // Hem wobble: one variant visible per frame, all three used, stepping with the beat.
    const D = samples[0].D;
    const beat = D / 2000 * 160;
    const seen = new Set();
    for (let k = 0; k < 6; k++) {
      const s = await seek((960 * D / 2000 + k * beat + beat / 2) / D);
      const on = s.hems.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);
      assert.strictEqual(on.length, 1, 'exactly one hem variant visible');
      assert.strictEqual(on[0], k % 3, 'hem variant cycles A, B, C on the fixed beat');
      seen.add(on[0]);
    }
    assert.strictEqual(seen.size, 3);
    await settleBeacons();
  });

  test('below lane: with no room above the match, the ghost uses the lane below and stays clear of it', async () => {
    await scrollTargetTo('target', 10);
    await replayFrozen();
    const lane = await page.evaluate(() => document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]').getAttribute('data-ghost-lane'));
    assert.strictEqual(lane, 'below');
    await assertProtectedAcrossFlight('below');
    for (const f of FRAMES) {
      const s = await seek(f);
      assert.ok(s.top >= s.matchBottom + 6, `below lane: ghost top ${s.top} must stay at least 6px below the match bottom ${s.matchBottom} at t=${f}`);
    }
    await settleBeacons();
  });

  test('suppressed: with neither lane fitting the viewport, nothing mounts (never covers text)', async () => {
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 1200, height: 160 });
    try {
      await scrollTargetTo('target', 70);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      assert.strictEqual(await page.locator('.oc-beacon-transient[data-ghostsweep]').count(), 0, 'the ghost must be suppressed');
    } finally {
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await settleBeacons();
    }
  });

  test('start-point cascade: with no cursor the entry side follows the find bar centre', async () => {
    await scrollTargetTo('target', 400);
    await replayFrozen();
    const r = await page.evaluate(() => {
      const root = document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]');
      const w = document.getElementById('oc-wrap').getBoundingClientRect();
      const m = document.getElementById('target').getBoundingClientRect();
      return { dir: root.getAttribute('data-ghost-dir'), wrapCx: w.left + w.width / 2, matchCx: m.left + m.width / 2 };
    });
    assert.strictEqual(r.dir, r.wrapCx <= r.matchCx ? 'ltr' : 'rtl', 'entry side must follow the find bar centre when the cursor is unknown');
    await settleBeacons();
  });

  test('mirrored branch (cursor right of the match): enters from the right edge travelling left, clear of the match', async () => {
    await page.mouse.move(1150, 300);
    await scrollTargetTo('target', 400);
    await replayFrozen();
    const g = await page.evaluate(() => {
      const root = document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]');
      const r = root.getBoundingClientRect();
      return { dir: root.getAttribute('data-ghost-dir'), left: r.left, right: r.right, flip: root.querySelector('svg').style.transform };
    });
    assert.strictEqual(g.dir, 'rtl');
    assert.strictEqual(g.flip, 'scaleX(-1)');
    assert.ok(g.right > VIEWPORT.width * 0.9, `starts at the right edge, right=${g.right}`);
    const end = await seek(1);
    assert.ok(end.cx < 100, `exits on the left, cx=${end.cx}`);
    await assertProtectedAcrossFlight('mirrored');
    for (const f of FRAMES) {
      const s = await seek(f);
      assert.ok(s.right <= VIEWPORT.width, `trail/ghost never pokes past the right viewport edge (t=${f}, right=${s.right})`);
    }
    await settleBeacons();
  });

  test('cursor left of the match: enters from the left travelling right', async () => {
    await page.mouse.move(30, 300);
    await scrollTargetTo('target', 400);
    await replayFrozen();
    const dir = await page.evaluate(() => document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]').getAttribute('data-ghost-dir'));
    assert.strictEqual(dir, 'ltr');
    const end = await seek(1);
    assert.ok(end.cx > VIEWPORT.width - 100, `exits on the right, cx=${end.cx}`);
    await settleBeacons();
  });

  test('viewport edges: at a 500x500 viewport the ghost stays inside the viewport horizontally and clear of the match', async () => {
    await waitForOverlayResizeSettled(page, evalInContentScript, { width: 500, height: 500 });
    try {
      await scrollTargetTo('target', 300);
      await replayFrozen();
      await assertProtectedAcrossFlight('narrow');
      for (const f of FRAMES) {
        const s = await seek(f);
        assert.ok(s.right <= 500, `nothing past the right edge at t=${f}`);
      }
    } finally {
      await waitForOverlayResizeSettled(page, evalInContentScript, VIEWPORT);
      await settleBeacons();
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive and every animation is canceled', async () => {
    await scrollTargetTo('target', 400);
    await replayLive();
    const count = await page.evaluate(() => {
      window.__gsAnims = Array.from(document.querySelectorAll('.oc-beacon-transient')).flatMap((e) => e.getAnimations({ subtree: true }));
      return window.__gsAnims.length;
    });
    // travel, pulse, lean, fade, wail, 3 hems, trail
    assert.strictEqual(count, 9);
    await settleBeacons();
    const states = await page.evaluate(() => window.__gsAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `all animations canceled, got ${states.join(',')}`);
  });

  test('natural completion: nothing remains in the DOM once the sequence finishes', async () => {
    await scrollTargetTo('target', 400);
    await replayLive();
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode, set for real through chrome.storage.sync: no trail, no hem wobble, no fade-through pose; the pass and wail pulse stay', async () => {
    try {
      await setSettings({ performanceMode: true });
      await scrollTargetTo('target', 400);
      await replayFrozen();
      const g = await page.evaluate(() => {
        const root = document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]');
        return {
          anims: root.getAnimations({ subtree: true }).length,
          trail: root.querySelectorAll('[data-part="trail"]').length,
          hems: root.querySelectorAll('[data-hem]').length,
          fade: root.querySelectorAll('[data-pose="fade"]').length,
          wail: root.querySelectorAll('[data-pose="wail"]').length,
        };
      });
      assert.deepStrictEqual(g, { anims: 4, trail: 0, hems: 1, fade: 0, wail: 1 });
      const mid = await seek(0.5);
      assert.ok(mid.wail === 1 || (await seek(0.45)).wail === 1 || (await seek(0.55)).wail === 1, 'wail still plays in Lite');
      await assertProtectedAcrossFlight('lite');
    } finally {
      await setSettings({ performanceMode: false });
      await settleBeacons();
    }
  });

  test('Beacon Size L and Animation Speed fast, set for real: the box scales and the duration halves', async () => {
    try {
      await setSettings({}, { beaconSize: 'l', animationSpeed: 'fast' });
      await scrollTargetTo('target', 400);
      await replayFrozen();
      const g = await page.evaluate(() => {
        const root = document.querySelector('.oc-beacon-transient[data-ghostsweep="ghost"]');
        const durs = root.getAnimations({ subtree: true }).map((a) => a.effect.getComputedTiming().duration);
        return { w: root.getBoundingClientRect().width, durs };
      });
      assert.ok(Math.abs(g.w - 90) < 1, `L scale box width 90, got ${g.w}`);
      assert.strictEqual(g.durs[0], 1000);
      await assertProtectedAcrossFlight('large');
    } finally {
      await setSettings({}, { beaconSize: 'm', animationSpeed: 'normal' });
      await settleBeacons();
    }
  });

  test('deterministic: no Math.random in the effect, and two runs give identical frames', async () => {
    const src = fs.readFileSync(path.join(EXTENSION, 'content.js'), 'utf8');
    const start = src.indexOf('function animateGhostSweep(');
    const body = src.slice(start, src.indexOf('  function animate(rect) {', start));
    assert.ok(!/Math\.random/.test(body));
    await scrollTargetTo('target', 400);
    await replayFrozen();
    const a = await seek(0.37);
    await settleBeacons();
    await replayFrozen();
    const b = await seek(0.37);
    assert.deepStrictEqual(a, b);
    await settleBeacons();
  });

  test('pack enumeration: absent while halloween is disabled, present once enabled, selection survives a disable/re-enable round trip, runtime falls back safely', async () => {
    async function openSettings() {
      await page.locator(GEAR_BTN).click();
      await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
    }
    async function closeSettings() {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('oc-wrap').shadowRoot.querySelector('#oc-settings-panel'), null, { timeout: POLL_TIMEOUT });
    }
    await scrollTargetTo('target', 400);
    try {
      await setSettings({ enabledPacks: [] });
      let keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.strictEqual(keys.indexOf('ghostsweep'), -1);
      await openSettings();
      assert.strictEqual(await page.locator(ROW).count(), 0);
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('ghostsweep'), -1);
      await openSettings();
      assert.strictEqual(await page.locator(ROW).count(), 1);
      await closeSettings();

      // Stored selection is NOT rewritten while the pack is off; the runtime falls back.
      await setSettings({ effect: 'ghostsweep', enabledPacks: [] });
      const stored = await evalInContentScript("new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })");
      assert.strictEqual(stored, 'ghostsweep');
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      assert.strictEqual(await page.locator('.oc-beacon-transient[data-ghostsweep]').count(), 0, 'pack off: the ghost must not render');
      await settleBeacons();

      await setSettings({ enabledPacks: ['halloween'] });
      await replayLive();
      assert.ok(await page.locator(MOUNTED).count() >= 1, 'selection restored on re-enable');
      await settleBeacons();
    } finally {
      await setSettings({ enabledPacks: ['__oc_ghostsweep_test_reset__'] });
      await setSettings({ effect: 'ghostsweep', enabledPacks: ['halloween'] });
    }
  });
});
