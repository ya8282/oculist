// isOculistNode()/isOculistMutation() mutation filter (oculist-39z): the debounced
// MutationObserver that re-scans the page on real DOM changes has to recognise the
// finder's OWN writes and skip them, or drawing/animating our own UI would schedule an
// unnecessary background rescan — one that, per oculist-39z's own repro, can spuriously
// wipe searchRanges if the active match happens to go invisible within the observer's
// 350ms debounce window.
//
// Before this fix, isOculistNode() recognised only the wrap element itself / #oc-wrap /
// #oc-global-highlight-styles, and Elements (not text nodes) carrying the exact class
// oc-beacon or oc-viewport-marker. Cyber-Vision's `readout.textContent = ...` write
// creates a text-node child of a `.oc-cv-readout` div — itself a child of, but not itself
// carrying, `.oc-beacon` — so neither the element nor its text-node child was recognised,
// and a genuine rescan was scheduled on every single Cyber-Vision run.
//
// Both directions below are load-bearing: the first alone would also pass a fix that
// recognised everything (isOculistNode() always returning true), which would BREAK real
// rescans on genuine page mutations — infinite-scroll pages silently going stale is the
// exact failure the observer exists to prevent. The second test guards that direction.
//
// Needs a real browser: real WAAPI/layout to actually run Cyber-Vision, and CDP access to
// the finder's own isolated execution context (armMutationRescanCounter runs inside it) —
// same reasoning as cyber_vision.test.js/draft_ownership.test.js.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = `<!doctype html><meta charset="utf-8">
<p>${'filler words to fill the page. '.repeat(20)} <span id="target">phosphorescent</span> ${'more filler words trailing after the match. '.repeat(20)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';

describe("isOculistNode() recognises our own beacon-descendant writes but not real page mutations", () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP before navigating so the isolated-world execution-context-created event
    // is never missed.
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

    await setSettings({ effect: 'cybervision' });
    await openFinder();
    await page.locator(INPUT).type('phosphorescent', { delay: 30 });
    // Wait for the draft debounce to actually land a real match count (and fire the first
    // beacon) before either test arms its own counter, instead of guessing its duration.
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
        // Intentional unscaled sub-poll: the scaled waitForSelector below surfaces the
        // real timeout error if all 20 attempts fail.
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
  }

  function evalInContentScript(expression) {
    return client
      .send('Runtime.evaluate', {
        expression,
        contextId: isolatedContextId,
        awaitPromise: true,
        returnByValue: true,
      })
      .then((res) => {
        if (res.exceptionDetails) {
          throw new Error('content-script eval failed: ' + JSON.stringify(res.exceptionDetails));
        }
        return res.result.value;
      });
  }

  // chrome.storage.onChanged fires listeners in registration order, so observing our own
  // probe listener fire is a direct proxy for content.js's own listener (registered
  // earlier, at page load) having already applied the change.
  async function armSettingsEcho() {
    return evalInContentScript(`
      (function () {
        if (!window.__ocSettingsEchoInstalled) {
          window.__ocSettingsEchoInstalled = true;
          window.__ocSettingsEchoes = 0;
          chrome.storage.onChanged.addListener(function (changes) {
            if (changes['oc-settings']) window.__ocSettingsEchoes++;
          });
        }
        return window.__ocSettingsEchoes;
      })()
    `);
  }

  async function waitForSettingsEcho(before) {
    return waitForContentScriptValue(evalInContentScript, 'window.__ocSettingsEchoes', (v) => v > before, {
      timeout: POLL_TIMEOUT,
      message: 'oc-settings change never echoed into the content script',
    });
  }

  async function setSettings(patch) {
    const echoBefore = await armSettingsEcho();
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, ' + JSON.stringify(patch) + ');' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
    await waitForSettingsEcho(echoBefore);
  }

  // Same technique as draft_ownership.test.js's own armMutationRescanCounter: monkeypatch
  // window.setTimeout inside the content script's isolated world to count calls scheduled
  // at the mutation observer's own 350ms delay (content.js's sole use of that exact delay,
  // startDomObserver()'s domObserverTimer) that have actually fired.
  async function armMutationRescanCounter() {
    return evalInContentScript(`
      (function () {
        if (!window.__ocMutationRescanFiresInstalled) {
          window.__ocMutationRescanFiresInstalled = true;
          window.__ocMutationRescanFires = 0;
          var orig = window.setTimeout;
          window.setTimeout = function (fn, delay) {
            if (delay === 350) {
              var wrapped = function () {
                window.__ocMutationRescanFires++;
                return fn.apply(this, arguments);
              };
              var args = [wrapped, delay].concat(Array.prototype.slice.call(arguments, 2));
              return orig.apply(window, args);
            }
            return orig.apply(window, arguments);
          };
        }
        return window.__ocMutationRescanFires;
      })()
    `);
  }

  async function waitForMutationRescan(before) {
    return waitForContentScriptValue(evalInContentScript, 'window.__ocMutationRescanFires', (v) => v > before, {
      timeout: POLL_TIMEOUT,
      message: 'the mutation-observer rescan (350ms debounce) never fired',
    });
  }

  // Fires the beacon (same replay() idiom as cyber_vision.test.js): clears any leftover
  // .oc-beacon nodes, presses Enter to re-fire the active match's effect, and waits for
  // the fresh container to actually exist.
  async function replay() {
    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  test("Cyber-Vision's own readout.textContent write never schedules a background rescan", async () => {
    const before = await armMutationRescanCounter();
    await replay();
    // animateCyberVision() sets readout.textContent synchronously, so the write has
    // already landed by the time replay() resolves. Wait comfortably past the observer's
    // 350ms debounce before asserting nothing was scheduled — a regression here fires
    // inside that window, not after it.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = await evalInContentScript('window.__ocMutationRescanFires');
    assert.strictEqual(
      after,
      before,
      `expected Cyber-Vision's readout write to be recognised as our own, saw ${after - before} rescan(s) scheduled`
    );
  });

  // The guard on the fix above: a fix broad enough to swallow the readout write (e.g.
  // isOculistNode() returning true unconditionally) would also swallow this, which is the
  // dangerous direction — real page mutations must still schedule a rescan, or
  // infinite-scroll pages go stale.
  test('a genuine page mutation outside any oculist subtree still schedules a rescan', async () => {
    const before = await armMutationRescanCounter();
    await page.evaluate(() => {
      const marker = document.createElement('span');
      marker.textContent = 'real page content, not ours';
      document.body.appendChild(marker);
    });
    await waitForMutationRescan(before);
  });
});
