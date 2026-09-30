// oculist-aebg: navigation must center the MATCH, not its parent. In a raw text view the
// parent is one giant <pre>, so centering the parent lands at the pre's midpoint.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
// One line height (18px) plus rounding slack.
const TOLERANCE = 20;
const TERM = 'zqxjvmarker';

const LINES = [];
for (let i = 0; i < 20000; i++) {
  LINES.push('line ' + i + ' filler text for the raw view' + (i === 300 || i === 19000 ? ' ' + TERM + ' here' : ''));
}
const SHELL_LINES = [];
for (let i = 0; i < 60; i++) SHELL_LINES.push('line ' + i + (i === 20 ? ' ' + TERM : ''));
// App-style layout: html/body do not scroll, a 100vh div does; the 1080px pre sits below a spacer.
const SHELL = `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}#m{height:100vh;overflow:auto}pre{margin:0;font:14px/18px monospace}</style><div id=m><div style="height:3000px"></div><pre>${SHELL_LINES.join('\n')}</pre><div style="height:3000px"></div></div>`;
const BODY_SCROLLER = `<!doctype html><style>html{height:100%;overflow:hidden}body{margin:0;height:100%;overflow:auto}pre{margin:0;font:14px/18px monospace}</style><div style="height:3000px"></div><pre>${SHELL_LINES.join('\n')}</pre><div style="height:3000px"></div>`;
// Quirks mode (no doctype): scrollingElement is null and the window is the scroller.
const QUIRKS = `<style>html{overflow:hidden}body{margin:0;overflow:auto}pre{margin:0;font:14px/18px monospace}</style><div style="height:3000px"></div><pre>${SHELL_LINES.join('\n')}</pre><div style="height:3000px"></div>`;
// Document > #o (600px) > #m (400px) > pre: the match needs all three scrollers to move.
const NESTED = `<!doctype html><style>body{margin:0}#o{height:600px;overflow:auto;margin-top:300px}#m{height:400px;overflow:auto}pre{margin:0;font:14px/18px monospace}</style><div id=o><div style="height:200px"></div><div id=m><div style="height:3000px"></div><pre>${SHELL_LINES.join('\n')}</pre><div style="height:3000px"></div></div><div style="height:200px"></div></div><div style="height:3000px"></div>`;
// 600px pre fits the 800px viewport but not its 300px container; the match is at y=360 in the pre, below the fold.
const FITS = `<!doctype html><style>body{margin:0}#m{height:300px;overflow:auto;margin-top:700px}pre{margin:0;font:14px/18px monospace}</style><div id=m><pre>${SHELL_LINES.slice(0, 33).join('\n')}</pre></div><div style="height:3000px"></div>`;
const PAGE = `<!doctype html><meta charset="utf-8"><style>body{margin:0}pre{margin:0;font:14px/18px monospace}</style><pre>${LINES.join('\n')}</pre>`;

describe('Navigation centers the match inside a viewport-exceeding parent', () => {
  let server, ctx, page, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end({ '/shell': SHELL, '/body': BODY_SCROLLER, '/nested': NESTED, '/quirks': QUIRKS, '/fits': FITS }[req.url] || PAGE);
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
    const client = await ctx.newCDPSession(page);
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
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function activeRect() {
    return page.evaluate(() => {
      const h = CSS.highlights.get('oculist-active-match');
      if (!h) return null;
      const r = [...h][0].getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, mid: r.top + r.height / 2, vh: window.innerHeight };
    });
  }

  // Wait until scrollY has held still, then read the active match rect.
  async function settledRect() {
    let prev = -1, stable = 0;
    await waitForCondition(
      async () => {
        const y = await page.evaluate(() => window.scrollY + ['m', 'o'].reduce((n, id) => n + (document.getElementById(id) ? document.getElementById(id).scrollTop : 0), document.body.scrollTop));
        stable = y === prev ? stable + 1 : 0;
        prev = y;
        return stable >= 5 && y > 0;
      },
      Boolean,
      { timeout: POLL_TIMEOUT, interval: 100, message: 'scroll never settled' }
    );
    return activeRect();
  }

  test('both matches land centered, not at the pre midpoint', async () => {
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    for (const n of [1, 2]) {
      const r = await settledRect();
      assert.ok(r, `match ${n}: no active highlight`);
      assert.ok(r.top >= 0 && r.bottom <= r.vh, `match ${n} not in viewport: ${JSON.stringify(r)}`);
      assert.ok(Math.abs(r.mid - r.vh / 2) <= TOLERANCE, `match ${n} not centered: ${JSON.stringify(r)}`);
      if (n === 1) {
        const y1 = await page.evaluate(() => window.scrollY);
        await page.keyboard.press('Enter');
        await waitForCondition(() => page.evaluate(() => window.scrollY), (y) => y > y1 + 1000, {
          timeout: POLL_TIMEOUT,
          interval: 50,
          message: 'second navigation never scrolled',
        });
      }
    }
  });

  test('match inside an inner scroll container is centered in it', async () => {
    await page.goto(origin + 'shell');
    await waitForCondition(() => page.evaluate(() => !document.getElementById('oc-wrap')), Boolean, { timeout: POLL_TIMEOUT });
    await openFinder();
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    const r = await settledRect();
    assert.ok(r, 'no active highlight');
    assert.ok(r.top >= 0 && r.bottom <= r.vh, `not in viewport: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.mid - r.vh / 2) <= TOLERANCE, `not centered: ${JSON.stringify(r)}`);
  });

  for (const [name, url] of [['body as the scroller', 'body'], ['nested scrollers', 'nested'], ['quirks mode body', 'quirks']]) {
    test(`match is centered with ${name}`, async () => {
      await page.goto(origin + url);
      await waitForCondition(() => page.evaluate(() => !document.getElementById('oc-wrap')), Boolean, { timeout: POLL_TIMEOUT });
      await openFinder();
      await page.fill(INPUT, TERM);
      await page.keyboard.press('Enter');
      const r = await settledRect();
      assert.ok(r, 'no active highlight');
      assert.ok(r.top >= 0 && r.bottom <= r.vh, `not in viewport: ${JSON.stringify(r)}`);
      assert.ok(Math.abs(r.mid - r.vh / 2) <= TOLERANCE, `not centered: ${JSON.stringify(r)}`);
    });
  }

  // oculist-spws: the parent fits the viewport but exceeds its own 300px scroller.
  test('parent fitting the viewport but not its scroller: match is centered in the scroller', async () => {
    await page.goto(origin + 'fits');
    await waitForCondition(() => page.evaluate(() => !document.getElementById('oc-wrap')), Boolean, { timeout: POLL_TIMEOUT });
    await openFinder();
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    const r = await settledRect();
    assert.ok(r, 'no active highlight');
    const c = await page.evaluate(() => {
      const b = document.getElementById('m').getBoundingClientRect();
      return { top: b.top, mid: b.top + b.height / 2, bottom: b.bottom };
    });
    assert.ok(r.top >= c.top && r.bottom <= c.bottom, `not inside the container: ${JSON.stringify({ r, c })}`);
    assert.ok(Math.abs(r.mid - c.mid) <= TOLERANCE, `not centered in the container: ${JSON.stringify({ r, c })}`);
  });
});
