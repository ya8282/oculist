// oculist-i955: the 300ms auto-scroll grace was counted from the trigger and detached on expiry, so a
// renderer stall before the first own scroll event dropped suppression for the whole own scroll and
// the first own scroll faded the beacon. The stall is forced deterministically: the content
// script's window.scrollBy is deferred 700ms after starting the native smooth scroll, so the grace timer
// can only run after the stall with the own scroll events still queued behind it.

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
for (let i = 0; i < 3000; i++) LINES.push('line ' + i + (i === 2500 ? ' ' + TERM : ''));
const PAGE = `<!doctype html><style>body{margin:0}pre{margin:0;font:14px/18px monospace}</style><pre>${LINES.join('\n')}</pre>`;

// oculist-u6x3 shape: the match sits in a fixed box clipped by the viewport bottom, so no own scroll can come.
const FIXED = `<!doctype html><style>body{margin:0}pre{margin:0;font:14px/18px monospace}</style><div style="position:fixed;left:0;top:785px;height:40px;font:14px/18px monospace">${TERM}</div><pre>${LINES.join('\n')}</pre>`;

describe('auto-scroll flag survives a stall before the first own scroll event (oculist-i955)', () => {
  let server, ctx, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/fixed' ? FIXED : PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function open(url) {
    const page = await ctx.newPage();
    const client = await ctx.newCDPSession(page);
    let contextId;
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.executionContextCreated', (e) => {
      const c = e.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) contextId = c.id;
    });
    await page.goto(origin + url);
    await waitForCondition(() => contextId, Boolean, { timeout: POLL_TIMEOUT, message: 'no isolated context' });
    const ev = (expression) => client.send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true }).then((r) => {
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try { await page.waitForSelector(INPUT, { timeout: 250 }); break; } catch (e) { /* retry */ }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    return { page, ev };
  }

  test('flag is still up when the first own scroll event arrives >300ms after the trigger', async () => {
    const { page, ev } = await open('/');

    // The native scroll starts 700ms after the trigger: past the 300ms grace and the 600ms cap timer
    // (which draws the beacon before any own scroll), as under a renderer stall.
    // Registered before the extension's own listeners arm (mine runs first), so it reads the flag state
    // as the first own scroll event finds it. getAutoScrollTimer() is non-null exactly while the flag is up.
    await ev(`window.__armedAtFirstScroll = null;
      window.addEventListener('scroll', function () {
        if (window.__armedAtFirstScroll === null) window.__armedAtFirstScroll = window.__ocTest.getAutoScrollTimer() !== null;
      }, true);
      var orig = window.scrollBy;
      window.scrollBy = function () {
        var args = arguments;
        setTimeout(function () { orig.apply(window, args); }, 700);
      };`);
    // Typing navigates to the first match, which triggers the smooth scroll.
    await page.fill(INPUT, TERM);
    await waitForCondition(() => ev('window.__armedAtFirstScroll'), (v) => v !== null, { timeout: POLL_TIMEOUT, interval: 20, message: 'no own scroll event' });
    assert.strictEqual(await ev('window.__armedAtFirstScroll'), true, 'flag already down when the first own scroll event arrived after the stall');
    await page.close();
  });

  test('the flag still clears when no own scroll ever happens', async () => {
    const { page, ev } = await open('/');
    await ev('window.scrollBy = function () {}');
    await page.fill(INPUT, TERM);
    await waitForCondition(() => ev('window.__ocTest.getAutoScrollTimer() !== null'), Boolean, { timeout: POLL_TIMEOUT, interval: 10, message: 'flag never armed' });
    await waitForCondition(() => ev('window.__ocTest.getAutoScrollTimer() === null'), Boolean, { timeout: POLL_TIMEOUT, interval: 50, message: 'flag never cleared without a scroll' });
    await page.close();
  });

  // A fixed match nothing can scroll toward: the flag must not outlive the 300ms, or a user scroll
  // right after the cap draw would no longer fade the beacon.
  test('a user scroll after the beacon draws still fades it when no own scroll can come', async () => {
    const { page, ev } = await open('/fixed');
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => ev('window.__ocTest.getActiveBeacons()'), (n) => n === 1, { timeout: POLL_TIMEOUT, interval: 10, message: 'no beacon drawn' });
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 300);
    await waitForCondition(() => page.evaluate(() => scrollY), (y) => y > 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'wheel did not scroll the page' });
    await waitForCondition(() => ev('window.__ocTest.getActiveBeacons()'), (n) => n === 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'user scroll did not fade the beacon' });
    await page.close();
  });
});
