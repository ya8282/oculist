// oculist-mg3: Oculist honoured its own motionSensitivity setting but ignored the
// OS-level prefers-reduced-motion query, so a user who had asked their system to
// reduce motion still got the full beacon effect until they found the extension
// setting. effectiveMotion() now downgrades 'full' to 'reduced' when the OS asks.
//
// Browser-based for the same reason as resize_overlays.test.js: JSDOM has no
// matchMedia emulation and no layout, so neither branch would be exercised.
//
// One context, flipping the emulated preference in place — half the browser launches
// (these suites run concurrently and starve each other otherwise), and it additionally
// proves the query is read live rather than latched once at content-script load.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${'filler words to fill the page. '.repeat(40)} <span id="target">quarklet</span></p>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('prefers-reduced-motion downgrades the beacon effect', () => {
  let server, ctx, page, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all. Same note as resize_overlays.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
      reducedMotion: 'no-preference',
    });

    page = await ctx.newPage();
    await page.goto(origin);
    await page.waitForLoadState('load');
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // No CDP session in this file, so there is no isolatedContextId to poll for injection
  // readiness — retry Control+f itself (a keypress a not-yet-attached listener would
  // otherwise silently swallow) until the input actually appears, instead of guessing a
  // fixed delay.
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

  // Both motion modes mount exactly one top-level .oc-beacon, so counting those tells
  // them apart from nothing. The difference is what lives inside it: the default Anime
  // Laser effect fills its container with ~23 animated parts, the reduced path draws a
  // single static glow box with no children. Count descendants instead.
  //
  // animate() calls cancelBeacons() first, so replaying never accumulates parts. Enter's
  // effect only actually builds once highlightActiveRange()'s own deferred setTimeout
  // fires (50ms in-viewport path, or up to 600ms for the scroll-settle path) — wait for
  // the beacon container to actually exist (its descendants are built in the same
  // synchronous effect.run() call, so no separate wait is needed for those) instead of
  // guessing "built, not yet faded out" as a wall-clock number.
  const replayAndCount = async () => {
    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
    return page.evaluate(() => document.querySelectorAll('.oc-beacon *').length);
  };

  test('flipping the OS preference downgrades the effect without a reload', async () => {
    await openFinder();
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    // Wait for the draft debounce to actually land (a real match count) before pressing
    // Enter, instead of guessing its duration.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    const full = await replayAndCount();
    assert.ok(
      full > 5,
      `expected the default effect to build a multi-part beacon, got ${full} parts — ` +
        `if the default effect changed, this test no longer proves anything`
    );

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await replayAndCount();
    assert.ok(
      reduced < full,
      `prefers-reduced-motion should downgrade to the reduced effect, but it drew ` +
        `${reduced} beacon parts vs ${full} with no preference`
    );

    // Downgrade-only: clearing the preference restores the full effect.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const restored = await replayAndCount();
    assert.ok(
      restored > reduced,
      `clearing the OS preference should restore the full effect, got ${restored} parts`
    );
  });
});
