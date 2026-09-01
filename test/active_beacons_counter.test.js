// oculist-5rv: animate() incremented activeBeacons BEFORE calling the selected effect's
// run(rect) — but every effectsRegistry entry opens run(rect) with the identical
// `if (!rect || rect.width === 0 || rect.height === 0) return;` guard (audited across all
// twelve registered effects; see the ponytail comment in content.js's animate()), so a
// zero-metric rect drew nothing while still leaving the counter incremented with no
// matching decrement. activeBeacons is only ever compared to 0 and reset to 0
// (cancelBeacons() zeroes it; fadeActiveBeacons(), on the unthrottled scroll path, checks
// it before running document.querySelectorAll('.oc-beacon')), so the concrete cost was one
// wasted querySelectorAll per leaked increment — fadeActiveBeacons() zeroes the flag again
// as soon as it finds no beacons — not suppressed beacons, not an exhausted cap. The fix
// gates the increment in animate() on that same zero-rect condition, so the counter only
// ever counts a run that could actually draw. run() is still called unconditionally:
// animateSpeedLines() relies on being invoked even on a guard-skipped rect to reset its
// own __ocTest hooks (oculist-47e).
//
// Reachable in production: buildPageIndex only skips display:none/visibility:hidden, so a
// font-size:0 span is still indexed and still matched, yielding a real zero-Range rect on
// every navigation to it — exactly the fixture this suite drives.
//
// Browser-based for the same reason as speed_lines.test.js / prefers_reduced_motion.test.js:
// activeBeacons is a module-private closure variable, only reachable through the real
// content script's isolated execution context via CDP, and real getBoundingClientRect()
// zero-sizing (font-size:0) only exists in a real layout engine.
//
// oculist-9t5: the reduced-motion branch in animate() returns before ever reaching the
// effectsRegistry activeBeacons++ site above, so a reduced-motion beacon left the counter
// at 0 while a real .oc-beacon sat in the DOM. fadeActiveBeacons() (handleScroll's entry
// point) opens with `if (activeBeacons === 0) return;`, so it short-circuited before ever
// fading a reduced-motion beacon out on scroll — not a permanent artifact (cancelBeacons()
// still clears it on the next search/navigation), but a real asymmetry with the
// full-motion path's scroll-fade. History check: the reduced-motion branch (oculist-l6m's
// VA-01..VA-09 suite) was bolted onto animate() three weeks after activeBeacons/
// fadeActiveBeacons already existed (fb666b53 predates 823dfb8), with no comment and no
// wiring into either — the same shape of oversight oculist-5rv later fixed for the
// zero-rect case, not a documented accessibility decision. The fix raises the flag on the
// reduced-motion site too, guarded by the identical zero-rect condition as the
// full-motion site (oculist-5rv).
//
// One shared context/session across all four tests, run in a fixed order:
// (b) normal-size run first (establishes the counter actually increments on a real draw
// and leaves a real .oc-beacon behind for the next test to observe being cleared), then
// (a) the zero-size regression case, then (c) and (d) reduced motion (independent of the
// other two, placed last so they can leave visionSettings changed without needing to
// restore it for a later test in this file).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${'filler words to fill the page. '.repeat(30)} <span id="target">quarklet</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('activeBeacons counter: incremented only on a run that can actually draw (oculist-5rv)', () => {
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
    // than rely on that — the guard being tested sits on animate()'s single activeBeacons++
    // site, so it applies identically no matter which effect is selected; only one is
    // needed to exercise it.
    await setSettings({ effect: 'hud' });

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

  // Same reasoning as speed_lines.test.js's armSettingsEcho/waitForSettingsEcho/setSettings
  // trio: chrome.storage.onChanged fires listeners in registration order, so observing our
  // own probe listener fire is a direct proxy for content.js's own listener (registered
  // earlier, at page load) having already applied the change.
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

  // Same as setSettings above, but merges into the nested visionSettings object instead of
  // replacing top-level keys (settings.visionSettings.motionSensitivity is what
  // effectiveMotion() reads).
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

  test('(b) a normal-size match increments activeBeacons to 1 and actually draws a beacon', async () => {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });

    const count = await evalInContentScript('window.__ocTest.getActiveBeacons()');
    assert.strictEqual(count, 1, `expected a real draw to leave activeBeacons at 1, got ${count}`);

    const beaconCount = await page.evaluate(() => document.querySelectorAll('.oc-beacon').length);
    assert.ok(beaconCount > 0, 'expected at least one .oc-beacon element to exist after a real draw');
  });

  test('(a) a guard-skipped run on a zero-size match leaves activeBeacons at 0 instead of leaking an unmatched increment', async () => {
    // Precondition from the previous test: a real .oc-beacon element exists and
    // activeBeacons === 1. Deliberately do NOT call window.__ocTest.cancelBeacons() here —
    // this test needs to observe THIS SPECIFIC animate() call's own cancelBeacons() (its
    // first statement) doing the reset, as proof that call actually ran and completed,
    // since a guard-skipped run leaves no other DOM trace (drawActiveMatchBorder/
    // drawActiveMatchLabel/drawActiveMatchShape/drawActiveMatchMagnifier all guard on the
    // same zero-rect check). Everything between cancelBeacons() and the counter's final
    // value in animate() is synchronous (no await/setTimeout/Promise in between), so once
    // the pre-existing beacon is observed removed, the whole call has already settled.
    const preCount = await page.evaluate(() => document.querySelectorAll('.oc-beacon').length);
    assert.ok(preCount > 0, 'sanity check: expected the prior real beacon to still be in the DOM');

    // font-size:0 is verified (in real Chromium) to yield a getBoundingClientRect of
    // {width:0, height:0} while the element stays display:inline/visibility:visible, so it
    // remains indexed and remains the active match (same technique as speed_lines.test.js's
    // oculist-47e regression case) — no chip/term change needed.
    await page.evaluate(() => { document.querySelector('#target').style.fontSize = '0'; });
    try {
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });

      const count = await evalInContentScript('window.__ocTest.getActiveBeacons()');
      assert.strictEqual(
        count,
        0,
        `expected a guard-skipped (zero-size) run to leave activeBeacons at 0, got ${count} — a leaked increment with no matching draw`
      );
    } finally {
      await page.evaluate(() => { document.querySelector('#target').style.fontSize = ''; });
    }
  });

  test('(c) the reduced-motion path raises activeBeacons on a real draw, same as full motion (oculist-9t5)', async () => {
    await setVisionSettings({ motionSensitivity: 'reduced' });

    // Explicit reset (rather than relying on test (a) having left it at 0) so this
    // assertion is unambiguous regardless of test run order within this file.
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');

    // animateReducedMotion() draws its own static box, also classed .oc-beacon (see
    // prefers_reduced_motion.test.js: "Both motion modes mount exactly one top-level
    // .oc-beacon").
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });

    const count = await evalInContentScript('window.__ocTest.getActiveBeacons()');
    assert.strictEqual(
      count,
      1,
      `expected the reduced-motion path's own animate() call site (guarded by the same ` +
        `zero-rect condition as the full-motion site, oculist-5rv) to raise activeBeacons ` +
        `to 1 on a real draw, got ${count} — without this, fadeActiveBeacons() short-circuits ` +
        `on the scroll path and a reduced-motion beacon is never faded out (oculist-9t5)`
    );
  });

  test('(d) a reduced-motion beacon is faded out on scroll, same as a full-motion one (oculist-9t5)', async () => {
    // Deliberately no setVisionSettings() call here: chrome.storage.sync.set() does not
    // fire onChanged for a write that doesn't actually change the stored value, so
    // re-asserting motionSensitivity: 'reduced' (already set by test (c), immediately
    // before this one) would hang waitForSettingsEcho(). Relies on (c) leaving
    // visionSettings in 'reduced' — see the header comment on why (c)/(d) are ordered
    // last and share that state.
    //
    // Because that reliance is invisible, assert it outright. Run under a name filter
    // that skips (c), or reorder/rename (c), and this test would otherwise still pass
    // green while silently exercising the FULL-motion path instead — a false green on
    // the one property it exists to check.
    const mode = await evalInContentScript('window.__ocTest.getEffectiveMotion()');
    assert.strictEqual(
      mode,
      'reduced',
      `this test only means anything on the reduced-motion branch, but animate() would take ` +
        `the ${JSON.stringify(mode)} branch — test (c) must run first and leave motionSensitivity set`
    );

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });

    const preCount = await evalInContentScript('window.__ocTest.getActiveBeacons()');
    assert.strictEqual(preCount, 1, `sanity check: expected activeBeacons to be 1 before scrolling, got ${preCount}`);

    try {
      // PAGE's own content fits inside the 800px viewport with nothing left to scroll
      // (by design — none of the other tests in this file need scroll room), so a wheel
      // event here would be a no-op without extra height to scroll into.
      await page.evaluate(() => {
        var spacer = document.createElement('div');
        spacer.style.height = '2000px';
        document.body.appendChild(spacer);
      });

      // fadeActiveBeacons() (handleScroll's entry point) sets opacity:0 with a 50ms
      // transition, then removes the element once that transition lands.
      //
      // The timeout here is deliberately far below the reduced-motion beacon's own
      // lifetime (2500ms for the arrows+spotlight variant, 3000ms for the plain glow):
      // those runs self-remove on their WAAPI anim.finished, so a generous POLL_TIMEOUT
      // would be satisfied by natural completion and this wait would pass with or without
      // the fade. Keeping it under a second means only the scroll-triggered fade can
      // satisfy it.
      const FADE_TIMEOUT = 1000;
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, {
        timeout: FADE_TIMEOUT,
      });

      const postCount = await evalInContentScript('window.__ocTest.getActiveBeacons()');
      assert.strictEqual(
        postCount,
        0,
        `expected fadeActiveBeacons() to zero activeBeacons and remove the reduced-motion ` +
          `beacon on scroll, got ${postCount}`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });
});
