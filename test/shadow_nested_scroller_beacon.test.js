// oculist-vo50: nested scroller / nested shadow root cases the blkh tests do not reach.
// Host step of the centring loop: a shadow scroller inside a light-DOM scroller must centre both (reverted, #o stays at scrollTop 0 and the settle wait times out).
// Nested roots: a scroller in an outer shadow root, text in an inner one, must still gate the draw.
// 20000 lines so the smooth scroll outlasts the 600ms fallback and its retry (about 1.2s).

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
for (let i = 0; i < 20000; i++) LINES.push('line ' + i + (i === 15000 ? ' ' + TERM : ''));
const TEXT = LINES.join('\n');
const STYLE = '<style>html,body{margin:0}pre{margin:0;font:14px/18px monospace}</style>';
const ESC = TEXT.replace(/\n/g, '\\n');
// shadow scroller (600px) inside a light-DOM scroller (300px) that sits below a 1000px spacer.
const SCROLLER_IN_SHADOW_IN_SCROLLER = `<!doctype html>${STYLE}<div id=o style="height:300px;overflow:auto"><div style="height:1000px"></div><div id=host></div></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<div id=m style="height:600px;overflow:auto"><pre>${ESC}</pre></div>'</script>`;
// scroller in an outer shadow root; the text lives in a shadow root nested inside it.
const NESTED_ROOTS = `<!doctype html>${STYLE}<div id=host></div><script>const s1=document.getElementById('host').attachShadow({mode:'open'});s1.innerHTML='<div id=m style="height:400px;overflow:auto"><div id=h2></div></div>';s1.getElementById('h2').attachShadow({mode:'open'}).innerHTML='<pre>${ESC}</pre>'</script>`;
const FIXTURES = [
  ['shadow scroller inside a light-DOM scroller', SCROLLER_IN_SHADOW_IN_SCROLLER,
    () => document.getElementById('o')],
  ['match in a shadow root nested inside another shadow root', NESTED_ROOTS,
    () => document.getElementById('host').shadowRoot.getElementById('m')],
];

for (const [name, html, getCentreBox] of FIXTURES) describe('beacon after a smooth scroll: ' + name + ' (oculist-vo50)', () => {
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
      const y = await page.evaluate(`(${getCentreBox})().scrollTop`);
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
    const { mid, scrollerMid } = await page.evaluate(`(() => {
      const sc = (${getCentreBox})(), b = sc.getBoundingClientRect();
      const r = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
      return { mid: r.top + r.height / 2, scrollerMid: b.top + b.height / 2 };
    })()`);
    assert.ok(Math.abs(mid - scrollerMid) <= TOLERANCE, `match at ${mid}, scroller centre ${scrollerMid}`);
  });
});
