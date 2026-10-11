// Spider Drop beacon effect (oculist-l0bs.4): the first Haunted Hollow ('hollow') pack
// effect after registration. A silk thread draws itself downward from an anchor above the
// match, the spider rides its tip ('descend'), stops with its body bottom >= 8px above the
// match's glyph box ('hang', two bobs), tucks ('recoil'), then climbs back up the thread,
// which erases bottom-up; a corner web draws in at the match's top-left OUTSIDE the glyph box
// plus 6px. Placement is above only: with no room for a short thread the effect suppresses.
//
// Modeled on test/jackolantern_effect.test.js (same real-extension fixture, replay and pack
// enumeration idioms) and test/trail_effect.test.js. Needs a real browser: WAAPI, real layout
// and chrome.storage.sync-driven settings only exist in real Chromium.
//
// The load-bearing proof for contract rule 10 is the per-frame sampler (recordRun): it reads
// every spider/thread/web box on every animation frame of a full run and asserts none of them
// ever intersects the match's rect inflated by 6px.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { scrollPageTo, POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

// A 400px lead-in puts #target at ~440px doc-y: roughly 440px of headroom unscrolled, and
// the 3000px tail gives real scrollable height so scrollTo(0, 300) is not a no-op.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:400px"></div>
<p style="margin-left:420px;">filler text <span id="target">quarklet</span></p>
<div style="height:3000px"></div>`;

const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const SD_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:spiderdrop"]';
const SD_SEL = '.oc-spiderdrop, .oc-spiderdrop-thread, .oc-spiderdrop-web';

describe('Spider Drop: a spider lowers on a thread above the match, bobs, recoils and climbs away', () => {
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

    // enabledPacks is written explicitly: the pack II seed may or may not have landed yet,
    // and the test must not depend on it.
    await setSettings({ effect: 'spiderdrop', enabledPacks: ['hollow'] });
    await waitForCondition(
      () => evalInContentScript('window.__ocTest.getAvailableEffectKeys()'),
      (keys) => keys.indexOf('spiderdrop') !== -1,
      { timeout: POLL_TIMEOUT, message: 'spiderdrop never became available' }
    );

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

  async function writeSettings(merge) {
    const echoBefore = await armSettingsEcho();
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = (' + merge + ')(current);' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
    await waitForSettingsEcho(echoBefore);
  }
  const setSettings = (patch) =>
    writeSettings('function (c) { return Object.assign({}, c, ' + JSON.stringify(patch) + '); }');
  const setVisionSettings = (patch) =>
    writeSettings(
      'function (c) { var vs = Object.assign({}, c.visionSettings || {}, ' + JSON.stringify(patch) +
        '); return Object.assign({}, c, { visionSettings: vs }); }'
    );

  // Production cancel-then-Enter re-fire path (cancelBeacons is exactly what animate() runs
  // first), then waits for `predicate` (default: any transient beacon mounted).
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

  async function waitForNoBeacons() {
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  }

  async function measureTarget() {
    return page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, scrollY: window.scrollY };
    });
  }

  // Records every animation frame of one full run: viewport boxes of the spider, thread and
  // web, the live match rect, and which leg pose is visible. Install first, then fire.
  async function recordRun() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      window.__sdRun = { samples: [], done: false };
      let seen = false, idle = 0;
      (function frame() {
        const sp = document.querySelector('.oc-spiderdrop');
        const th = document.querySelector('.oc-spiderdrop-thread');
        const wb = document.querySelector('.oc-spiderdrop-web');
        if (sp) {
          seen = true;
          idle = 0;
          const t = document.getElementById('target').getBoundingClientRect();
          const poses = Array.from(sp.querySelectorAll('[data-sd-pose]'))
            .filter((g) => parseFloat(getComputedStyle(g).opacity) > 0.5)
            .map((g) => g.getAttribute('data-sd-pose'));
          window.__sdRun.samples.push({
            sp: box(sp), th: box(th), wb: box(wb),
            target: { left: t.left, top: t.top, right: t.right, bottom: t.bottom },
            poses, scrollY: window.scrollY,
          });
        } else if (seen && ++idle > 3) {
          window.__sdRun.done = true;
          return;
        }
        requestAnimationFrame(frame);
      })();
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__sdRun.done, null, { timeout: POLL_TIMEOUT * 2 });
    return page.evaluate(() => window.__sdRun.samples);
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function assertNeverEntersProtectedRect(samples, label) {
    assert.ok(samples.length > 10, `${label}: expected a real run of frames, got ${samples.length}`);
    samples.forEach((s, i) => {
      const prot = { left: s.target.left - 6, top: s.target.top - 6, right: s.target.right + 6, bottom: s.target.bottom + 6 };
      ['sp', 'th', 'wb'].forEach((k) => {
        if (!s[k]) return;
        // 0.5px tolerance for subpixel layout rounding only.
        const b = { left: s[k].left + 0.5, top: s[k].top + 0.5, right: s[k].right - 0.5, bottom: s[k].bottom - 0.5 };
        assert.ok(!intersects(b, prot), `${label}: frame ${i}: ${k} box ${JSON.stringify(s[k])} entered the protected rect ${JSON.stringify(prot)}`);
      });
    });
  }

  test('UNSCROLLED: nothing ever enters the glyph box + 6px, the spider stays >= 8px above the match, and the poses run descend, hang, recoil, descend', async () => {
    await scrollPageTo(page, 0);
    const samples = await recordRun();
    assertNeverEntersProtectedRect(samples, 'unscrolled');

    let lowest = -Infinity;
    samples.forEach((s) => { lowest = Math.max(lowest, s.sp.bottom - s.target.top); });
    assert.ok(lowest <= -8 + 0.5, `spider body bottom must stay >= 8px above the match top at every frame, lowest was ${lowest}`);
    assert.ok(lowest > -20, `spider should hang close to the match (bottom ~8px above), lowest was ${lowest}`);

    // Thread bottom tracks the spider's top through every phase.
    samples.forEach((s, i) => {
      assert.ok(Math.abs(s.th.bottom - s.sp.top) <= 2.5, `frame ${i}: thread bottom ${s.th.bottom} must meet spider top ${s.sp.top}`);
    });

    // Pose order, collapsed.
    const order = [];
    samples.forEach((s) => {
      const p = s.poses.length === 1 ? s.poses[0] : null;
      if (p && order[order.length - 1] !== p) order.push(p);
    });
    assert.deepStrictEqual(order, ['descend', 'hang', 'recoil', 'descend'], `pose order, got ${order.join(', ')}`);

    // The spider rides the tip downward first, and ends higher than it hung.
    assert.ok(samples[0].sp.top < samples[Math.floor(samples.length / 3)].sp.top, 'spider must descend');
    const last = samples[samples.length - 1];
    assert.ok(last.sp.top < samples[Math.floor(samples.length / 2)].sp.top, 'spider must climb back up at the end');
  });

  test('SCROLLED (scrollY 300): elements are positioned in document space, and the web sits outside glyph box + 6px at the top-left corner', async () => {
    await scrollPageTo(page, 300);
    const mounted = await replay(() => {
      const sp = document.querySelector('.oc-spiderdrop');
      const wb = document.querySelector('.oc-spiderdrop-web');
      const th = document.querySelector('.oc-spiderdrop-thread');
      if (!sp || !wb || !th) return null;
      const t = document.getElementById('target').getBoundingClientRect();
      return {
        scrollY: window.scrollY,
        spTop: parseFloat(sp.style.top), spLeft: parseFloat(sp.style.left), spPos: getComputedStyle(sp).position,
        thTop: parseFloat(th.style.top),
        threadLen: parseFloat(sp.getAttribute('data-sd-thread-len')),
        wbRect: (() => { const r = wb.getBoundingClientRect(); return { right: r.right, bottom: r.bottom, left: r.left, top: r.top }; })(),
        wbPos: getComputedStyle(wb).position,
        target: { left: t.left, top: t.top, width: t.width },
      };
    });
    assert.ok(mounted.scrollY > 100, `sanity check: page must really be scrolled, scrollY=${mounted.scrollY}`);
    assert.strictEqual(mounted.spPos, 'absolute');
    assert.strictEqual(mounted.wbPos, 'absolute');
    // Document top = viewport top + scrollY: sprite bottom (top + threadLen + 64) sits at
    // match top - 8 - 6 (bob headroom) in document space.
    const expectedSpTop = mounted.target.top + mounted.scrollY - 8 - 6 - 64 - mounted.threadLen;
    assert.ok(Math.abs(mounted.thTop - expectedSpTop) <= 1.5, `thread anchor doc-y ${mounted.thTop} vs expected ${expectedSpTop}`);
    assert.ok(Math.abs(mounted.spLeft + 32 - (mounted.target.left + mounted.target.width / 2)) <= 1.5, 'spider is centred on the match horizontally');
    assert.ok(mounted.wbRect.right <= mounted.target.left - 6 + 1, `web right ${mounted.wbRect.right} must clear the glyph box by 6px (left ${mounted.target.left})`);
    assert.ok(mounted.wbRect.bottom <= mounted.target.top - 6 + 1, `web bottom ${mounted.wbRect.bottom} must clear the glyph box by 6px (top ${mounted.target.top})`);

    const samples = await recordRun();
    assertNeverEntersProtectedRect(samples, 'scrolled');
    await scrollPageTo(page, 0);
  });

  test('placement: headroom is judged from the PRE-SCROLL viewport rect; a short thread fits, no headroom suppresses (never hangs over the text)', async () => {
    const docY = await page.evaluate(() => document.getElementById('target').getBoundingClientRect().top + window.scrollY);
    try {
      // Match 150px below the viewport top: room for a capped, short thread.
      await scrollPageTo(page, docY - 150);
      const t = await measureTarget();
      const shortRun = await replay(() => {
        const sp = document.querySelector('.oc-spiderdrop');
        return sp ? { len: parseFloat(sp.getAttribute('data-sd-thread-len')), th: document.querySelector('.oc-spiderdrop-thread').style.top, scrollY: window.scrollY } : null;
      });
      // spTop = (match top - 14) - 64; threadLen = min(110, spTop - 4).
      const expectedLen = Math.min(110, t.top - 8 - 6 - 64 - 4);
      assert.ok(Math.abs(shortRun.len - expectedLen) <= 1.5, `thread length ${shortRun.len} should be capped by the room above (${expectedLen})`);
      assert.ok(parseFloat(shortRun.th) - shortRun.scrollY >= 4 - 0.5, 'thread anchor must stay inside the viewport edge margin');
      await waitForNoBeacons();

      // Match only 50px below the viewport top, though the DOCUMENT has 440px above it: the
      // viewport rect decides, so the effect suppresses.
      await scrollPageTo(page, docY - 50);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const state = await page.evaluate((sel) => ({
        spider: document.querySelectorAll(sel).length,
        transient: document.querySelectorAll('.oc-beacon-transient').length,
      }), SD_SEL);
      assert.strictEqual(state.spider, 0, 'no headroom: nothing may mount');
      assert.strictEqual(state.transient, 0, 'no headroom: no .oc-beacon-transient of any kind may remain');
    } finally {
      await scrollPageTo(page, 0);
    }
  });

  test('the match DOM is never mutated while the effect plays', async () => {
    await scrollPageTo(page, 0);
    const before = await page.evaluate(() => document.getElementById('target').parentElement.outerHTML);
    await replay(() => (document.querySelector('.oc-spiderdrop') ? true : null));
    const during = await page.evaluate(() => document.getElementById('target').parentElement.outerHTML);
    assert.strictEqual(during, before);
    await waitForNoBeacons();
  });

  test('eight legs per pose: three pose groups, each with exactly eight leg strokes', async () => {
    await scrollPageTo(page, 0);
    const info = await replay(() => {
      const sp = document.querySelector('.oc-spiderdrop');
      if (!sp) return null;
      return Array.from(sp.querySelectorAll('[data-sd-pose]')).map((g) => ({
        pose: g.getAttribute('data-sd-pose'),
        // each leg is an outline path plus a fill path
        legs: g.querySelectorAll('path').length / 2,
      }));
    });
    assert.deepStrictEqual(info.map((i) => i.pose), ['descend', 'hang', 'recoil']);
    info.forEach((i) => assert.strictEqual(i.legs, 8, `${i.pose} must have eight legs`));
  });

  test('Beacon Size XL, set for real through chrome.storage.sync: the sprite grows and the 8px gap and protected rect still hold', async () => {
    await scrollPageTo(page, 0);
    try {
      await setVisionSettings({ beaconSize: 'xl' });
      const samples = await recordRun();
      assertNeverEntersProtectedRect(samples, 'XL');
      const widest = Math.max.apply(null, samples.map((s) => s.sp.right - s.sp.left));
      assert.ok(widest > 120, `XL sprite should be ~144px wide, got ${widest}`);
      samples.forEach((s) => assert.ok(s.sp.bottom <= s.target.top - 8 + 0.5, 'XL: sprite bottom must stay >= 8px above the match'));
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
    }
  });

  test('Animation Speed, set for real through chrome.storage.sync: every rendered WAAPI duration AND delay scales by getBeaconDuration\'s factor', async () => {
    async function renderedTimings() {
      await replay(() => (document.querySelector('.oc-spiderdrop-web') ? true : null));
      return page.evaluate(collectAnimationTimings);
    }
    let currentSpeed = 'normal';
    try {
      await scrollPageTo(page, 0);
      const base = await renderedTimings();
      assert.ok(base.length > 0, 'sanity check: expected live WAAPI animations');
      for (const [speed, factor] of [['fast', 0.5], ['slow', 1.75]]) {
        currentSpeed = speed;
        await setVisionSettings({ animationSpeed: speed });
        const timings = await renderedTimings();
        assert.strictEqual(timings.length, base.length, `${speed}: same animation count`);
        timings.forEach((t, i) => {
          assert.ok(Math.abs(t.duration - base[i].duration * factor) <= 1, `${speed}: duration[${i}] ${t.duration} vs ${base[i].duration * factor}`);
          assert.ok(Math.abs(t.delay - base[i].delay * factor) <= 1, `${speed}: delay[${i}] ${t.delay} vs ${base[i].delay * factor}`);
        });
      }
    } finally {
      if (currentSpeed !== 'normal') await setVisionSettings({ animationSpeed: 'normal' });
    }
  });

  test('Lite Mode, set for real through chrome.storage.sync: silhouette, descent, hang and retract stay; the web, the second bob and the extra tones are dropped', async () => {
    function snapshot() {
      const sp = document.querySelector('.oc-spiderdrop');
      if (!sp) return null;
      return {
        poses: sp.querySelectorAll('[data-sd-pose]').length,
        web: document.querySelectorAll('.oc-spiderdrop-web').length,
        thread: document.querySelectorAll('.oc-spiderdrop-thread').length,
        ellipses: sp.querySelectorAll('ellipse').length,
        anims: Array.from(document.querySelectorAll('.oc-beacon-transient')).reduce((n, el) => n + el.getAnimations({ subtree: true }).length, 0),
        total: sp.getAnimations()[0].effect.getComputedTiming().duration,
      };
    }
    await scrollPageTo(page, 0);
    const full = await replay(() => { const s = document.querySelector('.oc-spiderdrop-web') && document.querySelector('.oc-spiderdrop'); return s ? true : null; }).then(() => page.evaluate(snapshot));
    assert.strictEqual(full.web, 1, 'full mode draws the corner web');
    assert.strictEqual(full.ellipses, 1, 'full mode carries the body highlight tone');
    assert.strictEqual(full.anims, 8, 'full mode: 4 spider + 1 thread + 3 web animations');
    try {
      await setSettings({ performanceMode: true });
      const lite = await replay(snapshot);
      assert.strictEqual(lite.poses, 3, 'Lite keeps all three poses');
      assert.strictEqual(lite.thread, 1, 'Lite keeps the thread');
      assert.strictEqual(lite.web, 0, 'Lite drops the web');
      assert.strictEqual(lite.ellipses, 0, 'Lite drops the highlight tone');
      assert.strictEqual(lite.anims, 5, 'Lite: 4 spider + 1 thread animations only');
      assert.ok(lite.total < full.total, `Lite drops the second bob (${lite.total} < ${full.total})`);
      const samples = await recordRun();
      assertNeverEntersProtectedRect(samples, 'lite');
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive and every animation is canceled', async () => {
    await scrollPageTo(page, 0);
    await replay(() => (document.querySelector('.oc-spiderdrop') ? true : null));
    const count = await page.evaluate(() => {
      window.__sdAnims = [];
      document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
        window.__sdAnims = window.__sdAnims.concat(el.getAnimations({ subtree: true }));
      });
      return window.__sdAnims.length;
    });
    assert.strictEqual(count, 8, `expected 8 live animations before cancellation, got ${count}`);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await waitForNoBeacons();
    const states = await page.evaluate(() => window.__sdAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got ${states.join(', ')}`);
  });

  test('overlay close: Escape tears down the finder and nothing survives', async () => {
    await replay(() => (document.querySelector('.oc-spiderdrop') ? true : null));
    try {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
      assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient').length), 0);
    } finally {
      await openFinder(page);
      await page.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page);
    }
  });

  test('rapid refire: repeated Enter never leaves more than one spider mounted', async () => {
    await scrollPageTo(page, 0);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Enter');
      const n = await page.evaluate(() => document.querySelectorAll('.oc-spiderdrop').length);
      assert.ok(n <= 1, `at most one spider at once, got ${n} after press ${i + 1}`);
    }
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await waitForNoBeacons();
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollPageTo(page, 0);
    await replay(() => (document.querySelector('.oc-spiderdrop') ? true : null));
    await waitForNoBeacons();
  });

  test('pack enumeration: absent while hollow is disabled, present once enabled, selection survives a round trip, runtime falls back safely', async () => {
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
    await scrollPageTo(page, 0);
    try {
      await setSettings({ enabledPacks: [] });
      let keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.strictEqual(keys.indexOf('spiderdrop'), -1, 'absent from availableEffects() while the pack is disabled');
      await openSettings();
      assert.strictEqual(await page.locator(SD_EFFECT_ROW).count(), 0, 'absent from the picker while disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['hollow'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('spiderdrop'), -1, 'present once hollow is enabled');
      await openSettings();
      assert.strictEqual(await page.locator(SD_EFFECT_ROW).count(), 1, 'present in the picker once enabled');
      await closeSettings();

      // The stored selection is NOT rewritten by disabling the pack.
      await setSettings({ effect: 'spiderdrop', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'spiderdrop', 'stored selection must not be rewritten while the pack is disabled');
      const fallback = await replay(() => (document.querySelector('.oc-beacon-transient') ? { spider: !!document.querySelector('.oc-spiderdrop') } : null));
      assert.strictEqual(fallback.spider, false, 'while disabled the runtime falls back to another effect');
      await waitForNoBeacons();

      await setSettings({ enabledPacks: ['hollow'] });
      const restored = await replay(() => (document.querySelector('.oc-spiderdrop') ? { spider: true } : null));
      assert.strictEqual(restored.spider, true, 'selection restored on re-enable');
      await waitForNoBeacons();
    } finally {
      await setSettings({ enabledPacks: ['__oc_spiderdrop_test_reset__'] });
      await setSettings({ effect: 'spiderdrop', enabledPacks: ['hollow'] });
    }
  });
});
