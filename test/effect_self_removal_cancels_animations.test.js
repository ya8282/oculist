// oculist-s81m: each effect whose end-of-effect timer detaches its own container must go
// through destroyBeacon(), not a bare remove(). Under load the WAAPI timeline lags the
// timer, so animations can still be running when it fires; a bare remove() left them
// running on a detached element (and fadeActiveBeacons() skips it, no parentNode).
// Slowing every animation to 1% rate makes that lag deterministic. Pattern from
// cyber_vision.test.js (oculist-5s7l).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p>${'filler words to fill the page. '.repeat(30)} <span id="target">phosphorescent</span> ${'more filler. '.repeat(30)}</p>`;
const INPUT = '#oc-wrap >> .oc-input';

// effect key -> content.js function owning the bare-remove timer
const EFFECTS = {
  hud: 'animateAnimeLaser',
  iris: 'animateIris',
  sweep: 'animateWarpDrive',
  flame: 'animateFlame',
  dispersion: 'animateDispersion',
  lightning: 'animateLightning',
};

describe('effect self-removal timers cancel still-running animations', () => {
  let server, ctx, page, client, isolatedContextId;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/`;
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
    });
    page = await ctx.newPage();
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId = c.id;
      }
    });
    await page.goto(origin);
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });
    await openFinder();
    await page.locator(INPUT).type('phosphorescent', { delay: 30 });
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function openFinder() {
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {}
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  async function setEffect(effect, extra) {
    const res = await client.send('Runtime.evaluate', {
      contextId: isolatedContextId,
      awaitPromise: true,
      returnByValue: true,
      expression:
        'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var next = Object.assign({}, (data && data['oc-settings']) || {}, { effect: " + JSON.stringify(effect) + ' }, ' + JSON.stringify(extra || {}) + ');' +
        "chrome.storage.sync.set({ 'oc-settings': next }, function () { setTimeout(resolve, 200); });" +
        '});' +
        '})',
    });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  }

  async function replay() {
    await page.evaluate(() => {
      document.querySelectorAll('.oc-beacon').forEach((el) => el.remove());
      window.__ocBeaconSeen = false;
      const obs = new MutationObserver(() => {
        if (document.querySelector('.oc-beacon')) {
          window.__ocBeaconSeen = true;
          obs.disconnect();
        }
      });
      obs.observe(document.documentElement, { childList: true });
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__ocBeaconSeen === true, null, { timeout: POLL_TIMEOUT });
  }

  for (const [effect, fn] of Object.entries(EFFECTS)) {
    test(`${effect} (${fn}): the self-removal timer cancels animations still running when it fires`, async () => {
      await setEffect(effect);
      await replay();
      const n = await page.evaluate(() => {
        const beacons = Array.from(document.querySelectorAll('.oc-beacon'));
        const elems = beacons.flatMap((b) => [b, ...b.querySelectorAll('*')]);
        window.__waapiSnapshot = elems.flatMap((el) => el.getAnimations());
        window.__waapiSnapshot.forEach((a) => a.updatePlaybackRate(0.01));
        return window.__waapiSnapshot.length;
      });
      assert.ok(n > 0, 'sanity check: expected live animations under .oc-beacon');
      try {
        await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, {
          timeout: POLL_TIMEOUT,
        });
        const after = await page.evaluate(() => window.__waapiSnapshot.map((a) => a.playState));
        assert.ok(
          after.every((s) => s !== 'running'),
          `expected the self-removal timer to cancel still-running animations; observed ${JSON.stringify(after)}`
        );
      } finally {
        await page.evaluate(() => { delete window.__waapiSnapshot; });
      }
    });
  }

  // oculist-w0xo: these two effects remove sibling elements off ONE sibling's .finished.
  // Only the siblings are slowed, so the trigger finishes while they are still running;
  // the removal must cancel them rather than detach them mid-flight. Beacon order is
  // mount order: arrows = [left(trigger), right]; reduced-motion = [overlay, glow(trigger),
  // left, right].
  const SIBLING_CASES = [
    { name: 'arrows (animatePointingArrows)', effect: 'arrows', extra: {}, trigger: 0 },
    { name: 'reduced-motion (animateReducedMotion)', effect: 'hud', extra: { displayPreset: 'reduced-motion', visionSettings: { motionSensitivity: 'reduced' } }, trigger: 1 },
  ];
  for (const c of SIBLING_CASES) {
    test(`${c.name}: removing siblings off one .finished cancels the lagging ones`, async () => {
      await setEffect(c.effect, c.extra);
      try {
        await replay();
        const n = await page.evaluate((trigger) => {
          const beacons = Array.from(document.querySelectorAll('.oc-beacon'));
          window.__waapiSnapshot = [];
          beacons.forEach((b, i) => {
            if (i === trigger) return;
            b.getAnimations().forEach((a) => { a.updatePlaybackRate(0.01); window.__waapiSnapshot.push(a); });
          });
          return window.__waapiSnapshot.length;
        }, c.trigger);
        assert.ok(n > 0, 'sanity check: expected live sibling animations');
        await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, {
          timeout: POLL_TIMEOUT,
        });
        const after = await page.evaluate(() => window.__waapiSnapshot.map((a) => a.playState));
        assert.ok(
          after.every((s) => s !== 'running'),
          `expected sibling animations cancelled on removal; observed ${JSON.stringify(after)}`
        );
      } finally {
        await page.evaluate(() => { delete window.__waapiSnapshot; });
        await setEffect('hud', { displayPreset: null, visionSettings: { motionSensitivity: 'full' } });
      }
    });
  }
});
