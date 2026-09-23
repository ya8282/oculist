// Flappy beacon effect (oculist-e2m.5): promotes fxFlappy (artifacts/prototypes/
// effects-playground.html) into extension/content.js as the second entry in the
// Halloween pack. A small bird flies a sawtooth of parabolic arcs from the cursor (or
// its fallback) to the match, perches on the match's top edge, then the absorption
// flash animateTrail already uses fires on the match rect.
//
// Modeled on test/trail_effect.test.js (cursor-fallback + document-space + Lite Mode
// idioms, since Flappy shares animateTrail's own start-point cascade) and
// test/boneassembly_effect.test.js (pack enumeration idioms) -- against the REAL
// extension, since flappy is a genuine effectsRegistry entry under pack:'halloween',
// no fixture copy needed for either.
//
// Needs a real browser for the same reasons as those two: WAAPI, offset-path, real
// layout, and chrome.storage.sync-driven settings only exist in real Chromium.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

// A fixed-height spacer gives real scrollable height (viewport is 1200x800), same
// reasoning as trail_effect.test.js's own fixture: window.scrollTo(0, 500) needs to be
// a real scroll, not a no-op, and a giant repeated-text paragraph was slow/flaky.
// #target's own 420px left margin (boneassembly_effect.test.js's own idiom) leaves
// genuine room on both sides: a mouse point well to its left exercises the real cursor
// cascade without tripping animateFlappy's own "start too close horizontally" degenerate
// fallback (a separate branch, covered by the "placement fallback" test below), and a mouse point well to its
// right exercises the mirrored branch.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:4000px"></div>
<p style="margin-left:420px;">filler text <span id="target">quarklet</span></p>`;

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const FLAPPY_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:flappy"]';

describe('Flappy: a bird flies a sawtooth of parabolic arcs from the cursor to the match, then perches', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing -- the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP before navigating so the isolated-world execution-context-created event
    // is never missed.
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

    // Select Flappy and turn its pack on for the whole suite before ever opening the
    // finder -- every tab of this persistent context shares this chrome.storage.sync
    // write.
    await setSettings({ effect: 'flappy', enabledPacks: ['halloween'] });

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
    await pg.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
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

  function evalInContentScript(expression, target) {
    const c = (target && target.client) || client;
    const ctxId = (target && target.contextId) || isolatedContextId;
    return c
      .send('Runtime.evaluate', {
        expression,
        contextId: ctxId,
        awaitPromise: true,
        returnByValue: true,
      })
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

  // Merges `patch` into the nested visionSettings object (e.g. beaconSize) via
  // chrome.storage.sync.set, same idiom as cyber_vision.test.js's own setVisionSettings —
  // setSettings() above only shallow-merges the top level, which would otherwise drop
  // every other key already inside visionSettings.
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

  // Same production cancellation path as trail_effect.test.js's replay(): cancels any
  // in-flight beacon through window.__ocTest.cancelBeacons() (the exact function
  // animate() itself calls first), then presses Enter to (re-)fire, waiting on
  // `predicate` -- folding presence and geometry reads into one page-side tick
  // (oculist-d5c) so nothing can self-clean in a round-trip gap. Bound to `page`
  // specifically -- the one fresh-tab test below drives its own page2/client2 pair
  // directly instead.
  async function replay(predicate) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    const handle = await page.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient') ? true : null)),
      null,
      { timeout: POLL_TIMEOUT }
    );
    return handle.jsonValue();
  }

  // 'M x0 y0 L x1 y1 L ... L xn yn' -> { start: [x0,y0], end: [xn,yn] }. Flappy's own
  // offset-path is expressed in absolute document coordinates (unlike Trail's, which is
  // relative to the arrow's own left/top) -- birdEl itself always sits at left:0;top:0,
  // so the path's own first and last points ARE the flight's document-space endpoints.
  function parseFlightPath(offsetPath) {
    const nums = (offsetPath || '').match(/-?\d+(?:\.\d+)?/g);
    assert.ok(nums && nums.length >= 4, `offset-path did not contain at least two coordinate pairs: "${offsetPath}"`);
    const values = nums.map(Number);
    return {
      start: [values[0], values[1]],
      end: [values[values.length - 2], values[values.length - 1]],
    };
  }

  function flappyBirdSnapshot() {
    const bird = document.querySelector('.oc-flappy-bird');
    if (!bird) return null;
    const wrap = bird.firstElementChild;
    const targetRect = document.getElementById('target').getBoundingClientRect();
    return {
      offsetPath: bird.style.offsetPath || getComputedStyle(bird).offsetPath,
      offsetRotate: bird.style.offsetRotate || getComputedStyle(bird).offsetRotate,
      wrapTransform: wrap ? wrap.style.transform : '',
      spriteWidth: parseFloat(bird.style.width),
      spriteHeight: parseFloat(bird.style.height),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      targetLeft: targetRect.left,
      targetTop: targetRect.top,
      targetWidth: targetRect.width,
      targetHeight: targetRect.height,
    };
  }

  test('document-space correctness: on a scrolled page, the flight starts at the tracked cursor and lands on the match\'s top edge, in document coordinates', async () => {
    const mouseClientX = 200;
    const mouseClientY = 120;
    await page.mouse.move(mouseClientX, mouseClientY);

    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });

    try {
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);

      const geom = await replay(flappyBirdSnapshot);
      assert.ok(geom, 'expected a mounted .oc-flappy-bird');
      assert.ok(geom.scrollY > 0, `sanity check: the page must actually be scrolled, got scrollY=${geom.scrollY}`);

      const parsed = parseFlightPath(geom.offsetPath);

      const expectedStartX = mouseClientX + geom.scrollX;
      const expectedStartY = mouseClientY + geom.scrollY;
      assert.ok(
        Math.abs(parsed.start[0] - expectedStartX) <= 2,
        `start X: expected ~${expectedStartX}, got ${parsed.start[0]}`
      );
      assert.ok(
        Math.abs(parsed.start[1] - expectedStartY) <= 2,
        `start Y: expected ~${expectedStartY}, got ${parsed.start[1]}`
      );

      // Landing point: the match's top edge, offset up by half the sprite's own height
      // (plus the fixed 3px overlap the effect uses), in document coordinates -- a
      // missing "+ window.scrollY" term here is exactly what a scrolled-page assertion
      // catches that an unscrolled one cannot.
      const expectedEndX = geom.targetLeft + geom.targetWidth / 2 + geom.scrollX;
      const expectedEndY = geom.targetTop + geom.scrollY - geom.spriteHeight / 2 + 3;
      assert.ok(
        Math.abs(parsed.end[0] - expectedEndX) <= 2,
        `end X: expected ~${expectedEndX}, got ${parsed.end[0]}`
      );
      assert.ok(
        Math.abs(parsed.end[1] - expectedEndY) <= 2,
        `end Y: expected ~${expectedEndY}, got ${parsed.end[1]}`
      );

      // A start well to the left of the match must not carry the mirror transform.
      assert.strictEqual(
        geom.wrapTransform.indexOf('scaleX(-1)'),
        -1,
        'a left-of-match start must not carry the mirror transform'
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('Beacon Size L and XL: the rendered sprite scales, the landed overlap stays proportional (not just the pinned +3px formula), and the painted intrusion stays near the M figure (oculist-rnqe)', async () => {
    // The old version of this test recomputed the landed bottom edge from the fired
    // path's own end point plus its OWN copy of getBeaconScale()'s 1.5/2.25 multiplier
    // -- since content.js's own endY formula is built the same way (subtract
    // SPRITE_H*beaconScale/2), the two arithmetically cancel out and reconstruct the
    // "correct" answer even when the wrap2 CSS `scale(...)` transform never actually
    // renders (i.e. disabling the Beacon Size TRANSFORM, as opposed to getBeaconScale()
    // itself, leaves it green). This version reads the real rendered box instead:
    // bird.firstElementChild (wrap2 in content.js) is the element the Beacon Size scale
    // transform is actually applied to, so its own getBoundingClientRect() reflects
    // whatever getBeaconScale() really painted.
    //
    // CONTACT_T: getBeaconDuration(900) at the default animationSpeed:'normal' this
    // suite never changes -- the exact instant travelAnim's offsetDistance keyframes
    // reach 100% (fill:'forwards' holds the bird there), i.e. the moment it actually
    // lands. Every WAAPI animation on the bird (travel, wing, fade) is paused and
    // seeked to this instant so the read is deterministic -- the same
    // pause()/currentTime idiom horseman_effect.test.js's own oculist-4afn test and
    // cheshire_effect.test.js use for frame-exact geometry.
    const CONTACT_T = 900;

    async function landedGeom() {
      await replay(() => (document.querySelector('.oc-flappy-bird') ? true : null));
      return page.evaluate((t) => {
        const bird = document.querySelector('.oc-flappy-bird');
        bird.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = t; });
        const wrap = bird.firstElementChild;
        const wrapRect = wrap.getBoundingClientRect();
        const targetRect = document.getElementById('target').getBoundingClientRect();
        return { wrapBottom: wrapRect.bottom, wrapHeight: wrapRect.height, targetTop: targetRect.top };
      }, CONTACT_T);
    }

    // Screenshots the match's own rect with no beacon at all (baseline) vs at the
    // landed frame, and counts pixels that actually changed -- the real "how much of
    // the match got painted over" metric a bounding-box comparison can't see, since
    // the bird is a pixel-art sprite, not a solid rectangle. Same in-repo PNG-decode
    // idiom as horseman_effect.test.js's own oculist-4afn test, via a throwaway decode
    // page so the extension's own overlay never interferes with the decode.
    async function paintedIntrusionPx(decodePage) {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
      const r = await page.evaluate(() => {
        const b = document.getElementById('target').getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      });
      const clip = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
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
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.oc-flappy-bird'), null, { timeout: POLL_TIMEOUT });
      await page.evaluate((t) => {
        document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
          el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = t; });
        });
      }, CONTACT_T);
      const shot = await decode(await page.screenshot({ clip }));

      let painted = 0;
      for (let i = 0; i < base.length; i += 4) {
        const d = Math.max(Math.abs(base[i] - shot[i]), Math.abs(base[i + 1] - shot[i + 1]), Math.abs(base[i + 2] - shot[i + 2]));
        if (d > 0) painted++;
      }
      return painted;
    }

    // #target sits behind a 4000px spacer (this fixture's own note above) -- bring it
    // into the physical viewport, same idiom as the document-space correctness test,
    // since a screenshot clip against an off-screen rect fails outright and the box
    // read above would otherwise be comparing a match that's nowhere near the bird.
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });
    await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);

    // Measured 2026-09-23 (headless Chromium, this fixture, CONTACT_T=900) in both
    // directions -- normal (mouse at 200,120, left of match) and mirrored (mouse at
    // 1100,300, right of match):
    //
    //   size×mirrored -> wrapBottom  wrapHeight  targetTop  overlapPx  paintedPx
    //   m  normal      671.45..728.55  57.11      721.00     7.55       56
    //   m  mirrored     672.76..727.24 54.49      721.00     6.24       59
    //   l  normal       645.14..730.86 85.71      721.00     9.86       67
    //   l  mirrored     647.11..728.89 81.77      721.00     7.89       76
    //   xl normal       605.66..734.34 128.69     721.00    13.34       83
    //   xl mirrored     608.63..731.37 122.74     721.00    10.37      106
    //
    // wrapHeight scaled almost exactly with getBeaconScale() (1, 1.5, 2.25): l/m =
    // 1.501/1.501, xl/m = 2.254/2.253 in the two directions -- that ratio is what a
    // disabled Beacon Size TRANSFORM (the wrap2 `scale(...)` never applied, the exact
    // gap the old test had) breaks outright, since wrapHeight would then stay flat
    // across all three sizes.
    //
    // (overlapPx - 3) / wrapHeight -- 3 being the fixed overlap content.js's own endY
    // formula pins -- came out effectively constant per direction regardless of size
    // (normal: 0.0797/0.0800/0.0803; mirrored: 0.0595/0.0598/0.0600, all within 1% of
    // each other): the remaining, size-scaling part of the overlap is sprite tilt from
    // the flight physics (offset-rotate:auto tracking a near-, not exactly, level
    // tangent at landing -- content.js's own comment on the ease-out correction term),
    // not a formula bug. So the ratio itself is what's size-invariant, and is asserted
    // against Beacon Size m's own ratio (computed at runtime, not hardcoded) with a
    // relative tolerance for run-to-run integration noise -- still tight enough to catch
    // the landing-offset regression this bead's own neighbouring comment describes fixing
    // (an unscaled half-height once put the bottom edge at y=374/392 instead of 362 on a
    // 359-377 match at L/XL, many times this ratio). oculist-vqq1: this suite's own l/xl
    // relative drift came out 0.34%/0.82% (normal) and 0.34%/0.83% (mirrored), identical
    // across 8 runs (5 solo, 3 alongside the rest of this file at
    // --test-concurrency=2) since every geometry read here comes from a WAAPI animation
    // paused and seeked to a fixed CONTACT_T, not a live timing race -- 0.15 (15%) still
    // leaves ~18x headroom over that measured drift for any real cross-machine/browser-
    // version noise, while cutting the tolerated extra XL drop from ~5px to ~1.5px.
    //
    // Painted intrusion grew with size but stayed under 2x the M figure in both
    // directions (1.48x normal, 1.80x mirrored) -- the same <=2x factor
    // horseman_effect.test.js's own oculist-4afn test uses for the same reason: a
    // bigger sprite's rounded silhouette is wider at the same landing depth, so some
    // growth is expected, but it must not balloon with beaconScale the way an unpinned
    // depth would.
    const SCALE_TOLERANCE = 0.1; // wrapHeight/m's own wrapHeight vs the nominal 1.5/2.25 multiplier
    const RATIO_TOLERANCE = 0.15; // L/XL's own overlap ratio vs m's own ratio (oculist-vqq1: tightened from 0.5, see comment above)
    const PAINT_TOLERANCE = 2; // painted intrusion vs the m figure

    // Tracks the last beaconSize actually written, so the finally below can skip its own
    // reset when we're already at 'm' -- chrome.storage.sync only fires onChanged on a
    // genuine value change (the "pack enumeration" test documents the same gotcha, and the
    // xl-already-set comment a few lines down relies on it too), so re-writing 'm' while
    // already at 'm' hangs setVisionSettings()'s echo-wait for the full POLL_TIMEOUT. That
    // matters here because an assertion failure inside the try below can itself leave
    // beaconSize at 'm' (the sanity check right after the write two lines down, for
    // instance) -- an unconditional reset in finally would then swallow the real assertion
    // error under a 15s "never echoed" timeout thrown while unwinding (oculist-vqq1: measured
    // by doubling content.js's own SPRITE_H*beaconScale half-height term, which fails that
    // sanity check and reproduces exactly this mask).
    let currentBeaconSize = null;

    let decodePage;
    try {
      decodePage = await ctx.newPage();

      for (const mousePos of [{ x: 200, y: 120, mode: 'normal' }, { x: 1100, y: 300, mode: 'mirrored' }]) {
        await page.mouse.move(mousePos.x, mousePos.y);

        await setVisionSettings({ beaconSize: 'm' });
        currentBeaconSize = 'm';
        const mGeom = await landedGeom();
        const mPainted = await paintedIntrusionPx(decodePage);
        const mRatio = (mGeom.wrapBottom - mGeom.targetTop - 3) / mGeom.wrapHeight;
        assert.ok(
          mGeom.wrapBottom > mGeom.targetTop,
          `sanity check: the Beacon Size m bird must actually overlap the match's top edge (${mousePos.mode}), got wrapBottom=${mGeom.wrapBottom}, targetTop=${mGeom.targetTop}`
        );

        for (const [size, scale] of [['l', 1.5], ['xl', 2.25]]) {
          await setVisionSettings({ beaconSize: size });
          currentBeaconSize = size;
          const geom = await landedGeom();

          const heightRatio = geom.wrapHeight / mGeom.wrapHeight;
          assert.ok(
            Math.abs(heightRatio - scale) <= scale * SCALE_TOLERANCE,
            `at Beacon Size ${size} (${mousePos.mode}), the rendered sprite height (${geom.wrapHeight}) must scale ~${scale}x Beacon Size m's own rendered height (${mGeom.wrapHeight}) -- got x${heightRatio.toFixed(3)}, which is exactly what a disabled Beacon Size transform breaks`
          );

          const ratio = (geom.wrapBottom - geom.targetTop - 3) / geom.wrapHeight;
          assert.ok(
            Math.abs(ratio - mRatio) <= mRatio * RATIO_TOLERANCE,
            `at Beacon Size ${size} (${mousePos.mode}), the landed overlap-to-height ratio (${ratio.toFixed(4)}) must stay near Beacon Size m's own ratio (${mRatio.toFixed(4)}) -- a bigger drift means the landing offset is not tracking the rendered sprite's own scaled size, and the bird would drift past the match's top edge`
          );
        }

        // beaconSize is already 'xl' from the last loop iteration above -- chrome.
        // storage.sync only fires onChanged on a genuine value change (this file's own
        // "pack enumeration" test documents the same gotcha), so re-setting it to the
        // value it already holds would hang setVisionSettings()'s echo-wait.
        const xlPainted = await paintedIntrusionPx(decodePage);
        assert.ok(
          xlPainted <= mPainted * PAINT_TOLERANCE,
          `at Beacon Size xl (${mousePos.mode}), the painted intrusion into the match's own rect (${xlPainted}px) must stay near the Beacon Size m figure (${mPainted}px), i.e. <= ${PAINT_TOLERANCE}x it -- this counts every changed pixel in the match's own rect (mostly background above the letters, not glyph ink), so exceeding it means the sprite is covering disproportionately more of that rect than its own scale explains`
        );
      }
    } finally {
      if (decodePage) await decodePage.close();
      // Skip the reset when we're already at 'm' -- see currentBeaconSize's own comment
      // above the try block.
      if (currentBeaconSize !== 'm') {
        await setVisionSettings({ beaconSize: 'm' });
      }
      await page.mouse.move(200, 120);
      // No explicit scrollTo(0, 0) here, unlike the document-space correctness test
      // above -- every replay()/paintedIntrusionPx() call already fired the finder's
      // own "scroll the active match into view" behavior, which leaves #target on-
      // screen for whatever runs next. Measured: forcing scrollY back to 0 instead
      // pushes #target back behind this fixture's own 4000px spacer, and a
      // subsequent page.mouse.move() at that now off-screen y silently fails to
      // dispatch a real mousemove at all -- which is exactly what broke the
      // "placement fallback" test immediately after this one while this line was
      // still here.
      await evalInContentScript('window.__ocTest.cancelBeacons()');
    }
  });

  test('Animation Speed, set for real through chrome.storage.sync: every rendered WAAPI duration AND delay scales by getBeaconDuration\'s own factor', async () => {
    // animateFlappy's own flap count (n = round(dist/160), content.js ~3097) depends on
    // the distance from the tracked cursor (or its fallback) to the match -- unlike every
    // other effect this bead covers, its FLAP_PERIOD (and so every rendered timing) is NOT
    // a pure function of animationSpeed alone. oculist-mcpd (reviewer-caught): an unpinned
    // mouse/scroll let that distance drift BETWEEN renders -- measured scrollY moving
    // 3190->3338px across two consecutive Enter presses on a page this test had never
    // scrolled itself, changing the flap count with it and reading as a bogus "duration
    // failed to scale" failure. Pinning the cursor and pre-scrolling the match fully into
    // view (so every Enter press below takes animate()'s own fixed-50ms "already in
    // viewport" branch instead of a native scrollIntoView that this test can't safely wait
    // out) makes the distance, and so the flap count, identical across all three renders.
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });
    await page.mouse.move(200, 120);
    await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);

    // Collects across BOTH top-level .oc-beacon-transient elements animateFlappy mounts --
    // the bird and the absorption flash, created synchronously in the same animateFlappy()
    // call (this file's own cancellation test documents that) -- not just the bird, so a
    // durFactor bug confined to the flash's own delay/duration (DUR = getBeaconDuration(900),
    // flashDuration = getBeaconDuration(450), content.js ~2990/3292) cannot hide behind a
    // bird-only read. Same test/helpers/waapi_timings.js collection
    // cheshire_effect.test.js's own equivalent test uses, generalized across multiple
    // roots. wingIterations is read alongside it, straight off the wing animation's own
    // getTiming() (n - 0.5, content.js ~3098) -- never multiplied by durFactor anywhere --
    // so it stays constant across every speed as long as the flight geometry above is
    // truly pinned; comparing it gives a mismatch a name ("the geometry changed") instead
    // of it reading as an ordinary duration/delay assertion failure.
    async function renderedTimings() {
      await replay(() => (document.querySelector('.oc-beacon-transient') ? true : null));
      const [timings, wingIterations] = await Promise.all([
        page.evaluate(collectAnimationTimings),
        page.evaluate(() => {
          const wing = document.querySelector('.oc-flappy-bird').getAnimations({ subtree: true })
            .find((a) => a.effect.getTiming().iterations !== 1);
          return wing ? wing.effect.getTiming().iterations : null;
        }),
      ]);
      return { timings, wingIterations };
    }

    // Tracks the last animationSpeed actually written, so the finally below can skip its
    // own reset when we're already back at 'normal' -- chrome.storage.sync only fires
    // onChanged on a genuine value change (this file's own "pack enumeration" test
    // documents the same gotcha), so an unconditional reset risks masking a real assertion
    // failure under a "never echoed" timeout thrown while unwinding (flappy_effect.test.js's
    // own Beacon Size test, oculist-vqq1, fixed the identical hazard the same way). Set
    // before the write itself, not after, so a write that lands but whose echo wait then
    // times out still leaves finally able to attempt the reset.
    let currentSpeed = 'normal';

    try {
      const base = await renderedTimings();
      assert.ok(base.timings.length > 0, 'sanity check: expected at least one live WAAPI animation');
      assert.ok(base.wingIterations !== null, 'sanity check: expected the wing animation with its own flap-count iterations');

      const SPEEDS = [['fast', 0.5], ['slow', 1.75]];
      for (const [speed, factor] of SPEEDS) {
        currentSpeed = speed;
        await setVisionSettings({ animationSpeed: speed });
        const r = await renderedTimings();
        assert.strictEqual(
          r.wingIterations,
          base.wingIterations,
          `Animation Speed ${speed}: the wing's own flap-count iterations changed from ${base.wingIterations} to ${r.wingIterations} -- the flight GEOMETRY differed between renders, not a duration/delay that failed to scale`
        );
        assert.strictEqual(
          r.timings.length,
          base.timings.length,
          `Animation Speed ${speed}: expected the same ${base.timings.length} animations`
        );
        r.timings.forEach((t, i) => {
          const expectedDuration = base.timings[i].duration * factor;
          const expectedDelay = base.timings[i].delay * factor;
          assert.ok(
            Math.abs(t.duration - expectedDuration) <= 1,
            `Animation Speed ${speed}: duration[${i}] expected ~${expectedDuration}ms (base ${base.timings[i].duration}ms x ${factor}), got ${t.duration}ms`
          );
          assert.ok(
            Math.abs(t.delay - expectedDelay) <= 1,
            `Animation Speed ${speed}: delay[${i}] expected ~${expectedDelay}ms (base ${base.timings[i].delay}ms x ${factor}), got ${t.delay}ms`
          );
        });
      }
    } finally {
      if (currentSpeed !== 'normal') {
        await setVisionSettings({ animationSpeed: 'normal' });
      }
      // No explicit scrollTo(0, 0) here -- the Beacon Size test right above this one
      // documents (and this bead re-discovered under --test-concurrency=2) that forcing
      // scrollY back to 0 pushes #target back behind this fixture's own 4000px spacer,
      // and "placement fallback" two tests later reads a match-relative mouse coordinate
      // straight off getBoundingClientRect() with no re-scroll of its own -- an off-
      // screen Y there makes page.mouse.move() silently fail to dispatch a real
      // mousemove at all.
      await page.mouse.move(200, 120);
    }
  });

  test('the mirrored branch: starting to the right of the match flies in mirrored, right way up, facing left', async () => {
    // #target sits around x~460 of the 1200px viewport (420px margin-left plus "filler
    // text " before it) -- a cursor placed at x=1100 is comfortably to its right, which
    // is all "mirrored" depends on (dx < 0 between the cascade's start point and the
    // match), independent of any viewport-edge placement logic.
    await page.mouse.move(1100, 300);
    try {
      const geom = await replay(flappyBirdSnapshot);
      assert.ok(geom, 'expected a mounted .oc-flappy-bird');

      assert.notStrictEqual(
        geom.wrapTransform.indexOf('scaleX(-1)'),
        -1,
        `a start to the right of the match must carry the mirror transform, got wrapTransform="${geom.wrapTransform}"`
      );
      assert.ok(
        geom.offsetRotate.indexOf('180deg') !== -1,
        `a mirrored flight must add the 180deg offset-rotate branch (rule 7 of oculist-e2m.1), got offsetRotate="${geom.offsetRotate}"`
      );

      const parsed = parseFlightPath(geom.offsetPath);
      assert.ok(
        parsed.start[0] > parsed.end[0],
        `a mirrored flight must actually start to the right of the match: start X ${parsed.start[0]}, end X ${parsed.end[0]}`
      );
    } finally {
      // Restore a left-of-match cursor position so later tests (and the cursor-unknown
      // fallback test's own fresh tab, which never receives a mousemove at all) are
      // unaffected by this tab's own lastMouseX/lastMouseY.
      await page.mouse.move(200, 120);
    }
  });

  test('placement fallback: a cursor too close to the match horizontally is discarded for a real 200px-clear launch', async () => {
    const matchInfo = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    // 60px to the match's own right -- well under the 120px threshold animateFlappy uses
    // to decide a cascade start point is too close horizontally to read as a flight.
    await page.mouse.move(matchInfo.cx + 60, matchInfo.cy);
    try {
      const geom = await replay(flappyBirdSnapshot);
      assert.ok(geom, 'expected a mounted .oc-flappy-bird');

      // The raw cursor was to the match's RIGHT (dx<0 before the override), but the
      // degenerate branch relaunches 200px to the match's LEFT -- if this test instead
      // observed the raw too-close cursor point, the flight would be both far shorter
      // than 200px and would carry the mirror transform, catching a regression where the
      // override is skipped or the raw cursor position leaks through unmodified.
      assert.strictEqual(
        geom.wrapTransform.indexOf('scaleX(-1)'),
        -1,
        'the degenerate-distance override relaunches from the match\'s left, so this must not be mirrored'
      );

      const parsed = parseFlightPath(geom.offsetPath);
      const expectedStartX = matchInfo.cx + geom.scrollX - 200;
      assert.ok(
        Math.abs(parsed.start[0] - expectedStartX) <= 2,
        `degenerate-distance start X: expected ~${expectedStartX} (200px left of the match), got ${parsed.start[0]}`
      );
    } finally {
      await page.mouse.move(200, 120);
    }
  });

  test('with no mouse movement anywhere on the page, the flight still starts at the find bar, not 0,0', async () => {
    // A brand-new tab of the same persistent context -- its content script instance has
    // never received a single mousemove event, so lastMouseX/lastMouseY are genuinely
    // null, the exact scenario a keyboard-only Ctrl+F, Enter user produces.
    const page2 = await ctx.newPage();

    const client2 = await ctx.newCDPSession(page2);
    await client2.send('Page.enable');
    await client2.send('Runtime.enable');
    let isolatedContextId2;
    client2.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId2 = c.id;
      }
    });

    try {
      await page2.goto(origin);
      await waitForCondition(() => isolatedContextId2, Boolean, {
        timeout: POLL_TIMEOUT,
        message: 'never observed the content script isolated execution context for the fresh tab',
      });
      await openFinder(page2);

      // oculist-8s5 (see trail_effect.test.js's own comment on this): a fresh tab's
      // persisted 'effect' can race a first-install seeding write in background.js and
      // come back stuck on the in-memory default. window.__ocTest.setEffectKey() sets
      // settings.effect directly, bypassing chrome.storage.sync entirely.
      await evalInContentScript("window.__ocTest.setEffectKey('flappy')", { client: client2, contextId: isolatedContextId2 });

      await page2.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page2);

      const targetDocY = await page2.evaluate(() => {
        const r = document.getElementById('target').getBoundingClientRect();
        return r.top + window.scrollY + r.height / 2;
      });
      await page2.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);

      await evalInContentScript('window.__ocTest.cancelBeacons()', { client: client2, contextId: isolatedContextId2 });
      await page2.keyboard.press('Enter');

      const handle = await page2.waitForFunction(
        () => {
          const bird = document.querySelector('.oc-flappy-bird');
          if (!bird) return null;
          const wrapRect = document.getElementById('oc-wrap').getBoundingClientRect();
          return {
            offsetPath: bird.style.offsetPath,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            wrapLeft: wrapRect.left,
            wrapTop: wrapRect.top,
            wrapWidth: wrapRect.width,
            wrapHeight: wrapRect.height,
          };
        },
        null,
        { timeout: POLL_TIMEOUT }
      );
      const geom = await handle.jsonValue();
      const parsed = parseFlightPath(geom.offsetPath);

      assert.ok(
        parsed.start[0] > 5 || parsed.start[1] > 5,
        `flight must never start at (0,0), got (${parsed.start[0]}, ${parsed.start[1]})`
      );

      const expectedStartX = geom.wrapLeft + geom.wrapWidth / 2 + geom.scrollX;
      const expectedStartY = geom.wrapTop + geom.wrapHeight / 2 + geom.scrollY;
      assert.ok(
        Math.abs(parsed.start[0] - expectedStartX) <= 2,
        `fallback start X: expected the find bar's centre ~${expectedStartX}, got ${parsed.start[0]}`
      );
      assert.ok(
        Math.abs(parsed.start[1] - expectedStartY) <= 2,
        `fallback start Y: expected the find bar's centre ~${expectedStartY}, got ${parsed.start[1]}`
      );
    } finally {
      await page2.close();
    }
  });

  test('cancellation mid-flight: no .oc-beacon-transient nodes survive, and every WAAPI animation on the bird AND the flash is actually canceled', async () => {
    // The flash element (and its own delayed Animation) is created synchronously in the
    // same animateFlappy() call as the bird, so by the time .oc-flappy-bird has mounted
    // .oc-flappy-flash has too -- both are captured in one predicate tick.
    const mounted = await replay(() =>
      document.querySelector('.oc-flappy-bird') && document.querySelector('.oc-flappy-flash') ? true : null
    );
    assert.ok(mounted, 'sanity check: the bird and the flash must both actually mount before they can be cancelled');

    // Snapshot every live Animation on the bird AND the flash BEFORE cancelling --
    // destroyBeacon() (content.js) always removes the element it's handed regardless of
    // whether __waapiAnims lists every live animation, so a missing entry there leaks a
    // still-running Animation on a detached node (waapi_beacon_cancel.test.js's own
    // header), invisible to a DOM-survival check alone (boneassembly_effect.test.js's own
    // cancellation test uses the identical idiom). The flash's own Animation only starts
    // playing after its delay:DUR elapses, but getAnimations() returns it regardless of
    // playState, including 'pending' before that delay fires -- a pending or a running
    // Animation is equally leaked if cancelBeacons() cannot reach it.
    const animCounts = await page.evaluate(() => {
      const bird = document.querySelector('.oc-flappy-bird');
      const flash = document.querySelector('.oc-flappy-flash');
      window.__flappyTestBirdAnims = bird.getAnimations({ subtree: true });
      window.__flappyTestFlashAnims = flash.getAnimations({ subtree: true });
      return { bird: window.__flappyTestBirdAnims.length, flash: window.__flappyTestFlashAnims.length };
    });
    assert.ok(animCounts.bird > 0, 'sanity check: the bird must have live animations before cancellation');
    assert.ok(animCounts.flash > 0, 'sanity check: the flash must have a live animation before cancellation');

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });

    const states = await page.evaluate(() => ({
      bird: window.__flappyTestBirdAnims.map((a) => a.playState),
      flash: window.__flappyTestFlashAnims.map((a) => a.playState),
    }));
    assert.ok(
      states.bird.every((s) => s === 'idle'),
      `every bird animation must be canceled (playState 'idle') after cancelBeacons(), got: ${states.bird.join(', ')}`
    );
    assert.ok(
      states.flash.every((s) => s === 'idle'),
      `the flash's animation must be canceled (playState 'idle') after cancelBeacons(), got: ${states.flash.join(', ')}`
    );
  });

  test('natural completion: nothing remains in the DOM once the bird\'s own beat sequence finishes, with no cancel', async () => {
    const mounted = await replay(() => (document.querySelector('.oc-flappy-bird') ? true : null));
    assert.ok(mounted, 'sanity check: the bird must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- this is the natural-completion path (travel, then
    // the fade, then the flash), distinct from the cancellation test above. A genuine
    // leak surfaces as this wait's own TimeoutError.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });
  });

  test('Lite Mode drops the absorption flash\'s glow, but never the bird or its flight', async () => {
    const counts = () => {
      const bird = document.querySelector('.oc-flappy-bird');
      const flash = document.querySelector('.oc-flappy-flash');
      if (!bird || !flash) return null;
      return {
        birdCount: document.querySelectorAll('.oc-flappy-bird').length,
        hasGlow: flash.style.boxShadow !== '',
      };
    };

    let snap = await replay(counts);
    assert.strictEqual(snap.birdCount, 1, 'full mode must render the bird');
    assert.ok(snap.hasGlow, 'full mode must render the absorption flash\'s glow');

    try {
      await setSettings({ performanceMode: true });
      snap = await replay(counts);
      assert.strictEqual(snap.birdCount, 1, 'Lite Mode must still render the bird and its flight -- they are the effect');
      assert.ok(!snap.hasGlow, 'Lite Mode must drop the absorption flash\'s box-shadow glow');
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('pack enumeration: absent while halloween is disabled, present once enabled, selection survives a disable/re-enable round trip, and the runtime falls back safely while disabled', async () => {
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

    try {
      // Disabled: absent from both availableEffects() and the picker DOM.
      await setSettings({ enabledPacks: [] });
      let keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.strictEqual(keys.indexOf('flappy'), -1, 'flappy must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(FLAPPY_EFFECT_ROW).count(),
        0,
        'flappy must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      // Enabled: present in both.
      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('flappy'), -1, 'flappy must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(FLAPPY_EFFECT_ROW).count(),
        1,
        'flappy must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'flappy' (a real,
      // registered -- just currently unavailable -- key, not a genuinely unknown one),
      // so firing must fall back to some other effect rather than mount a flappy bird or
      // throw.
      await setSettings({ effect: 'flappy', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        birdMounted: !!document.querySelector('.oc-flappy-bird'),
      } : null));
      assert.strictEqual(
        geom.birdMounted,
        false,
        'while the pack is disabled, the runtime fallback must not render a flappy bird'
      );
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });

      // Selection restored on re-enable: no explicit re-selection of 'flappy' here -- if
      // the disable step above had rewritten settings.effect, this would now fire
      // whatever it was rewritten to instead.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-flappy-bird') ? { birdMounted: true } : null));
      assert.strictEqual(geom.birdMounted, true, 'the stored flappy selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs
      // (test/active_match_magnifier.test.js documents the same gotcha) -- the happy
      // path above already leaves settings at exactly { effect: 'flappy', enabledPacks:
      // ['halloween'] }, so restoring straight to that value here would be a no-op write
      // that setSettings()'s echo-wait would hang on. Routing through a sentinel value
      // first guarantees both writes are genuine changes, regardless of which line above
      // (if any) actually threw.
      await setSettings({ enabledPacks: ['__oc_flappy_test_reset__'] });
      await setSettings({ effect: 'flappy', enabledPacks: ['halloween'] });
    }
  });
});
