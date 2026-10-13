// Cross-effect QA for Haunted Hollow, pack II (oculist-l0bs.16). Not a substitute for each
// effect's own test; it runs ALL eleven effects through the lifecycle shapes that only show
// up when they share a page: rapid Enter / Shift+Enter spam, one-character and full-line
// matches at all four viewport edges and on a scrolled page, Lite Mode, reduced motion, and
// the pack toggle round-trip. Every run must leave zero .oc-beacon-transient nodes, no
// console / page errors, and no <style> or @keyframes added by the effect.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { scrollPageTo, POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const HOLLOW = ['ghostsweep', 'spiderdrop', 'witchflyby', 'blackcatpounce', 'gravehands', 'ouijaplanchette',
  'moonrise', 'trickortreat', 'possessedtext', 'cursedrune', 'mummyunwrap'];
const VIEWPORT = { width: 1200, height: 800 };
const INPUT = '#oc-wrap >> .oc-input';

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; }
.c { position: absolute; }</style>
<span class="c" style="left:0;top:0">Z</span>
<span class="c" style="right:0;top:0">Z</span>
<span class="c" style="left:0;top:770px">Z</span>
<span class="c" style="right:0;top:770px">Z</span>
<div style="position:absolute;left:0;top:400px;width:1200px;white-space:nowrap;overflow:hidden">${'fullline '.repeat(40)}</div>
<div style="height:3000px"></div>
<div style="position:absolute;left:300px;top:2200px">scrolledword</div>`;

describe('Haunted Hollow cross-effect QA', () => {
  let server, ctx, page, client, isolatedContextId, origin;
  const errors = [];

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: VIEWPORT,
    });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.exceptionThrown', (e) => errors.push('exception: ' + JSON.stringify(e.exceptionDetails.exception && e.exceptionDetails.exception.description)));
    client.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) isolatedContextId = c.id;
    });
    await page.goto(origin);
    await waitForCondition(() => isolatedContextId, Boolean, { timeout: POLL_TIMEOUT, message: 'no isolated context' });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function evalCS(expression) {
    return client.send('Runtime.evaluate', { expression, contextId: isolatedContextId, awaitPromise: true, returnByValue: true })
      .then((res) => {
        if (res.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(res.exceptionDetails));
        return res.result.value;
      });
  }

  async function setSettings(patch, vision) {
    await evalCS('new Promise(function (resolve) {' +
      "chrome.storage.sync.get('oc-settings', function (data) {" +
      "var cur = (data && data['oc-settings']) || {};" +
      'var next = Object.assign({}, cur, ' + JSON.stringify(patch) + ');' +
      (vision ? 'next.visionSettings = Object.assign({}, cur.visionSettings || {}, ' + JSON.stringify(vision) + ');' : '') +
      "chrome.storage.sync.set({ 'oc-settings': next }, resolve); }); })");
    await page.waitForTimeout(200);
  }

  async function getSettings() {
    return evalCS("new Promise(function (r) { chrome.storage.sync.get('oc-settings', function (d) { r(d['oc-settings']); }); })");
  }

  async function openFinder() {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Control+f');
      try { await page.waitForSelector(INPUT, { timeout: 250 }); return; } catch (e) { /* retry */ }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  async function search(term) {
    await openFinder();
    await page.locator(INPUT).fill('');
    await page.locator(INPUT).type(term, { delay: 20 });
    await page.waitForFunction(() => {
      const root = document.getElementById('oc-wrap');
      const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
      return !!count && /of \d+/.test(count.textContent);
    }, null, { timeout: POLL_TIMEOUT });
  }

  const transients = () => page.evaluate(() => document.querySelectorAll('.oc-beacon-transient').length);
  async function drain(label) {
    await waitForCondition(transients, (n) => n === 0, { timeout: 15000, message: `${label}: transient beacons never drained` });
  }
  async function styleFootprint() {
    return page.evaluate(() => ({
      styles: document.querySelectorAll('style').length,
      kf: Array.from(document.styleSheets).reduce((n, s) => {
        try { return n + Array.from(s.cssRules).filter((r) => r.type === 7).length; } catch (e) { return n; }
      }, 0),
    }));
  }

  describe('lifecycle per effect', () => {
    for (const key of HOLLOW) {
      test(`${key}: rapid Enter/Shift+Enter spam, edges, one-char + full-line, scrolled, then drains clean`, async () => {
        await setSettings({ effect: key, enabledPacks: ['halloween'], scrollBehavior: 'instant', performanceMode: false }, { motionSensitivity: 'full' });
        errors.length = 0;
        await scrollPageTo(page, 0);
        await search('Z');
        const before = await styleFootprint();
        for (let i = 0; i < 10; i++) await page.keyboard.press('Enter');
        for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(80);
        const live = await transients();
        assert.ok(live < 60, `${key}: ${live} transient nodes right after spam looks like a leak`);
        await drain(key + ' spam');
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(120);
        }
        await drain(key + ' edges');
        await search('fullline');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        await drain(key + ' fullline');
        await search('scrolledword');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        const sy = await page.evaluate(() => window.scrollY);
        assert.ok(sy > 1000, 'fixture scrolled, scrollY=' + sy);
        await drain(key + ' scrolled');
        assert.deepStrictEqual(await styleFootprint(), before, `${key}: injected style element or @keyframes`);
        assert.deepStrictEqual(errors, [], `${key}: errors`);
      });
    }
  });

  describe('Lite Mode and reduced motion', () => {
    for (const key of HOLLOW) {
      test(`${key}: Lite Mode and reduced motion run clean and drain`, async () => {
        errors.length = 0;
        await scrollPageTo(page, 0);
        await setSettings({ effect: key, enabledPacks: ['halloween'], scrollBehavior: 'instant', performanceMode: true }, { motionSensitivity: 'full' });
        await search('Z');
        for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
        await drain(key + ' lite');
        await setSettings({ performanceMode: false }, { motionSensitivity: 'reduced' });
        for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
        await drain(key + ' reduced');
        assert.deepStrictEqual(errors, [], `${key}: errors`);
      });
    }
  });

  test('pack toggle: stored effect selection survives pack off and restores when back on', async () => {
    errors.length = 0;
    await setSettings({ effect: 'ghostsweep', enabledPacks: ['halloween'] }, { motionSensitivity: 'full' });
    for (const packs of [[], ['halloween'], ['adventure'], ['halloween', 'adventure']]) {
      await setSettings({ enabledPacks: packs });
      const s = await getSettings();
      assert.strictEqual(s.effect, 'ghostsweep', `selection rewritten with packs=${JSON.stringify(packs)}`);
      await scrollPageTo(page, 0);
      await search('Z');
      await page.keyboard.press('Enter');
      await drain('toggle ' + JSON.stringify(packs));
    }
    assert.deepStrictEqual(errors, []);
  });
});
