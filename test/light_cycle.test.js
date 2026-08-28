// Light Cycle beacon effect (oculist-dvt.3): a cycle head runs in toward the match on
// right angles only — no curves, no diagonals — leaving a solid glowing wall behind it,
// segment by segment. On arrival the wall holds, a box outline snaps around the match,
// then the wall de-rezzes from the tail forward. First of the two DOM/WAAPI effects in
// the oculist-dvt epic; ships alongside animateTrail, not in place of it.
//
// Needs a real browser for the same reasons as trail_effect.test.js / speed_lines.test.js:
// real layout, real WAAPI, and Lite Mode can only be toggled for real through
// chrome.storage.sync.
//
// One context, one finder session kept open across all tests (mirroring trail_effect.
// test.js / speed_lines.test.js) — settings are changed via direct chrome.storage.sync
// writes from inside the content script's own isolated world, and each test that mutates
// shared state restores it in a `finally` so later tests start clean. The cancellation
// test is deliberately last: it presses Escape, which closes the finder for the rest of
// the suite.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target is the text the finder searches for and the beacon fires on.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; background:#06080D; color:#ccc; }</style>
<p>${'filler words to fill the page and give the light cycle room to run. '.repeat(30)} <span id="target">quarklet</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const WALL = '.oc-lightcycle-wall';

describe('Light Cycle: a right-angle wall of light grows in toward the match, then de-rezzes tail-first', () => {
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

    // Select the Light Cycle effect for the whole suite before ever opening the finder —
    // every test below assumes this baseline.
    await setSettings({ effect: 'lightcycle' });

    await openFinder();
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    // Wait for the draft debounce to actually land a real match count before any test
    // fires the beacon, instead of guessing its duration.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function openFinder() {
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
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

  // Same reasoning as speed_lines.test.js's armSettingsEcho/waitForSettingsEcho/
  // setSettings trio: chrome.storage.onChanged fires listeners in registration order, so
  // observing our own probe listener fire is a direct proxy for content.js's own listener
  // (registered earlier, at page load) having already applied the change.
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
    return waitForContentScriptValue(evalInContentScript, 'window.__ocSettingsEchoes', (v) => v > before, {
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

  // Clears any leftover .oc-beacon nodes, presses Enter to (re-)fire the active beacon
  // (goToNext()/replay path — the only match on the page, so every Enter re-fires the same
  // active match), and waits for a fresh .oc-beacon container to actually exist. animate()
  // calls cancelBeacons() first, so this never accumulates parts across calls.
  async function replay() {
    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  // Waits for content.js's own lightCycleRunInDone flag — flipped from inside each wall
  // segment's real growth Animation's .finished promise, once every segment has actually
  // reached the end of its own scaleX(1)/scaleY(1) keyframe — rather than guessing a
  // timeout and racing this test against the WAAPI schedule. This is a completion signal
  // only (mirrors speedLinesDone/chronoDone); it says nothing about whether the geometry
  // itself is correct, which the caller must still verify independently.
  async function waitForRunInDone() {
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.lightCycleRunInDone', (v) => v === true, {
      timeout: POLL_TIMEOUT,
      message: 'light cycle wall segments never finished growing',
    });
  }

  test('every wall segment is right-angled: real rendered geometry, never both wide and tall', async () => {
    await replay();
    await waitForRunInDone();

    // Read the *actual rendered* bounding box of every wall segment directly off the live
    // DOM (getBoundingClientRect, after the scaleX(1)/scaleY(1) growth keyframe has
    // resolved) — not a flag content.js sets about itself. A segment mutated to carry both
    // a real width and a real height (a diagonal) must fail this, regardless of what any
    // internal bookkeeping claims.
    const rects = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
    }, WALL);

    assert.ok(rects.length >= 3, `sanity check: expected at least 3 wall segments in full mode, got ${rects.length}`);

    for (const r of rects) {
      // Sanity: this must be a real, visible segment, not a collapsed zero-size div —
      // otherwise "one dimension is thin" would pass vacuously.
      assert.ok(
        Math.max(r.width, r.height) > 20,
        `expected a real segment with meaningful length, got width=${r.width}, height=${r.height}`
      );
      // The right-angle assertion itself: one axis must stay thin (the wall's own
      // thickness), the other carries the segment's length. Both axes measuring large at
      // once is exactly what a diagonal segment (both a real width and a real height)
      // would produce.
      assert.ok(
        Math.min(r.width, r.height) <= 10,
        `expected a purely horizontal or purely vertical segment (one axis <= 10px); got width=${r.width}, height=${r.height} — this is what a diagonal segment looks like`
      );
    }
  });

  test('wall segments de-rez in tail-first order, not simultaneously', async () => {
    await replay();

    // Read every wall segment's real, scheduled WAAPI fade-out delay straight off the live
    // Animation objects (Element.getAnimations()), identified by which of an element's
    // animations actually touches opacity — not from any value content.js reports about
    // itself. Animation delay/timing is fixed at creation time, so this needs no waiting
    // and cannot race the animation's own playback.
    const delays = await page.evaluate((sel) => {
      const walls = Array.from(document.querySelectorAll(sel)).sort(
        (a, b) => Number(a.getAttribute('data-oc-lc-index')) - Number(b.getAttribute('data-oc-lc-index'))
      );
      return walls.map((wall) => {
        const anims = wall.getAnimations();
        const fade = anims.find((a) => a.effect.getKeyframes().some((kf) => 'opacity' in kf));
        return fade ? fade.effect.getTiming().delay : null;
      });
    }, WALL);

    assert.ok(delays.length >= 3, `sanity check: expected at least 3 wall segments in full mode, got ${delays.length}`);
    assert.ok(
      delays.every((d) => typeof d === 'number'),
      `expected every wall segment to carry a real fade-out (opacity) animation; got ${JSON.stringify(delays)}`
    );

    // Tail-first: the segment drawn first (index 0, farthest from the match) must be
    // scheduled to start fading strictly before the next segment drawn, and so on. A
    // simultaneous de-rez (every segment sharing one delay) or a reversed order both fail
    // this strict ascending check.
    for (let i = 1; i < delays.length; i++) {
      assert.ok(
        delays[i] > delays[i - 1],
        `expected segment ${i}'s de-rez delay (${delays[i]}) to start strictly after segment ${i - 1}'s (${delays[i - 1]}) — de-rez must proceed tail-first, not simultaneously`
      );
    }
  });

  test('Lite Mode renders a single straight segment', async () => {
    await replay();
    const fullCount = await page.locator(WALL).count();
    assert.ok(fullCount >= 3, `sanity check: expected at least 3 wall segments in full mode, got ${fullCount}`);

    try {
      await setSettings({ performanceMode: true });
      await replay();
      const liteCount = await page.locator(WALL).count();
      assert.strictEqual(liteCount, 1, `expected Lite Mode to render exactly one wall segment, got ${liteCount}`);
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('every .oc-beacon element is removed once the effect finishes (no leak)', async () => {
    await replay();
    assert.ok(
      (await page.locator('.oc-beacon').count()) > 0,
      'sanity check: the beacon must actually render before checking it is cleaned up'
    );
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  // Deliberately last: Escape closes the finder for the rest of the suite (__ocDestroy()
  // calls cancelBeacons()), so no later test can reopen it within this shared session.
  test('cancelBeacons() cancels the live WAAPI animations, not just the DOM (no visual or resource leak)', async () => {
    await replay();

    // Snapshot every live Animation on every piece of this beacon *before* cancelling, so
    // the references survive the DOM removal cancelBeacons() performs — proving whether
    // cancellation genuinely stopped them, not merely detached their targets. Verified
    // separately (see cancelBeacons() in content.js) that a WAAPI animation left uncancelled
    // keeps its playState 'running' and currentTime advancing even after its target element
    // is removed from the document; a bare container.remove() alone would not be enough.
    await page.evaluate((sel) => {
      const walls = Array.from(document.querySelectorAll(sel));
      const head = document.querySelector('.oc-lightcycle-head');
      const box = document.querySelector('.oc-lightcycle-box');
      window.__lcAnimsSnapshot = [...walls, head, box]
        .filter(Boolean)
        .flatMap((el) => el.getAnimations());
    }, WALL);

    const before = await page.evaluate(() => window.__lcAnimsSnapshot.map((a) => a.playState));
    assert.ok(
      before.length > 0 && before.some((s) => s === 'running'),
      `sanity check: expected some animation running before cancellation, got ${JSON.stringify(before)}`
    );

    await page.keyboard.press('Escape'); // -> window.__ocDestroy() -> cancelBeacons()
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: POLL_TIMEOUT });

    const afterStates = await page.evaluate(() => window.__lcAnimsSnapshot.map((a) => a.playState));
    assert.ok(
      afterStates.every((s) => s === 'idle'),
      `expected every animation to be genuinely cancelled (idle) after cancelBeacons(), got ${JSON.stringify(afterStates)}`
    );

    // A cancelled (idle) Animation's currentTime reads null and must not resume advancing —
    // confirm it stays frozen across a short real wait, ruling out "idle now, but ticking
    // again a moment later" false positives.
    const t1 = await page.evaluate(() => window.__lcAnimsSnapshot.map((a) => a.currentTime));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const t2 = await page.evaluate(() => window.__lcAnimsSnapshot.map((a) => a.currentTime));
    assert.deepStrictEqual(t2, t1, `expected cancelled animations to stay frozen; before=${JSON.stringify(t1)}, after=${JSON.stringify(t2)}`);
  });
});
