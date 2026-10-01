// oculist-ntvt: under CSS zoom on the page, the beacon (appended to documentElement in
// document coordinates) must still land on the match.

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

const BODY = '<pre>' + Array.from({ length: 200 }, (_, i) => 'line ' + i + (i === 120 ? ' ' + TERM : '')).join('\n') + '</pre>';
const CSS = 'body{margin:0}pre{margin:0;font:14px/18px monospace}';
const page_ = (css, body) => `<!doctype html><style>${CSS}${css}</style>${body}`;
const FIXTURES = [
  ['html zoom 1', page_('', BODY)],
  ['html zoom 1.1', page_('html{zoom:1.1}', BODY)],
  ['html zoom 1.25', page_('html{zoom:1.25}', BODY)],
  ['body zoom 1.25', page_('body{zoom:1.25}', BODY)],
  ['ancestor-only zoom 1.25', page_('#w{zoom:1.25}', '<div id=w>' + BODY + '</div>')],
];

for (const [name, html] of FIXTURES) describe('beacon under CSS zoom: ' + name + ' (oculist-ntvt)', () => {
  let server, ctx, page;

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

  test('beacon centre is on the match centre', async () => {
    await page.evaluate(() => {
      window.__beacon = null;
      new MutationObserver((records) => {
        if (window.__beacon) return;
        for (const r of records) for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('oc-beacon-transient')) {
            const b = n.getBoundingClientRect();
            const m = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
            window.__beacon = { beacon: b.top + b.height / 2, match: m.top + m.height / 2, scrollY: window.scrollY };
            return;
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    const got = await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    assert.ok(got.scrollY > 0, 'match should require scrolling');
    assert.ok(Math.abs(got.beacon - got.match) <= TOLERANCE, `beacon at ${got.beacon}, match at ${got.match}`);
  });
});
