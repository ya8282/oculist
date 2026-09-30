// oculist-blkh: same, where the text and scroller live in open shadow roots.
// oculist-yl02: a smooth navigation that scrolls only an inner overflow container must draw
// the beacon once that container settles, not at the 600ms fallback mid-scroll.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const TOLERANCE = 20; // one 18px line plus rounding slack
const TERM = 'zqxjvmarker';

const LINES = [];
for (let i = 0; i < 400; i++) LINES.push('line ' + i + (i === 300 ? ' ' + TERM : ''));
const TEXT = LINES.join('\n');
const STYLE = '<style>html,body{margin:0}pre{margin:0;font:14px/18px monospace}</style>';
// (i) open shadow root holding a fixed-height scroller; the page itself does not scroll.
const IN_SHADOW = `<!doctype html>${STYLE}<div id=host></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<div id=m style="height:400px;overflow:auto"><pre>${TEXT.replace(/\n/g, '\\n')}</pre></div>'</script>`;
// (ii) light-DOM scroller whose content reaches the match through a shadow host.
const VIA_HOST = `<!doctype html>${STYLE}<div id=m style="height:400px;overflow:auto"><div id=host></div></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<pre>${TEXT.replace(/\n/g, '\\n')}</pre>'</script>`;
const FIXTURES = [
  ['scroller inside a shadow root', IN_SHADOW, () => document.getElementById('host').shadowRoot.getElementById('m')],
  ['light-DOM scroller around a shadow host', VIA_HOST, () => document.getElementById('m')],
];

for (const [name, html, getScroller] of FIXTURES) describe('beacon after a smooth scroll: ' + name + ' (oculist-blkh)', () => {
  let server, ctx, page, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
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
    await page.goto(origin);
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

  test('beacon is drawn at the match settled position', async () => {
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
    await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    // Let the container finish settling, then compare with the drawn position.
    let prev = -1, stable = 0;
    await waitForCondition(async () => {
      const y = await page.evaluate(`(${getScroller})().scrollTop`);
      stable = y === prev ? stable + 1 : 0;
      prev = y;
      return stable >= 5 && y > 0;
    }, Boolean, { timeout: POLL_TIMEOUT, interval: 100, message: 'scroll never settled' });
    const { beacon, settled } = await page.evaluate(() => {
      const h = CSS.highlights.get('oculist-active-match');
      const r = [...h][0].getBoundingClientRect();
      return { beacon: window.__beacon.mid, settled: r.top + r.height / 2 };
    });
    assert.ok(Math.abs(beacon - settled) <= TOLERANCE, `beacon at ${beacon}, match settled at ${settled}`);
  });
});
