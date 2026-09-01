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

// #target is the text the finder searches for and the beacon fires on. min-height gives the
// scroll-robustness test below (oculist-gor) real room to scroll the page underneath the
// beacon; it doesn't move #target or change anything the other tests in this suite assert
// on.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; background:#06080D; color:#ccc; min-height: 1600px; }</style>
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
      // previous run (see replay() above): '.oc-beacon' is removed in frame()'s own
      // completion branch (content.js, oculist-ws4 — mirroring animateChronoTunnel's
      // oculist-3ae fix), synchronously in the same tick that flips speedLinesDone to true.
      // That means by the time any external poll (a separate CDP round trip) ever observes
      // speedLinesDone === true, the container has always already been detached — even
      // capturing a rect at the exact moment 'done' is observed is already too late. The
      // container's CSS position never changes after it's created (position:absolute, fixed
      // left/top/transform for its whole life), so content.js instead captures its rect once,
      // right after it's appended to the document (see lastSpeedLinesContainerRect in
      // content.js) — long before completion, or an intervening cancelBeacons()/
      // fadeActiveBeacons() removal, can possibly happen. Reading that captured rect here
      // instead of re-querying '.oc-beacon' removes the race structurally.
      // '#target' itself is never touched by content.js and is safe to query live at any time.
      //
      // Both sides of this comparison must live in the SAME coordinate space, and it must be
      // one that cannot go stale between the capture above and this read: content.js stores
      // lastSpeedLinesContainerRect in DOCUMENT coordinates (its viewport rect at capture
      // time plus the scroll offset at that same instant), so '#target' is converted to
      // document coordinates the same way here — its live viewport rect plus the CURRENT
      // scroll offset, read in the same round trip as the rect itself so nothing can scroll
      // in between. Document coordinates for a statically-positioned element never change
      // with scrolling, so this holds regardless of how much the page has scrolled since the
      // container was captured.
      const result = await evalInContentScript(`
        (function () {
          var el = document.querySelector('#target');
          var containerRect = window.__ocTest.lastSpeedLinesContainerRect;
          var independent = null;
          if (el && containerRect) {
            var r = el.getBoundingClientRect();
            var docLeft = r.left + window.scrollX;
            var docTop = r.top + window.scrollY;
            independent = { x: docLeft + r.width / 2 - containerRect.left, y: docTop + r.height / 2 - containerRect.top };
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

  // Scroll-robustness (oculist-gor): lastSpeedLinesContainerRect is captured once, right
  // after the container is appended, and stored in DOCUMENT coordinates precisely so that a
  // scroll happening any time afterwards cannot desync it from a live read taken later (see
  // the capture site in content.js). This test forces exactly that gap: it fires the beacon
  // while scrolled to SCROLL_AT_CAPTURE (so the capture happens away from scrollY=0, where a
  // stale viewport-relative rect would otherwise coincidentally equal its document-coordinate
  // value), then scrolls further to a *different* offset, SCROLL_AT_READ, before rerunning the
  // same atomic frames/draws/highlightY/independent check the Lite Mode test above uses.
  // Against a pre-fix version that stored a viewport-relative rect, this fails with a dy
  // roughly equal to (SCROLL_AT_READ - SCROLL_AT_CAPTURE); against the fix, both sides are in
  // document coordinates and the scroll delta cancels out.
  test('the centre-line highlight anchor check survives a scroll between capture and read', async () => {
    const SCROLL_AT_CAPTURE = 150;
    const SCROLL_AT_READ = 550;
    await page.evaluate((y) => window.scrollTo(0, y), SCROLL_AT_CAPTURE);
    try {
      await replay();
      await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesFrameCount', (v) => v >= 2, {
        timeout: POLL_TIMEOUT,
        message: 'speed lines never rendered its first frames',
      });

      // This fixture sets no 'scroll-behavior', so the scroll resolves instantly and
      // scrollY is already updated by the time this evaluate() round trip returns -- no
      // separate scroll-settle wait is needed. Note the two-argument form is NOT
      // unconditionally instant: it uses behavior 'auto', which does consult CSS
      // 'scroll-behavior'. On a page that sets 'smooth' this would need a settle wait.
      await page.evaluate((y) => window.scrollTo(0, y), SCROLL_AT_READ);

      // oculist-a96: this used to wait for window.__ocTest.speedLinesDone, but that hook
      // reflects the rAF loop's own completion, which has nothing to do with what this test
      // actually checks (the highlight's document-coordinate maths across an intervening
      // scroll) -- it was never load-bearing here. Pre-oculist-qii it happened to flip true
      // anyway, because fadeActiveBeacons() removed the beacon's DOM on scroll without
      // cancelling its rAF loop, so the loop kept ticking on the orphaned, detached canvas
      // until it hit its own finish line. Once oculist-qii makes fadeActiveBeacons() cancel
      // that loop atomically with removal, completion is no longer reachable after a scroll,
      // and this wait would become an outright 15s timeout instead.
      //
      // What this test needs is confirmed directly by content.js's capture sites:
      // lastSpeedLinesContainerRect is written once, synchronously, during animateSpeedLines()'s
      // setup -- before its first rAF frame runs -- and is never touched again for the rest of
      // the beacon's life. lastSpeedLinesHighlightY is set during that same setup, before the
      // first frame; frame() does rewrite it every frame, but always to the same fixed value
      // (the local `highlightY = offsetY`, which never changes across the beacon's run), so its
      // value is already settled by setup and cannot drift afterward. Both hooks are therefore
      // already populated by the frameCount >= 2 wait above, well before the second scrollTo();
      // this poll is a safety margin against the CDP round trip, not a wait for animation
      // progress.
      await waitForContentScriptValue(
        evalInContentScript,
        '!!(window.__ocTest.lastSpeedLinesContainerRect && window.__ocTest.lastSpeedLinesHighlightY != null)',
        (v) => v === true,
        {
          timeout: POLL_TIMEOUT,
          message: 'centre-line highlight anchor hooks never populated after the scroll',
        }
      );

      const result = await evalInContentScript(`
        (function () {
          var el = document.querySelector('#target');
          var containerRect = window.__ocTest.lastSpeedLinesContainerRect;
          var independent = null;
          if (el && containerRect) {
            var r = el.getBoundingClientRect();
            var docLeft = r.left + window.scrollX;
            var docTop = r.top + window.scrollY;
            independent = { x: docLeft + r.width / 2 - containerRect.left, y: docTop + r.height / 2 - containerRect.top };
          }
          return {
            frames: window.__ocTest.speedLinesFrameCount,
            draws: window.__ocTest.speedLinesHighlightDrawCount,
            highlightY: window.__ocTest.lastSpeedLinesHighlightY,
            independent: independent
          };
        })()
      `);

      assert.ok(result.frames > 0, 'sanity check: expected at least one frame to have rendered');
      assert.strictEqual(
        result.draws,
        result.frames,
        `expected the highlight to draw on every frame despite the intervening scroll; frames=${result.frames}, highlightDraws=${result.draws}`
      );
      assert.ok(result.independent, 'sanity check: expected both #target and .oc-beacon to resolve to real elements');
      const dy = Math.abs(result.highlightY - result.independent.y);
      assert.ok(
        dy <= ANCHOR_TOLERANCE,
        `expected the centre-line highlight to still match the match's real rendered vertical centre within ` +
          `${ANCHOR_TOLERANCE}px after scrolling from ${SCROLL_AT_CAPTURE}px to ${SCROLL_AT_READ}px between capture ` +
          `and read; highlightY=${result.highlightY}, independent=${JSON.stringify(result.independent)} (dy=${dy}px)`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
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

  // oculist-ws4: animateSpeedLines used to remove its container from an independently-timed
  // setTimeout(DUR) fired right after the first rAF, exactly like animateChronoTunnel did
  // before oculist-3ae fixed it there — that timer consistently fired a frame before the
  // loop's own completion, so one more frame() ran against an already-detached container,
  // stale-frame-inflating whatever __ocTest hooks a later run had by then installed. Moved
  // to frame()'s own completion branch (mirroring oculist-3ae) so removal is strictly after
  // the last frame that will ever run, by construction. This pins a MutationObserver
  // (isolated content-script world, so it can read window.__ocTest directly) to the exact
  // instant the container is removed from the DOM and records speedLinesFrameCount at that
  // instant — then positively confirms the counter never advances past that recorded value,
  // the same grew/timeout pattern the cancelBeacons() test below uses. Against a version that
  // still used the independent setTimeout(DUR), this fails: the recorded value is one frame
  // short of the final count, so the counter is later observed to grow past it.
  test('the container is removed only after the rAF loop\'s own final frame, never before', async () => {
    await replay();
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesFrameCount', (v) => v >= 2, {
      timeout: POLL_TIMEOUT,
      message: 'speed lines never rendered its first frames',
    });

    // Armed in the isolated content-script world (not page.evaluate()'s main world) so the
    // observer callback can read window.__ocTest directly — that hook lives only in the
    // isolated world's own global, not the page's.
    await evalInContentScript(`
      (function () {
        window.__ocWs4RemovalFrameCount = null;
        var mo = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var removed = records[i].removedNodes;
            for (var j = 0; j < removed.length; j++) {
              var node = removed[j];
              if (node.nodeType === 1 && node.classList && node.classList.contains('oc-beacon-transient')) {
                window.__ocWs4RemovalFrameCount = window.__ocTest.speedLinesFrameCount;
                mo.disconnect();
                return;
              }
            }
          }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      })()
    `);

    const atRemoval = await waitForContentScriptValue(
      evalInContentScript,
      'window.__ocWs4RemovalFrameCount',
      (v) => v !== null,
      { timeout: LONG_TIMEOUT, message: 'the container was never observed being removed from the DOM' }
    );
    assert.ok(atRemoval > 0, `sanity check: expected a nonzero frame count at the removal instant, got ${atRemoval}`);

    // Positively confirm the frame counter never grows past its value at the removal
    // instant: wait (up to the same POLL_TIMEOUT budget used everywhere else in this suite)
    // for it to exceed that value. If removal genuinely happens strictly after the last
    // frame, that wait times out — the success case here — rather than resolving.
    let grew = false;
    try {
      await waitForContentScriptValue(
        evalInContentScript,
        'window.__ocTest.speedLinesFrameCount',
        (v) => v > atRemoval,
        { timeout: POLL_TIMEOUT }
      );
      grew = true;
    } catch (e) {
      if (!/timed out/.test(e.message)) throw e;
    }
    assert.strictEqual(
      grew,
      false,
      `expected speedLinesFrameCount to never advance past its value (${atRemoval}) at the moment the container was removed from the DOM`
    );
  });

  // oculist-47e: animateSpeedLines' early-return guard (rect missing or zero-sized) used to
  // sit BEFORE every __ocTest hook was touched, so a skipped run left all ten hooks holding
  // whatever the previous real run had last written. A test polling speedLinesDone === true
  // would then resolve immediately off that stale prior-run flag and grade every other hook
  // against the same stale run, never surfacing that the current run never fired at all --
  // the same class of bug oculist-viv found for lastSpeedLinesContainerRect alone. This runs
  // a real beacon first (so every hook holds genuine, non-default data), captures that
  // state, then drives the guard through the extension's own normal call path -- no
  // synthetic rect, no test-only export of the effect renderer itself. Six of the ten hooks
  // (lastSpeedLinesContainerRect/lastSpeedLinesLaneBounds/lastSpeedLinesAnchor/
  // lastSpeedLinesHighlightY reset to null, speedLinesDone to false, and
  // lastSpeedLinesStreakCount to 0 -- never legitimately 0, since a real run assigns it
  // 20 or 74 synchronously before it could be observed) are unambiguous "this
  // run produced nothing" sentinels a real run never writes back into at setup. The
  // remaining four (speedLinesFrameCount/lastSpeedLinesLaneAlphaMax/
  // lastSpeedLinesElseAlphaMax/speedLinesHighlightDrawCount) reset to 0, which a REAL run
  // also holds momentarily at its own setup before its first frame -- 0 alone cannot
  // distinguish "skipped" from "started, first frame not drawn yet", so those four are safe
  // to read only because speedLinesDone gates every consumer (asserted last, below).
  test('a skipped run (zero-size rect) resets every hook instead of leaving the previous run\'s data', async () => {
    await replay();
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.speedLinesDone', (v) => v === true, {
      timeout: LONG_TIMEOUT,
      message: 'speed lines beacon never reached its final frame',
    });

    const readHooks = `
      ({
        containerRect: window.__ocTest.lastSpeedLinesContainerRect,
        streakCount: window.__ocTest.lastSpeedLinesStreakCount,
        frameCount: window.__ocTest.speedLinesFrameCount,
        laneAlphaMax: window.__ocTest.lastSpeedLinesLaneAlphaMax,
        elseAlphaMax: window.__ocTest.lastSpeedLinesElseAlphaMax,
        laneBounds: window.__ocTest.lastSpeedLinesLaneBounds,
        anchor: window.__ocTest.lastSpeedLinesAnchor,
        highlightY: window.__ocTest.lastSpeedLinesHighlightY,
        highlightDrawCount: window.__ocTest.speedLinesHighlightDrawCount,
        done: window.__ocTest.speedLinesDone
      })
    `;

    const before = await evalInContentScript(readHooks);

    // Sanity check: the real run above must have actually left every hook holding real
    // data -- otherwise the assertions below could pass vacuously against an
    // already-default value instead of proving the guard resets anything.
    assert.ok(before.containerRect, 'sanity check: expected a real container rect from the prior run');
    assert.ok(before.streakCount > 0, 'sanity check: expected a nonzero streak count from the prior run');
    assert.ok(before.frameCount > 0, 'sanity check: expected a nonzero frame count from the prior run');
    assert.ok(before.laneAlphaMax > 0, 'sanity check: expected a nonzero lane alpha max from the prior run');
    assert.ok(before.elseAlphaMax > 0, 'sanity check: expected a nonzero else alpha max from the prior run');
    assert.ok(before.laneBounds, 'sanity check: expected lane bounds from the prior run');
    assert.ok(before.anchor, 'sanity check: expected an anchor from the prior run');
    assert.strictEqual(typeof before.highlightY, 'number', 'sanity check: expected a numeric highlightY from the prior run');
    assert.ok(before.highlightDrawCount > 0, 'sanity check: expected a nonzero highlight draw count from the prior run');
    assert.strictEqual(before.done, true, 'sanity check: expected the prior run to have completed');

    // Drive the SAME early-return guard through the extension's real, normal call path
    // instead of a synthetic rect or an exported test-only closure. Make the already-active
    // match's own element genuinely zero-sized -- font-size:0 is verified (in real
    // Chromium) to yield a getBoundingClientRect of {width:0, height:0} while the element
    // stays display:inline/visibility:visible, so it remains indexed and remains the active
    // match; no chip/term change is needed. Then re-fire that SAME active match exactly the
    // way replay() above does (cancelBeacons() + Enter): findNext() ->
    // highlightActiveRange(true) -> animate(freshRect) in content.js reaches this guard
    // with a rect read fresh off the real DOM at fire time, not a manufactured one.
    await page.evaluate(() => { document.querySelector('#target').style.fontSize = '0'; });
    try {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.keyboard.press('Enter');

      // No '.oc-beacon' will ever appear -- the guard returns before the container is
      // created -- so this cannot reuse replay()'s own waitForSelector('.oc-beacon'). Poll
      // speedLinesFrameCount specifically instead: it can only go from the prior run's
      // nonzero value back to 0 by this reset running, since no real run is possible once
      // the element is zero-sized.
      const after = await waitForContentScriptValue(evalInContentScript, readHooks, (v) => v.frameCount === 0, {
        timeout: POLL_TIMEOUT,
        message: 'the zero-size-match run never reset speedLinesFrameCount',
      });

      assert.strictEqual(
        after.containerRect,
        null,
        `expected a skipped run to null out lastSpeedLinesContainerRect instead of leaving the prior run's ${JSON.stringify(before.containerRect)}`
      );
      assert.strictEqual(
        after.streakCount,
        0,
        `expected a skipped run to zero lastSpeedLinesStreakCount instead of leaving the prior run's ${before.streakCount}`
      );
      assert.strictEqual(
        after.frameCount,
        0,
        `expected a skipped run to zero speedLinesFrameCount instead of leaving the prior run's ${before.frameCount}`
      );
      assert.strictEqual(after.laneAlphaMax, 0, 'expected a skipped run to zero lastSpeedLinesLaneAlphaMax');
      assert.strictEqual(after.elseAlphaMax, 0, 'expected a skipped run to zero lastSpeedLinesElseAlphaMax');
      assert.strictEqual(
        after.laneBounds,
        null,
        `expected a skipped run to null out lastSpeedLinesLaneBounds instead of leaving the prior run's ${JSON.stringify(before.laneBounds)}`
      );
      assert.strictEqual(
        after.anchor,
        null,
        `expected a skipped run to null out lastSpeedLinesAnchor instead of leaving the prior run's ${JSON.stringify(before.anchor)}`
      );
      assert.strictEqual(
        after.highlightY,
        null,
        `expected a skipped run to null out lastSpeedLinesHighlightY instead of leaving the prior run's ${before.highlightY}`
      );
      assert.strictEqual(
        after.highlightDrawCount,
        0,
        `expected a skipped run to zero speedLinesHighlightDrawCount instead of leaving the prior run's ${before.highlightDrawCount}`
      );
      // The load-bearing assertion: a test that polls speedLinesDone === true to detect
      // completion must NOT be satisfied by a skipped run. Leaving this false means such a
      // wait times out loudly instead of resolving off the prior run's stale true.
      assert.strictEqual(
        after.done,
        false,
        "expected a skipped run to leave speedLinesDone false rather than reporting the prior run's stale completion"
      );
    } finally {
      await page.evaluate(() => { document.querySelector('#target').style.fontSize = ''; });
    }
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
