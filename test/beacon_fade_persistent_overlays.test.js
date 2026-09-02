// oculist-di4: fadeActiveBeacons() (handleScroll's entry point) used to select every
// .oc-beacon element, but drawActiveOverlays() classes the persistent accessibility
// overlays (border/shape/label/magnifier) as .oc-beacon too — so the first scroll after
// a match wiped those out along with the transient beacon effect. Those overlays are
// positioned in document coordinates and track scroll correctly; fading them is pure
// loss, and it lands hardest on exactly the users who turned a thick border on.
//
// The fix tags only the transient beacon effects with an additional
// .oc-beacon-transient marker and has fadeActiveBeacons() select that class instead of
// the broader .oc-beacon. This suite drives borderStyle:'thick' (drawActiveMatchBorder,
// content.js) — a persistent overlay always drawn whenever motion isn't fully off — and
// asserts a real scroll fades the transient beacon while the border survives untouched,
// in both full motion and reduced motion.
//
// Browser-based for the same reason as active_beacons_counter.test.js: fadeActiveBeacons
// and drawActiveMatchBorder are only reachable through the real content script's isolated
// execution context, and a real scroll event only exists in a real browser.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${'filler words to fill the page. '.repeat(30)} <span id="target">quarklet</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('fadeActiveBeacons() fades the transient beacon but leaves the persistent border overlay alone (oculist-di4)', () => {
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

    // hud (Anime Laser) is content.js's own DEFAULTS.effect, but pin it explicitly rather
    // than rely on that.
    await setSettings({ effect: 'hud' });
    // borderStyle 'thick' is the persistent overlay under test — drawActiveMatchBorder()
    // only draws when it is not 'none' (content.js DEFAULTS).
    await setVisionSettings({ borderStyle: 'thick' });

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

    // Give the page scroll room — PAGE's own content fits inside the 800px viewport with
    // nothing left to scroll into otherwise.
    await page.evaluate(() => {
      var spacer = document.createElement('div');
      spacer.style.height = '2000px';
      document.body.appendChild(spacer);
    });
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

  // Same reasoning as active_beacons_counter.test.js's armSettingsEcho/waitForSettingsEcho/
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

  // Fires the beacon fresh, tags the persistent border overlay(s) so they can be told
  // apart from the transient beacon after the DOM churns, and returns how many of each
  // existed right after the draw.
  async function fireAndTagBeacon() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');

    // Waiting on a bare '.oc-beacon' is not enough.
    //
    // The cancelBeacons() above empties the DOM. Which branch this Enter takes depends on
    // the scroll position left by whatever ran before it, not on which call this is: on
    // the first call (the full-motion test above), nothing has scrolled yet and the match
    // is inside the viewport (scrollY=0, target rect top=186.97/bottom=204.97 against
    // innerHeight=800, measured), so highlightActiveRange() takes the fully-in-viewport
    // branch and draws after a flat 50ms setTimeout, never calling triggerAutoScrollFlag()
    // at all. On the second call (reduced motion), that same in-viewport branch fires
    // again (measured: draw lands ~53-77ms in) -- not because nothing has changed, but
    // because the full-motion test's own `finally { window.scrollTo(0, 0) }` (oculist-1rf)
    // restores scrollY to 0 before this test runs, undoing the scroll-to-fade wheeling
    // that would otherwise have left the match out of view. If a future change scrolls the
    // page between these two tests without restoring position afterward, this second call
    // would take the smooth-scroll branch instead and not draw until 'scrollend' fires.
    //
    // (oculist-m8u corrected this block. It used to assert the smooth-scroll branch and a
    // ~360ms scrollend wait for the second call, which was true when oculist-xj4 wrote it
    // and stopped being true when oculist-1rf added the scroll restore above -- a correct
    // hygiene fix silently falsifying a correct comment. Hence the rule rather than the
    // branch name.)
    //
    // Either way, animate() (content.js) does its cancelBeacons()-plus-redraw in one
    // synchronous task -- drawActiveOverlays() and the effect itself (run(), or
    // animateReducedMotion() on the reduced-motion path) both append their elements
    // before that task yields -- so waiting for one persistent overlay AND one transient
    // beacon to both be present is already the settled state; there is no partially-drawn
    // DOM state in between to wait out.
    //
    // (An earlier version of this comment blamed a vision-settings change for leaving a
    // ~390ms hole with nothing drawn. That was wrong: oculist-2c5 measured the settings
    // path and found it removes and redraws in a single script turn, never dropping a
    // frame. The delay is the smooth-scroll wait above, and the empty window is this
    // helper's own cancelBeacons().)
    //
    // (A still-earlier version of this comment also said 'scrollend' fired TWICE, ~47ms
    // apart, so animate()'s cancelBeacons()-plus-redraw ran a second time right after the
    // first draw and this helper had to wait out that second churn cycle too, via a
    // MutationObserver-based quiet-period wait. That was wrong twice over: oculist-7k0
    // (commit 03d7f97) found the double draw was never a doubled native 'scrollend' --
    // that listener is {once:true} and cannot re-fire -- but an orphaned
    // scrollDebounceTimer, and made onScrollEnd idempotent so a scrolled navigation now
    // draws exactly once. oculist-r1w then measured the churn observer directly across
    // repeated runs of both tests below and found both elements appended in one batch,
    // ~50ms after cancelBeacons(), with no further ADDS -- the only later mutation is the
    // fade's own removal. There is no second churn cycle left to
    // wait out, so the quiet-period wait was removed.)
    await page.waitForFunction(
      () =>
        document.querySelector('.oc-beacon:not(.oc-beacon-transient)') &&
        document.querySelector('.oc-beacon-transient'),
      null,
      { timeout: POLL_TIMEOUT }
    );

    return page.evaluate(() => {
      var persistent = Array.from(document.querySelectorAll('.oc-beacon:not(.oc-beacon-transient)'));
      var transient = Array.from(document.querySelectorAll('.oc-beacon-transient'));
      persistent.forEach(function (el, i) {
        el.setAttribute('data-oc-fade-test-persistent', String(i));
      });
      return { persistentCount: persistent.length, transientCount: transient.length };
    });
  }

  async function scrollAndWaitForTransientGone() {
    // fadeActiveBeacons() (handleScroll's entry point) sets opacity:0 with a 50ms
    // transition on .oc-beacon-transient elements, then removes them once that
    // transition lands.
    //
    // handleScroll() drops every scroll while isAutoScrolling is set, and content.js sets
    // that for 800ms each time highlightActiveRange() takes its out-of-viewport branch to
    // bring a match on screen; a wheel landing inside that window would be silently
    // ignored and nothing would fade. Keep scrolling like a user, rather than sending one
    // wheel and asserting immediately, so this stays correct even when that window is
    // live. Rather than sleep past a fixed duration (hard-coding a constant this test does
    // not own), keep scrolling until the fade actually starts. A genuine failure to fade
    // still fails, by exhausting the deadline.
    //
    // (An earlier version of this comment said firing the beacon above "just did" scroll
    // a match into view, engaging that 800ms window. oculist-m8u measured that neither
    // fireAndTagBeacon() call above does that today: both land via highlightActiveRange()'s
    // fully-in-viewport branch -- scrollY=0 and the target rect, top=186.97/bottom=204.97,
    // already inside the 800px viewport at both calls -- so triggerAutoScrollFlag() is
    // never reached and isAutoScrolling is never engaged that way. The repeated-wheel loop
    // below is not guarding against a hazard that exists today; it costs nothing when the
    // fade starts on the very first wheel, and stays correct if a future change ever
    // leaves the match out of view when the beacon fires.)
    // oculist-67h: POLL_TIMEOUT (5000ms) is this suite's budget for a SINGLE poll, but it
    // was bounding this whole loop of wheel-plus-400ms-poll round trips. LONG_TIMEOUT
    // (15000ms) is the constant the rest of the suite already uses for multi-round-trip
    // waits on this same assertion -- see chrono_tunnel.test.js and speed_lines.test.js,
    // both waiting on '.oc-beacon' removal -- so it belongs here instead. Measured cost of
    // the loop is 1 iteration and 77-117ms, so this is a correctness-of-constant fix with
    // headroom for contention, NOT a fix for the 5s timeout this bead was filed about;
    // that stall was ~50x the measured cost and came from concurrent npm test runs.
    const deadline = Date.now() + LONG_TIMEOUT;
    for (;;) {
      await page.mouse.wheel(0, 400);
      try {
        await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
          timeout: 400,
        });
        return;
      } catch (e) {
        if (Date.now() >= deadline) {
          throw new Error('the transient beacon never faded after repeated real scrolls');
        }
      }
    }
  }

  // WAAPI-driven overlays (drawActiveMatchBorder's fade-in) never write their final
  // opacity back to el.style — that inline attribute stays at its pre-animation value
  // forever, only fadeActiveBeacons() itself ever sets it explicitly. So "survived" means
  // still attached to the document with a non-zero rendered (computed) opacity, not a
  // check of the inline style.
  async function persistentSurvived() {
    return page.evaluate(() => {
      var tagged = Array.from(document.querySelectorAll('[data-oc-fade-test-persistent]'));
      if (tagged.length === 0) return false;
      return tagged.every(function (el) {
        return el.isConnected && parseFloat(getComputedStyle(el).opacity) > 0;
      });
    });
  }

  test('full motion: scroll fades the transient beacon but the thick border overlay survives', async () => {
    try {
      const before = await fireAndTagBeacon();
      assert.strictEqual(
        await evalInContentScript('window.__ocTest.getEffectiveMotion()'),
        'full',
        'this test only means anything on the full-motion branch'
      );
      assert.ok(before.persistentCount > 0, 'expected the thick border overlay to be drawn');
      assert.ok(before.transientCount > 0, 'expected the transient beacon effect to be drawn');

      await scrollAndWaitForTransientGone();

      assert.ok(
        await persistentSurvived(),
        'the persistent border overlay must survive a scroll while the transient beacon is faded'
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('reduced motion: scroll fades the transient beacon but the thick border overlay survives', async () => {
    await setVisionSettings({ motionSensitivity: 'reduced' });
    assert.strictEqual(
      await evalInContentScript('window.__ocTest.getEffectiveMotion()'),
      'reduced',
      'this test only means anything on the reduced-motion branch'
    );

    const before = await fireAndTagBeacon();
    assert.ok(before.persistentCount > 0, 'expected the thick border overlay to be drawn under reduced motion');
    assert.ok(before.transientCount > 0, 'expected the reduced-motion transient beacon to be drawn');

    await scrollAndWaitForTransientGone();

    assert.ok(
      await persistentSurvived(),
      'the persistent border overlay must survive a scroll under reduced motion too'
    );
  });
});
