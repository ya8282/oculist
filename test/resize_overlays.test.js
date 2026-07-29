// Regression: in Low Vision the active-match overlays (thick border + "Match #n of m"
// label) are absolutely positioned in document coordinates from a one-shot rect. A
// window resize reflows the page and moves the match, and before the fix the overlays
// stayed behind at their old coordinates.
//
// This has to run in a real browser: the overlays are a layout bug, and JSDOM (what the
// other suites use) has no layout — every getBoundingClientRect is zeros.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');

// Percentage width + long filler means the target word rewraps to a different place
// when the viewport narrows, which is exactly the reflow that stranded the overlays.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; }
  .col { width: 60%; margin: 40px auto; }
</style>
<div class="col">
  <p>${'filler words to push things around. '.repeat(60)}
  <span id="target">quarklet</span>
  ${'more filler to keep the paragraph long. '.repeat(60)}</p>
</div>`;

const INPUT = '#oc-wrap >> .oc-input';
const LABEL = '#oc-active-match-label';

describe('Low Vision overlays survive a window resize', () => {
  let server, ctx, page, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all. Same note as scripts/screenshots.js.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
    });

    // Turn on Low Vision through the real popup, so the test exercises the same
    // storage path a user does rather than hand-writing settings.
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${sw.url().split('/')[2]}/popup.html`);
    await popup.waitForSelector('#vision-profile');
    await popup.selectOption('#vision-profile', 'low-vision');
    await popup.waitForTimeout(300);
    await popup.close();

    page = await ctx.newPage();
    await page.goto(origin);
    await page.waitForLoadState('load');
    await page.waitForTimeout(500);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // The label is centered over the match and sits just above it. Comparing centers is
  // enough to catch a stranded overlay without re-deriving the clamping math.
  const offset = () =>
    page.evaluate((labelSel) => {
      const label = document.querySelector(labelSel);
      const target = document.getElementById('target');
      if (!label) return null;
      const l = label.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      return {
        dx: (l.left + l.width / 2) - (t.left + t.width / 2),
        dy: t.top - l.bottom,
        matchLeft: t.left,
      };
    }, LABEL);

  test('label tracks the match after the viewport narrows', async () => {
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForSelector(LABEL, { timeout: 5000 });
    await page.waitForTimeout(1200); // outlast the beacon; the overlays persist

    const before = await offset();
    assert.ok(before, 'expected the Low Vision match label to be drawn');
    assert.ok(Math.abs(before.dx) < 6, `label should start centered on the match, dx=${before.dx}`);

    await page.setViewportSize({ width: 700, height: 800 });
    // 100ms resize debounce in content.js, plus the 250ms label fade-in.
    await page.waitForTimeout(900);

    const after = await offset();
    assert.ok(after, 'label should still exist after the resize');
    assert.ok(
      Math.abs(after.matchLeft - before.matchLeft) > 20,
      `the resize must actually move the match, otherwise this test proves nothing ` +
        `(before=${before.matchLeft}, after=${after.matchLeft})`
    );
    assert.ok(Math.abs(after.dx) < 6, `label drifted off the match after resize, dx=${after.dx}`);
    assert.ok(after.dy >= 0 && after.dy < 24, `label should sit just above the match, dy=${after.dy}`);
  });
});
