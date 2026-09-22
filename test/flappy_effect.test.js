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

  test('Beacon Size L and XL: the bird\'s landed bottom edge keeps the same 3px overlap as the default size', async () => {
    // getBeaconScale() (content.js): 'l' -> 1.5, 'xl' -> 2.25. The Beacon Size transform
    // scales the sprite around its own wrapper's centre, the same point offset-anchor:50%
    // 50% tracks along the flight path -- so the sprite's visible bottom edge sits at
    // pathEndY + spriteHeight*scale/2, not pathEndY + spriteHeight/2. Asserted directly
    // against the fired path's own end point rather than by waiting out the whole flight:
    // the landing point is fixed at fire time, it does not move over the animation's own
    // duration.
    const SIZES = [['l', 1.5], ['xl', 2.25]];
    try {
      for (const [size, scale] of SIZES) {
        await setVisionSettings({ beaconSize: size });
        const geom = await replay(flappyBirdSnapshot);
        assert.ok(geom, `expected a mounted .oc-flappy-bird at Beacon Size ${size}`);

        const parsed = parseFlightPath(geom.offsetPath);
        const landedBottom = parsed.end[1] + (geom.spriteHeight * scale) / 2;
        const expectedBottom = geom.targetTop + geom.scrollY + 3;

        assert.ok(
          landedBottom <= expectedBottom + 1,
          `at Beacon Size ${size}, the bird's landed bottom edge (${landedBottom}) must not reach past the ` +
            `match's top edge + 3px overlap (${expectedBottom}) -- it would otherwise paint over the match's own glyphs`
        );
      }
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
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
