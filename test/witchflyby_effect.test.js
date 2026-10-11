// Witch Flyby beacon effect (oculist-l0bs.5): the first Haunted Hollow ('hollow') pack
// effect built for pack II. A witch on a broom crosses along a lane ABOVE the match (level
// cruise), climbs into one loop-the-loop, dives past the match's far side swinging her wand
// and exits; a spark-trail ribbon follows her and the wand swing draws the trail's closing
// stroke as an underline beneath the match, which fades after she has gone.
//
// There is no prototype (the beat spec in the bead stands in for it), so this suite is the
// proof of the contract rather than a port check:
//   - Rule 2: document coordinates (scrolled page) with viewport-fit decisions made from the
//     PRE-SCROLL viewport rect.
//   - Rule 9: the cursor / find-bar / viewport-centre cascade picks the entry side, and the
//     mirrored (right-to-left) branch really renders, flipped.
//   - Rule 10: in every sampled frame of every placement mode the witch's box, the ribbon
//     (with its stroke), the sparks and the underline stay clear of the glyph box plus 6px,
//     and the page's own text pixels are identical frame to frame.
//   - Placement: loop, degraded straight pass (no room for the loop), 'below' lane (no room
//     above), and suppression (no room above or below).
//   - Lifecycle: mid-flight cancellation, natural completion, Lite Mode (set for real
//     through chrome.storage.sync), beacon size, animation speed, pack enumeration.
//
// Modeled on test/trail_effect.test.js and test/batflight_effect.test.js. Needs a real
// browser: WAAPI, offset-path and layout only exist in real Chromium.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { scrollPageTo, POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1600px"></div>
<div style="margin-left:600px;"><span id="target">hexweaver</span> filler</div>
<div style="height:1600px"></div>
<p style="font-size:96px;margin:0"><span id="wideTarget">spellbroom</span> filler</p>
<div style="height:1200px"></div>`;

const TARGET_TERMS = { target: 'hexweaver', wideTarget: 'spellbroom' };
const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const WITCH_ROW = '#oc-wrap >> [data-oc-key="effect:witchflyby"]';
const WITCH_SEL = '.oc-beacon-transient[data-witchflyby="witch"]';

describe('Witch Flyby: a witch crosses above the match, loops, dives with a wand, and a spark trail underlines it', () => {
  let server, ctx, page, client, isolatedContextId, origin;
  let currentTarget = 'target';

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

    await setSettings({ effect: 'witchflyby', enabledPacks: ['hollow'], scrollBehavior: 'instant' });
    await waitForCondition(
      () => evalInContentScript('window.__ocTest.getAvailableEffectKeys()'),
      (keys) => keys.indexOf('witchflyby') !== -1,
      { timeout: POLL_TIMEOUT, message: 'the hollow pack never became available' }
    );

    await openFinder(page);
    await page.locator(INPUT).type(TARGET_TERMS.target, { delay: 30 });
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

  // Cancels through the production path, then Enter. Waits for the witch element.
  async function replay(predicate) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    const handle = await page.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-witchflyby="witch"]') ? true : null)),
      null,
      { timeout: POLL_TIMEOUT }
    );
    return handle.jsonValue();
  }

  // Fires with every animation frozen at t=0 from the very first mutation, so the rendered
  // state is a pure function of the sampled currentTime.
  async function fireFrozen() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.evaluate(() => {
      if (window.__wfFreeze) window.__wfFreeze.disconnect();
      window.__wfFreeze = new MutationObserver(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((root) => {
          root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
        });
      });
      window.__wfFreeze.observe(document.documentElement, { childList: true, subtree: true });
    });
    try {
      await page.keyboard.press('Enter');
      await page.waitForSelector(WITCH_SEL, { timeout: POLL_TIMEOUT, state: 'attached' });
    } finally {
      await page.evaluate(() => { window.__wfFreeze.disconnect(); delete window.__wfFreeze; });
    }
  }

  // Page-side: steps every beacon animation to t and returns what rendered.
  const SAMPLE_FN = (args) => {
    const { t, id } = args;
    document.querySelectorAll('.oc-beacon-transient').forEach((root) => {
      root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = t; });
    });
    const m = document.getElementById(id).getBoundingClientRect();
    const w = document.querySelector('[data-witchflyby="witch"]');
    if (!w) return null;
    const b = w.getBoundingClientRect();
    const poses = {};
    w.querySelectorAll('[data-witchflyby-pose]').forEach((g) => {
      poses[g.getAttribute('data-witchflyby-pose')] = parseFloat(getComputedStyle(g).opacity);
    });
    return {
      t,
      box: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
      opacity: parseFloat(getComputedStyle(w).opacity),
      poses,
      match: { left: m.left, right: m.right, top: m.top, bottom: m.bottom },
    };
  };

  // Static geometry: the ribbon polyline (sampled along its own length) with stroke radius,
  // every spark's box at its final state, the underline's box. All viewport space.
  const STATIC_FN = (id) => {
    const out = { ribbon: [], strokeR: 0, sparks: [], underline: null, scrollX: window.scrollX, scrollY: window.scrollY };
    const rib = document.querySelector('[data-witchflyby="ribbon"]');
    if (rib) {
      const len = rib.getTotalLength();
      const step = Math.max(2, len / 400);
      out.strokeR = parseFloat(rib.getAttribute('stroke-width')) / 2;
      const ctm = rib.getScreenCTM();
      for (let s = 0; s <= len + 0.01; s += step) {
        const p = rib.getPointAtLength(Math.min(s, len));
        out.ribbon.push([p.x * ctm.a + p.y * ctm.c + ctm.e, p.x * ctm.b + p.y * ctm.d + ctm.f]);
      }
    }
    document.querySelectorAll('[data-witchflyby="spark"]').forEach((g) => {
      const r = g.getBoundingClientRect();
      out.sparks.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    });
    const u = document.querySelector('[data-witchflyby="underline"]');
    if (u) {
      const r = u.getBoundingClientRect();
      out.underline = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, sw: parseFloat(u.getAttribute('stroke-width')) };
    }
    return out;
  };

  function boxesOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }
  function inflate(r, n) {
    return { left: r.left - n, right: r.right + n, top: r.top - n, bottom: r.bottom + n };
  }
  function distToRect(p, r) {
    const dx = Math.max(r.left - p[0], 0, p[0] - r.right);
    const dy = Math.max(r.top - p[1], 0, p[1] - r.bottom);
    return Math.hypot(dx, dy);
  }

  const FLIGHT_MS = 1900;

  // Samples the whole flight (and the underline hold) and asserts rule 10 geometrically in
  // every frame. Returns the frames and static geometry for further assertions.
  async function sampleAndAssertProtected(id, label, opts) {
    const { steps = 48 } = opts || {};
    const frames = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * FLIGHT_MS;
      const f = await page.evaluate(SAMPLE_FN, { t, id });
      assert.ok(f, `${label}: witch missing at t=${t}`);
      frames.push(f);
      assert.ok(
        !boxesOverlap(f.box, inflate(f.match, 6)),
        `${label}: the witch box enters the glyph box + 6px at t=${t.toFixed(0)}: ${JSON.stringify(f.box)} vs ${JSON.stringify(f.match)}`
      );
    }
    // Static geometry at the end state (all sparks revealed, underline fully drawn).
    await page.evaluate(SAMPLE_FN, { t: FLIGHT_MS + 100, id });
    const st = await page.evaluate(STATIC_FN, id);
    const match = frames[0].match;
    const P = inflate(match, 6);
    for (const p of st.ribbon) {
      assert.ok(
        distToRect(p, match) >= 6 + st.strokeR - 0.01,
        `${label}: the trail ribbon (point ${p}) comes within 6px of the glyph box`
      );
    }
    for (const s of st.sparks) {
      const w = s.right - s.left, h = s.bottom - s.top;
      const grown = { left: s.left - w * 0.15, right: s.right + w * 0.15, top: s.top - h * 0.15, bottom: s.bottom + h * 0.15 };
      assert.ok(!boxesOverlap(grown, P), `${label}: a star spark enters the glyph box + 6px`);
    }
    if (st.underline) {
      assert.ok(st.underline.top >= match.bottom + 6, `${label}: the underline must clear the glyph box by at least 6px (top=${st.underline.top}, bottom of match=${match.bottom})`);
      assert.ok(!boxesOverlap(st.underline, P), `${label}: the underline enters the glyph box + 6px`);
    }
    return { frames, st, match };
  }

  async function matchPixels(id) {
    const r = await page.evaluate((elId) => {
      const b = document.getElementById(elId).getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    }, id);
    return page.screenshot({ clip: r });
  }

  async function scrollTargetTo(id, topOffset) {
    const docTop = await page.evaluate((elId) => {
      const r = document.getElementById(elId).getBoundingClientRect();
      return r.top + window.scrollY;
    }, id);
    await scrollPageTo(page, Math.max(0, docTop - topOffset));
  }

  async function switchTo(id) {
    if (currentTarget === id) return;
    await page.locator(INPUT).fill('');
    await page.locator(INPUT).type(TARGET_TERMS[id], { delay: 30 });
    await waitForMatchCount(page);
    await settleNavigation();
    currentTarget = id;
  }

  function posesSeen(frames) {
    const seen = [];
    for (const f of frames) {
      for (const name of ['cruise', 'climb', 'dive']) {
        if (f.poses[name] > 0.5 && seen[seen.length - 1] !== name) seen.push(name);
      }
    }
    return seen;
  }

  test('document-space correctness and the full beat: on a scrolled page the flight is cruise, climb (loop), dive, with a loop that stays clear of the glyph box', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await page.mouse.move(50, 400);
    await fireFrozen();
    try {
      const scrollY = await page.evaluate(() => window.scrollY);
      assert.ok(scrollY > 500, `sanity: the page must really be scrolled, got scrollY=${scrollY}`);

      // The element's own offset-path is in DOCUMENT space: its first point minus scroll is a
      // viewport y that sits above the glyph box.
      const geom = await page.evaluate(() => {
        const w = document.querySelector('[data-witchflyby="witch"]');
        const m = document.getElementById('target').getBoundingClientRect();
        const d = w.style.offsetPath || getComputedStyle(w).offsetPath;
        const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        return { first: [nums[0], nums[1]], scrollX: window.scrollX, scrollY: window.scrollY, matchTop: m.top, matchBottom: m.bottom, position: getComputedStyle(w).position, z: getComputedStyle(w).zIndex, cls: w.className };
      });
      assert.strictEqual(geom.position, 'absolute');
      assert.strictEqual(geom.z, '2147483642');
      assert.ok(/oc-beacon oc-beacon-transient/.test(geom.cls));
      assert.ok(geom.first[1] > geom.scrollY, 'the path must carry the "+ scrollY" term (document coordinates)');
      assert.ok(geom.first[1] - geom.scrollY < geom.matchTop - 10, 'the lane must sit above the glyph box (viewport-decided, then document-positioned)');

      const { frames, st } = await sampleAndAssertProtected('target', 'loop mode');
      assert.deepStrictEqual(posesSeen(frames), ['cruise', 'climb', 'cruise', 'dive'], 'poses must run cruise -> climb (loop) -> cruise -> dive');

      // The loop: the witch's box rises well above the lane height (box top above the lane).
      const laneTop = frames[0].box.top;
      const minTop = Math.min(...frames.map((f) => f.box.top));
      assert.ok(laneTop - minTop >= 30, `expected a real loop (rise ${laneTop - minTop}px above the lane)`);

      // Dive: the witch ends lower than the lane; the exit stays clear of the glyph box.
      const last = frames[frames.length - 1];
      assert.ok(last.box.top > laneTop + 10, 'the dive must descend past the lane');

      // The underline exists and is a horizontal stroke beneath the whole match.
      assert.ok(st.underline, 'the closing underline must exist');
      assert.ok(st.underline.left <= frames[0].match.left && st.underline.right >= frames[0].match.right, 'the underline must span the match');
      assert.ok(st.sparks.length >= 8, `expected the fixed table of star sparks, got ${st.sparks.length}`);

      // Document-space spot check of the underline path itself.
      const ud = await page.evaluate(() => document.querySelector('[data-witchflyby="underline"]').getAttribute('d'));
      const un = (ud.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      assert.ok(un[1] - geom.scrollY >= geom.matchBottom + 6, 'the underline path y must be document-space (viewport y + scrollY)');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
  });

  test('the match DOM and its glyph pixels are untouched in every sampled frame', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await page.mouse.move(50, 400);
    const htmlBefore = await page.evaluate(() => document.getElementById('target').parentElement.outerHTML);
    await fireFrozen();
    try {
      await page.evaluate(SAMPLE_FN, { t: 0, id: 'target' });
      const base = await matchPixels('target');
      for (const t of [0, 250, 500, 800, 1100, 1400, 1700, 1900, 2100, 2500]) {
        await page.evaluate(SAMPLE_FN, { t, id: 'target' });
        const px = await matchPixels('target');
        assert.ok(base.equals(px), `the glyph box pixels changed at t=${t}`);
      }
      const htmlAfter = await page.evaluate(() => document.getElementById('target').parentElement.outerHTML);
      assert.strictEqual(htmlAfter, htmlBefore, 'the match DOM must be untouched');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
  });

  test('mirrored branch (rule 9): with the cursor to the right of the match the witch really enters from the right, flipped, and stays protected', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await page.mouse.move(1150, 400);
    await fireFrozen();
    try {
      const { frames } = await sampleAndAssertProtected('target', 'mirrored');
      const first = frames[0], last = frames[frames.length - 1];
      const mcx = (first.match.left + first.match.right) / 2;
      assert.ok((first.box.left + first.box.right) / 2 > mcx, 'the witch must start on the right of the match');
      assert.ok((last.box.left + last.box.right) / 2 < mcx, 'she exits on the far (left) side');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
  });

  test('mirrored branch, corrected: right entry exits on the LEFT and the sprite is flipped with scaleX(-1)', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await page.mouse.move(1150, 400);
    await fireFrozen();
    try {
      const a = await page.evaluate(SAMPLE_FN, { t: 0, id: 'target' });
      const b = await page.evaluate(SAMPLE_FN, { t: FLIGHT_MS, id: 'target' });
      const mcx = (a.match.left + a.match.right) / 2;
      assert.ok((a.box.left + a.box.right) / 2 > mcx, 'entry on the right');
      assert.ok((b.box.left + b.box.right) / 2 < mcx, 'exit on the left (the far side)');
      const flip = await page.evaluate(() => document.querySelector('[data-witchflyby="witch"] svg').style.transform);
      assert.strictEqual(flip, 'scaleX(-1)');
      await page.mouse.move(50, 400);
      await fireFrozen();
      const flip2 = await page.evaluate(() => document.querySelector('[data-witchflyby="witch"] svg').style.transform);
      assert.strictEqual(flip2, '', 'left-to-right travel must not be flipped');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
  });

  test('no room for the loop: degrades to a straight pass with the underline, no climb pose, still protected', async () => {
    await switchTo('target');
    // Room for the witch above (lane) but not for a loop: match top 95px below the viewport top.
    await scrollTargetTo('target', 95);
    await page.mouse.move(50, 400);
    await fireFrozen();
    try {
      const { frames, st } = await sampleAndAssertProtected('target', 'straight pass');
      assert.ok(!posesSeen(frames).includes('climb'), 'no loop means no climb pose');
      assert.ok(posesSeen(frames).includes('dive'), 'the wand swing pose must still appear');
      const tops = frames.map((f) => f.box.top);
      assert.ok(Math.max(...tops) - Math.min(...tops) < 60, 'a straight pass has no loop-sized vertical excursion');
      assert.ok(st.underline, 'the underline must still be drawn');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
  });

  test('viewport edge, no room above: the witch flies a straight lane BELOW the underline, never enters the glyph box, underline still drawn', async () => {
    await switchTo('wideTarget');
    await scrollTargetTo('wideTarget', 8);
    await page.mouse.move(50, 400);
    await fireFrozen();
    try {
      const { frames, st, match } = await sampleAndAssertProtected('wideTarget', 'below lane');
      assert.ok(frames.every((f) => f.box.top >= match.bottom + 6), 'every frame must sit wholly below the glyph box');
      assert.ok(!posesSeen(frames).includes('climb'), 'no loop in the below lane');
      assert.ok(st.underline, 'the underline must be drawn');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
  });

  test('no room above or below: the effect is suppressed and nothing mounts', async () => {
    await switchTo('wideTarget');
    await page.setViewportSize({ width: 1200, height: 190 });
    try {
      await scrollTargetTo('wideTarget', 4);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 700));
      const n = await page.evaluate(() => document.querySelectorAll('[data-witchflyby]').length);
      assert.strictEqual(n, 0, 'a suppressed run must not leave or mount any witch element');
    } finally {
      await page.setViewportSize(VIEWPORT);
      await scrollPageTo(page, 0);
    }
  });

  test('no cursor ever moved (rule 9 cascade): a fresh tab falls back to the find bar and still enters from a real side', async () => {
    const page2 = await ctx.newPage();
    const client2 = await ctx.newCDPSession(page2);
    await client2.send('Page.enable');
    await client2.send('Runtime.enable');
    let ctxId2;
    client2.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) ctxId2 = c.id;
    });
    try {
      await page2.goto(origin);
      await waitForCondition(() => ctxId2, Boolean, { timeout: POLL_TIMEOUT, message: 'no isolated context for the fresh tab' });
      await openFinder(page2);
      await evalInContentScript("window.__ocTest.setEffectKey('witchflyby')", { client: client2, contextId: ctxId2 });
      await page2.locator(INPUT).type(TARGET_TERMS.target, { delay: 30 });
      await waitForMatchCount(page2);
      const docTop = await page2.evaluate(() => {
        const r = document.getElementById('target').getBoundingClientRect();
        return r.top + window.scrollY;
      });
      await scrollPageTo(page2, docTop - 300);
      await page2.keyboard.press('Enter');
      const info = await (await page2.waitForFunction(() => {
        const w = document.querySelector('[data-witchflyby="witch"]');
        if (!w) return null;
        const flipped = w.querySelector('svg').style.transform === 'scaleX(-1)';
        const m = document.getElementById('target').getBoundingClientRect();
        const bar = document.getElementById('oc-wrap').getBoundingClientRect();
        return { flipped, matchCx: m.left + m.width / 2, barCx: bar.left + bar.width / 2 };
      }, null, { timeout: POLL_TIMEOUT })).jsonValue();
      // Entry side comes from the find bar centre vs the match centre.
      assert.strictEqual(info.flipped, info.barCx > info.matchCx, `find-bar fallback picks the side: bar ${info.barCx} vs match ${info.matchCx}`);
    } finally {
      await page2.close();
    }
  });

  test('every poses fits its own viewBox (nothing relies on the sprite clip) and the sprite SVG still clips as a backstop', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await page.mouse.move(50, 400);
    await fireFrozen();
    try {
      const res = await page.evaluate(() => {
        const svg = document.querySelector('[data-witchflyby="witch"] svg');
        const out = { overflow: getComputedStyle(svg).overflow, poses: {} };
        svg.querySelectorAll('[data-witchflyby-pose]').forEach((g) => {
          const b = g.getBBox();
          out.poses[g.getAttribute('data-witchflyby-pose')] = { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height };
        });
        return out;
      });
      assert.strictEqual(res.overflow, 'hidden');
      for (const [name, b] of Object.entries(res.poses)) {
        assert.ok(b.x >= -0.5 && b.y >= -0.5 && b.r <= 120.5 && b.b <= 84.5, `pose ${name} paints outside the viewBox: ${JSON.stringify(b)}`);
      }
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive and no animation keeps running', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await replay();
    await new Promise((r) => setTimeout(r, 250));
    const before = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient').length);
    assert.ok(before >= 2, 'the witch and the trail layer must be mounted mid-flight');
    const handles = await page.evaluate(() => {
      window.__wfAnims = Array.from(document.querySelectorAll('.oc-beacon-transient')).flatMap((r) => r.getAnimations({ subtree: true }));
      return window.__wfAnims.length;
    });
    assert.ok(handles > 0);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    const after = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.oc-beacon-transient').length,
      states: window.__wfAnims.map((a) => a.playState),
    }));
    assert.strictEqual(after.nodes, 0);
    assert.ok(after.states.every((s) => s === 'idle' || s === 'finished'), `every WAAPI animation must be cancelled: ${after.states}`);
    await scrollPageTo(page, 0);
  });

  test('natural completion: nothing remains in the DOM, and the Animation Speed knob scales every duration', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await setVisionSettings({ animationSpeed: 'fast' });
    try {
      await replay();
      const durs = await page.evaluate(() => {
        const w = document.querySelector('[data-witchflyby="witch"]');
        return w ? w.getAnimations({ subtree: true }).map((a) => a.effect.getTiming().duration) : [];
      });
      assert.ok(durs.includes(FLIGHT_MS * 0.5), `fast speed must halve the flight duration, got ${JSON.stringify(durs)}`);
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
      assert.strictEqual(await page.evaluate(() => document.querySelectorAll('[data-witchflyby]').length), 0);
    } finally {
      await setVisionSettings({ animationSpeed: 'normal' });
      await scrollPageTo(page, 0);
    }
  });

  test('Lite Mode, set for real through chrome.storage.sync: keeps the pass, loop and underline, drops the star sparks and the bristle flutter', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await page.mouse.move(50, 400);
    async function counts() {
      await fireFrozen();
      return page.evaluate(() => ({
        sparks: document.querySelectorAll('[data-witchflyby="spark"]').length,
        ribbon: document.querySelectorAll('[data-witchflyby="ribbon"]').length,
        underline: document.querySelectorAll('[data-witchflyby="underline"]').length,
        witch: document.querySelectorAll('[data-witchflyby="witch"]').length,
        poses: document.querySelectorAll('[data-witchflyby-pose]').length,
        anims: Array.from(document.querySelectorAll('.oc-beacon-transient')).reduce((n, r) => n + r.getAnimations({ subtree: true }).length, 0),
      }));
    }
    let full, lite;
    try {
      full = await counts();
      await setSettings({ performanceMode: true });
      lite = await counts();
    } finally {
      await setSettings({ performanceMode: false });
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
    assert.ok(full.sparks >= 8, 'full mode draws the star sparks');
    assert.strictEqual(lite.sparks, 0, 'Lite Mode drops the star sparks');
    assert.ok(full.anims - lite.anims >= full.sparks, 'Lite Mode drops the spark and bristle-flutter animations');
    assert.deepStrictEqual([lite.ribbon, lite.underline, lite.witch, lite.poses], [full.ribbon, full.underline, full.witch, full.poses], 'Lite keeps the silhouette, the pass and the underline');
  });

  test('Beacon Size XL scales the sprite box, and the protected rect still holds', async () => {
    await switchTo('target');
    await scrollTargetTo('target', 300);
    await page.mouse.move(50, 400);
    async function boxW() {
      await fireFrozen();
      return page.evaluate(() => document.querySelector('[data-witchflyby="witch"]').getBoundingClientRect().width);
    }
    try {
      const m = await boxW();
      await setVisionSettings({ beaconSize: 'xl' });
      const xl = await boxW();
      assert.ok(Math.abs(xl / m - 2.25) < 0.05, `XL must scale the sprite 2.25x, got ${xl / m}`);
      await sampleAndAssertProtected('target', 'xl', { steps: 24 });
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await scrollPageTo(page, 0);
    }
  });

  test('pack enumeration: absent while hollow is disabled, present once enabled, selection survives a disable/re-enable round trip, runtime falls back safely', async () => {
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
    await switchTo('target');
    await scrollTargetTo('target', 300);
    try {
      await setSettings({ enabledPacks: [] });
      let keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.strictEqual(keys.indexOf('witchflyby'), -1);
      await openSettings();
      assert.strictEqual(await page.locator(WITCH_ROW).count(), 0, 'absent from the picker while disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['hollow'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('witchflyby'), -1);
      await openSettings();
      assert.strictEqual(await page.locator(WITCH_ROW).count(), 1, 'present in the picker once enabled');
      await closeSettings();

      // Disabled: the stored selection is NOT rewritten, and firing falls back to another effect.
      await setSettings({ enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'witchflyby', 'the stored selection must not be rewritten while the pack is disabled');
      const geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? { mounted: !!document.querySelector('[data-witchflyby]') } : null));
      assert.strictEqual(geom.mounted, false, 'the runtime fallback must not render the witch');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Re-enable: selection restored with no re-selection.
      await setSettings({ enabledPacks: ['hollow'] });
      const again = await replay(() => (document.querySelector('[data-witchflyby="witch"]') ? { mounted: true } : null));
      assert.strictEqual(again.mounted, true);
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      await setSettings({ enabledPacks: ['__oc_witchflyby_test_reset__'] });
      await setSettings({ effect: 'witchflyby', enabledPacks: ['hollow'] });
      await scrollPageTo(page, 0);
    }
  });
});
