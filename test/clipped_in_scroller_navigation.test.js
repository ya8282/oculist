// oculist-bxyf: a match inside the viewport rect but clipped by an overflow:auto ancestor
// must still be scrolled into that ancestor's visible area, and a match already visible
// there must keep the no-scroll path.

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

const lines = (n, at) => Array.from({ length: n }, (_, i) => 'line ' + i + (i === at ? ' ' + TERM : '')).join('\n');
const page_ = (before, pre) => `<!doctype html><style>body{margin:0}#m{height:300px;overflow:auto;margin-top:100px}pre{margin:0;font:14px/18px monospace}</style><div id=m>${before}<pre>${pre}</pre></div><div style="height:3000px"></div>`;
const PAGES = {
  // 594px pre taller than the 300px container, match at y=540 (clipped, rect still inside the viewport).
  tall: page_('', lines(33, 30)),
  // 252px pre fits the container; match at y=400+234 is clipped below the fold.
  short: page_('<div style="height:400px"></div>', lines(14, 13)),
  // Match already visible inside the container.
  visible: page_('', lines(33, 3)),
};

describe('match clipped by an inner scroller but inside the viewport rect (oculist-bxyf)', () => {
  let server, ctx, page, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES[req.url.slice(1)] || '');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
    page = await ctx.newPage();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function search(name) {
    await page.goto(origin + name);
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try { await page.waitForSelector(INPUT, { timeout: 250 }); break; } catch (e) { /* retry */ }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    await page.evaluate(() => {
      window.__beacon = null;
      window.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__t0 = performance.now(); }, true);
      new MutationObserver((records) => {
        if (window.__beacon) return;
        for (const r of records) for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('oc-beacon-transient')) {
            const b = n.getBoundingClientRect();
            window.__beacon = { mid: b.top + b.height / 2, at: performance.now() - window.__t0 };
            return;
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    // Let the container stop moving, then read everything.
    let prev = -1, stable = 0;
    await waitForCondition(async () => {
      const y = await page.evaluate(() => document.getElementById('m').scrollTop);
      stable = y === prev ? stable + 1 : 0;
      prev = y;
      return stable >= 5;
    }, Boolean, { timeout: POLL_TIMEOUT, interval: 100, message: 'scroll never settled' });
    return page.evaluate(() => {
      const r = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
      const m = document.getElementById('m');
      const c = m.getBoundingClientRect();
      return {
        top: r.top, bottom: r.bottom, mid: r.top + r.height / 2,
        cTop: c.top + m.clientTop, cBottom: c.top + m.clientTop + m.clientHeight,
        scrollTop: m.scrollTop, beacon: window.__beacon.mid, beaconAt: window.__beacon.at,
      };
    });
  }

  for (const name of ['tall', 'short']) {
    test(`${name} parent: match is scrolled into the container and the beacon follows`, async () => {
      const s = await search(name);
      assert.ok(s.top >= s.cTop && s.bottom <= s.cBottom, `match not inside the container: ${JSON.stringify(s)}`);
      assert.ok(Math.abs(s.beacon - s.mid) <= TOLERANCE, `beacon at ${s.beacon}, match settled at ${s.mid}`);
    });
  }

  test('match already visible in the container: no scroll, beacon drawn promptly', async () => {
    const s = await search('visible');
    assert.strictEqual(s.scrollTop, 0, `container scrolled: ${JSON.stringify(s)}`);
    assert.ok(s.top >= s.cTop && s.bottom <= s.cBottom, `fixture: match not visible: ${JSON.stringify(s)}`);
    assert.ok(s.beaconAt < 400, `beacon took ${s.beaconAt}ms, expected the ~50ms in-viewport path`);
  });
});
