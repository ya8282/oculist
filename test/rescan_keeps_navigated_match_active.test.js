// oculist-aknk: a rescan that inserts (or removes) a match earlier in the document keeps the
// navigated match active (the index follows it) and the beacon lands on that same match.

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

// Matches at line `first` (NAVMARK) and line 300 (FARMARK).
const shell = (first) => {
  const lines = [];
  for (let i = 0; i < 400; i++) {
    const mark = i === first ? ' ' + TERM + ' NAVMARK' : i === 300 ? ' ' + TERM + ' FARMARK' : '';
    lines.push(`<div id=l${i}>line ${i}${mark}</div>`);
  }
  return `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}#m{height:100vh;overflow:auto;font:14px/18px monospace}</style><div id=m>${lines.join('')}</div>`;
};

describe('rescan keeps the navigated match active (oculist-aknk)', () => {
  let server, ctx, page, html;

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

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function open(first) {
    html = shell(first);
    if (page) await page.close();
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
    await page.evaluate(() => {
      window.__beacon = null;
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
          if (!window.__beacon && n.nodeType === 1 && n.classList && n.classList.contains('oc-beacon-transient')) {
            const b = n.getBoundingClientRect();
            window.__beacon = { mid: b.top + b.height / 2 };
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
    await page.fill(INPUT, TERM);
  }

  const activeInfo = () => page.evaluate(() => {
    const r = [...CSS.highlights.get('oculist-active-match')][0];
    const b = r.getBoundingClientRect();
    return { text: r.startContainer.parentElement.textContent, mid: b.top + b.height / 2 };
  });
  const countText = async () => (await page.locator(COUNT).textContent()).trim();
  const waitCount = (want) => waitForCondition(countText, (t) => t === want, { timeout: POLL_TIMEOUT, interval: 20, message: 'counter never read ' + want });
  const insertEarlier = () => page.evaluate(() => {
    const d = document.createElement('div');
    d.textContent = 'inserted zqxjvmarker EARLYMARK';
    document.getElementById('l5').before(d);
  });

  test('earlier match inserted mid smooth scroll: highlight, counter and beacon stay on the navigated match', async () => {
    await open(100);
    await page.keyboard.press('Enter');
    await insertEarlier();
    await waitCount('2 of 3');
    await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    // let the smooth scroll settle before measuring
    await waitForCondition(() => page.evaluate(() => document.getElementById('m').scrollTop), (() => { let last = -1, n = 0; return (v) => { n = v === last ? n + 1 : 0; last = v; return n >= 5; }; })(), { timeout: POLL_TIMEOUT, interval: 50, message: 'scroll never settled' });
    const a = await activeInfo();
    assert.ok(a.text.includes('NAVMARK'), 'active highlight moved to: ' + a.text);
    const beacon = await page.evaluate(() => window.__beacon.mid);
    assert.ok(Math.abs(beacon - a.mid) <= 20, `beacon at ${beacon}, active highlight at ${a.mid}`);
  });

  test('earlier match inserted with no scroll in flight: the index follows the visible active match', async () => {
    await open(8);
    await page.keyboard.press('Enter');
    await waitCount('1 of 2');
    await insertEarlier();
    await waitCount('2 of 3');
    assert.ok((await activeInfo()).text.includes('NAVMARK'));
  });

  test('navigated match removed mid scroll: falls back to the clamped old index, the next match', async () => {
    await open(100);
    await page.keyboard.press('Enter');
    await page.evaluate(() => document.getElementById('l100').remove());
    await waitCount('1 of 1');
    assert.ok((await activeInfo()).text.includes('FARMARK'));
  });

  // oculist-6xyq: the page replaces the navigated paragraph while the smooth scroll runs.
  const settle = () => waitForCondition(() => page.evaluate(() => document.getElementById('m').scrollTop), (() => { let last = -1, n = 0; return (v) => { n = v === last ? n + 1 : 0; last = v; return n >= 5; }; })(), { timeout: POLL_TIMEOUT, interval: 50, message: 'scroll never settled' });
  const replacers = {
    clone: () => { const o = document.getElementById('l100'); o.replaceWith(o.cloneNode(true)); },
    textContent: () => { const o = document.getElementById('l100'); o.textContent = o.textContent; },
  };
  for (const [name, withEarlier] of [['clone', false], ['textContent', false], ['clone', true], ['textContent', true]]) {
    test(`paragraph replaced by ${name} mid scroll${withEarlier ? ' with an earlier match inserted' : ''}: highlight and beacon stay on the navigated match`, async () => {
      await open(100);
      await page.keyboard.press('Enter');
      await page.evaluate(`(${replacers[name]})()`);
      if (withEarlier) await insertEarlier();
      await waitCount(withEarlier ? '2 of 3' : '1 of 2');
      await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
      await settle();
      const a = await activeInfo();
      assert.ok(a.text.includes('NAVMARK'), 'active highlight moved to: ' + a.text);
      const beacon = await page.evaluate(() => window.__beacon.mid);
      assert.ok(Math.abs(beacon - a.mid) <= 20, `beacon at ${beacon}, active highlight at ${a.mid}`);
    });
  }

  test('identical button rows: resetting the navigated one keeps the highlight on its row (oculist-6xyq)', async () => {
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push(`<div style="height:500px"><button id=b${i}>${TERM}</button></div>`);
    html = `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}#m{height:100vh;overflow:auto}</style><div id=m>${rows.join('')}</div>`;
    if (page) await page.close();
    page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try { await page.waitForSelector(INPUT, { timeout: 250 }); break; } catch (e) { /* retry */ }
    }
    await page.evaluate(() => {
      window.__beacon = null;
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
          if (!window.__beacon && n.nodeType === 1 && n.classList && n.classList.contains('oc-beacon-transient')) {
            const b = n.getBoundingClientRect();
            window.__beacon = { mid: b.top + b.height / 2 };
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
    await page.fill(INPUT, TERM);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
    await waitCount('4 of 7');
    await settle();
    await page.evaluate(() => { window.__beacon = null; });
    await page.keyboard.press('Shift+Enter');
    await page.evaluate(() => { const o = document.getElementById('b2'); o.textContent = o.textContent; });
    await waitCount('3 of 7');
    await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    await settle();
    assert.strictEqual(await countText(), '3 of 7');
    const r = await page.evaluate(() => {
      const h = [...CSS.highlights.get('oculist-active-match')][0];
      const b = h.getBoundingClientRect();
      return { id: h.startContainer.parentElement.id, mid: b.top + b.height / 2 };
    });
    assert.strictEqual(r.id, 'b2');
    const beacon = await page.evaluate(() => window.__beacon.mid);
    assert.ok(Math.abs(beacon - r.mid) <= 20, `beacon at ${beacon}, highlight at ${r.mid}`);
  });
});
