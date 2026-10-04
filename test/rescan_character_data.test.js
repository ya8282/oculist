// oculist-6kd1: in-place text edits (insertData, .data =) rescan only when they can change
// the match set, and a stream of unrelated mutations cannot starve the trailing debounce.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const COUNT = '#oc-wrap >> .oc-count';
const TERM = 'zqxjvmarker';

const HTML = `<!doctype html><body>
<p id=a>alpha ${TERM} one</p>
<p id=b>plain text</p>
<p id=clock>0</p>
<div id=ce contenteditable>typing here</div>
<div id=ctr>0</div>
<div id=host></div></body>`;

describe('rescan on characterData edits (oculist-6kd1)', () => {
  let server, ctx, page;
  let html = HTML;

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
  });
  after(async () => { await ctx.close(); server.close(); });

  const countText = async () => (await page.locator(COUNT).textContent()).trim();
  // Total only: the active index depends on where the rescan lands it.
  const waitCount = (n) => waitForCondition(countText, (t) => (n === 0 ? t === 'no match' : t.endsWith(' of ' + n)), { timeout: POLL_TIMEOUT, interval: 20, message: 'counter never reached ' + n + ' matches' });
  // A rescan builds a fresh Highlight, so identity change is the rescan signal.
  const mark = () => page.evaluate(() => { window.__h = CSS.highlights.get('oculist-match'); });
  const rescanned = () => page.evaluate(() => CSS.highlights.get('oculist-match') !== window.__h);
  const quiet = (ms) => new Promise((r) => setTimeout(r, ms));

  async function open() {
    if (page) await page.close();
    page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try { await page.waitForSelector(INPUT, { timeout: 250 }); break; } catch (e) { /* retry */ }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    await page.fill(INPUT, TERM);
    await waitCount(1);
  }

  test('insertData that adds a match moves the counter', async () => {
    await open();
    await page.evaluate((t) => document.getElementById('b').firstChild.insertData(0, t.toUpperCase() + ' '), TERM);
    await waitCount(2);
  });

  test('a data edit that removes a match drops the counter', async () => {
    await open();
    await page.evaluate(() => { document.getElementById('a').firstChild.data = 'nothing here'; });
    await waitCount(0);
  });

  test('an edit that joins a match with an adjacent text node moves the counter, and breaking it drops it', async () => {
    await open();
    await page.evaluate(() => {
      const p = document.getElementById('b');
      p.textContent = 'zqxjv';
      p.appendChild(document.createTextNode('XXarker'));
    });
    await quiet(700); // let the childList rescan settle so the edits below are characterData only
    await waitCount(1);
    await page.evaluate(() => { document.getElementById('b').lastChild.data = 'marker'; });
    await waitCount(2);
    await page.evaluate(() => { document.getElementById('b').lastChild.data = 'XX'; });
    await waitCount(1);
  });

  test('a clock, typing and a text counter with no term in them trigger no rescan', async () => {
    await open();
    await mark();
    await page.evaluate(() => {
      const clock = document.getElementById('clock').firstChild;
      const ce = document.getElementById('ce').firstChild;
      for (let i = 1; i <= 5; i++) { clock.data = String(i); ce.insertData(0, 'x'); }
    });
    await quiet(900);
    assert.strictEqual(await rescanned(), false);
  });

  test('a per-frame text counter cannot starve the debounce: an appended match is counted', async () => {
    await open();
    await page.evaluate(() => {
      const c = document.getElementById('ctr');
      let n = 0;
      (function tick() { c.textContent = String(++n); window.__raf = requestAnimationFrame(tick); })();
      const p = document.createElement('p');
      p.textContent = 'late ' + 'zqxjvmarker';
      document.getElementById('host').appendChild(p);
    });
    await waitCount(2);
    await page.evaluate(() => cancelAnimationFrame(window.__raf));
  });

  // Lite Mode stores inactive chips' termRanges as holes, not Ranges. Probing them per record
  // threw and swallowed a TypeError each time (~16ms/record on 3000 paragraphs).
  test('Lite Mode with chips: a clock edit costs no rescan and stays cheap per batch', async () => {
    let body = '<p id=clock>0</p>';
    for (let i = 0; i < 3000; i++) body += '<p>para ' + i + ' common word text</p>';
    html = '<!doctype html><body>' + body + '<p>rare</p></body>';
    let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    await sw.evaluate(() => new Promise((res) => chrome.storage.sync.get('oc-settings', (d) => chrome.storage.sync.set({ 'oc-settings': Object.assign({}, d['oc-settings'] || {}, { performanceMode: true }) }, res))));
    try {
      if (page) await page.close();
      page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      for (let attempt = 0; attempt < 20; attempt++) {
        await page.keyboard.press('Control+f');
        try { await page.waitForSelector(INPUT, { timeout: 250 }); break; } catch (e) { /* retry */ }
      }
      for (const t of ['common', 'word', 'rare']) {
        await page.locator(INPUT).fill(t);
        await page.keyboard.press('Enter');
        await waitForCondition(() => page.evaluate(() => document.getElementById('oc-wrap').shadowRoot.querySelectorAll('.oc-chip').length), (n) => n >= ['common', 'word', 'rare'].indexOf(t) + 1, { timeout: POLL_TIMEOUT, interval: 20, message: 'chip not added' });
      }
      await page.locator(INPUT).fill('');
      await quiet(1000);
      await mark();
      const ms = [];
      for (let k = 0; k < 3; k++) {
        ms.push(await page.evaluate(async () => {
          const c = document.getElementById('clock').firstChild;
          const t0 = performance.now();
          for (let i = 0; i < 20; i++) c.data = String(Math.random());
          await new Promise((r) => setTimeout(r, 0));
          return performance.now() - t0;
        }));
      }
      await quiet(600);
      assert.strictEqual(await rescanned(), false);
      assert.ok(Math.min(...ms) < 100, 'per-batch ms: ' + ms.join(', '));
    } finally {
      await sw.evaluate(() => new Promise((res) => chrome.storage.sync.get('oc-settings', (d) => chrome.storage.sync.set({ 'oc-settings': Object.assign({}, d['oc-settings'] || {}, { performanceMode: false }) }, res))));
      html = HTML;
    }
  });
});
