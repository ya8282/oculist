// Cursed Rune beacon effect (oculist-l0bs.11), Haunted Hollow ('hollow') pack. A violet sigil
// draws itself AROUND the match: the outer ring sweeps clockwise as an open arc, then the inner
// ring; four runes appear in the band between the rings; four candles at the cardinal points of
// the outer ring light and flicker through three flame states; the complete sigil pulses ~5%
// larger (bright tone to the runes, dark tone to the outer ring) and everything fades together.
// The sheet's inscribed pentagram would cross the text, so it is omitted (contract rule 10).
//
// Modeled on test/moonrise_effect.test.js and test/trail_effect.test.js. The load-bearing proofs
// for rule 10 are (a) a per-frame geometric sampler: the match's glyph box + 6px must lie inside
// the INNER ring ellipse in every frame and no rune/candle box may touch it, and (b) a pixel
// comparison of the protected rectangle against a no-effect baseline at several paused times.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { scrollPageTo, POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:400px"></div>
<p style="margin-left:420px;">filler text <span id="target">quarklet</span></p>
<div style="height:3000px"></div>`;

const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const CR_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:cursedrune"]';

describe('Cursed Rune: a double-ring sigil with runes and four candles draws itself around the match', () => {
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

    await setSettings({ effect: 'cursedrune', enabledPacks: ['hollow'] });
    await waitForCondition(
      () => evalInContentScript('window.__ocTest.getAvailableEffectKeys()'),
      (keys) => keys.indexOf('cursedrune') !== -1,
      { timeout: POLL_TIMEOUT, message: 'cursedrune never became available' }
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

  // Records every animation frame of one full run: the match rect, the ring ellipses' boxes,
  // rune/candle boxes, flame opacities, ring dash offsets and the rune / outer-ring colours.
  async function recordRun() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      window.__crRun = { samples: [], done: false };
      let seen = false, idle = 0;
      (function frame() {
        const host = document.querySelector('.oc-cursedrune');
        if (host) {
          seen = true;
          idle = 0;
          const t = document.getElementById('target').getBoundingClientRect();
          const line = (n) => host.querySelector('[data-cr-line="' + n + '"]');
          const flames = {};
          ['0', '1', '2'].forEach((s) => {
            const f = host.querySelector('[data-cr-candle="top"] [data-cr-flame="' + s + '"]');
            flames[s] = f ? parseFloat(getComputedStyle(f).opacity) : null;
          });
          const rune0 = host.querySelector('[data-cr-rune="0"] path');
          window.__crRun.samples.push({
            target: { left: t.left, top: t.top, right: t.right, bottom: t.bottom },
            host: box(host),
            outer: box(line('outer')), inner: box(line('inner')),
            runes: Array.from(host.querySelectorAll('[data-cr-rune]')).map(box),
            candles: Array.from(host.querySelectorAll('[data-cr-candle]')).map(box),
            outerOff: parseFloat(getComputedStyle(line('outer')).strokeDashoffset),
            innerOff: parseFloat(getComputedStyle(line('inner')).strokeDashoffset),
            outerStroke: getComputedStyle(line('outer')).stroke,
            runeStroke: rune0 ? getComputedStyle(rune0).stroke : null,
            flames,
            scrollY: window.scrollY,
          });
        } else if (seen && ++idle > 3) {
          window.__crRun.done = true;
          return;
        }
        requestAnimationFrame(frame);
      })();
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__crRun.done, null, { timeout: POLL_TIMEOUT * 2 });
    return page.evaluate(() => window.__crRun.samples);
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  // Rule 10, geometrically: the protected rect (glyph box + 6px) is strictly inside the inner
  // ring ellipse (less 1.75px for the underlay's half stroke) and the outer ring contains the
  // inner; runes and candles never touch the protected rect.
  function assertNeverEntersProtectedRect(samples, label) {
    assert.ok(samples.length > 10, `${label}: expected a real run of frames, got ${samples.length}`);
    samples.forEach((s, i) => {
      const p = { left: s.target.left - 6, top: s.target.top - 6, right: s.target.right + 6, bottom: s.target.bottom + 6 };
      const e = s.inner;
      const cx = (e.left + e.right) / 2, cy = (e.top + e.bottom) / 2;
      const rx = (e.right - e.left) / 2 - 1.75, ry = (e.bottom - e.top) / 2 - 1.75;
      [[p.left, p.top], [p.right, p.top], [p.left, p.bottom], [p.right, p.bottom]].forEach(([x, y]) => {
        const v = Math.pow((x - cx) / rx, 2) + Math.pow((y - cy) / ry, 2);
        assert.ok(v < 1, `${label}: frame ${i}: protected corner (${x},${y}) outside the inner ring (value ${v})`);
      });
      assert.ok(s.outer.left < e.left && s.outer.right > e.right && s.outer.top < e.top && s.outer.bottom > e.bottom, `${label}: frame ${i}: outer ring must enclose the inner`);
      s.runes.concat(s.candles).forEach((b, j) => {
        const bb = { left: b.left + 0.5, top: b.top + 0.5, right: b.right - 0.5, bottom: b.bottom - 0.5 };
        assert.ok(!intersects(bb, p), `${label}: frame ${i}: part ${j} ${JSON.stringify(b)} entered the protected rect ${JSON.stringify(p)}`);
      });
    });
  }

  const RGB = { bright: 'rgb(227, 210, 255)', dark: 'rgb(93, 61, 168)' };

  async function placeAt(top) {
    const docY = await page.evaluate(() => document.getElementById('target').getBoundingClientRect().top + window.scrollY);
    await scrollPageTo(page, docY - top);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    await new Promise((resolve) => setTimeout(resolve, 250));
    return page.evaluate(() => {
      const h = document.querySelector('.oc-cursedrune');
      if (!h) return { mounted: false, transient: document.querySelectorAll('.oc-beacon-transient').length };
      const r = h.getBoundingClientRect();
      return { mounted: true, k: parseFloat(h.getAttribute('data-cr-k')), band: parseFloat(h.getAttribute('data-cr-band')), top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
  }

  test('UNSCROLLED: nothing ever enters the glyph box + 6px; outer ring draws before the inner, runes then candles follow, pulse is ~5%, colours shift, then it fades', async () => {
    await scrollPageTo(page, 0);
    const samples = await recordRun();
    assertNeverEntersProtectedRect(samples, 'unscrolled');

    // Open arc: the outer ring is part-drawn in some frame while the inner has not started.
    assert.ok(samples.some((s) => s.outerOff > 0.05 && s.outerOff < 0.95 && s.innerOff > 0.99), 'outer ring is an open arc while the inner has not started');
    // Draw order: the inner ring never moves before the outer finishes.
    samples.forEach((s, i) => {
      if (s.innerOff < 0.99) assert.ok(s.outerOff < 0.01, `frame ${i}: inner started (${s.innerOff}) before the outer finished (${s.outerOff})`);
    });
    assert.ok(samples.some((s) => s.innerOff > 0.05 && s.innerOff < 0.95), 'inner ring is drawn in over time');
    // Three flame states are all seen on the top candle.
    ['0', '1', '2'].forEach((st) => assert.ok(samples.some((s) => s.flames[st] > 0.5), `flame state ${st} is shown at some point`));
    // Pulse: the outer ring grows ~5%.
    const widths = samples.map((s) => s.outer.right - s.outer.left);
    const ratio = Math.max.apply(null, widths) / Math.min.apply(null, widths);
    assert.ok(Math.abs(ratio - 1.05) < 0.012, `pulse ratio ${ratio} should be ~1.05`);
    // Bright tone on the runes and dark tone on the outer ring, together.
    assert.ok(samples.some((s) => s.runeStroke === RGB.bright && s.outerStroke === RGB.dark), 'pulse: bright runes + dark outer ring');
    assert.ok(samples[0].runeStroke !== RGB.bright && samples[0].outerStroke !== RGB.dark, 'pulse colours are not present at the start');
  });

  test('pixels: the protected rectangle is byte-identical to a no-effect baseline at several paused times', async () => {
    await scrollPageTo(page, 0);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await waitForNoBeacons();
    const clip = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return { x: Math.floor(r.left - 6), y: Math.floor(r.top - 6), width: Math.ceil(r.width + 12), height: Math.ceil(r.height + 12) };
    });
    const baseline = await page.screenshot({ clip, animations: 'allow' });
    await replay(() => (document.querySelector('.oc-cursedrune') ? true : null));
    for (const frac of [0.2, 0.45, 0.62, 0.78, 0.9]) {
      await page.evaluate((f) => {
        document.querySelectorAll('.oc-cursedrune').forEach((root) => {
          root.getAnimations({ subtree: true }).forEach((a) => {
            a.pause();
            a.currentTime = f * a.effect.getComputedTiming().duration;
          });
        });
      }, frac);
      const shot = await page.screenshot({ clip, animations: 'allow' });
      assert.ok(shot.equals(baseline), `protected rect pixels changed at ${frac} of the run`);
    }
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await waitForNoBeacons();
  });

  test('construction: two rings, four runes, four candles, no pentagram, deterministic markup', async () => {
    await scrollPageTo(page, 0);
    const info = await replay(() => {
      const h = document.querySelector('.oc-cursedrune');
      if (!h) return null;
      return {
        rings: h.querySelectorAll('[data-cr-line]').length,
        runes: h.querySelectorAll('[data-cr-rune]').length,
        candles: Array.from(h.querySelectorAll('[data-cr-candle]')).map((c) => c.getAttribute('data-cr-candle')),
        flames: h.querySelectorAll('[data-cr-candle="top"] [data-cr-flame]').length,
        zIndex: h.style.zIndex,
        pe: getComputedStyle(h).pointerEvents,
        html: h.innerHTML,
      };
    });
    assert.strictEqual(info.rings, 2);
    assert.strictEqual(info.runes, 4);
    assert.deepStrictEqual(info.candles, ['top', 'right', 'bottom', 'left']);
    assert.strictEqual(info.flames, 3);
    assert.strictEqual(info.zIndex, '2147483642');
    assert.strictEqual(info.pe, 'none');
    assert.ok(!/NaN|undefined/.test(info.html), 'no NaN/undefined leaked into the SVG');
    await waitForNoBeacons();
    const again = await replay(() => { const h = document.querySelector('.oc-cursedrune'); return h ? h.innerHTML : null; });
    assert.strictEqual(again, info.html, 'same inputs, same markup (no Math.random)');
    await waitForNoBeacons();
  });

  test('SCROLLED (scrollY 300): positioned in document space and centred on the match', async () => {
    await scrollPageTo(page, 300);
    const m = await replay(() => {
      const h = document.querySelector('.oc-cursedrune');
      if (!h) return null;
      const t = document.getElementById('target').getBoundingClientRect();
      return {
        scrollY: window.scrollY, pos: getComputedStyle(h).position,
        top: parseFloat(h.style.top), height: parseFloat(h.style.height), left: parseFloat(h.style.left), width: parseFloat(h.style.width),
        target: { left: t.left, top: t.top, width: t.width, height: t.height },
      };
    });
    assert.ok(m.scrollY > 100, `sanity check: page must really be scrolled, scrollY=${m.scrollY}`);
    assert.strictEqual(m.pos, 'absolute');
    const docCy = m.target.top + m.scrollY + m.target.height / 2;
    assert.ok(Math.abs(m.top + m.height / 2 - docCy) <= 1.5, `centre doc-y ${m.top + m.height / 2} vs ${docCy}`);
    assert.ok(Math.abs(m.left + m.width / 2 - (m.target.left + m.target.width / 2)) <= 1.5, 'centred horizontally');
    const samples = await recordRun();
    assertNeverEntersProtectedRect(samples, 'scrolled');
    await scrollPageTo(page, 0);
  });

  test('placement is judged from the PRE-SCROLL viewport rect: full size, shrunk, then suppressed', async () => {
    try {
      const full = await placeAt(120);
      assert.strictEqual(full.mounted, true);
      assert.strictEqual(full.k, 1);
      assert.ok(full.top >= 4 - 0.5 && full.bottom <= VIEWPORT.height - 4 + 0.5);
      await waitForNoBeacons();

      // ~48px of room above the match in the viewport (the document has ~440): band shrinks.
      const small = await placeAt(48);
      assert.strictEqual(small.mounted, true, 'a shrunk sigil still fits');
      assert.ok(small.k < 1 && small.band >= 8 - 0.01, `shrunk to k=${small.k}, band=${small.band}`);
      assert.ok(small.top >= 4 - 0.5, `stays inside the viewport top edge, top=${small.top}`);
      await waitForNoBeacons();

      // Bottom edge, same rule.
      const bottom = await placeAt(VIEWPORT.height - 48 - 26);
      assert.strictEqual(bottom.mounted, true);
      assert.ok(bottom.bottom <= VIEWPORT.height - 4 + 0.5, `stays inside the viewport bottom edge, bottom=${bottom.bottom}`);
      await waitForNoBeacons();

      const none = await placeAt(25);
      assert.strictEqual(none.mounted, false, 'no room: nothing may mount');
      assert.strictEqual(none.transient, 0, 'no room: no .oc-beacon-transient may remain');
    } finally {
      await scrollPageTo(page, 0);
    }
  });

  test('horizontal edges: shrinks near the left and right viewport edges and suppresses when nothing legal fits', async () => {
    const centreAt = async (cx) => {
      await page.evaluate(() => { document.querySelector('p').style.marginLeft = '0px'; });
      const base = await page.evaluate(() => { const r = document.getElementById('target').getBoundingClientRect(); return r.left + r.width / 2; });
      await page.evaluate((m) => { document.querySelector('p').style.marginLeft = m + 'px'; }, cx - base);
    };
    try {
      await scrollPageTo(page, 0);
      await centreAt(80);
      let m = await replay(() => { const h = document.querySelector('.oc-cursedrune'); return h ? { k: parseFloat(h.getAttribute('data-cr-k')), left: h.getBoundingClientRect().left } : null; });
      assert.ok(m.k < 1, `left edge shrinks, k=${m.k}`);
      assert.ok(m.left >= 4 - 0.5, `left edge: sigil left ${m.left} must be >= 4`);
      await waitForNoBeacons();
      await centreAt(VIEWPORT.width - 80);
      m = await replay(() => { const h = document.querySelector('.oc-cursedrune'); return h ? { k: parseFloat(h.getAttribute('data-cr-k')), right: h.getBoundingClientRect().right } : null; });
      assert.ok(m.k < 1, `right edge shrinks, k=${m.k}`);
      assert.ok(m.right <= VIEWPORT.width - 4 + 0.5, `right edge: sigil right ${m.right} must be <= ${VIEWPORT.width - 4}`);
      await waitForNoBeacons();
      await centreAt(30);
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient').length), 0, 'nothing legal fits: suppressed');
    } finally {
      await page.evaluate(() => { document.querySelector('p').style.marginLeft = '420px'; });
    }
  });

  test('the match DOM is never mutated while the effect plays', async () => {
    await scrollPageTo(page, 0);
    const before = await page.evaluate(() => document.getElementById('target').parentElement.outerHTML);
    await replay(() => (document.querySelector('.oc-cursedrune') ? true : null));
    const during = await page.evaluate(() => document.getElementById('target').parentElement.outerHTML);
    assert.strictEqual(during, before);
    await waitForNoBeacons();
  });

  test('Beacon Size XL, set for real through chrome.storage.sync: the sigil grows and the protected rect still holds', async () => {
    await scrollPageTo(page, 0);
    try {
      const base = await recordRun();
      const baseW = Math.max.apply(null, base.map((s) => s.host.right - s.host.left));
      await setVisionSettings({ beaconSize: 'xl' });
      const samples = await recordRun();
      assertNeverEntersProtectedRect(samples, 'XL');
      const w = Math.max.apply(null, samples.map((s) => s.host.right - s.host.left));
      assert.ok(w > baseW, `XL sigil (${w}) should be wider than medium (${baseW})`);
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
    }
  });

  test('Animation Speed, set for real through chrome.storage.sync: every rendered WAAPI duration AND delay scales by getBeaconDuration\'s factor', async () => {
    async function renderedTimings() {
      await replay(() => (document.querySelector('.oc-cursedrune') ? true : null));
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

  test('Lite Mode, set for real through chrome.storage.sync: outline-only sigil, no underlay, one static flame; draw-in and pulse stay', async () => {
    function snapshot() {
      const h = document.querySelector('.oc-cursedrune');
      if (!h) return null;
      return {
        underlays: h.querySelectorAll('[data-cr-underlay]').length,
        rings: h.querySelectorAll('[data-cr-line]').length,
        runes: h.querySelectorAll('[data-cr-rune]').length,
        candles: h.querySelectorAll('[data-cr-candle]').length,
        flames: h.querySelectorAll('[data-cr-flame]').length,
        fills: Array.from(h.querySelectorAll('path, rect')).filter((n) => { const f = n.getAttribute('fill'); return f && f !== 'none'; }).length,
        anims: Array.from(document.querySelectorAll('.oc-beacon-transient')).reduce((n, el) => n + el.getAnimations({ subtree: true }).length, 0),
      };
    }
    await scrollPageTo(page, 0);
    await replay(() => (document.querySelector('.oc-cursedrune') ? true : null));
    const full = await page.evaluate(snapshot);
    assert.strictEqual(full.underlays, 2);
    assert.strictEqual(full.flames, 12, 'full: three flame states on each of four candles');
    assert.strictEqual(full.anims, 31, 'full: 4 ring strokes, outer tone, 8 rune, 12 flame, 4 candle, pulse, fade');
    try {
      await setSettings({ performanceMode: true });
      const lite = await replay(snapshot);
      assert.strictEqual(lite.underlays, 0);
      assert.strictEqual(lite.rings, 2);
      assert.strictEqual(lite.runes, 4);
      assert.strictEqual(lite.candles, 4);
      assert.strictEqual(lite.flames, 4, 'Lite: one static flame per candle');
      assert.strictEqual(lite.fills, 0, 'Lite: line only, no fills');
      assert.strictEqual(lite.anims, 17, 'Lite: draw-in, rune/candle appear, pulse, fade; no flame flicker');
      const samples = await recordRun();
      assertNeverEntersProtectedRect(samples, 'lite');
      assert.ok(samples.some((s) => s.outerOff > 0.05 && s.outerOff < 0.95), 'Lite keeps the draw-in');
      const w = samples.map((s) => s.outer.right - s.outer.left);
      assert.ok(Math.max.apply(null, w) / Math.min.apply(null, w) > 1.04, 'Lite keeps the pulse');
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive and every animation is canceled', async () => {
    await scrollPageTo(page, 0);
    await replay(() => (document.querySelector('.oc-cursedrune') ? true : null));
    const count = await page.evaluate(() => {
      window.__crAnims = [];
      document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
        window.__crAnims = window.__crAnims.concat(el.getAnimations({ subtree: true }));
      });
      return window.__crAnims.length;
    });
    assert.ok(count >= 30, `expected the full set of live animations before cancellation, got ${count}`);
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await waitForNoBeacons();
    const states = await page.evaluate(() => window.__crAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled, got ${states.join(', ')}`);
  });

  test('overlay close: Escape tears down the finder and nothing survives', async () => {
    await replay(() => (document.querySelector('.oc-cursedrune') ? true : null));
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

  test('rapid refire: repeated Enter never leaves more than one sigil mounted', async () => {
    await scrollPageTo(page, 0);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Enter');
      const n = await page.evaluate(() => document.querySelectorAll('.oc-cursedrune').length);
      assert.ok(n <= 1, `at most one sigil at once, got ${n} after press ${i + 1}`);
    }
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await waitForNoBeacons();
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await scrollPageTo(page, 0);
    await replay(() => (document.querySelector('.oc-cursedrune') ? true : null));
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
      assert.strictEqual(keys.indexOf('cursedrune'), -1, 'absent from availableEffects() while the pack is disabled');
      await openSettings();
      assert.strictEqual(await page.locator(CR_EFFECT_ROW).count(), 0, 'absent from the picker while disabled');
      await closeSettings();

      await setSettings({ enabledPacks: ['hollow'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('cursedrune'), -1, 'present once hollow is enabled');
      await openSettings();
      assert.strictEqual(await page.locator(CR_EFFECT_ROW).count(), 1, 'present in the picker once enabled');
      await closeSettings();

      await setSettings({ effect: 'cursedrune', enabledPacks: [] });
      const stored = await evalInContentScript(
        "new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings'].effect); }); })"
      );
      assert.strictEqual(stored, 'cursedrune', 'stored selection must not be rewritten while the pack is disabled');
      const fallback = await replay(() => (document.querySelector('.oc-beacon-transient') ? { sigil: !!document.querySelector('.oc-cursedrune') } : null));
      assert.strictEqual(fallback.sigil, false, 'while disabled the runtime falls back to another effect');
      await waitForNoBeacons();

      await setSettings({ enabledPacks: ['hollow'] });
      const restored = await replay(() => (document.querySelector('.oc-cursedrune') ? { sigil: true } : null));
      assert.strictEqual(restored.sigil, true, 'selection restored on re-enable');
      await waitForNoBeacons();
    } finally {
      await setSettings({ enabledPacks: ['__oc_cursedrune_test_reset__'] });
      await setSettings({ effect: 'cursedrune', enabledPacks: ['hollow'] });
    }
  });
});
