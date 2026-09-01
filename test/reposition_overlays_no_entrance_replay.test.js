// Regression (oculist-rrn): repositionActiveOverlays() (content.js) is the shared entry
// point for both a window resize and an overlay-affecting vision-settings change
// (borderStyle/textLabels/motionSensitivity/magnifier — see the OVERLAY_AFFECTING_KEYS
// storage listener in content.js). Neither of those events actually moves the match
// relative to the page, so the fix's own comment on repositionActiveOverlays() says it
// deliberately does not replay the transient beacon effect on either path. But before the
// fix it still tore down and RE-CREATED the accessibility overlays themselves (border/
// label/magnifier), and every one of those constructors starts at opacity:0 and plays a
// fresh WAAPI entrance (drawActiveMatchBorder's 200ms fade, drawActiveMatchMagnifier's
// 320ms zoom-lift) — so the match indicator blinked to invisible and ramped back in on
// every settings tweak and every resize.
//
// This suite proves the fix without waiting out any animation duration: drawActiveMatch
// Border()/Magnifier() call .animate() synchronously, in the same script turn as creating
// the element, so a MutationObserver microtask firing right after the element is appended
// already sees whether an entrance Animation was created at all. Before the fix that
// count is always >=1 (the fade/lift Animation just started) with computed opacity still
// ~0; after the fix (skipEntrance) no Animation is created and the element is already at
// its final opacity — a deterministic distinction that does not race real frame timing.
//
// Needs a real browser for the same reasons as active_match_magnifier.test.js/
// resize_overlays.test.js: real layout and the real Web Animations API don't exist in
// jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; } .col { width: 60%; }</style>
<div class="col"><p>${'filler words to push things around. '.repeat(60)} <span id="target">quarklet</span> ${'more filler to keep the paragraph long. '.repeat(60)}</p></div>`;

const INPUT = '#oc-wrap >> .oc-input';
const MAGNIFIER = '#oc-active-match-magnifier';

describe('repositionActiveOverlays() does not replay the accessibility overlays\' entrance (oculist-rrn)', () => {
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
    await waitForIsolatedContext();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function waitForIsolatedContext() {
    const deadline = Date.now() + POLL_TIMEOUT;
    while (!isolatedContextId) {
      if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

  // Writes straight through chrome.storage.sync from inside the content script's own
  // isolated world (the same path the popup takes under the hood), merging into
  // visionSettings. Deliberately does not wait for anything beyond the write itself
  // landing — callers poll for the redraw's own observable effect (the entrance probe)
  // instead of a chrome.storage.onChanged echo.
  function setVisionSettings(patch) {
    return evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var vs = Object.assign({}, current.visionSettings || {}, ' + JSON.stringify(patch) + ');' +
        'var next = Object.assign({}, current, { visionSettings: vs });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
  }

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

  async function searchAndSettle() {
    await page.locator(INPUT).fill('quarklet');
    // Wait for the draft debounce to actually land a real match count before firing,
    // instead of guessing its duration.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
    await page.keyboard.press('Enter');
  }

  // The initial Enter above can take a smooth-scroll path whose 'scrollend' handler fires
  // twice (oculist-7k0, out of scope here — see beacon_fade_persistent_overlays.test.js's
  // fireAndTagBeacon() for the same issue), which runs animate()'s cancelBeacons()-plus-
  // full-redraw a second time shortly after the first. Arming the entrance probe in that
  // gap would let it catch the tail end of that genuine first-draw entrance instead of the
  // settings/resize-driven redraw this suite actually tests. Wait for `.oc-beacon` churn to
  // go quiet before arming anything, so only the redraw under test is observed.
  async function waitForBeaconChurnToSettle() {
    await page.evaluate(() => {
      window.__ocChurnAt = performance.now();
      if (window.__ocChurnObserver) window.__ocChurnObserver.disconnect();
      window.__ocChurnObserver = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of [...r.addedNodes, ...r.removedNodes]) {
            if (n.classList && n.classList.contains('oc-beacon')) {
              window.__ocChurnAt = performance.now();
              return;
            }
          }
        }
      });
      window.__ocChurnObserver.observe(document.documentElement, { childList: true, subtree: true });
    });
    const QUIET_MS = 250;
    await page.waitForFunction((quiet) => performance.now() - window.__ocChurnAt > quiet, QUIET_MS, {
      timeout: POLL_TIMEOUT,
    });
  }

  // Arms a MutationObserver that watches for the next `.oc-beacon` element matching
  // `matchFn` to be appended anywhere under <html>, and records — synchronously inside
  // that same microtask, before any animation frame paints — whether a WAAPI Animation
  // already exists on it and what its computed opacity is at that instant. Only the first
  // matching node is recorded (later, unrelated churn from the same redraw must not
  // overwrite it).
  async function armEntranceProbe(matchFnBody) {
    await page.evaluate((matchFnBody) => {
      if (window.__ocEntranceObserver) window.__ocEntranceObserver.disconnect();
      window.__ocEntranceProbe = null;
      // eslint-disable-next-line no-new-func
      const matchFn = new Function('n', matchFnBody);
      window.__ocEntranceObserver = new MutationObserver((records) => {
        if (window.__ocEntranceProbe) return;
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType === 1 && matchFn(n)) {
              window.__ocEntranceProbe = {
                animCount: n.getAnimations().length,
                opacity: parseFloat(getComputedStyle(n).opacity),
              };
              return;
            }
          }
        }
      });
      window.__ocEntranceObserver.observe(document.documentElement, { childList: true });
    }, matchFnBody);
  }

  async function waitForEntranceProbe() {
    await page.waitForFunction(() => window.__ocEntranceProbe !== null, null, { timeout: POLL_TIMEOUT });
    return page.evaluate(() => window.__ocEntranceProbe);
  }

  // The persistent border overlay has no id and is the only non-transient `.oc-beacon`
  // drawn under these settings (magnifier/textLabels off, default palette so
  // drawActiveMatchShape declines).
  const BORDER_MATCH_FN = "return n.classList && n.classList.contains('oc-beacon') && " +
    "!n.classList.contains('oc-beacon-transient') && !n.id;";
  const MAGNIFIER_MATCH_FN = "return n.id === 'oc-active-match-magnifier';";

  test('a vision-settings change redraws the border overlay without replaying its fade-in', async () => {
    await setVisionSettings({ borderStyle: 'thick', magnifier: false, textLabels: false, motionSensitivity: 'full' });
    await openFinder();
    await searchAndSettle();
    await page.waitForSelector('.oc-beacon:not(.oc-beacon-transient)', { timeout: POLL_TIMEOUT });
    await waitForBeaconChurnToSettle();

    await armEntranceProbe(BORDER_MATCH_FN);
    await setVisionSettings({ borderStyle: 'thin' });
    const probe = await waitForEntranceProbe();

    assert.strictEqual(
      probe.animCount,
      0,
      'the redrawn border must not carry a fresh entrance Animation — it should be drawn straight at its final opacity'
    );
    assert.ok(
      probe.opacity > 0.99,
      `the redrawn border's computed opacity must already be full the instant it lands, got ${probe.opacity}`
    );
  });

  test('a vision-settings change redraws the magnifier without replaying its zoom-lift entrance', async () => {
    await setVisionSettings({ borderStyle: 'none', magnifier: true, textLabels: false, motionSensitivity: 'full' });
    await openFinder();
    await searchAndSettle();
    await page.waitForSelector(MAGNIFIER, { timeout: POLL_TIMEOUT });
    await waitForBeaconChurnToSettle();

    await armEntranceProbe(MAGNIFIER_MATCH_FN);
    // Any overlay-affecting settings change reaches repositionActiveOverlays() the same
    // way — this one also happens to newly draw the border, which is fine: the probe only
    // watches for the magnifier's own re-creation.
    await setVisionSettings({ borderStyle: 'thick' });
    const probe = await waitForEntranceProbe();

    assert.strictEqual(
      probe.animCount,
      0,
      'the redrawn magnifier must not carry a fresh zoom-lift Animation on a settings-driven redraw'
    );
    assert.ok(
      probe.opacity > 0.99,
      `the redrawn magnifier's computed opacity must already be full the instant it lands, got ${probe.opacity}`
    );
  });

  test('a window resize redraws the border overlay without replaying its fade-in', async () => {
    await setVisionSettings({ borderStyle: 'thick', magnifier: false, textLabels: false, motionSensitivity: 'full' });
    await openFinder();
    await searchAndSettle();
    await page.waitForSelector('.oc-beacon:not(.oc-beacon-transient)', { timeout: POLL_TIMEOUT });
    await waitForBeaconChurnToSettle();

    await armEntranceProbe(BORDER_MATCH_FN);
    // handleResize() (content.js) debounces 100ms before calling repositionActiveOverlays().
    await page.setViewportSize({ width: 900, height: 800 });
    const probe = await waitForEntranceProbe();

    assert.strictEqual(
      probe.animCount,
      0,
      'a resize-driven border redraw must not carry a fresh entrance Animation'
    );
    assert.ok(
      probe.opacity > 0.99,
      `a resize-driven border redraw's computed opacity must already be full the instant it lands, got ${probe.opacity}`
    );

    // Restore the viewport so later tests in this file see the same layout they expect.
    await page.setViewportSize({ width: 1200, height: 800 });
  });
});
