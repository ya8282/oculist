// oculist-9of8: a DOM-mutation rescan (skipScroll re-highlight) that lands while a smooth
// navigation is still scrolling must not cancel the pending draw; the beacon still appears.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const TERM = 'zqxjvmarker';

const LINES = [];
for (let i = 0; i < 400; i++) LINES.push('line ' + i + (i === 300 ? ' ' + TERM : ''));
const SHELL = `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}#m{height:100vh;overflow:auto}pre{margin:0;font:14px/18px monospace}</style><div id=m><pre>${LINES.join('\n')}</pre></div>`;

describe('rescan mid smooth scroll keeps the pending beacon (oculist-9of8)', () => {
  let server, ctx, page;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SHELL);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
    page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        await page.waitForSelector(INPUT, { timeout: 250 });
        break;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('beacon is still drawn after a mutation rescan during the scroll', async () => {
    await page.evaluate(() => {
      window.__beacon = false;
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('oc-beacon-transient')) window.__beacon = true;
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    // The rescan fires 350ms after this mutation, well inside the ~1s smooth scroll.
    await page.evaluate(() => document.body.appendChild(document.createElement('span')));
    await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    assert.ok(await page.evaluate(() => window.__beacon));
  });
});
