// Speed Lines beacon effect (oculist-dvt.1): horizontal light streaks blasting outward
// from the match toward both viewport edges, additive-blended on a canvas — the anime
// speed-line idiom, hue derived from getEffectiveColors().beacon. Ported from the approved
// beacon-bench.html reference geometry (tiers, gradient stops, outward ease, clear lane,
// flare); this suite is about the real-page adaptations that geometry needed and the
// beacon contract every effect must honour.
//
// Needs a real browser for the same reasons as dispersion_bloom.test.js /
// trail_effect.test.js: a real <canvas> and a real layout only exist in real Chromium, and
// Lite Mode can only be toggled for real through chrome.storage.sync.
//
// One context, one finder session kept open across all four tests (mirroring
// dispersion_bloom.test.js) — settings are changed via direct chrome.storage.sync writes
// from inside the content script's own isolated world, and each test that mutates shared
// state restores it in a `finally` so later tests start clean. The cancellation test is
// deliberately last: it presses Escape, which closes the finder for the rest of the suite.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { elementCenterInContainer } = require('./helpers/effect_anchor');

const EXTENSION = path.resolve(__dirname, '../extension');

// Generous enough to absorb sub-pixel float rounding between the effect's own local-canvas
// math and a real getBoundingClientRect() read, tight enough that the 200px whole-effect
// offset this test exists to catch (oculist-dvt.7) still fails it by two orders of
// magnitude.
const ANCHOR_TOLERANCE = 2;

// #target is the text the finder searches for and the beacon fires on.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; background:#06080D; color:#ccc; }</style>
<p>${'filler words to fill the page and give the streak field room to spread. '.repeat(30)} <span id="target">quarklet</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('Speed Lines: horizontal streak field radiating from the match', () => {
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

    // Select the Speed Lines effect for the whole suite before ever opening the finder —
    // every test below assumes this baseline.
    await setSettings({ effect: 'speedlines' });

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
        // Intentional unscaled sub-poll: the scaled waitForSelector below surfaces
        // the real timeout error if all 20 attempts fail.
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

  // Same reasoning as dispersion_bloom.test.js's armSettingsEcho/waitForSettingsEcho/
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

  // Cancels any still-running previous beacon through the extension's own cancellation
  // path (window.__ocTest.cancelBeacons(), the exact function animate() itself calls first —
  // see cancelBeacons() in content.js), then presses Enter to (re-)fire the active beacon
  // (goToNext()/replay path — the only match on the page, so every Enter re-fires the same
  // active match), and waits for a fresh .oc-beacon container to actually exist.
  //
  // This used to rip the previous run's .oc-beacon nodes out of the DOM directly
  // (document.querySelectorAll('.oc-beacon').forEach(el => el.remove())) instead of going
  // through cancelBeacons(). cancelBeacons() finds its targets via querySelectorAll('.oc-
  // beacon') too, so once the test had already removed those nodes itself, animate()'s own
  // cancelBeacons() call (content.js's very first statement on every replay) found nothing
  // left to cancel — the previous run's rAF loop (hung off the now-detached container's own
  // __rafId) kept ticking forever against a node no longer in the document. That orphaned
  // loop would eventually reach its own final frame and flip window.__ocTest.speedLinesDone
  // to true — potentially AFTER the new run had already reset that same flag to false at its
  // own start — so a later wait for speedLinesDone could observe the stale previous run's
  // completion instead of the current run's, and read state while the current run was still
  // mid-flight (oculist-viv). Routing through the real cancelBeacons() here instead means the
  // previous run's nodes are still present in the DOM at the moment it runs (this always
  // fires before the new Enter press, not after), so it genuinely cancels the outstanding
  // rAF/WAAPI work and removes the nodes itself, exactly as a second real search would.
  // Calling it here even when nothing is left to cancel is harmless: cancelBeacons() itself
  // simply finds zero .oc-beacon nodes and no-ops.
  async function replay() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  test('streaks crossing the match text band are attenuated to a clear lane', async () => {
    await replay();

    // Deliberately not pixel sampling. The old version of this test polled the live canvas
    // with its own independent requestAnimationFrame loop, racing the content script's own
    // rAF loop for a chance to rasterise the canvas at a lucky instant — under parallel test
    // load that second poller could be starved down to a frame or two, at which point
    // whatever the canvas happened to show (often near-empty, early- or late-envelope) was
    // meaningless to compare. Instead, content.js's own frame() loop accumulates the running
    // maximum post-attenuation alpha it actually applied to lane-crossing vs. other streaks,
    // on window.__ocTest.lastSpeedLinesLaneAlphaMax/lastSpeedLinesElseAlphaMax — no second
    // rAF consumer, no canvas rasterisation, no getImageData. speedLinesDone flips once the
    // run reaches its final frame, so waiting for it (a plain isolated-world value poll, not
    // a page-side rAF race) is a deterministic completion signal regardless of how many
    // frames the effect actually got to draw under load.
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesDone', (v) => v === true, {
      timeout: LONG_TIMEOUT,
      message: 'speed lines beacon never reached its final frame',
    });

    const laneMax = await evalInContentScript('window.__ocTest.lastSpeedLinesLaneAlphaMax');
    const elseMax = await evalInContentScript('window.__ocTest.lastSpeedLinesElseAlphaMax');
    const laneBounds = await evalInContentScript('window.__ocTest.lastSpeedLinesLaneBounds');

    assert.ok(
      elseMax > 0.05,
      `sanity check: expected visible streak alpha away from the lane at some point during the animation, got elseMax=${elseMax}`
    );
    // laneMax and elseMax are both classified and graded by the same `inLane` test in
    // content.js, so on their own they only prove "whatever got labelled in-lane was
    // dimmer" — not that the lane actually sits over the match. An emptied lane leaves
    // laneMax at its initial 0, which would otherwise satisfy the comparison below
    // vacuously. Require it to have actually recorded an attenuated streak first.
    assert.ok(
      laneMax > 0,
      `expected the lane to have attenuated at least one streak (laneMax stuck at 0 means no streak was ever classified in-lane); laneBounds=${JSON.stringify(laneBounds)}`
    );
    // Pin *where* the lane is, independent of the multiplier check below: the match's own
    // vertical centre (matchY, same local canvas-y space as laneTop/laneBot) must fall
    // inside the lane bounds content.js actually attenuated against. This is what catches a
    // lane shifted away from the word while still leaving the multiplier and both alpha
    // maxes internally consistent.
    assert.ok(
      laneBounds.matchY >= laneBounds.top && laneBounds.matchY <= laneBounds.bot,
      `expected the clear lane to bracket the match's vertical centre; laneBounds=${JSON.stringify(laneBounds)}`
    );
    // Attenuation multiplies in-lane alpha by ~0.12; density is also weighted toward the
    // match's own line, so an unattenuated field would make the lane the *brightest* area,
    // not merely comparable. A generous 50% threshold still fails hard if the attenuation
    // line is removed.
    assert.ok(
      laneMax < elseMax * 0.5,
      `expected the lane to be measurably dimmer than the rest of the field; laneMax=${laneMax}, elseMax=${elseMax}`
    );
  });

  // The clear-lane test above pins that lastSpeedLinesLaneBounds brackets the match — but
  // that assertion, and every other one in this suite, is graded entirely against values
  // content.js reports about itself. A shared internal anchor bug (e.g. offsetY offset by a
  // constant, oculist-dvt.7) shifts the lane, the streak field and the flare together,
  // which leaves every internally-anchored assertion self-consistent while the whole beacon
  // fires away from the word. This test grades window.__ocTest.lastSpeedLinesAnchor against
  // an independent source of truth instead: the match's own rendered position, read
  // straight off the DOM (see test/helpers/effect_anchor.js).
  test("the effect's own reported anchor matches where the match actually renders", async () => {
    await replay();

    const anchor = await evalInContentScript('window.__ocTest.lastSpeedLinesAnchor');
    const independent = await elementCenterInContainer(page, '#target', '.oc-beacon');

    assert.ok(independent, 'sanity check: expected both #target and .oc-beacon to resolve to real elements');
    const dx = Math.abs(anchor.matchX - independent.x);
    const dy = Math.abs(anchor.matchY - independent.y);
    assert.ok(
      dx <= ANCHOR_TOLERANCE && dy <= ANCHOR_TOLERANCE,
      `expected the effect's own reported anchor to match the match's real rendered position within ${ANCHOR_TOLERANCE}px; ` +
        `anchor=${JSON.stringify(anchor)}, independent=${JSON.stringify(independent)} (dx=${dx}px, dy=${dy}px)`
    );
  });

  // Centre-line highlight (oculist-s0t): a persistent horizontal locator at the match's own
  // vertical centre, on top for the effect's full duration. Same independent-truth approach
  // as the anchor test above — content.js's own lastSpeedLinesHighlightY hook is graded
  // against the match's real rendered position via elementCenterInContainer, not against
  // any other value content.js reports about itself.
  test("the centre-line highlight renders at the match's vertical centre, verified independently", async () => {
    await replay();
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesFrameCount', (v) => v >= 2, {
      timeout: POLL_TIMEOUT,
      message: 'speed lines never rendered its first frames',
    });

    const highlightY = await evalInContentScript('window.__ocTest.lastSpeedLinesHighlightY');
    const independent = await elementCenterInContainer(page, '#target', '.oc-beacon');

    assert.ok(independent, 'sanity check: expected both #target and .oc-beacon to resolve to real elements');
    const dy = Math.abs(highlightY - independent.y);
    assert.ok(
      dy <= ANCHOR_TOLERANCE,
      `expected the centre-line highlight to sit at the match's real rendered vertical centre within ${ANCHOR_TOLERANCE}px; ` +
        `highlightY=${highlightY}, independent=${JSON.stringify(independent)} (dy=${dy}px)`
    );
  });

  // Persistence: the highlight must be part of every single frame from the effect's start to
  // its finish, not just an early flourish that fades with the burst. speedLinesFrameCount
  // and speedLinesHighlightDrawCount are incremented together, once per real frame, from the
  // same frame() call in content.js — so if they still match at both an early sample and the
  // final (speedLinesDone) sample, the highlight drew on literally every frame in between,
  // with no separate rAF race or pixel sample needed. Both counters in a sample are read with
  // a single evalInContentScript round trip (not two) so the effect's own rAF loop cannot
  // advance a frame in between the two reads and manufacture a false mismatch.
  async function readFrameAndDrawCounts() {
    return evalInContentScript(
      '({ frames: window.__ocTest.speedLinesFrameCount, draws: window.__ocTest.speedLinesHighlightDrawCount })'
    );
  }

  test('the centre-line highlight persists for the full effect duration, not just a moment', async () => {
    await replay();
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesFrameCount', (v) => v >= 2, {
      timeout: POLL_TIMEOUT,
      message: 'speed lines never rendered its first frames',
    });
    const early = await readFrameAndDrawCounts();
    assert.strictEqual(
      early.draws,
      early.frames,
      `expected the highlight to have drawn on every frame so far; frames=${early.frames}, highlightDraws=${early.draws}`
    );

    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesDone', (v) => v === true, {
      timeout: LONG_TIMEOUT,
      message: 'speed lines beacon never reached its final frame',
    });
    const late = await readFrameAndDrawCounts();
    assert.ok(
      late.frames > early.frames,
      `sanity check: expected more frames to have run by completion than at the early sample; early=${early.frames}, late=${late.frames}`
    );
    assert.strictEqual(
      late.draws,
      late.frames,
      `expected the highlight to still be drawing on every frame through to completion, not fading out early; frames=${late.frames}, highlightDraws=${late.draws}`
    );
  });

  // Lite Mode drops the streak count and the tier-2 bloom halos, but the centre-line
  // highlight is the accessibility locator itself, not decoration — it must stay, just
  // without its own soft-glow pass.
  test('Lite Mode still draws the centre-line highlight on every frame', async () => {
    try {
      await setSettings({ performanceMode: true });
      await replay();
      await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesDone', (v) => v === true, {
        timeout: LONG_TIMEOUT,
        message: 'speed lines beacon never reached its final frame in Lite Mode',
      });
      // Two races were stacked here (oculist-viv). First: frames and draws read as two
      // SEPARATE round trips off a live, still-running rAF loop, so a frame could land in
      // between them and manufacture a false mismatch — closed by reading
      // frames/draws/highlightY/independent-anchor together in one atomic evaluation, right
      // when 'done' is observed, the same way readFrameAndDrawCounts() already does for its
      // own early/late samples in the persistence test above.
      //
      // Second, and the one that actually mattered once replay() genuinely cancelled the
      // previous run (see replay() above): '.oc-beacon' is removed by an independent
      // wall-clock setTimeout(DUR) in content.js. Measuring the actual firing order showed
      // that timer reliably wins the race against the rAF loop's own final "done" tick — that
      // tick can only run on the next vsync-aligned callback at-or-after elapsed>=DUR, while
      // the timer fires right at DUR — so even capturing a rect at the exact moment
      // speedLinesDone flips true was already too late; the container was already gone. The
      // container's CSS position never changes after it's created (position:absolute, fixed
      // left/top/transform for its whole life), so content.js now captures its rect once,
      // right after it's appended to the document (see lastSpeedLinesContainerRect in
      // content.js) — long before either the completion tick or the removal timer can
      // possibly fire, not at the finish line where the race was already lost. Reading that
      // captured rect here instead of re-querying '.oc-beacon' removes the race structurally.
      // '#target' itself is never touched by content.js and is safe to query live at any time.
      const result = await evalInContentScript(`
        (function () {
          var el = document.querySelector('#target');
          var containerRect = window.__ocTest.lastSpeedLinesContainerRect;
          var independent = null;
          if (el && containerRect) {
            var r = el.getBoundingClientRect();
            independent = { x: r.left + r.width / 2 - containerRect.left, y: r.top + r.height / 2 - containerRect.top };
          }
          return {
            frames: window.__ocTest.speedLinesFrameCount,
            draws: window.__ocTest.speedLinesHighlightDrawCount,
            highlightY: window.__ocTest.lastSpeedLinesHighlightY,
            independent: independent
          };
        })()
      `);
      assert.ok(result.frames > 0, 'sanity check: expected at least one frame to have rendered in Lite Mode');
      assert.strictEqual(
        result.draws,
        result.frames,
        `expected the highlight to draw on every frame in Lite Mode too; frames=${result.frames}, highlightDraws=${result.draws}`
      );

      assert.ok(result.independent, 'sanity check: expected both #target and .oc-beacon to resolve to real elements');
      const dy = Math.abs(result.highlightY - result.independent.y);
      assert.ok(
        dy <= ANCHOR_TOLERANCE,
        `expected the Lite Mode highlight to still sit at the match's real vertical centre within ${ANCHOR_TOLERANCE}px; ` +
          `highlightY=${result.highlightY}, independent=${JSON.stringify(result.independent)} (dy=${dy}px)`
      );
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('Lite Mode draws materially fewer streaks than full mode', async () => {
    await replay();
    const fullCount = await evalInContentScript('window.__ocTest.lastSpeedLinesStreakCount');
    assert.ok(fullCount > 40, `sanity check: expected a large full-mode streak count, got ${fullCount}`);

    try {
      await setSettings({ performanceMode: true });
      await replay();
      const liteCount = await evalInContentScript('window.__ocTest.lastSpeedLinesStreakCount');
      assert.ok(
        liteCount < fullCount / 2,
        `expected Lite Mode to draw materially fewer streaks than full mode; full=${fullCount}, lite=${liteCount}`
      );
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
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: LONG_TIMEOUT });
  });

  // Deliberately last: Escape closes the finder for the rest of the suite (__ocDestroy()
  // calls cancelBeacons()), so no later test can reopen it within this shared session.
  test('cancelBeacons() stops the rAF loop mid-flight (proves container.__rafId is wired)', async () => {
    await replay();

    // Let a couple of real frames render first, so a stuck-at-zero counter can't pass by
    // accident.
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesFrameCount', (v) => v >= 2, {
      timeout: POLL_TIMEOUT,
      message: 'speed lines never rendered its first frames',
    });

    await page.keyboard.press('Escape'); // -> window.__ocDestroy() -> cancelBeacons()
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: POLL_TIMEOUT });

    const afterCancel = await evalInContentScript('window.__ocTest.speedLinesFrameCount');

    // Positively confirm the frame counter never grows again: wait (up to the same
    // POLL_TIMEOUT budget used everywhere else in this suite) for it to exceed its
    // post-cancellation value. If cancelBeacons() actually cancelled the rAF loop, that
    // wait times out — which is the success case here — rather than resolving.
    let grew = false;
    try {
      await waitForContentScriptValue(
        evalInContentScript,
        'window.__ocTest.speedLinesFrameCount',
        (v) => v > afterCancel,
        { timeout: POLL_TIMEOUT }
      );
      grew = true;
    } catch (e) {
      if (!/timed out/.test(e.message)) throw e;
    }
    assert.strictEqual(
      grew,
      false,
      `expected the rAF loop to have stopped after cancelBeacons(); frame count kept growing past ${afterCancel}`
    );
  });
});
