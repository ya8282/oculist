// WAAPI animation leak on cancel (oculist-kqv): a Web Animations API animation does NOT
// stop on its own when its target is detached from the document — verified empirically
// (see cancelBeacons() in content.js): playState stays 'running' and currentTime keeps
// advancing on a removed element unless .cancel() is called explicitly. oculist-dvt.3 wired
// this up for Light Cycle only (container.__waapiAnims + cancelBeacons()'s cancel loop);
// this closes the gap for every other WAAPI-driven effect: animateAnimeLaser, animateIris,
// animateWarpDrive, animateFlame, animatePointingArrows, animateDispersion, animateTrail,
// animateLightning, and drawActiveMatchMagnifier (a companion overlay, not an
// effectsRegistry entry — see content.js).
//
// Needs a real browser: real layout, real WAAPI, and effect/vision-settings selection can
// only be toggled for real through chrome.storage.sync.
//
// One context, one finder session kept open across all tests: each test selects an effect
// via chrome.storage.sync, fires the beacon once, snapshots its
// live Animation objects *before* any cancellation (document.getAnimations() would not
// necessarily include animations on already-detached elements — capturing the references
// while the beacon is still live and holding onto them is what lets the assertions read
// their state after removal), then cancels mid-flight through window.__ocTest.cancelBeacons
// (content.js) — a direct reference to the real closure, exposed purely for test
// reachability (see its own comment in content.js). A real second search reaches the exact
// same cancelBeacons() call, just from inside an animate() that content.js itself only ever
// invokes off a scroll-settle handler or a setTimeout (highlightActiveRange()), never
// synchronously from the keypress that triggered it — driving "cancel mid-flight" through
// simulated keystrokes alone would race that latency instead of testing cancellation itself.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT, TIMEOUT_SCALE } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target is the text the finder searches for and the beacon fires on. Single match only —
// Enter always re-fires the same match (the page has only one occurrence of the search term).
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; background:#06080D; color:#ccc; }</style>
<p>${'filler words to fill the page and give every beacon effect room to run. '.repeat(30)} <span id="target">quarklet</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';

// Every effectsRegistry key that drives at least one WAAPI .animate() call (content.js).
// electron/speedlines/chrono are canvas + requestAnimationFrame driven (cancelBeacons()
// reaches those via __rafId instead) and are deliberately excluded — they are a different
// leak class from the one this bug covers. cybervision was already fixed by oculist-dvt.3
// and is included here as regression coverage alongside the newly-fixed effects.
const WAAPI_EFFECTS = ['hud', 'iris', 'sweep', 'flame', 'lightning', 'arrows', 'dispersion', 'trail', 'cybervision'];

describe('WAAPI beacon animations are genuinely cancelled (not just detached) on every effect', () => {
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

  // chrome.storage.onChanged fires listeners in registration order, so observing our own
  // probe listener fire is a direct proxy for content.js's own listener (registered earlier,
  // at page load) having already applied the change.
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

  // Merges `patch` into the nested visionSettings object (e.g. magnifier) via
  // chrome.storage.sync.set, waiting for content.js's own onChanged listener to actually apply it.
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

  // Fires (or re-fires) the beacon for the currently active match. Enter re-runs
  // findNext()/highlightActiveRange(true) on the same single match this suite's page has,
  // which in content.js schedules animate(freshRect) off a scroll-settle handler or a
  // setTimeout rather than calling it synchronously from the keydown — waitForSelector below
  // absorbs that latency instead of racing it.
  async function fireBeacon() {
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  // Snapshots every live Animation on every element currently under a .oc-beacon container
  // (the container itself and all of its descendants — several effects mount their
  // Animation on a child of the .oc-beacon element cancelBeacons() actually selects, e.g.
  // drawActiveMatchMagnifier's connector). Stashed on window so later reads survive the
  // elements' own removal — proving whether cancellation genuinely stopped the animation,
  // not merely detached its target (see cancelBeacons() in content.js: an uncancelled WAAPI
  // animation keeps playState 'running' and currentTime advancing even after its target
  // element is removed from the document).
  async function snapshotBeaconAnimations() {
    return page.evaluate(() => {
      const beacons = Array.from(document.querySelectorAll('.oc-beacon'));
      const elems = beacons.flatMap((b) => [b, ...b.querySelectorAll('*')]);
      window.__waapiSnapshot = elems.flatMap((el) => el.getAnimations());
      return window.__waapiSnapshot.length;
    });
  }

  function readSnapshotStates() {
    return page.evaluate(() => window.__waapiSnapshot.map((a) => a.playState));
  }

  // Cancels mid-flight via the real cancelBeacons() closure (content.js), exposed at
  // window.__ocTest.cancelBeacons purely for test reachability — see fireBeacon()'s own
  // comment above for why driving this through simulated keystrokes instead would race
  // content.js's own scroll-settle/setTimeout latency rather than testing cancellation.
  async function cancelBeaconsMidFlight() {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
  }

  for (const effectKey of WAAPI_EFFECTS) {
    test(`effect "${effectKey}": cancelBeacons() mid-flight stops every WAAPI animation, not just detaches its element`, async () => {
      await setSettings({ effect: effectKey });
      await fireBeacon();

      const snapshotCount = await snapshotBeaconAnimations();
      assert.ok(snapshotCount > 0, `effect "${effectKey}": sanity check: expected at least one live WAAPI animation under a .oc-beacon element, got 0`);

      const before = await readSnapshotStates();
      assert.ok(
        before.some((s) => s === 'running'),
        `effect "${effectKey}": sanity check: expected at least one animation 'running' before cancellation, got ${JSON.stringify(before)}`
      );

      await cancelBeaconsMidFlight();

      const after = await readSnapshotStates();
      assert.ok(
        after.every((s) => s === 'idle'),
        `effect "${effectKey}": expected every animation to be genuinely cancelled (idle) after cancelBeacons(), got ${JSON.stringify(after)}`
      );
      assert.strictEqual(
        await page.locator('.oc-beacon').count(),
        0,
        `effect "${effectKey}": expected cancelBeacons() to also remove every .oc-beacon element`
      );
    });
  }

  // animateLightning (content.js) schedules a second setTimeout-driven phase (flash/flicker)
  // that guards itself with `if (!container.isConnected) return;` (oculist-kqv) so a container
  // already cancelled/removed by cancelBeacons() before that timer fires never gets new
  // elements or animations appended to it. The generic loop above only asserts on animations
  // that already existed *before* cancellation, so it would still pass even if that guard were
  // deleted -- this closes that gap. document.getAnimations() does not reliably include
  // animations targeting an element that is (or becomes) detached from the document (verified
  // empirically: a freshly-created animation on an already-detached element's descendant does
  // not appear in document.getAnimations() even while genuinely 'running'), so, like
  // snapshotBeaconAnimations()/readSnapshotStates() above, the real check reads the container's
  // own live state directly (its __waapiAnims array length and descendant element count)
  // rather than relying on document.getAnimations() to reflect it.
  function captureLightningContainer() {
    return evalInContentScript(`
      (function () {
        var container = document.querySelector('.oc-beacon');
        window.__ocLightningContainer = container;
        return {
          animCount: (container && container.__waapiAnims) ? container.__waapiAnims.length : 0,
          childCount: container ? container.querySelectorAll('*').length : 0,
        };
      })()
    `);
  }

  function readLightningContainerState() {
    return evalInContentScript(`
      (function () {
        var container = window.__ocLightningContainer;
        return {
          isConnected: container ? container.isConnected : null,
          animCount: (container && container.__waapiAnims) ? container.__waapiAnims.length : 0,
          childCount: container ? container.querySelectorAll('*').length : 0,
        };
      })()
    `);
  }

  test('effect "lightning": cancelBeacons() before the async second phase fires stops it from ever creating new animations on the detached container', async () => {
    try {
      await setSettings({ effect: 'lightning' });
      // 'slow' scales animateLightning's travelDuration (getBeaconDuration(350)) to ~612ms,
      // giving the early cancel below (which happens right after fireBeacon() returns) a wide,
      // deterministic margin ahead of the scheduled second-phase setTimeout in content.js.
      await setVisionSettings({ animationSpeed: 'slow' });
      await fireBeacon();

      // fireBeacon() only waits for .oc-beacon to appear in the DOM, which happens
      // synchronously when the container is first created -- long before the ~612ms
      // second-phase timer elapses -- so capturing state right here is still well inside
      // travelDuration.
      const before = await captureLightningContainer();
      assert.ok(before.animCount > 0, 'sanity check: expected first-phase strike animations to exist before cancellation');

      await cancelBeaconsMidFlight();

      assert.strictEqual(
        await page.locator('.oc-beacon').count(),
        0,
        'expected cancelBeacons() to remove the lightning beacon container immediately'
      );

      // Wait past the scheduled second-phase timeout (travelDuration, ~612ms under 'slow')
      // with headroom, scaled by OCULIST_TEST_TIMEOUT_SCALE (test/helpers/wait.js) so a
      // contended CI box does not read state before that timer would have fired.
      const travelDurationSlowMs = 350 * 1.75; // getBeaconDuration(350) under animationSpeed: 'slow'
      await new Promise((resolve) => setTimeout(resolve, (travelDurationSlowMs + 500) * TIMEOUT_SCALE));

      const after = await readLightningContainerState();
      assert.strictEqual(after.isConnected, false, 'sanity check: the container should remain detached after cancellation');
      assert.strictEqual(
        after.animCount,
        before.animCount,
        `expected no new animations to be created by the async second phase on a cancelled/detached container, got ${before.animCount} -> ${after.animCount}`
      );
      assert.strictEqual(
        after.childCount,
        before.childCount,
        `expected no new elements (flash/flicker) to be appended by the async second phase to a cancelled/detached container, got ${before.childCount} -> ${after.childCount}`
      );

      assert.strictEqual(
        await page.evaluate(() =>
          document
            .getAnimations()
            .filter((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('.oc-beacon')).length
        ),
        0,
        'expected no beacon-related animations left in document.getAnimations()'
      );
      assert.strictEqual(await page.locator('.oc-beacon').count(), 0, 'expected no .oc-beacon element to exist after the wait');
    } finally {
      await setVisionSettings({ animationSpeed: 'normal' });
    }
  });

  // drawActiveMatchMagnifier (content.js) is a companion overlay drawn by drawActiveOverlays()
  // alongside whichever effect is selected, not an effectsRegistry entry itself — it needs
  // its own coverage, gated on visionSettings.magnifier rather than settings.effect.
  test('drawActiveMatchMagnifier: cancelBeacons() mid-flight stops its WAAPI animations, not just detaches its element', async () => {
    try {
      await setSettings({ effect: 'hud' });
      await setVisionSettings({ magnifier: true });
      // visionSettings is one of content.js's OVERLAY_AFFECTING_KEYS, so with an active
      // match already selected (this suite's shared before() plus every WAAPI_EFFECTS test
      // ahead of this one), turning the magnifier on above synchronously redraws it via
      // repositionActiveOverlays() right there in the onChanged handler - before fireBeacon()
      // below ever presses Enter. Left in place, that incidental draw is enough to satisfy
      // fireBeacon()'s own `.oc-beacon` wait, and the test proceeds to cancel while Enter's
      // own (deliberately setTimeout-delayed, see fireBeacon()'s comment) redraw is still
      // pending - which then fires after cancelBeacons() below and resurrects the card.
      // Clearing it here guarantees the beacon fireBeacon() waits for is the one Enter
      // itself produces, not this unrelated settings-change side effect.
      await cancelBeaconsMidFlight();
      await fireBeacon();
      await page.waitForSelector('#oc-active-match-magnifier', { timeout: POLL_TIMEOUT });

      const snapshotCount = await snapshotBeaconAnimations();
      assert.ok(snapshotCount > 0, 'sanity check: expected at least one live WAAPI animation under a .oc-beacon element, got 0');

      const before = await readSnapshotStates();
      assert.ok(
        before.some((s) => s === 'running'),
        `sanity check: expected at least one animation 'running' before cancellation, got ${JSON.stringify(before)}`
      );

      await cancelBeaconsMidFlight();

      const after = await readSnapshotStates();
      assert.ok(
        after.every((s) => s === 'idle'),
        `expected every animation to be genuinely cancelled (idle) after cancelBeacons(), got ${JSON.stringify(after)}`
      );
      assert.strictEqual(
        await page.locator('#oc-active-match-magnifier').count(),
        0,
        'expected cancelBeacons() to also remove the magnifier card element'
      );
    } finally {
      await setVisionSettings({ magnifier: false });
    }
  });
});
