// oculist-qv2i: element scroll events do not bubble, so a user scrolling an inner container
// (app-style layout: html/body overflow:hidden, a 100vh div scrolls) must still fade the
// beacon and refresh viewport markers, while the extension's own inner smooth scroll must not
// fade the beacon it is about to draw.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const TERM = 'zqxjvmarker';

function shell(every, n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push('line ' + i + (every ? (i % every === 0 ? ' ' + TERM : '') : (i === n - 100 ? ' ' + TERM : '')));
  return `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}#m{height:100vh;overflow:auto}pre{margin:0;font:14px/18px monospace}</style><div id=m><pre>${lines.join('\n')}</pre></div>`;
}
const TICKER = '<div id=t style="position:fixed;right:0;top:0;width:80px;height:100px;overflow:auto"><div style="height:5000px"></div></div><script>var t=document.getElementById("t");setInterval(function(){t.scrollTop=(t.scrollTop+3)%4000},150)</script>';
const PAGES = { '/ticker': shell(0, 2000).replace('</div>', '</div>' + TICKER), '/one': shell(0, 2000), '/many': shell(10, 400) };

describe('user scroll of an inner container (oculist-qv2i)', () => {
  let server, ctx, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES[req.url]);
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

  // Opens a page with the finder, searches TERM, and returns { page, ev } where ev evaluates in
  // the content script's isolated world.
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

  const beacons = (ev) => ev('window.__ocTest.getActiveBeacons()');

  test('user wheel over the inner scroller fades the beacon; the extension own inner scroll does not', async () => {
    const { page, ev } = await open('/one');
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => beacons(ev), (n) => n === 1, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    // (iii) the extension's own scroll must not have faded what it just drew.
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(await beacons(ev), 1, 'own inner smooth scroll faded the beacon');
    // (i) a user scroll of the same container fades it.
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 400);
    await waitForCondition(() => beacons(ev), (n) => n === 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'user inner scroll did not fade the beacon' });
    await page.close();
  });

  // The flag must outlive the 300ms no-event window while the extension's own inner scroll runs
  // (its scroll/scrollend do not bubble), survive an unrelated scroller's scrollend, and still
  // terminate once the own scroll ends although the unrelated scroller keeps scrolling.
  // The flag is deliberately a 300ms grace from the last own scroll event, so a renderer stall
  // longer than that (parallel load) legitimately expires it, and once down it stays down. The
  // page records a defect only when the flag was up at one own scroll event and is down at the
  // next although they came under 250ms apart (the grace cannot have run out). A flag found down
  // otherwise is a stall: retry on a fresh page.
  test('auto-scroll flag follows the own inner scroll only, not an unrelated scroller', async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { page, ev } = await open('/ticker');
      const timer = () => ev('window.__ocTest.getAutoScrollTimer() !== null');
      // The ticker is an unrelated scroller whose scroll legitimately fades a drawn beacon (any
      // scroll counts), up to 150ms after the draw; under load that outruns a 20ms count poll.
      // Record the draw itself instead of sampling the live count.
      await ev(`window.__drawn = false; window.__defect = false;
        new MutationObserver(function (ms, o) {
          if (document.querySelector('.oc-beacon-transient')) { window.__drawn = true; o.disconnect(); } }).observe(document.documentElement, { childList: true, subtree: true });
        var prev = 0, prevUp = false;
        document.getElementById('m').addEventListener('scroll', function () {
          var now = Date.now(), gap = now - prev; prev = now;
          setTimeout(function () {
            var up = window.__ocTest.getAutoScrollTimer() !== null;
            if (prevUp && !up && gap < 250) window.__defect = true;
            prevUp = up;
          }, 0);
        })`);
      await page.fill(INPUT, TERM);
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 700));
      let stalled = false;
      for (let i = 0; i < 4; i++) {
        assert.strictEqual(await ev('window.__defect'), false, 'flag expired while the own inner scroll was still running');
        if (!(await timer())) { stalled = true; break; }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (stalled) { await page.close(); continue; }
      await waitForCondition(() => ev('window.__drawn'), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
      await waitForCondition(timer, (v) => v === false, { timeout: POLL_TIMEOUT, interval: 50, message: 'unrelated scroller kept the flag alive after the own scroll ended' });
      await page.close();
      return;
    }
    assert.fail('renderer stalled past the 300ms grace on every attempt');
  });

  test('viewport markers refresh on a user scroll of the inner container', async () => {
    const { page, ev } = await open('/many');
    await ev(`new Promise(function (resolve) { chrome.storage.sync.get('oc-settings', function (d) {
      var cur = (d && d['oc-settings']) || {};
      var vs = Object.assign({}, cur.visionSettings || {}, { colorPalette: 'amber-sky' });
      chrome.storage.sync.set({ 'oc-settings': Object.assign({}, cur, { visionSettings: vs }) }, resolve); }); })`);
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    const tops = () => page.evaluate(() => [...document.querySelectorAll('.oc-viewport-marker')].map((m) => m.style.top).join());
    const before = await waitForCondition(tops, Boolean, { timeout: POLL_TIMEOUT, interval: 50, message: 'no viewport markers' });
    await new Promise((r) => setTimeout(r, 400));
    const settled = await tops();
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 400);
    await waitForCondition(tops, (t) => t !== settled, { timeout: POLL_TIMEOUT, interval: 50, message: 'markers did not refresh: ' + before });
    await page.close();
  });
});
