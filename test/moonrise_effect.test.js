// Moonrise beacon effect (oculist-l0bs.12), Haunted Hollow ('hollow') pack. The matched
// line's top edge is the horizon: a full moon rises from behind it (clipped by the sprite's
// bottom edge, 9px above the glyph box), a wolf pops up standing on it, raises its head into
// a howl while a thin moonlit rim shows 7-9px above the box, holds, drops back, and the moon
// sets. Clouds drift across the moon and stars twinkle on a fixed beat. Placement is above
// only: full -> smaller moon with side stars -> crescent only -> suppressed.
//
// Modeled on test/spiderdrop_effect.test.js and test/trail_effect.test.js. The load-bearing
// proof for contract rule 10 is the per-frame sampler (recordRun): every sprite/rim box on
// every animation frame must stay outside the match's rect inflated by 6px.

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
const MR_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:moonrise"]';

describe('Moonrise: a full moon rises behind the match line, a wolf howls on the horizon, the moon sets', () => {
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
    await setSettings({ effect: 'moonrise', enabledPacks: ['hollow'] });
    await waitForCondition(
      () => evalInContentScript('window.__ocTest.getAvailableEffectKeys()'),
      (keys) => keys.indexOf('moonrise') !== -1,
      { timeout: POLL_TIMEOUT, message: 'moonrise never became available' }
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

  // Records every animation frame of one full run: viewport boxes of the host sprite and the
  // rim, the live match rect, the wolf head's rotation, and the moon's top. Install first,
  // then fire.
  async function recordRun() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      window.__mrRun = { samples: [], done: false };
      let seen = false, idle = 0;
      (function frame() {
        const host = document.querySelector('.oc-moonrise');
        const rim = document.querySelector('.oc-moonrise-rim');
        if (host) {
          seen = true;
          idle = 0;
          const t = document.getElementById('target').getBoundingClientRect();
          const head = host.querySelector('[data-mr-head]');
          let angle = null;
          if (head) {
            const m = getComputedStyle(head).transform;
            const v = m && m !== 'none' ? m.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number) : [1, 0];
            angle = Math.round(Math.atan2(v[1], v[0]) * 180 / Math.PI);
          }
          const moon = host.querySelector('[data-mr-moon]');
          const wolf = host.querySelector('[data-mr-wolf-g]');
          window.__mrRun.samples.push({
            host: box(host), rim: box(rim),
            target: { left: t.left, top: t.top, right: t.right, bottom: t.bottom },
            angle,
            moonTop: moon ? moon.getBoundingClientRect().top : null,
            wolfTop: wolf ? wolf.getBoundingClientRect().top : null,
            rimOpacity: rim ? parseFloat(getComputedStyle(rim).opacity) : 0,
            scrollY: window.scrollY,
          });
        } else if (seen && ++idle > 3) {
          window.__mrRun.done = true;
          return;
        }
        requestAnimationFrame(frame);
      })();
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__mrRun.done, null, { timeout: POLL_TIMEOUT * 2 });
    return page.evaluate(() => window.__mrRun.samples);
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function assertNeverEntersProtectedRect(samples, label) {
    assert.ok(samples.length > 10, `${label}: expected a real run of frames, got ${samples.length}`);
    samples.forEach((s, i) => {
      const prot = { left: s.target.left - 6, top: s.target.top - 6, right: s.target.right + 6, bottom: s.target.bottom + 6 };
      ['host', 'rim'].forEach((k) => {
        if (!s[k]) return;
        // 0.5px tolerance for subpixel layout rounding only.
        const b = { left: s[k].left + 0.5, top: s[k].top + 0.5, right: s[k].right - 0.5, bottom: s[k].bottom - 0.5 };
        assert.ok(!intersects(b, prot), `${label}: frame ${i}: ${k} box ${JSON.stringify(s[k])} entered the protected rect ${JSON.stringify(prot)}`);
      });
    });
  }

  // Scrolls so the match sits `top` px below the viewport top, then fires and returns the
  // mounted host's state (or null after a settle delay when nothing mounts).
  async function placeAt(top) {
    const docY = await page.evaluate(() => document.getElementById('target').getBoundingClientRect().top + window.scrollY);
    await scrollPageTo(page, docY - top);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    await new Promise((resolve) => setTimeout(resolve, 250));
    return page.evaluate(() => {
      const h = document.querySelector('.oc-moonrise');
      if (!h) return { mounted: false, transient: document.querySelectorAll('.oc-beacon-transient').length };
      const r = h.getBoundingClientRect();
      return {
        mounted: true, mode: h.getAttribute('data-mr-mode'), wolf: h.getAttribute('data-mr-wolf'),
        d: parseFloat(h.getAttribute('data-mr-moon-d')),
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        stars: h.querySelectorAll('[data-mr-star]').length, clouds: h.querySelectorAll('[data-mr-cloud]').length,
        craters: h.querySelectorAll('[data-mr-crater]').length,
        targetTop: document.getElementById('target').getBoundingClientRect().top,
      };
    });
  }

  test('UNSCROLLED: nothing ever enters the glyph box + 6px; moon rises from the horizon, wolf pops up and raises its head, rim shows during the hold, then it all sets', async () => {
    await scrollPageTo(page, 0);
    const samples = await recordRun();
    assertNeverEntersProtectedRect(samples, 'unscrolled');

    // The host's bottom edge IS the horizon: 9px above the glyph box, in every frame.
    samples.forEach((s, i) => {
      assert.ok(Math.abs(s.host.bottom - (s.target.top - 9)) <= 1, `frame ${i}: horizon at ${s.host.bottom}, expected ${s.target.top - 9}`);
    });
    // Moon: starts below the horizon (clipped), reaches rest, ends below again.
    const horizon = samples[0].host.bottom;
    assert.ok(samples[0].moonTop >= horizon - 1, 'moon starts hidden below the horizon');
    const restTop = Math.min.apply(null, samples.map((s) => s.moonTop));
    assert.ok(restTop < horizon - 40, `moon must rise well above the horizon, rest top ${restTop} vs horizon ${horizon}`);
    assert.ok(samples[samples.length - 1].moonTop > restTop + 20, 'moon sets again at the end');
    // Wolf pops up (its top rises) and the head goes -38 -> 0 -> -38.
    const angles = samples.map((s) => s.angle);
    assert.ok(angles[0] <= -30, `head starts lowered, got ${angles[0]}`);
    assert.ok(angles.indexOf(0) !== -1, 'head reaches the raised howl pose');
    const peakAt = angles.indexOf(0);
    assert.ok(angles.slice(peakAt).some((a) => a <= -30), 'head lowers again before the wolf drops');
    const wolfTops = samples.map((s) => s.wolfTop);
    assert.ok(Math.min.apply(null, wolfTops) < horizon - 20, 'wolf stands up above the horizon');
    // Rim: present only mid-run, 7-9px above the glyph box.
    const withRim = samples.filter((s) => s.rimOpacity > 0.5);
    assert.ok(withRim.length >= 3, 'rim is visible during the hold');
    withRim.forEach((s) => {
      assert.ok(s.rim.bottom <= s.target.top - 7 + 0.5, `rim bottom ${s.rim.bottom} must clear glyph box + 6px (top ${s.target.top})`);
      assert.ok(s.rim.top >= s.target.top - 10, 'rim hugs the box top edge');
    });
    assert.ok(samples[0].rimOpacity < 0.1, 'rim absent at the start');
  });

  test('construction: three craters, two cloud strips, a four-point and a five-point star pair, deterministic markup', async () => {
    await scrollPageTo(page, 0);
    const info = await replay(() => {
      const h = document.querySelector('.oc-moonrise');
      if (!h) return null;
      return {
        mode: h.getAttribute('data-mr-mode'),
        craters: h.querySelectorAll('[data-mr-crater]').length,
        clouds: h.querySelectorAll('[data-mr-cloud]').length,
        fours: h.querySelectorAll('[data-mr-star="4"]').length,
        fives: h.querySelectorAll('[data-mr-star="5"]').length,
        html: h.innerHTML,
      };
    });
    assert.strictEqual(info.mode, 'full');
    assert.strictEqual(info.craters, 3);
    assert.strictEqual(info.clouds, 2);
    assert.strictEqual(info.fours, 2);
    assert.strictEqual(info.fives, 2);
    assert.ok(!/NaN|undefined/.test(info.html), 'no NaN/undefined leaked into the SVG');
    await waitForNoBeacons();
    // Same inputs, same markup (no Math.random).
    const again = await replay(() => { const h = document.querySelector('.oc-moonrise'); return h ? h.innerHTML : null; });
    assert.strictEqual(again, info.html);
    await waitForNoBeacons();
  });

  test('SCROLLED (scrollY 300): elements are positioned in document space, with the horizon 9px above the glyph box', async () => {
    await scrollPageTo(page, 300);
    const mounted = await replay(() => {
      const h = document.querySelector('.oc-moonrise');
      const rim = document.querySelector('.oc-moonrise-rim');
      if (!h || !rim) return null;
      const t = document.getElementById('target').getBoundingClientRect();
      return {
        scrollY: window.scrollY,
        hostTop: parseFloat(h.style.top), hostH: parseFloat(h.style.height), hostLeft: parseFloat(h.style.left), hostW: parseFloat(h.style.width),
        hostPos: getComputedStyle(h).position, rimPos: getComputedStyle(rim).position,
        rimTop: parseFloat(rim.style.top),
        target: { left: t.left, top: t.top, width: t.width },
      };
    });
    assert.ok(mounted.scrollY > 100, `sanity check: page must really be scrolled, scrollY=${mounted.scrollY}`);
    assert.strictEqual(mounted.hostPos, 'absolute');
    assert.strictEqual(mounted.rimPos, 'absolute');
    const docTop = mounted.target.top + mounted.scrollY;
    assert.ok(Math.abs(mounted.hostTop + mounted.hostH - (docTop - 9)) <= 1.5, `sprite bottom doc-y ${mounted.hostTop + mounted.hostH} vs ${docTop - 9}`);
    assert.ok(Math.abs(mounted.rimTop - (docTop - 9)) <= 1.5, `rim doc-y ${mounted.rimTop} vs ${docTop - 9}`);
    assert.ok(Math.abs(mounted.hostLeft + mounted.hostW / 2 - (mounted.target.left + mounted.target.width / 2)) <= 1.5, 'centred on the match horizontally');

    const samples = await recordRun();
    assertNeverEntersProtectedRect(samples, 'scrolled');
    await scrollPageTo(page, 0);
  });

  test('placement is judged from the PRE-SCROLL viewport rect: full, small moon with side stars, crescent only, then suppressed', async () => {
    try {
      const full = await placeAt(200);
      assert.deepStrictEqual([full.mode, full.wolf, full.d], ['full', '1', 64]);
      assert.strictEqual(full.stars, 4);
      assert.strictEqual(full.clouds, 2);
      await waitForNoBeacons();

      // 70px of room above the match in the viewport (the document has ~440): a smaller moon, wolf kept.
      const small = await placeAt(70);
      assert.strictEqual(small.mode, 'small');
      assert.strictEqual(small.wolf, '1');
      assert.ok(Math.abs(small.d - (70 - 9 - 4)) <= 1, `moon shrinks to the room available, got ${small.d}`);
      assert.strictEqual(small.stars, 4, 'stars are moved to the sides, not dropped');
      assert.ok(small.top >= 4 - 0.5, `sprite stays inside the viewport top edge, top=${small.top}`);
      assert.ok(Math.abs(small.bottom - (small.targetTop - 9)) <= 1);
      await waitForNoBeacons();

      // Wolf cannot fit: crescent only, no wolf, no decor.
      const cres = await placeAt(40);
      assert.strictEqual(cres.mode, 'crescent');
      assert.strictEqual(cres.wolf, '0');
      assert.strictEqual(cres.stars + cres.clouds + cres.craters, 0);
      assert.ok(cres.top >= 4 - 0.5);
      await waitForNoBeacons();

      // Nothing fits: suppressed, no transient of any kind.
      const none = await placeAt(25);
      assert.strictEqual(none.mounted, false, 'no room: nothing may mount');
      assert.strictEqual(none.transient, 0, 'no room: no .oc-beacon-transient may remain');
    } finally {
      await scrollPageTo(page, 0);
    }
  });

  test('horizontal edges: the sprite is clamped inside the viewport at the left and right edges', async () => {
    const setMargin = (px) => page.evaluate((m) => { document.querySelector('p').style.marginLeft = m + 'px'; }, px);
    try {
      await scrollPageTo(page, 0);
      await setMargin(0);
      let m = await replay(() => { const h = document.querySelector('.oc-moonrise'); return h ? h.getBoundingClientRect().left : null; });
      assert.ok(m >= 4 - 0.5, `left edge: sprite left ${m} must be >= 4`);
      await waitForNoBeacons();
      await setMargin(VIEWPORT.width - 200);
      const right = await replay(() => { const h = document.querySelector('.oc-moonrise'); return h ? h.getBoundingClientRect().right : null; });
      assert.ok(right <= VIEWPORT.width - 4 + 0.5, `right edge: sprite right ${right} must be <= ${VIEWPORT.width - 4}`);
      await waitForNoBeacons();
    } finally {
      await setMargin(420);
    }
  });

  test('the match DOM is never mutated while the effect plays', async () => {
    await scrollPageTo(page, 0);
    const before = await page.evaluate(() => document.getElementById('target').parentElement.outerHTML);
    await replay(() => (document.querySelector('.oc-moonrise') ? true : null));
    const during = await page.evaluate(() => document.getElementById('target').parentElement.outerHTML);
    assert.strictEqual(during, before);
    await waitForNoBeacons();
  });

  test('Beacon Size XL, set for real through chrome.storage.sync: the moon grows and the protected rect still holds', async () => {
    await scrollPageTo(page, 0);
    try {
      await setVisionSettings({ beaconSize: 'xl' });
      const samples = await recordRun();
      assertNeverEntersProtectedRect(samples, 'XL');
      const tall = Math.max.apply(null, samples.map((s) => s.host.bottom - s.host.top));
      assert.ok(tall > 150, `XL sprite should be ~180px tall, got ${tall}`);
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
    }
  });

  test('Animation Speed, set for real through chrome.storage.sync: every rendered WAAPI duration AND delay scales by getBeaconDuration\'s factor', async () => {
    async function renderedTimings() {
      await replay(() => (document.querySelector('.oc-moonrise-rim') ? true : null));
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

  test('Lite Mode, set for real through chrome.storage.sync: crescent moon and wolf stay; clouds, stars, rim, craters, edge light and the pop/howl motion are dropped', async () => {
    function snapshot() {
      const h = document.querySelector('.oc-moonrise');
      if (!h) return null;
      return {
        moon: h.querySelector('[data-mr-moon]').getAttribute('data-mr-moon'),
        wolf: !!h.querySelector('[data-mr-wolf-g]'),
        clouds: h.querySelectorAll('[data-mr-cloud]').length,
        stars: h.querySelectorAll('[data-mr-star]').length,
        craters: h.querySelectorAll('[data-mr-crater]').length,
        rim: document.querySelectorAll('.oc-moonrise-rim').length,
        wolfPaths: h.querySelectorAll('[data-mr-wolf-g] path').length,
        anims: Array.from(document.querySelectorAll('.oc-beacon-transient')).reduce((n, el) => n + el.getAnimations({ subtree: true }).length, 0),
      };
    }
    await scrollPageTo(page, 0);
    await replay(() => (document.querySelector('.oc-moonrise-rim') ? true : null));
    const full = await page.evaluate(snapshot);
    assert.strictEqual(full.moon, 'full');
    assert.strictEqual(full.anims, 10, 'full mode: 4 stars, moon, 2 clouds, wolf, head, rim');
    try {
      await setSettings({ performanceMode: true });
      const lite = await replay(snapshot);
      assert.strictEqual(lite.moon, 'crescent', 'Lite draws the crescent');
      assert.strictEqual(lite.wolf, true, 'Lite keeps the wolf');
      assert.strictEqual(lite.clouds + lite.stars + lite.craters + lite.rim, 0);
      assert.strictEqual(lite.wolfPaths, 2, 'Lite: body and head only, no edge-light copies');
      assert.strictEqual(lite.anims, 2, 'Lite: moon rise/set plus the wolf appear/disappear only');
      const samples = await recordRun();
      assertNeverEntersProtectedRect(samples, 'lite');
      assert.ok(samples.every((s) => s.rim === null), 'Lite never mounts the rim');
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive and every animation is canceled', async () => {
    await scrollPageTo(page, 0);
    await replay(() => (document.querySelector('.oc-moonrise-rim') ? true : null));
    const count = await page.evaluate(() => {
      window.__mrAnims = [];
      document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
        window.__mrAnims = window.__mrAnims.concat(el.getAnimations({ subtree: true }));
      });
      return window.__mrAnims.length;
    });
    assert.ok(count >= 10, `expected the full set of live animations before cancellation, got ${count}`);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await waitForNoBeacons();
    const states = await page.evaluate(() => window.__mrAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got ${states.join(', ')}`);
  });

  test('overlay close: Escape tears down the finder and nothing survives', async () => {
    await replay(() => (document.querySelector('.oc-moonrise') ? true : null));
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

  test('rapid refire: repeated Enter never leaves more than one moon mounted', async () => {
    await scrollPageTo(page, 0);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Enter');
      const n = await page.evaluate(() => document.querySelectorAll('.oc-moonrise').length);
      assert.ok(n <= 1, `at most one moon at once, got ${n} after press ${i + 1}`);
    }
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await waitForNoBeacons();
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollPageTo(page, 0);
    await replay(() => (document.querySelector('.oc-moonrise') ? true : null));
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
      assert.strictEqual(keys.indexOf('moonrise'), -1, 'absent from availableEffects() while the pack is disabled');
      await openSettings();
      assert.strictEqual(await page.locator(MR_EFFECT_ROW).count(), 0, 'absent from the picker while disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['hollow'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('moonrise'), -1, 'present once hollow is enabled');
      await openSettings();
      assert.strictEqual(await page.locator(MR_EFFECT_ROW).count(), 1, 'present in the picker once enabled');
      await closeSettings();

      // The stored selection is NOT rewritten by disabling the pack.
      await setSettings({ effect: 'moonrise', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'moonrise', 'stored selection must not be rewritten while the pack is disabled');
      const fallback = await replay(() => (document.querySelector('.oc-beacon-transient') ? { moon: !!document.querySelector('.oc-moonrise') } : null));
      assert.strictEqual(fallback.moon, false, 'while disabled the runtime falls back to another effect');
      await waitForNoBeacons();

      await setSettings({ enabledPacks: ['hollow'] });
      const restored = await replay(() => (document.querySelector('.oc-moonrise') ? { moon: true } : null));
      assert.strictEqual(restored.moon, true, 'selection restored on re-enable');
      await waitForNoBeacons();
    } finally {
      await setSettings({ enabledPacks: ['__oc_moonrise_test_reset__'] });
      await setSettings({ effect: 'moonrise', enabledPacks: ['hollow'] });
    }
  });
});
