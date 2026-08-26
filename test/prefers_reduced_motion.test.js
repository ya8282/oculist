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
    await page.waitForTimeout(500);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // Both motion modes mount exactly one top-level .oc-beacon, so counting those tells
  // them apart from nothing. The difference is what lives inside it: the default Anime
  // Laser effect fills its container with ~23 animated parts, the reduced path draws a
  // single static glow box with no children. Count descendants instead.
  //
  // animate() calls cancelBeacons() first, so replaying never accumulates parts.
  const replayAndCount = async () => {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600); // effect built, not yet faded out
    return page.evaluate(() => document.querySelectorAll('.oc-beacon *').length);
  };

  test('flipping the OS preference downgrades the effect without a reload', async () => {
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    await page.waitForTimeout(400);

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
