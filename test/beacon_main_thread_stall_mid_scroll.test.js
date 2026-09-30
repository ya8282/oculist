// oculist-wzqi: a main-thread stall between scroll events of a smooth scroll must not trip the
// 80ms idle debounce into drawing the beacon mid-scroll; scrollend governs where it exists.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const TOLERANCE = 20;
const TERM = 'zqxjvmarker';
const LINES = [];
for (let i = 0; i < 400; i++) LINES.push('line ' + i + (i === 300 ? ' ' + TERM : ''));
const SHELL = `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}#m{height:100vh;overflow:auto}pre{margin:0;font:14px/18px monospace}</style><div id=m><pre>${LINES.join('\n')}</pre></div>`;

describe('beacon survives a main-thread stall mid smooth scroll (oculist-wzqi)', () => {
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

  test('beacon is drawn at the settled position after a 250ms stall', async () => {
    await page.evaluate(() => {
      window.__beacon = null;
      new MutationObserver((records) => {
        if (window.__beacon) return;
        for (const r of records) for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('oc-beacon-transient')) {
            const b = n.getBoundingClientRect();
            window.__beacon = { mid: b.top + b.height / 2 };
            return;
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    // Registered after the extension's own scroll listener, so the debounce is already armed
    // when this one blocks the thread past 80ms, once, mid scroll.
    await page.evaluate(() => {
      let n = 0;
      window.addEventListener('scroll', () => {
        if (++n === 3) { const end = performance.now() + 250; while (performance.now() < end); }
      }, true);
    });
    await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    await waitForCondition(() => page.evaluate(() => {
      const m = document.getElementById('m');
      window.__prev = window.__prev === m.scrollTop ? window.__prev : m.scrollTop;
      return new Promise((r) => setTimeout(() => r(m.scrollTop === window.__prev && m.scrollTop > 0), 400));
    }), Boolean, { timeout: POLL_TIMEOUT * 2, interval: 100, message: 'scroll never settled' });
    const { beacon, settled } = await page.evaluate(() => {
      const r = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
      return { beacon: window.__beacon.mid, settled: r.top + r.height / 2 };
    });
    assert.ok(Math.abs(beacon - settled) <= TOLERANCE, `beacon at ${beacon}, match settled at ${settled}`);
  });
});
