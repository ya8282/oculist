// Regression: SPA frameworks like Turbo (GitHub) navigate by swapping in a whole new
// <body> element. That took #oc-wrap down with it while the `wrap` variable still
// pointed at the detached node, so the bar vanished and Ctrl+F could never bring it
// back — every press took the "already open" branch and focused a detached input. The
// MutationObserver was bound to the old body too, so matches stopped re-scanning.
//
// The second test is the guard on the fix: the observer moved from document.body up to
// document.documentElement, which is also where beacons and viewport markers mount, so
// our own drawing could otherwise retrigger the scan that redraws it, forever.
//
// Real browser required — JSDOM has no layout and no Turbo-style body swap semantics.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');

// One "quarklet" on the first page, three on the second, so a stale scan and a fresh one
// give different counts and the assertion cannot pass by accident.
const PAGE = `<!doctype html><meta charset="utf-8">
<body><p>hello quarklet world</p></body>
<script>
  window.navigateSPA = function () {
    history.pushState({}, '', '/page2');
    var nb = document.createElement('body');
    nb.innerHTML = '<p>quarklet again, and quarklet, plus one more quarklet</p>';
    document.body.replaceWith(nb);
  };
<\/script>`;

const INPUT = '#oc-wrap >> .oc-input';
const COUNT = '#oc-wrap >> .oc-count';

describe('Finder survives SPA navigation that swaps the body', () => {
  let server, ctx, page;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
    page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForTimeout(500);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('bar stays mounted and re-scans the new page after a body swap', async () => {
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    await page.waitForTimeout(500);
    assert.strictEqual((await page.locator(COUNT).textContent()).trim(), '1 of 1');

    await page.evaluate(() => window.navigateSPA());
    // 350ms observer debounce, plus room for the re-scan.
    await page.waitForTimeout(1200);

    assert.strictEqual(
      await page.evaluate(() => !!document.getElementById('oc-wrap')),
      true,
      'the bar was left detached after the body swap'
    );
    assert.strictEqual(
      (await page.locator(COUNT).textContent()).trim(),
      '1 of 3',
      'the finder should have re-scanned the new body, which has three matches'
    );
  });

  test('Ctrl+F still reopens the finder after it is closed', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.evaluate(() => !!document.getElementById('oc-wrap')), false);

    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    assert.strictEqual(await page.evaluate(() => !!document.getElementById('oc-wrap')), true);
  });

  // Viewport markers only render under a colour-blind palette (content.js gates them),
  // and they mount on documentElement — the node the observer now watches. Each rescan
  // redraws them, so without the added/removed-node filter the redraw schedules the next
  // rescan and the page never goes idle. The default palette draws no markers at all,
  // which would make this test pass for the wrong reason.
  test('our own beacons and markers do not retrigger the scan loop', async () => {
    const popup = await ctx.newPage();
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    await popup.goto(`chrome-extension://${sw.url().split('/')[2]}/popup.html`);
    await popup.waitForSelector('#vision-profile');
    await popup.selectOption('#vision-profile', 'color-blind-deuteranopia');
    await popup.waitForTimeout(300);
    await popup.close();
    await page.bringToFront();

    await page.locator(INPUT).type('quarklet', { delay: 30 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter'); // draws a beacon on documentElement
    await page.waitForTimeout(1500);    // let it settle

    assert.ok(
      await page.evaluate(() => !!document.querySelector('.oc-viewport-marker')),
      'expected viewport markers to be drawn, otherwise this test proves nothing'
    );

    // With a feedback loop, the rescan fires every 350ms and keeps re-adding our nodes.
    // A quiet window means the observer correctly ignores what we drew.
    const added = await page.evaluate(async () => {
      let n = 0;
      const mo = new MutationObserver((recs) => {
        for (const r of recs) {
          for (const node of r.addedNodes) {
            if (node.nodeType === 1 && (node.classList?.contains('oc-beacon') || node.classList?.contains('oc-viewport-marker'))) n++;
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      await new Promise((r) => setTimeout(r, 2500));
      mo.disconnect();
      return n;
    });

    assert.strictEqual(added, 0, `expected an idle page to draw nothing, saw ${added} node(s) added — rescan loop`);
  });
});
