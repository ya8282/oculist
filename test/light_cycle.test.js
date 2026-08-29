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
const { elementCenterInContainer } = require('./helpers/effect_anchor');

const EXTENSION = path.resolve(__dirname, '../extension');

// Generous enough to absorb sub-pixel float rounding between the effect's own local-canvas
// math and a real getBoundingClientRect() read, tight enough that a 150px whole-effect
// offset (oculist-dvt.7) still fails it by two orders of magnitude.
const ANCHOR_TOLERANCE = 2;

// #target is the text the finder searches for and the beacon fires on. The "before" filler
// is repeated well past what the original geometry tests needed (30) so the match sits deep
// enough in the document (docCenterY ~1000px+) that the oculist-3ak degenerate-geometry test
// below can scroll it down to a viewport-relative position near the bottom of an 800px-tall
// viewport — impossible with a page barely taller than the viewport itself.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; background:#06080D; color:#ccc; }</style>
<p>${'filler words to fill the page and give the light cycle room to run. '.repeat(100)} <span id="target">quarklet</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const WALL = '.oc-lightcycle-wall';
const BOX = '.oc-lightcycle-box';

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

  // Merges `patch` into the nested visionSettings object (e.g. beaconSize) via
  // chrome.storage.sync.set, waiting for content.js's own onChanged listener to actually
  // apply it. Mirrors cyber_vision.test.js / chip_row.test.js's own setVisionSettings.
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

  // Swept across every beaconSize, not just the default 'm': the wall's rendered
  // thickness rides getBeaconScale() (content.js), and a regression that double-applies
  // that scale to the wall's own child-element thickness (oculist-dvt.8) only breaches
  // the "one axis <= 10px" threshold at the larger sizes — 'm' alone stays well inside
  // it either way, so a test that never varies beaconSize cannot catch that bug. One test
  // with an internal loop (not one test per size) because chrome.storage.onChanged only
  // fires on an actual value change: consecutive same-value writes (e.g. a reset to 'm'
  // immediately followed by a fresh test setting 'm' again) would never echo and the wait
  // would time out. Mirrors chip_row.test.js's own beaconSize sweep.
  test('every wall segment is right-angled at every beaconSize: real rendered geometry, never both wide and tall', async () => {
    try {
      for (const size of ['s', 'm', 'l', 'xl']) {
        await setVisionSettings({ beaconSize: size });
        await replay();
        await waitForRunInDone();

        // Read the *actual rendered* bounding box of every wall segment directly off the
        // live DOM (getBoundingClientRect, after the scaleX(1)/scaleY(1) growth keyframe
        // has resolved) — not a flag content.js sets about itself. A segment mutated to
        // carry both a real width and a real height (a diagonal) must fail this,
        // regardless of what any internal bookkeeping claims.
        const rects = await page.evaluate((sel) => {
          return Array.from(document.querySelectorAll(sel)).map((el) => {
            const r = el.getBoundingClientRect();
            return { width: r.width, height: r.height };
          });
        }, WALL);

        assert.ok(rects.length >= 3, `beaconSize="${size}": sanity check: expected at least 3 wall segments in full mode, got ${rects.length}`);

        for (const r of rects) {
          // Sanity: this must be a real, visible segment, not a collapsed zero-size div —
          // otherwise "one dimension is thin" would pass vacuously.
          assert.ok(
            Math.max(r.width, r.height) > 20,
            `beaconSize="${size}": expected a real segment with meaningful length, got width=${r.width}, height=${r.height}`
          );
          // The right-angle assertion itself: one axis must stay thin (the wall's own
          // thickness), the other carries the segment's length. Both axes measuring large
          // at once is exactly what a diagonal segment (both a real width and a real
          // height) would produce — or, at larger beaconSize values, what a wall
          // thickness scaled twice over would produce.
          assert.ok(
            Math.min(r.width, r.height) <= 10,
            `beaconSize="${size}": expected a purely horizontal or purely vertical segment (one axis <= 10px); got width=${r.width}, height=${r.height}`
          );
        }
      }
    } finally {
      // Reset to the shipped default so later tests in this file start from a known size.
      await setVisionSettings({ beaconSize: 'm' });
    }
  });

  // Regression test for oculist-3ak (found reviewing oculist-dvt.8): the MIN_SEG_SEP guard
  // around midYVp/finalYVp used to re-clamp its downward push back to window.innerHeight -
  // 26 — exactly the bound that produced the near-zero gap — so for a match low enough in
  // the viewport that midYVp is pinned there too, the push was a no-op and the connecting
  // (middle, vertical) wall segment collapsed to a ~1px stub (Math.max(len, 1) below).
  //
  // The exact boundary (vpCy landing precisely where finalYVp === window.innerHeight - 26)
  // is a knife-edge: Chrome's actual scrollY lands on an integer, so the realized vpCy is
  // off by a fraction of a pixel from the target, and which side of the boundary it falls on
  // determines whether the buggy branch even triggers (oculist-3ak review: -42 measured as
  // vpCy=749.34 with scrollY=368, landing just outside the buggy window and passing
  // vacuously against the unfixed guard). Target a vpCy a few px inside the buggy window
  // instead of exactly on its edge, so sub-pixel scroll rounding can't push it out: solving
  // vpCy + mh / 2 + 16 === window.innerHeight - 26 gives the boundary at -42; -46 lands ~4px
  // further into the window with margin to spare in both directions.
  test('a match low in the viewport does not collapse the middle wall segment into a stub', async () => {
    const originalScrollY = await page.evaluate(() => window.scrollY);
    try {
      const desiredScrollY = await page.evaluate(() => {
        const r = document.getElementById('target').getBoundingClientRect();
        const mh = r.height;
        const docCenterY = r.top + window.scrollY + mh / 2;
        // -46 (rather than the -42 boundary) lands a few px inside the buggy window so
        // integer scrollY rounding can't land the realized vpCy outside it either way.
        const desiredVpCy = window.innerHeight - 46 - mh / 2;
        return docCenterY - desiredVpCy;
      });
      await page.evaluate((y) => window.scrollTo(0, y), desiredScrollY);
      await waitForCondition(
        () => page.evaluate((y) => Math.abs(window.scrollY - y) < 1, desiredScrollY),
        (landed) => landed,
        { timeout: POLL_TIMEOUT, message: 'page never actually scrolled to the degenerate-geometry position' }
      );

      await replay();
      await waitForRunInDone();

      const rects = await page.evaluate((sel) => {
        return Array.from(document.querySelectorAll(sel)).map((el) => {
          const r = el.getBoundingClientRect();
          return { index: Number(el.getAttribute('data-oc-lc-index')), width: r.width, height: r.height };
        });
      }, WALL);

      assert.ok(rects.length >= 3, `sanity check: expected at least 3 wall segments in full mode, got ${rects.length}`);

      // MIN_SEG_SEP is 12px; the fixed guard should land the connecting segment at (or very
      // near) that floor for this degenerate config, comfortably above the ~1px stub the old
      // no-op guard produced. 8px leaves headroom for pixel rounding while still failing hard
      // against the old stub.
      const MIN_MEANINGFUL_LEN = 8;
      for (const r of rects) {
        const len = Math.max(r.width, r.height);
        assert.ok(
          len >= MIN_MEANINGFUL_LEN,
          `expected every wall segment to have a real length (>= ${MIN_MEANINGFUL_LEN}px) even for a match low in the viewport; got width=${r.width}, height=${r.height}`
        );
      }

      // fullPts is [ (entryXVp,midYVp), (turnXVp,midYVp), (turnXVp,finalYVp), (vpCx,finalYVp) ],
      // so segment index 1 — (turnXVp,midYVp) to (turnXVp,finalYVp) — is the vertical
      // connecting segment between midYVp and finalYVp that the old guard's no-op re-clamp
      // collapsed to a stub. Identify it directly by its data-oc-lc-index rather than relying
      // on the all-segments loop above alone, so a regression in exactly this segment can't
      // hide behind other segments' lengths.
      const middleSegment = rects.find((r) => r.index === 1);
      assert.ok(middleSegment, `expected a wall segment with data-oc-lc-index="1" (the middle connecting segment); got indices ${rects.map((r) => r.index)}`);
      const middleLen = Math.max(middleSegment.width, middleSegment.height);
      assert.ok(
        middleLen >= MIN_MEANINGFUL_LEN,
        `expected the middle connecting wall segment (index 1) to have a real length (>= ${MIN_MEANINGFUL_LEN}px); got width=${middleSegment.width}, height=${middleSegment.height}`
      );
    } finally {
      await page.evaluate((y) => window.scrollTo(0, y), originalScrollY);
    }
  });

  // content.js positions the box's CSS `left`/`top` at (matchEdge - boxPad) and its
  // (content-box) `width`/`height` at (matchSize + 2*boxPad), then draws a boxBorder-wide
  // border OUTSIDE that content box. Because `left`/`top` fix the BORDER box's outer edge
  // (not the content box's), and the border extends the border box's right/bottom edges by
  // 2*boxBorder without moving the pinned left/top, the rendered border box's own centre
  // sits exactly boxBorder px past the match's centre in both axes — real, deterministic
  // box-model geometry, not effect misbehaviour or floating-point noise. Confirmed by
  // running this exact assertion without the boxBorder correction: it fails ~50% of the
  // time under load with dx/dy landing right at boxBorder px, since ANCHOR_TOLERANCE alone
  // sat exactly on that deterministic bias.
  const BOX_BORDER = 2; // matches content.js's box.style.cssText 'border:2px solid ...'

  // The right-angle test above proves every wall segment's *shape* is correct, but not
  // that the wall (and the box it grows in toward) actually terminates on the match: a
  // shared internal anchor bug (e.g. offsetY offset by a constant, oculist-dvt.7) would
  // move the head, every wall segment and the outline box together, leaving the
  // right-angle geometry check — which only measures each segment's own width/height —
  // fully satisfied while the whole effect runs in toward the wrong spot. Unlike Speed
  // Lines/Chrono Tunnel, this needs no extra content.js hook: the outline box is a real
  // positioned DOM element already, so its own rendered centre (mapped into the shared
  // .oc-beacon container's local space, see test/helpers/effect_anchor.js) can be graded
  // directly against the match's own rendered centre plus the known BOX_BORDER bias above,
  // mapped the same way — two independent DOM reads, no internal bookkeeping involved on
  // either side.
  test('the outline box lands on the match: real rendered geometry, not internal bookkeeping', async () => {
    await replay();
    await waitForRunInDone();

    const matchCenter = await elementCenterInContainer(page, '#target', '.oc-beacon');
    const boxCenter = await elementCenterInContainer(page, BOX, '.oc-beacon');

    assert.ok(matchCenter && boxCenter, 'sanity check: expected both #target and the outline box to resolve to real elements');
    const dx = Math.abs(matchCenter.x + BOX_BORDER - boxCenter.x);
    const dy = Math.abs(matchCenter.y + BOX_BORDER - boxCenter.y);
    assert.ok(
      dx <= ANCHOR_TOLERANCE && dy <= ANCHOR_TOLERANCE,
      `expected the outline box to be centred on the match (plus the known ${BOX_BORDER}px border bias) within ${ANCHOR_TOLERANCE}px; ` +
        `match=${JSON.stringify(matchCenter)}, box=${JSON.stringify(boxCenter)} (dx=${dx}px, dy=${dy}px)`
    );
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
