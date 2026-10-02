// oculist-4uii: under CSS zoom on <html>, viewport markers (appended to documentElement in
// document coordinates) must still sit beside their match.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const TOLERANCE = 5;
const TERM = 'zqxjvmarker';

const BODY = '<pre>' + Array.from({ length: 12 }, (_, i) => 'line ' + i + (i === 3 || i === 8 ? ' ' + TERM : '')).join('\n') + '</pre>';
const page_ = (css) => `<!doctype html><style>body{margin:0}pre{margin:0;font:14px/18px monospace}${css}</style>${BODY}`;
const FIXTURES = [
  ['html zoom 1', page_('')],
  ['html zoom 1.25', page_('html{zoom:1.25}')],
];

for (const [name, html] of FIXTURES) describe('viewport markers under CSS zoom: ' + name + ' (oculist-4uii)', () => {
  let server, ctx, page, client;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
    page = await ctx.newPage();
    client = await ctx.newCDPSession(page);
    let contextId;
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.executionContextCreated', (e) => {
      const c = e.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) contextId = c.id;
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await waitForCondition(() => contextId, Boolean, { timeout: POLL_TIMEOUT, message: 'no isolated context' });
    await client.send('Runtime.evaluate', {
      contextId, awaitPromise: true,
      expression: `new Promise(function (resolve) { chrome.storage.sync.get('oc-settings', function (d) {
        var cur = (d && d['oc-settings']) || {};
        var vs = Object.assign({}, cur.visionSettings || {}, { colorPalette: 'amber-sky' });
        chrome.storage.sync.set({ 'oc-settings': Object.assign({}, cur, { visionSettings: vs }) }, resolve); }); })`,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try { await page.waitForSelector(INPUT, { timeout: 250 }); break; } catch (e) { /* retry */ }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('the viewport marker of the non-active match sits beside it', async () => {
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    const probe = () => page.evaluate(() => {
      const ms = [...document.querySelectorAll('.oc-viewport-marker')].map((m) => {
        const r = m.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const hl = CSS.highlights.get('oculist-match');
      const rs = hl ? [...hl].map((r) => r.getBoundingClientRect()) : [];
      return { ms, rs: rs.map((r) => ({ right: r.right, y: r.top + r.height / 2 })) };
    });
    const got = await waitForCondition(probe, (g) => g.ms.length > 0 && g.rs.length > 0, { timeout: POLL_TIMEOUT, interval: 50, message: 'no viewport marker' });
    await new Promise((r) => setTimeout(r, 400));
    const s = await probe();
    for (const m of s.ms) {
      const near = s.rs.some((r) => Math.abs(m.y - r.y) <= TOLERANCE && Math.abs(m.x - (r.right + 4 + 6)) <= TOLERANCE);
      assert.ok(near, `marker at ${JSON.stringify(m)} not beside any match ${JSON.stringify(s.rs)}`);
    }
    assert.strictEqual(s.ms.length, 1, 'one non-active visible match expected');
  });
});
