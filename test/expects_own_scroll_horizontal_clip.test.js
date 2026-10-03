// oculist-hdr7: expectsOwnScroll predicts an own scroll that sometimes never happens (here: the match is
// clipped only horizontally by overflow-x:hidden while the parent is already vertically centred), so the
// auto-scroll flag was held 1.5s and a user scroll in that window did not fade the beacon. The fix observes
// instead of predicting: no scroll event / position change within a few frames releases the flag early.
// The keep-beacon pages all perform a real own scroll after a 600ms renderer stall and must NOT release it.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const TERM = 'zqxjvmarker';
// #box is centred in the 800px viewport (top 300, height 200); its text sits 10px below its centre
// (padding-top), the match is the box's own text node, so the document "has room" to move. The match is 1500px along inside an
// overflow-x:hidden wrapper, so it is clipped horizontally only.
const STALLED = `<!doctype html><style>body{margin:0;height:3000px;font:14px/18px monospace}
#wrap{position:absolute;top:300px;left:0;width:100%;overflow-x:hidden;overflow-y:hidden}
#box{height:50px;padding-top:150px;width:200px;margin-left:2500px}</style><div id="wrap"><div id="box">${TERM}</div><div style="width:4000px;height:1px"></div></div>
<script>addEventListener('keyup',function(e){if(e.key==='Enter'){var t=performance.now();while(performance.now()-t<600);}},true);</script>`;
const STALLED_RTL = STALLED.replace('overflow-y:hidden}', 'overflow-y:hidden;direction:rtl}').replace('margin-left:2500px', 'margin-right:2500px');
const STALL = STALLED.slice(STALLED.indexOf('<script>'));
// html scroll-padding-bottom makes scrollIntoView still scroll the document ~40px vertically.
const STALLED_PAD = `<!doctype html><style>html{scroll-padding-bottom:80px}body{margin:0;height:3000px;font:14px/18px monospace}#wrap{position:absolute;top:300px;left:0;width:100%;overflow-x:hidden}#box{height:50px;padding-top:150px;width:3000px;text-indent:1500px}</style><div id="wrap"><div id="box">${TERM}</div></div>${STALL}`;
// direction comes from body (propagates to the viewport) so window.scrollX runs 0..-max while html stays ltr.
const STALLED_BODYRTL = `<!doctype html><style>body{margin:0;height:3000px;font:14px/18px monospace}#wrap{width:4000px;padding-top:300px}#box{height:50px;padding-top:150px;width:200px;margin-right:3500px}</style><body dir=rtl><div id="wrap"><div id="box">${TERM}</div></div>${STALL}`;
const FILL = 'x'.repeat(170);
// reviewer adversarial (a): scroll-margin-top:-80px makes scrollIntoView scroll the document ~40px.
const STALLED_NEGMARGIN = `<!doctype html><style>body{margin:0;height:3000px;font:14px/18px monospace}#wrap{position:absolute;top:300px;left:0;width:100%;overflow-x:hidden}#box{height:50px;padding-top:150px;width:3000px;text-indent:1500px;scroll-margin-top:-80px}</style><div id="wrap"><div id="box">${TERM}</div></div>${STALL}`;
// (b): scroll-padding-left:200px on an overflow-x:hidden wrapper at scrollLeft 300; inline nearest scrolls it 300 -> 200.
const STALLED_PADLEFT = `<!doctype html><style>body{margin:0;height:3000px;font:14px/18px monospace}#wrap{position:absolute;top:300px;left:0;width:100%;overflow-x:hidden;scroll-padding-left:200px}#box{height:50px;padding-top:150px;width:200px;margin-left:400px;white-space:nowrap}</style><div id="wrap"><div id="box">${FILL}${TERM}</div><div style="width:4000px;height:1px"></div></div><script>document.getElementById('wrap').scrollLeft=300</script>${STALL}`;
const PAGE = `<!doctype html><style>body{margin:0;height:3000px;font:14px/18px monospace}
#wrap{position:absolute;top:300px;left:0;width:100%;overflow-x:hidden;overflow-y:visible}
#box{height:50px;padding-top:150px;width:3000px;text-indent:1500px}</style><div id="wrap"><div id="box">${TERM}</div></div>`;

describe('expectsOwnScroll with a horizontal-only clip (oculist-hdr7)', () => {
  let server, ctx, origin;
  before(async () => {
    server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(req.url === '/stalled' ? STALLED : req.url === '/stalled-rtl' ? STALLED_RTL : req.url === '/stalled-pad' ? STALLED_PAD : req.url === '/stalled-bodyrtl' ? STALLED_BODYRTL : req.url === '/stalled-negmargin' ? STALLED_NEGMARGIN : req.url === '/stalled-padleft' ? STALLED_PADLEFT : PAGE); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
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
    await page.goto(origin + (url || ''));
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

  test('a user scroll within 1.5s of the trigger fades the beacon', async () => {
    const { page, ev } = await open();
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => ev('window.__ocTest.getActiveBeacons()'), (n) => n === 1, { timeout: POLL_TIMEOUT, interval: 10, message: 'no beacon drawn' });
    await page.mouse.move(600, 100);
    await page.mouse.wheel(0, 300);
    await waitForCondition(() => page.evaluate(() => scrollY), (y) => y > 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'wheel did not scroll the page' });
    await waitForCondition(() => ev('window.__ocTest.getActiveBeacons()'), (n) => n === 0, { timeout: 1000, interval: 20, message: 'user scroll did not fade the beacon' });
    await page.close();
  });

  // scrollIntoView really scrolls the wrapper horizontally (box centred vertically, range below its middle);
  // a 600ms renderer stall before the first own scroll must not make that scroll read as the user's.
  test('a genuine own horizontal scroll after a renderer stall does not fade the beacon', async () => {
    const { page, ev } = await open('/stalled');
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => page.evaluate(() => document.getElementById('wrap').scrollLeft), (x) => x > 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'wrapper never scrolled' });
    await page.waitForTimeout(1200);
    assert.strictEqual(await ev('window.__ocTest.getActiveBeacons()'), 1, 'own horizontal scroll faded the beacon');
    await page.close();
  });

  // RTL scrollers run scrollLeft 0..-max; the room check must read leftward room there too.
  test('a genuine own horizontal scroll in an RTL scroller after a renderer stall does not fade the beacon', async () => {
    const { page, ev } = await open('/stalled-rtl');
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => page.evaluate(() => document.getElementById('wrap').scrollLeft), (x) => x < 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'rtl wrapper never scrolled' });
    await page.waitForTimeout(1200);
    assert.strictEqual(await ev('window.__ocTest.getActiveBeacons()'), 1, 'own rtl horizontal scroll faded the beacon');
    await page.close();
  });

  test('scroll-padding makes scrollIntoView scroll vertically; that own scroll does not fade the beacon', async () => {
    const { page, ev } = await open('/stalled-pad');
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => page.evaluate(() => scrollY), (y) => y > 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'page never scrolled' });
    await page.waitForTimeout(1200);
    assert.strictEqual(await ev('window.__ocTest.getActiveBeacons()'), 1, 'own scroll faded the beacon');
    await page.close();
  });

  test('body dir=rtl document scroll (scrollX runs negative) does not fade the beacon', async () => {
    const { page, ev } = await open('/stalled-bodyrtl');
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => page.evaluate(() => scrollX), (x) => x < 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'document never scrolled' });
    await page.waitForTimeout(1200);
    assert.strictEqual(await ev('window.__ocTest.getActiveBeacons()'), 1, 'own rtl document scroll faded the beacon');
    await page.close();
  });

  test('scroll-margin-top:-80px: own document scroll does not fade the beacon', async () => {
    const { page, ev } = await open('/stalled-negmargin');
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => page.evaluate(() => scrollY), (y) => y > 0, { timeout: POLL_TIMEOUT, interval: 20, message: 'page never scrolled' });
    await page.waitForTimeout(1200);
    assert.strictEqual(await ev('window.__ocTest.getActiveBeacons()'), 1, 'own scroll faded the beacon');
    await page.close();
  });

  test('scroll-padding-left: own 300 -> 200 horizontal scroll does not fade the beacon', async () => {
    const { page, ev } = await open('/stalled-padleft');
    await page.fill(INPUT, TERM);
    await page.keyboard.press('Enter');
    await waitForCondition(() => page.evaluate(() => document.getElementById('wrap').scrollLeft), (x) => x < 300, { timeout: POLL_TIMEOUT, interval: 20, message: 'wrapper never scrolled' });
    await page.waitForTimeout(1200);
    assert.strictEqual(await ev('window.__ocTest.getActiveBeacons()'), 1, 'own scroll faded the beacon');
    await page.close();
  });
});
