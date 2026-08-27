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
    // Wait for the write to actually land before tearing the popup page down, instead of
    // guessing how long the async chrome.storage.sync.set() call takes.
    await popup.waitForFunction(
      () =>
        chrome.storage.sync
          .get('oc-settings')
          .then((d) => !!(d['oc-settings'] && d['oc-settings'].visionProfile === 'low-vision')),
      null,
      { timeout: 5000 }
    );
    await popup.close();

    page = await ctx.newPage();
    await page.goto(origin);
    await page.waitForLoadState('load');
  });

  // No CDP session in this file, so there is no isolatedContextId to poll for injection
  // readiness — retry Control+f itself (a keypress a not-yet-attached listener would
  // otherwise silently swallow) until the input actually appears, instead of guessing a
  // fixed delay.
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
    await page.waitForSelector(INPUT, { timeout: 5000 }); // surfaces the real timeout error
  }

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
      { timeout: 5000 }
    );
    await page.keyboard.press('Enter');
    // drawActiveMatchLabel() and the beacon effect are both drawn from the same
    // synchronous animate() call (deferred by highlightActiveRange()'s own setTimeout) —
    // by the time the label exists, that whole draw has already landed, so no separate
    // wait is needed to "outlast" anything before reading its position.
    await page.waitForSelector(LABEL, { timeout: 5000 });

    const before = await offset();
    assert.ok(before, 'expected the Low Vision match label to be drawn');
    assert.ok(Math.abs(before.dx) < 6, `label should start centered on the match, dx=${before.dx}`);

    await page.setViewportSize({ width: 700, height: 800 });
    // Poll for the real post-resize state (the 100ms resize debounce, plus the label's
    // own fade-in) rather than guessing "debounce + fade-in" as a wall-clock number.
    await page.waitForFunction(
      (args) => {
        const target = document.getElementById('target');
        return target && Math.abs(target.getBoundingClientRect().left - args.beforeLeft) > 20;
      },
      { beforeLeft: before.matchLeft },
      { timeout: 5000 }
    );
    await page.waitForFunction(
      (labelSel) => {
        const label = document.querySelector(labelSel);
        const target = document.getElementById('target');
        if (!label || !target) return false;
        const l = label.getBoundingClientRect();
        const t = target.getBoundingClientRect();
        return Math.abs((l.left + l.width / 2) - (t.left + t.width / 2)) < 6;
      },
      LABEL,
      { timeout: 5000 }
    );

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
