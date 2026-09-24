// Cheshire Cat beacon effect (oculist-e2m.6): promotes fxCheshire (artifacts/prototypes/
// effects-playground.html, the geometric-dissolve redraw from oculist-e2m.8/.9) into
// extension/content.js as the third entry in the Halloween pack. A hand-drawn cat fades
// in above the match (or below it when there is no room), its six head/body regions
// dissolve while its grin settles toward the match, pops, holds, then fades -- the grin
// outlasts the body, it does not persist.
//
// Modeled on test/trail_effect.test.js (document-space + Lite Mode idioms) and
// test/flappy_effect.test.js (this Halloween pack's own sibling, same fixture/helper
// shape and the same pack-enumeration coverage) -- against the REAL extension, since
// cheshire is a genuine effectsRegistry entry under pack:'halloween', no fixture copy
// needed for either.
//
// Needs a real browser for the same reasons as those two: WAAPI, real layout, and
// chrome.storage.sync-driven settings only exist in real Chromium.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');
const { collectAnimationTimings } = require('./helpers/waapi_timings');

const EXTENSION = path.resolve(__dirname, '../extension');

// A fixed-height spacer both above and below #target gives real scrollable room to
// place the match near the very top of the viewport (forcing the below-match fallback)
// or comfortably mid-viewport (the default above-match placement), the same reasoning
// flappy_effect.test.js's own fixture gives for a real, non-flaky scroll.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:1200px"></div>
<p style="margin-left:420px;">filler text <span id="target">quarklet</span></p>
<div style="height:2000px"></div>`;

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const CHESHIRE_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:cheshire"]';

// The prototype's own VB_W/VB_H aspect and match-relative clamp (animateCheshire,
// content.js) -- reused here only for the placement/document-space assertions below,
// which recompute the expected geometry the same way flappy_effect.test.js's own
// document-space test does. The Beacon Size L/XL test further down deliberately does
// NOT use this recomputation -- see its own comment.
const ASPECT = 130 / 100;
function expectedCatHeight(targetHeight) {
  return Math.max(48, Math.min(110, 3.2 * targetHeight));
}

describe('Cheshire Cat: a hand-drawn cat fades in above (or below) the match, dissolves, and its grin settles, pops, holds, then fades', () => {
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
      viewport: VIEWPORT,
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

    // Select Cheshire Cat and turn its pack on for the whole suite before ever opening the
    // finder -- every tab of this persistent context shares this chrome.storage.sync
    // write.
    await setSettings({ effect: 'cheshire', enabledPacks: ['halloween'] });

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
  // chrome.storage.sync.set, same idiom as flappy_effect.test.js's own
  // setVisionSettings -- setSettings() above only shallow-merges the top level, which
  // would otherwise drop every other key already inside visionSettings.
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

  // Same production cancellation path as flappy_effect.test.js's own replay(): cancels
  // any in-flight beacon through window.__ocTest.cancelBeacons() (the exact function
  // animate() itself calls first), then presses Enter to (re-)fire, waiting on
  // `predicate` -- folding presence and geometry reads into one page-side tick so
  // nothing can self-clean in a round-trip gap.
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

  // animateCheshire's own single .oc-beacon-transient element IS the <svg> itself (see
  // its header comment), not a wrapping <div> -- unlike animateFlappy's birdEl or
  // animateBoneAssembly's figWrap.
  function cheshireSnapshot() {
    const svg = document.querySelector('svg.oc-beacon-transient');
    if (!svg) return null;
    const target = document.getElementById('target').getBoundingClientRect();
    return {
      styleLeft: parseFloat(svg.style.left),
      styleTop: parseFloat(svg.style.top),
      styleWidth: parseFloat(svg.style.width),
      styleHeight: parseFloat(svg.style.height),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      targetLeft: target.left,
      targetTop: target.top,
      targetBottom: target.bottom,
      targetWidth: target.width,
      targetHeight: target.height,
    };
  }

  test('document-space correctness and placement: on a scrolled page with headroom above the match, the cat renders ABOVE it, in document coordinates', async () => {
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY;
    });

    try {
      // Leave ~400px of headroom above the match -- comfortably more than catHeight+GAP
      // (well under 110px even at the largest clamp), so animateCheshire's own `above`
      // branch fires, and a real, non-zero scrollY exercises document-space math a
      // window.scrollTo(0, 0) page could not.
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 400)), targetDocY);

      const geom = await replay(cheshireSnapshot);
      assert.ok(geom, 'expected a mounted cheshire svg');
      assert.ok(geom.scrollY > 0, `sanity check: the page must actually be scrolled, got scrollY=${geom.scrollY}`);

      const catHeight = expectedCatHeight(geom.targetHeight);
      const catWidth = catHeight * ASPECT;
      const expectedScreenLeft = geom.targetLeft + geom.targetWidth / 2 - catWidth / 2;
      const expectedScreenTop = geom.targetTop - 8 - catHeight; // GAP=8, above branch

      const expectedDocLeft = expectedScreenLeft + geom.scrollX;
      const expectedDocTop = expectedScreenTop + geom.scrollY;

      assert.ok(
        Math.abs(geom.styleLeft - expectedDocLeft) <= 2,
        `left: expected ~${expectedDocLeft}, got ${geom.styleLeft}`
      );
      assert.ok(
        Math.abs(geom.styleTop - expectedDocTop) <= 2,
        `top: expected ~${expectedDocTop} -- a missing "+ window.scrollY" term here is exactly what a scrolled-page ` +
          `assertion catches that an unscrolled one cannot -- got ${geom.styleTop}`
      );
      assert.ok(
        Math.abs(geom.styleWidth - catWidth) <= 2,
        `width: expected ~${catWidth}, got ${geom.styleWidth}`
      );
      assert.ok(
        Math.abs(geom.styleHeight - catHeight) <= 2,
        `height: expected ~${catHeight}, got ${geom.styleHeight}`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('placement fallback: near the top of the viewport, the cat renders BELOW the match and is fully on screen', async () => {
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY;
    });

    try {
      // Leave only 20px of headroom above the match -- well under catHeight+GAP at any
      // Beacon Size, so animateCheshire's own below-match fallback branch fires.
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 20)), targetDocY);

      const geom = await replay(cheshireSnapshot);
      assert.ok(geom, 'expected a mounted cheshire svg');

      const catHeight = expectedCatHeight(geom.targetHeight);
      const expectedScreenTop = geom.targetBottom + 8; // GAP=8, below branch
      const expectedDocTop = expectedScreenTop + geom.scrollY;

      assert.ok(
        Math.abs(geom.styleTop - expectedDocTop) <= 2,
        `top: expected ~${expectedDocTop} (below-match fallback), got ${geom.styleTop}`
      );

      const viewportTop = geom.styleTop - geom.scrollY;
      assert.ok(viewportTop >= 0, `cat's top edge must be on screen, got viewport-space top ${viewportTop}`);
      assert.ok(
        viewportTop + catHeight <= VIEWPORT.height + 1,
        `cat's bottom edge must be on screen (viewport height ${VIEWPORT.height}), got ${viewportTop + catHeight}`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('Beacon Size L and XL, set for real through chrome.storage.sync: the RENDERED box grows and still clears the match', async () => {
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY;
    });
    await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 400)), targetDocY);

    async function renderedBox() {
      await replay(() => (document.querySelector('svg.oc-beacon-transient') ? true : null));
      // Wait for the 0-180ms fade/scale-in to settle at its final transform:scale(1)
      // before reading the box: getBoundingClientRect() would otherwise still reflect
      // the animation's own in-flight scale(0.9..1), not the effect's real footprint.
      await page.waitForFunction(() => {
        const svg = document.querySelector('svg.oc-beacon-transient');
        return svg && parseFloat(getComputedStyle(svg).opacity) > 0.98 ? true : null;
      }, null, { timeout: POLL_TIMEOUT });
      return page.evaluate(() => {
        const rect = document.querySelector('svg.oc-beacon-transient').getBoundingClientRect();
        const target = document.getElementById('target').getBoundingClientRect();
        return { width: rect.width, height: rect.height, bottom: rect.bottom, targetTop: target.top };
      });
    }

    // The svg carries overflow:visible, so #grin (drift-translated and, at the pop,
    // scaled 1.12x) can render outside the svg's own bounding box entirely -- the
    // renderedBox() assertions below, which only read the svg's own box, cannot see
    // that. Seeks every animation directly to 840ms (180 + 720*0.9167, grinG's own
    // settle+pop keyframe offset 0.9167 -- see animateCheshire's own grinG.animate()
    // call), the pop's peak scale and the currently-mounted instance's furthest drift,
    // the same Animation.currentTime idiom the grin-outlasts-body test below uses
    // instead of a wall-clock sample.
    async function grinPopBox() {
      return page.evaluate(() => {
        const svg = document.querySelector('svg.oc-beacon-transient');
        const anims = svg.getAnimations({ subtree: true });
        anims.forEach((a) => {
          a.pause();
          a.currentTime = 840;
        });
        const grin = svg.querySelector('[data-cheshire-part="grin"]');
        const rect = grin.getBoundingClientRect();
        const target = document.getElementById('target').getBoundingClientRect();
        return { bottom: rect.bottom, targetTop: target.top };
      });
    }

    try {
      // getBeaconScale() (content.js): 'm' -> 1, 'l' -> 1.5, 'xl' -> 2.25. Baseline
      // measured from the RENDERED box at the default size first, then compared by
      // ratio at each larger size -- measured, not recomputed from animateCheshire's
      // own catHeight/beaconScale formula, so a bug in that formula (e.g. forgetting to
      // multiply by beaconScale) cannot cancel out against an identical recomputation
      // here.
      const base = await renderedBox();

      const SIZES = [['l', 1.5], ['xl', 2.25]];
      for (const [size, scale] of SIZES) {
        await setVisionSettings({ beaconSize: size });
        const geom = await renderedBox();

        assert.ok(
          Math.abs(geom.width / base.width - scale) < 0.05,
          `Beacon Size ${size}: rendered width must scale ~${scale}x the default's (${base.width}), got ${geom.width}`
        );
        assert.ok(
          Math.abs(geom.height / base.height - scale) < 0.05,
          `Beacon Size ${size}: rendered height must scale ~${scale}x the default's (${base.height}), got ${geom.height}`
        );
        assert.ok(
          geom.bottom <= geom.targetTop + 1,
          `Beacon Size ${size}: the cat's rendered box (bottom ${geom.bottom}) must clear the match's top edge ` +
            `(${geom.targetTop}) -- it must never paint over the match's own glyphs`
        );

        // #grin itself, at the pop's own peak -- the drift value feeds grinG's
        // transform in SVG user units, which the viewBox-to-catWidth/catHeight mapping
        // already scales by beaconScale; a drift accidentally multiplied by
        // beaconScale a second time pushes the grin's own bbox past the match's top
        // edge specifically at the larger sizes, invisible to the svg-box check above.
        const grinGeom = await grinPopBox();
        assert.ok(
          grinGeom.bottom <= grinGeom.targetTop + 1,
          `Beacon Size ${size}: the grin's own rendered box at the pop (bottom ${grinGeom.bottom}) must still clear ` +
            `the match's top edge (${grinGeom.targetTop}) -- the svg carries overflow:visible, so the grin can cross ` +
            `into the match even when the svg's own box does not`
        );
      }
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('Animation Speed, set for real through chrome.storage.sync: every rendered WAAPI duration AND delay scales by getBeaconDuration\'s own factor', async () => {
    // oculist-mcpd: collection itself now lives in test/helpers/waapi_timings.js (shared
    // with boneassembly/flappy/horseman/jackolantern/trail's own Animation Speed tests) --
    // it reads every top-level .oc-beacon-transient element, not just cheshire's single
    // svg root, but cheshire only ever mounts that one element, so the result is identical.
    async function renderedTimings() {
      await replay(() => (document.querySelector('svg.oc-beacon-transient') ? true : null));
      return page.evaluate(collectAnimationTimings);
    }

    try {
      // getBeaconDuration (content.js): 'fast' -> baseDuration*0.5, 'slow' ->
      // baseDuration*1.75, anything else (including the default 'normal') -> baseDuration
      // unscaled. Baseline measured from the RENDERED timings at the default speed
      // first, then compared against each scaled speed's own rendered timings --
      // measured, not recomputed from animateCheshire's own 180/360/600/720/900ms
      // literals, so a bug that skips durFactor entirely (or applies it to only some
      // phases) cannot cancel out against an identical recomputation here. Both
      // duration AND delay are checked (oculist-s0vr, reviewer-caught survivor):
      // every one of animateCheshire's .animate() calls multiplies BOTH its own
      // duration and delay by durFactor (only the svg's own 0-180ms fade/scale-in has
      // no delay at all, i.e. delay 0 -- 0*factor stays 0, so it needs no special
      // case), and a mutant that scales only duration (e.g. hardcoding one call's own
      // `delay: 180` instead of `delay: 180 * durFactor`) reads as fully green if only
      // duration is ever asserted. Sorted by [delay, duration] rather than compared by
      // array index, since getAnimations() does not promise the same per-element
      // ordering across two independently-mounted svg instances, and durFactor scales
      // every timing by the same factor regardless of order; ties (the six fragment
      // dissolves share one identical [delay, duration] pair) sort arbitrarily among
      // themselves but compare correctly since their values are interchangeable.
      const base = await renderedTimings();
      assert.strictEqual(base.length, 10, `expected 10 live WAAPI animations, got ${base.length}`);

      const SPEEDS = [['fast', 0.5], ['slow', 1.75]];
      for (const [speed, factor] of SPEEDS) {
        await setVisionSettings({ animationSpeed: speed });
        const timings = await renderedTimings();
        assert.strictEqual(timings.length, base.length, `Animation Speed ${speed}: expected the same 10 animations`);
        timings.forEach((t, i) => {
          const expectedDuration = base[i].duration * factor;
          const expectedDelay = base[i].delay * factor;
          assert.ok(
            Math.abs(t.duration - expectedDuration) <= 1,
            `Animation Speed ${speed}: duration[${i}] expected ~${expectedDuration}ms (base ${base[i].duration}ms x ${factor}), got ${t.duration}ms`
          );
          assert.ok(
            Math.abs(t.delay - expectedDelay) <= 1,
            `Animation Speed ${speed}: delay[${i}] expected ~${expectedDelay}ms (base ${base[i].delay}ms x ${factor}), got ${t.delay}ms`
          );
        });
      }
    } finally {
      // The loop above always ends on 'slow', a genuine change from the default
      // 'normal' either way this exits (success or a thrown assertion), so this final
      // write is never a same-value write -- chrome.storage only fires onChanged when
      // the stored value actually differs (the pack-enumeration test's own comment,
      // further down, documents the same gotcha).
      await setVisionSettings({ animationSpeed: 'normal' });
    }
  });

  test('below-match settle direction: the grin drifts the opposite way it does above the match', async () => {
    // Independent of the previous test's own cleanup: a read, not a write, so there is
    // no same-value-write hang to risk -- this test's own currentTime=180/780 seeks
    // (below) assume durFactor=1 (the default speed), and would silently measure a
    // scaled drift window if Animation Speed were left at 'fast'/'slow'.
    const currentSpeed = await evalInContentScript(
      "new Promise(function (resolve) {" +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var vs = (data && data['oc-settings'] && data['oc-settings'].visionSettings) || {};" +
        "resolve(vs.animationSpeed || 'normal');" +
        '});' +
        '})'
    );
    assert.strictEqual(
      currentSpeed,
      'normal',
      "sanity check: Animation Speed must already be 'normal' entering this test, independent of the previous test's own cleanup"
    );

    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY;
    });

    // grinG's own settle animation (animateCheshire, content.js): delay 180*durFactor,
    // duration 720*durFactor, drift keyframe at offset 0.833 -- at the real default
    // speed (durFactor=1) currentTime=180 samples the pre-drift translate(0,0) frame,
    // currentTime=780 samples the settled translate(0,drift) frame. The delta between
    // the grin's own getBoundingClientRect().top at those two frames is the drift's
    // real, rendered direction and rough magnitude -- not a re-read of the `drift`
    // variable itself, which is exactly what a re-signing bug in that variable could
    // not expose.
    async function grinDriftTop() {
      await replay(() => (document.querySelector('svg.oc-beacon-transient') ? true : null));
      return page.evaluate(() => {
        const svg = document.querySelector('svg.oc-beacon-transient');
        const anims = svg.getAnimations({ subtree: true });
        const grin = svg.querySelector('[data-cheshire-part="grin"]');
        function seek(t) {
          anims.forEach((a) => {
            a.pause();
            a.currentTime = t;
          });
          return grin.getBoundingClientRect().top;
        }
        const before = seek(180);
        const after = seek(780);
        return after - before;
      });
    }

    try {
      // Above branch: ~400px of headroom, the same scroll the "document-space
      // correctness" test above uses to force animateCheshire's own `above` branch.
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 400)), targetDocY);
      const aboveDelta = await grinDriftTop();

      // Below branch: only 20px of headroom, the same scroll the "placement fallback"
      // test above uses to force animateCheshire's own below-match branch.
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 20)), targetDocY);
      const belowDelta = await grinDriftTop();

      assert.ok(
        Math.abs(aboveDelta) > 1,
        `sanity check: the above branch's own drift must be visibly non-zero, got a top-delta of ${aboveDelta}`
      );
      assert.ok(
        aboveDelta > 0,
        `above the match, the grin must drift DOWN (toward the match below it), got a top-delta of ${aboveDelta}`
      );
      assert.ok(
        belowDelta < 0,
        `below the match, the grin must drift UP (toward the match above it) -- the opposite sign of the above ` +
          `branch's own ${aboveDelta} -- got a top-delta of ${belowDelta}`
      );

      // Rough magnitude, not the exact -0.06*VB_H constant (oculist-s0vr): the two
      // branches' own drift magnitudes should be in the same ballpark, since only
      // their sign is meant to differ.
      const ratio = Math.abs(belowDelta) / Math.abs(aboveDelta);
      assert.ok(
        ratio > 0.5 && ratio < 2,
        `above/below drift magnitudes should be comparable, got above=${aboveDelta} below=${belowDelta} (ratio ${ratio})`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('the grin outlasts the body: once every dissolve fragment has faded, the grin is still visible', async () => {
    await replay(() => (document.querySelector('svg.oc-beacon-transient') ? true : null));

    // Seeks every WAAPI animation directly to fixed points on its own timeline
    // (Animation.currentTime), rather than polling real wall-clock time -- a real-time
    // sample raced actual test-runner scheduling under load and intermittently missed
    // its window entirely (measured: a real timeout, not just a late catch).
    //
    // Two samples, not one: 800ms alone does not tell "the grin's own hold-then-fade
    // animation has not started yet" apart from "the grin's fade HAS started but its
    // own ease-in easing keeps early progress visually close to 1" -- a fade whose
    // delay regressed from 900ms to 600ms is already active by 800ms (its own local
    // time is then 200 of 600ms) but, measured, still reads ~1.0 there because ease-in
    // is very shallow near its own start; that regression only reads a clearly lower
    // opacity by 850-950ms. So:
    //  - 800ms: deterministically between the fragments' own dissolve-animation end
    //    (180+600=780ms, after which fill:'forwards' holds opacity 0) and the grin's
    //    real delay:900ms start -- fragments must be gone here.
    //  - 950ms: inside the grin's own intended hold plateau (delay 900 + the first
    //    120ms of its own 600ms duration, offset 0-0.2 both opacity 1) at the real
    //    900ms delay, but well past where a regressed 600ms delay's own eased fade
    //    would have visibly dropped (measured ~0.74 under that regression, vs. exactly
    //    1 at the real delay) -- the grin must still read visible here too.
    async function seekAndSample(t) {
      return page.evaluate((t) => {
        const svg = document.querySelector('svg.oc-beacon-transient');
        const anims = svg.getAnimations({ subtree: true });
        anims.forEach((a) => {
          a.pause();
          a.currentTime = t;
        });
        const grin = svg.querySelector('[data-cheshire-part="grin"]');
        const fragments = Array.from(svg.querySelectorAll('[data-cheshire-fragment]'));
        return {
          fragmentsGone: fragments.every((f) => parseFloat(getComputedStyle(f).opacity) < 0.05),
          grinVisible: parseFloat(getComputedStyle(grin).opacity) > 0.95,
        };
      }, t);
    }

    const at800 = await seekAndSample(800);
    assert.strictEqual(at800.fragmentsGone, true, 'every dissolve fragment must have faded before the grin does');
    assert.strictEqual(at800.grinVisible, true, 'the grin must still be visible once the body has dissolved');

    const at950 = await seekAndSample(950);
    assert.strictEqual(
      at950.grinVisible,
      true,
      'the grin must still be visible at 950ms -- inside its own intended hold plateau at the real delay:900ms start, ' +
        'but past where a fade that started too early would already read as measurably faded'
    );

    // Cancel rather than let the seeked (now paused) animations run out naturally --
    // paused animations never reach 'finished', so a real-time completion wait here
    // would hang.
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    const mounted = await replay(() => (document.querySelector('svg.oc-beacon-transient') ? true : null));
    assert.ok(mounted, 'sanity check: the cat must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- this is the natural-completion path (dissolve,
    // then the grin's settle/pop/hold/fade), distinct from the cancellation test below.
    // A genuine leak surfaces as this wait's own TimeoutError.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on the cat (fragments and grin included) is actually canceled', async () => {
    const mounted = await replay(() => (document.querySelector('svg.oc-beacon-transient') ? true : null));
    assert.ok(mounted, 'sanity check: the cat must actually mount before it can be cancelled');

    // Snapshot every live Animation on the svg AND its descendants BEFORE cancelling --
    // destroyBeacon() (content.js) always removes the element it's handed regardless of
    // whether __waapiAnims lists every live animation, so a missing entry there leaks a
    // still-running Animation on a detached node, invisible to a DOM-survival check
    // alone (flappy_effect.test.js's own cancellation test uses the identical idiom).
    // animateCheshire hangs all ten of its own animations (the svg-level fade/scale-in,
    // detailsG's fade, all six per-fragment dissolves, and both grinG animations) off
    // the single svg.__waapiAnims array -- getAnimations({ subtree: true }) reaches
    // every one of them regardless of which node's own .animate() call created it.
    const animCount = await page.evaluate(() => {
      const svg = document.querySelector('svg.oc-beacon-transient');
      window.__cheshireTestAnims = svg.getAnimations({ subtree: true });
      return window.__cheshireTestAnims.length;
    });
    assert.strictEqual(
      animCount,
      10,
      `expected 10 live WAAPI animations before cancellation (1 svg fade/scale-in + 1 detailsG fade + ` +
        `6 fragment dissolves + 2 grinG animations), got ${animCount}`
    );

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });

    const states = await page.evaluate(() => window.__cheshireTestAnims.map((a) => a.playState));
    assert.ok(
      states.every((s) => s === 'idle'),
      `every animation (fragments and grin included) must be canceled (playState 'idle') after cancelBeacons(), got: ${states.join(', ')}`
    );
  });

  test('Lite Mode, set for real through chrome.storage.sync: nothing changes -- there was never a glow or box-shadow to drop', async () => {
    function snapshot() {
      const svg = document.querySelector('svg.oc-beacon-transient');
      if (!svg) return null;
      const teeth = svg.querySelector('[data-cheshire-part="grin"] path');
      return {
        fragmentCount: svg.querySelectorAll('[data-cheshire-fragment]').length,
        hasBoxShadow: Array.from(svg.querySelectorAll('*')).some((el) => getComputedStyle(el).boxShadow !== 'none'),
        teethFill: teeth ? teeth.getAttribute('fill') : null,
      };
    }

    const full = await replay(snapshot);
    assert.ok(full, 'expected a mounted cheshire svg in full mode');
    assert.strictEqual(full.fragmentCount, 6, 'full mode must render all six dissolve fragments');
    assert.strictEqual(full.hasBoxShadow, false, 'full mode never had a box-shadow glow to begin with');
    assert.strictEqual(full.teethFill, '#FFF8DC', 'full mode teeth must render with the plain crescent fill, no glow layer');

    try {
      await setSettings({ performanceMode: true });
      const lite = await replay(snapshot);
      assert.ok(lite, 'expected a mounted cheshire svg in Lite Mode');
      assert.strictEqual(lite.fragmentCount, 6, 'Lite Mode must still render all six dissolve fragments -- they are the effect');
      assert.strictEqual(lite.hasBoxShadow, false, 'Lite Mode must still have no box-shadow glow');
      assert.strictEqual(lite.teethFill, '#FFF8DC', 'Lite Mode teeth must render identically to full mode -- there is no glow to drop');
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
      assert.strictEqual(keys.indexOf('cheshire'), -1, 'cheshire must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(CHESHIRE_EFFECT_ROW).count(),
        0,
        'cheshire must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      // Enabled: present in both.
      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('cheshire'), -1, 'cheshire must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(CHESHIRE_EFFECT_ROW).count(),
        1,
        'cheshire must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'cheshire' (a real,
      // registered -- just currently unavailable -- key, not a genuinely unknown one),
      // so firing must fall back to some other effect rather than mount a cheshire svg
      // or throw.
      await setSettings({ effect: 'cheshire', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        catMounted: !!document.querySelector('svg.oc-beacon-transient'),
      } : null));
      assert.strictEqual(
        geom.catMounted,
        false,
        'while the pack is disabled, the runtime fallback must not render a cheshire cat'
      );
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });

      // Selection restored on re-enable: no explicit re-selection of 'cheshire' here --
      // if the disable step above had rewritten settings.effect, this would now fire
      // whatever it was rewritten to instead.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('svg.oc-beacon-transient') ? { catMounted: true } : null));
      assert.strictEqual(geom.catMounted, true, 'the stored cheshire selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs
      // (test/active_match_magnifier.test.js documents the same gotcha) -- the happy
      // path above already leaves settings at exactly { effect: 'cheshire', enabledPacks:
      // ['halloween'] }, so restoring straight to that value here would be a no-op write
      // that setSettings()'s echo-wait would hang on. Routing through a sentinel value
      // first guarantees both writes are genuine changes, regardless of which line above
      // (if any) actually threw.
      await setSettings({ enabledPacks: ['__oc_cheshire_test_reset__'] });
      await setSettings({ effect: 'cheshire', enabledPacks: ['halloween'] });
    }
  });
});
