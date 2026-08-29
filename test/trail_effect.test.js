// Trail beacon effect (oculist-9wy): a single arrowhead travels an L-shaped (one
// right-angle elbow) path — via CSS offset-path/offset-rotate, not hand-rolled keyframes —
// from the user's last known cursor position to the active match. Find-in-page is
// keyboard-driven, so the cursor position is frequently unknown (Ctrl+F + Enter, no mouse
// movement); the load-bearing behaviour under test is that fallback, plus that the start
// point is expressed in *document* space (viewport client coords + scrollX/Y), which only
// a scrolled-page assertion can actually catch a regression in.
//
// Needs a real browser for the same reasons as dispersion_bloom.test.js /
// prefers_reduced_motion.test.js: WAAPI, offset-path and a real layout only exist in real
// Chromium, and Lite Mode can only be toggled for real through chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// A fixed-height spacer (not a giant repeated-text paragraph) gives real scrollable height
// — viewport is 1200x800, so window.scrollTo(0, 500) is not a no-op, the whole point of the
// "scroll before asserting" step below — without the layout/reflow cost of laying out
// thousands of wrapped words, which was slow enough during smooth-scroll-into-view to make
// the beacon's own arrival flaky against a 5s timeout.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:4000px"></div>
<p>filler text <span id="target">quarklet</span></p>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('Trail: an arrowhead travels an L-shaped motion path from cursor to match', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
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

    // Select the Trail effect for the whole suite before ever opening the finder. This
    // write lands in chrome.storage.sync, which every tab of this persistent context
    // shares — the fresh tab test 2 opens later boots with this same setting already in
    // place, with no per-tab configuration of its own required.
    await setSettings({ effect: 'trail' });

    await openFinder(page);
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    await waitForMatchCount(page);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // isolatedContextId existing only proves the content script's realm has been created,
  // not that its synchronous top-level init has reached the keydown-listener registration
  // yet — retry Control+f (a keypress a not-yet-attached listener would otherwise silently
  // swallow) until the input actually appears, instead of trusting one press.
  async function openFinder(pg) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await pg.keyboard.press('Control+f');
      try {
        // Intentional unscaled sub-poll: the scaled waitForSelector below surfaces
        // the real timeout error if all 20 attempts fail.
        await pg.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await pg.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
  }

  // Wait for the draft debounce to actually land a real match count before any test fires
  // the beacon, instead of guessing its duration.
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
      .send('Runtime.evaluate', {
        expression,
        contextId: isolatedContextId,
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

  // Arm a probe listener inside the content script's own isolated world *before* writing a
  // settings change: chrome.storage.onChanged fires every listener registered against that
  // same document for the same event, in registration order — content.js's own listener was
  // registered at page load, long before this probe, so observing OUR listener fire is a
  // direct proxy for content.js's own listener having already applied the change.
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

  // Merges `patch` into the top-level persisted settings via chrome.storage.sync.set — the
  // same underlying write the popup/in-page settings panel makes — from inside the content
  // script's own isolated world, and waits for content.js's own onChanged listener to
  // actually apply it.
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

  // Clears any leftover .oc-beacon nodes, presses Enter to (re-)fire the active beacon, and
  // waits for a fresh .oc-beacon container to actually exist. animate() calls
  // cancelBeacons() first, so this never accumulates parts across calls.
  async function replay(pg) {
    await pg.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await pg.keyboard.press('Enter');
    await pg.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  // Pulls out the L-shaped path's start/elbow/end points from the .oc-trail-arrow arrow's
  // inline offset-path, plus the geometry needed to compute the *expected* points, all in
  // one synchronous page.evaluate call so nothing can move between reads.
  async function readTrailGeometry(pg) {
    return pg.evaluate(() => {
      const arrow = document.querySelector('.oc-trail-arrow');
      const targetRect = document.getElementById('target').getBoundingClientRect();
      return {
        left: arrow ? arrow.style.left : null,
        top: arrow ? arrow.style.top : null,
        offsetPath: arrow ? (arrow.style.offsetPath || getComputedStyle(arrow).offsetPath) : null,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        targetLeft: targetRect.left,
        targetTop: targetRect.top,
        targetWidth: targetRect.width,
        targetHeight: targetRect.height,
      };
    });
  }

  // 'M 0 0 L <dx> 0 L <dx> <dy>' -> { dx, dy } (the arrow's own end point, relative to
  // where it's mounted).
  function parseOffsetPathEnd(offsetPath) {
    const m = /M\s*([-\d.]+)\s+([-\d.]+)\s*L\s*([-\d.]+)\s+([-\d.]+)\s*L\s*([-\d.]+)\s+([-\d.]+)/.exec(
      offsetPath || ''
    );
    assert.ok(m, `offset-path did not parse as an M ... L ... L ... path: "${offsetPath}"`);
    return {
      m0: [parseFloat(m[1]), parseFloat(m[2])],
      elbow: [parseFloat(m[3]), parseFloat(m[4])],
      end: [parseFloat(m[5]), parseFloat(m[6])],
    };
  }

  test('the path starts at the tracked cursor position and ends at the match, in document space', async () => {
    const mouseClientX = 55;
    const mouseClientY = 65;
    await page.mouse.move(mouseClientX, mouseClientY);

    // Scroll before firing — a missing window.scrollX/Y conversion in animateTrail() would
    // otherwise pass this test by accident on an unscrolled page. Land the match already
    // fully inside the viewport (rather than scrolling it out of view and relying on
    // highlightActiveRange()'s native smooth-scroll-into-view + settle-detection timing,
    // which is real wall-clock browser animation time unrelated to what this test proves,
    // and was flaky against a fixed timeout) — this takes the deterministic "already in
    // view" firing path instead.
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });
    await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);

    await replay(page);
    const geom = await readTrailGeometry(page);
    assert.ok(geom.left && geom.top, 'expected a mounted .oc-trail-arrow arrowhead');

    const parsed = parseOffsetPathEnd(geom.offsetPath);
    assert.deepStrictEqual(parsed.m0, [0, 0], 'the path must start at the arrow\'s own local origin');

    const actualStartX = parseFloat(geom.left) + parsed.m0[0];
    const actualStartY = parseFloat(geom.top) + parsed.m0[1];
    const actualEndX = parseFloat(geom.left) + parsed.end[0];
    const actualEndY = parseFloat(geom.top) + parsed.end[1];

    const expectedStartX = mouseClientX + geom.scrollX;
    const expectedStartY = mouseClientY + geom.scrollY;
    const expectedEndX = geom.targetLeft + geom.targetWidth / 2 + geom.scrollX;
    const expectedEndY = geom.targetTop + geom.targetHeight / 2 + geom.scrollY;

    assert.ok(geom.scrollY > 0, `sanity check: the page must actually be scrolled, got scrollY=${geom.scrollY}`);

    assert.ok(
      Math.abs(actualStartX - expectedStartX) <= 2,
      `start X: expected ~${expectedStartX}, got ${actualStartX}`
    );
    assert.ok(
      Math.abs(actualStartY - expectedStartY) <= 2,
      `start Y: expected ~${expectedStartY}, got ${actualStartY}`
    );
    assert.ok(Math.abs(actualEndX - expectedEndX) <= 2, `end X: expected ~${expectedEndX}, got ${actualEndX}`);
    assert.ok(Math.abs(actualEndY - expectedEndY) <= 2, `end Y: expected ~${expectedEndY}, got ${actualEndY}`);
  });

  test('with no mouse movement anywhere on the page, the path still starts at the find bar, not 0,0', async () => {
    // A brand-new tab of the same persistent context: chrome.storage.sync's 'trail'
    // effect selection (set in before()) is already shared, but this tab's content script
    // instance has never received a single mousemove event, so lastMouseX/lastMouseY are
    // genuinely null — the exact scenario a keyboard-only Ctrl+F, Enter user produces.
    const page2 = await ctx.newPage();
    try {
      await page2.goto(origin);
      await openFinder(page2);
      await page2.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page2);

      // Land the match already fully inside the viewport before Enter, same reasoning as
      // test 1: this test is not about scroll-into-view timing, and relying on that native
      // animation's real wall-clock settle time made the wait flaky.
      const targetDocY = await page2.evaluate(() => {
        const r = document.getElementById('target').getBoundingClientRect();
        return r.top + window.scrollY + r.height / 2;
      });
      await page2.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);

      await page2.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
      await page2.keyboard.press('Enter');
      await page2.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });

      const geom = await page2.evaluate(() => {
        const arrow = document.querySelector('.oc-trail-arrow');
        const wrapRect = document.getElementById('oc-wrap').getBoundingClientRect();
        return {
          left: arrow ? arrow.style.left : null,
          top: arrow ? arrow.style.top : null,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          wrapLeft: wrapRect.left,
          wrapTop: wrapRect.top,
          wrapWidth: wrapRect.width,
          wrapHeight: wrapRect.height,
        };
      });

      assert.ok(geom.left && geom.top, 'expected a mounted .oc-trail-arrow arrowhead');
      const actualStartX = parseFloat(geom.left);
      const actualStartY = parseFloat(geom.top);

      assert.ok(
        actualStartX > 5 || actualStartY > 5,
        `path must never start at (0,0), got (${actualStartX}, ${actualStartY})`
      );

      const expectedStartX = geom.wrapLeft + geom.wrapWidth / 2 + geom.scrollX;
      const expectedStartY = geom.wrapTop + geom.wrapHeight / 2 + geom.scrollY;
      assert.ok(
        Math.abs(actualStartX - expectedStartX) <= 2,
        `fallback start X: expected the find bar's centre ~${expectedStartX}, got ${actualStartX}`
      );
      assert.ok(
        Math.abs(actualStartY - expectedStartY) <= 2,
        `fallback start Y: expected the find bar's centre ~${expectedStartY}, got ${actualStartY}`
      );
    } finally {
      await page2.close();
    }
  });

  test('every .oc-beacon element is removed once the effect finishes (no leak)', async () => {
    await replay(page);
    assert.ok(
      (await page.locator('.oc-beacon').count()) > 0,
      'sanity check: the beacon must actually render before checking it is cleaned up'
    );
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('Lite Mode drops the trailing line, keeping only the arrowhead', async () => {
    await replay(page);
    assert.strictEqual(await page.locator('svg.oc-beacon').count(), 1, 'full mode must render the trailing line');
    assert.strictEqual(await page.locator('.oc-trail-arrow').count(), 1, 'full mode must render the arrowhead');

    try {
      await setSettings({ performanceMode: true });
      await replay(page);
      assert.strictEqual(
        await page.locator('svg.oc-beacon').count(),
        0,
        'Lite Mode must drop the trailing line entirely'
      );
      assert.strictEqual(
        await page.locator('.oc-trail-arrow').count(),
        1,
        'Lite Mode must still render the arrowhead alone'
      );
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  // The absorption flash (oculist-3ig): when the arrowhead reaches the match, it fades
  // out into the match itself, which flashes once as if it absorbed the energy. It carries
  // its own 'oc-trail-flash' class (alongside the shared 'oc-beacon' bookkeeping class), so
  // tests identify it independently of its tag — same for the arrowhead's 'oc-trail-arrow'
  // class above.
  const FLASH = '.oc-trail-flash';

  test('the absorption flash mounts over the match rect', async () => {
    // Self-sufficient scroll: this test must not rely on scroll state left over from an
    // earlier test (e.g. test 1's own scrollTo) — without it, running this test in
    // isolation (or after a reorder) would let a missing window.scrollX/Y term in the
    // flash's own positioning pass unnoticed. Scroll here, and condition-poll that it
    // actually landed rather than assuming a synchronous, non-smooth scrollTo.
    //
    // Only scrollY is exercised: the fixture (a single narrow column, no wide content) has
    // no horizontal overflow, so window.scrollTo(x, ...) with x > 0 is clamped back to 0 —
    // widening the page just to exercise scrollX would be contorting the fixture for a
    // dimension the flash's positioning math treats identically to Y.
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });
    const desiredScrollY = await page.evaluate(
      (y) => Math.max(0, y - window.innerHeight / 2),
      targetDocY
    );
    await page.evaluate((y) => window.scrollTo(0, y), desiredScrollY);
    await waitForCondition(() => page.evaluate(() => window.scrollY), (y) => y > 0, {
      timeout: POLL_TIMEOUT,
      message: 'page never actually scrolled before the flash-geometry assertion',
    });

    await replay(page);
    await page.waitForSelector(FLASH, { timeout: POLL_TIMEOUT });

    const geom = await page.evaluate(() => {
      const flash = document.querySelector('.oc-trail-flash');
      const targetRect = document.getElementById('target').getBoundingClientRect();
      return {
        left: flash ? parseFloat(flash.style.left) : null,
        top: flash ? parseFloat(flash.style.top) : null,
        width: flash ? parseFloat(flash.style.width) : null,
        height: flash ? parseFloat(flash.style.height) : null,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        targetLeft: targetRect.left,
        targetTop: targetRect.top,
        targetWidth: targetRect.width,
        targetHeight: targetRect.height,
      };
    });

    assert.ok(geom.left !== null, 'expected a mounted .oc-trail-flash flash element');
    assert.ok(geom.scrollY > 0, `sanity check: the page must actually be scrolled, got scrollY=${geom.scrollY}`);

    const expectedLeft = geom.targetLeft + geom.scrollX;
    const expectedTop = geom.targetTop + geom.scrollY;

    // Expanded a few px past the raw match rect so the glow reads outside the text, not
    // only under it — assert it covers the rect (allowing that expansion) rather than
    // matching it exactly.
    assert.ok(geom.left <= expectedLeft + 1, `flash left ${geom.left} must not start inside the match rect (${expectedLeft})`);
    assert.ok(geom.top <= expectedTop + 1, `flash top ${geom.top} must not start inside the match rect (${expectedTop})`);
    assert.ok(
      geom.left + geom.width >= expectedLeft + geom.targetWidth - 1,
      `flash must extend at least across the match's own width`
    );
    assert.ok(
      geom.top + geom.height >= expectedTop + geom.targetHeight - 1,
      `flash must extend at least across the match's own height`
    );
  });

  test('the absorption flash cannot fire early: its delay equals the travel duration', async () => {
    await replay(page);
    await page.waitForSelector(FLASH, { timeout: POLL_TIMEOUT });

    const timings = await page.evaluate(() => {
      const arrow = document.querySelector('.oc-trail-arrow');
      const flash = document.querySelector('.oc-trail-flash');
      const arrowAnim = arrow.getAnimations()[0];
      const flashAnim = flash.getAnimations()[0];
      return {
        travelDuration: arrowAnim.effect.getTiming().duration,
        flashDelay: flashAnim.effect.getTiming().delay,
      };
    });

    assert.strictEqual(
      timings.flashDelay,
      timings.travelDuration,
      `flash delay (${timings.flashDelay}) must equal the travel duration (${timings.travelDuration}), or it could fire before the arrowhead arrives`
    );
  });

  test('the absorption flash runs exactly one iteration (WCAG 2.3.1 guard)', async () => {
    await replay(page);
    await page.waitForSelector(FLASH, { timeout: POLL_TIMEOUT });

    const iterations = await page.evaluate(() => {
      const flash = document.querySelector('.oc-trail-flash');
      return flash.getAnimations()[0].effect.getTiming().iterations;
    });

    assert.strictEqual(iterations, 1, 'the absorption flash must be a single pulse, never a loop or strobe');
  });

  test('Lite Mode still produces the absorption flash', async () => {
    try {
      await setSettings({ performanceMode: true });
      await replay(page);
      await page.waitForSelector(FLASH, { timeout: POLL_TIMEOUT });
      assert.strictEqual(
        await page.locator(FLASH).count(),
        1,
        'Lite Mode must still render the absorption flash — it is the payoff of the effect'
      );
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('the absorption flash element is removed once its animation finishes (no leak)', async () => {
    await replay(page);
    await page.waitForSelector(FLASH, { timeout: POLL_TIMEOUT });
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: POLL_TIMEOUT });
  });
});
