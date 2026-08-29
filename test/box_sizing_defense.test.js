// Defensive box-sizing (oculist-6p6): beacon elements whose geometry depends on width/
// height combined with border (e.g. Cyber-Vision's targeting brackets, content.js:2856-2863
// — 15px box, 2px border) assume the host page leaves box-sizing at its content-box default.
// Oculist injects into arbitrary host pages, and a very large fraction of real sites ship a
// global reset such as 'html, body, *, *::before, *::after { box-sizing: border-box }'. Since
// beacon elements are appended to document.documentElement/document.body, a universal host
// selector WILL match them, and under border-box the border draws INSIDE the declared
// width/height instead of outside it, shrinking every such element's rendered box.
//
// The fix pins an explicit 'box-sizing:content-box' in the cssText of every beacon element
// whose geometry depends on it (see content.js's per-element comments), so host-page CSS can
// never re-interpret their box model regardless of what the host page does. This test proves
// that fix by rendering the SAME beacon on two otherwise-identical fixture pages — one with
// a realistic (no !important) border-box reset, one without — and asserting the rendered
// geometry is identical either way. It must fail on unfixed code (verified by temporarily
// reverting the content.js fix and re-running this file alone: the brackets render up to
// 2 * (number of border sides) px smaller/differently-positioned under the reset without the
// fix).
//
// Cyber-Vision's four targeting brackets (content.js:2856-2863) are exercised: the exact
// geometry reported by the oculist-dvt.4 re-reviewer. Checked via getBoundingClientRect() once
// content.js's own cyberVisionBracketsSettled flag confirms each bracket has finished its
// snap-in keyframe and is holding at transform: translate(0,0) — mirrors cyber_vision.
// test.js's own waitForBracketsSettled() timing, which is not a guess: it is real math
// derived from this run's own scheduled BRACKET_DELAY/BRACKET_DUR.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target is the text the finder searches for and the beacon fires on.
function buildPage(withBorderBoxReset) {
  const reset = withBorderBoxReset
    ? '<style>html, body, *, *::before, *::after { box-sizing: border-box; }</style>'
    : '';
  return `<!doctype html><meta charset="utf-8">
${reset}
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; background:#06080D; color:#ccc; }</style>
<p>${'filler words to fill the page and give the beacon room to render. '.repeat(30)} <span id="target">trapezohedron</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;
}

const INPUT = '#oc-wrap >> .oc-input';
const BRACKET = '.oc-cv-bracket';
const SEARCH_TERM = 'trapezohedron';

describe('Beacon geometry does not depend on host-page box-sizing (oculist-6p6)', () => {
  let server, plainOrigin, borderBoxOrigin;

  before(async () => {
    server = http.createServer((req, res) => {
      const withReset = req.url.indexOf('/borderbox') === 0;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buildPage(withReset));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    plainOrigin = `http://127.0.0.1:${port}/plain`;
    borderBoxOrigin = `http://127.0.0.1:${port}/borderbox`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // Renders the audited beacon on a fresh, isolated persistent context navigated to `url`,
  // and returns its real rendered geometry. Each call gets its own browser context (not
  // shared across the two fixture pages) so nothing about one page's chrome.storage.sync
  // state, DOM, or timing can bleed into the other's measurement.
  async function measureGeometry(url) {
    const ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1200, height: 800 },
    });

    try {
      const page = await ctx.newPage();
      const client = await ctx.newCDPSession(page);
      await client.send('Page.enable');
      await client.send('Runtime.enable');

      let isolatedContextId;
      client.on('Runtime.executionContextCreated', (event) => {
        const c = event.context;
        if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
          isolatedContextId = c.id;
        }
      });

      await page.goto(url);
      await waitForCondition(() => isolatedContextId, Boolean, {
        timeout: POLL_TIMEOUT,
        message: 'never observed the content script isolated execution context',
      });

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

      // Mirrors cyber_vision.test.js's own armSettingsEcho/waitForSettingsEcho/setSettings
      // trio: chrome.storage.onChanged fires listeners in registration order, so observing
      // our own probe listener fire is a direct proxy for content.js's own listener (already
      // registered, at page load) having applied the change.
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

      async function openFinder() {
        for (let attempt = 0; attempt < 20; attempt++) {
          await page.keyboard.press('Control+f');
          try {
            await page.waitForSelector(INPUT, { timeout: 250 });
            return;
          } catch (e) {
            // keep retrying
          }
        }
        await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
      }

      async function replay() {
        await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
        await page.keyboard.press('Enter');
      }

      async function waitForBracketsSettled() {
        await waitForContentScriptValue(
          evalInContentScript,
          'window.__ocTest.cyberVisionBracketsSettled',
          (v) => v === true,
          {
            timeout: POLL_TIMEOUT,
            message: 'cyber-vision brackets never finished snapping in',
          }
        );
      }

      await setSettings({ effect: 'cybervision' });
      await openFinder();
      await page.locator(INPUT).type(SEARCH_TERM, { delay: 30 });
      // Wait for the draft debounce to actually land a real match count before firing.
      await page.waitForFunction(
        () => {
          const root = document.getElementById('oc-wrap');
          const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
          return !!count && /of \d+/.test(count.textContent);
        },
        null,
        { timeout: POLL_TIMEOUT }
      );

      await replay();
      await page.waitForSelector(BRACKET, { timeout: POLL_TIMEOUT });
      await waitForBracketsSettled();

      const bracketGeometry = await page.evaluate((sel) => {
        const target = document.getElementById('target');
        const m = target.getBoundingClientRect();
        const brackets = Array.from(document.querySelectorAll(sel)).map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        });
        return { match: { left: m.left, top: m.top, right: m.right, bottom: m.bottom }, brackets };
      }, BRACKET);

      assert.strictEqual(
        bracketGeometry.brackets.length,
        4,
        `sanity check: expected exactly 4 corner brackets, got ${bracketGeometry.brackets.length}`
      );

      return { bracketGeometry };
    } finally {
      await ctx.close();
    }
  }

  test('Cyber-Vision bracket geometry is identical with and without a host-page box-sizing:border-box reset', async () => {
    // Sequential, not parallel: two full browser contexts + extensions competing for the
    // same CPU is exactly the kind of contention the oculist-li8 flake note warns about, and
    // this test has no need to race them against each other.
    const withoutReset = await measureGeometry(plainOrigin);
    const withReset = await measureGeometry(borderBoxOrigin);

    // Sanity: the page layout itself (not just the beacons) must be identical between the two
    // fixtures, or a real difference in bracket geometry could be masked by/mistaken for a
    // difference in where the match itself rendered. Neither fixture page sets an explicit
    // width alongside padding anywhere the reset could affect, so the match rect should not
    // move at all.
    const m1 = withoutReset.bracketGeometry.match;
    const m2 = withReset.bracketGeometry.match;
    assert.deepStrictEqual(
      m1,
      m2,
      `sanity check: expected the match's own rect to be identical between fixtures (the reset must not itself move page content), got ${JSON.stringify(m1)} vs ${JSON.stringify(m2)}`
    );

    const TOLERANCE = 0.5; // subpixel rendering slack between two independent browser contexts
    for (let i = 0; i < 4; i++) {
      const b1 = withoutReset.bracketGeometry.brackets[i];
      const b2 = withReset.bracketGeometry.brackets[i];
      for (const key of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
        const d = Math.abs(b1[key] - b2[key]);
        assert.ok(
          d <= TOLERANCE,
          `bracket ${i}'s ${key} differs between the plain fixture (${b1[key]}) and the border-box-reset fixture ` +
            `(${b2[key]}) by ${d}px — Cyber-Vision's bracket geometry must be identical regardless of host-page ` +
            `box-sizing (bracket ${i} full rects: without-reset=${JSON.stringify(b1)}, with-reset=${JSON.stringify(b2)})`
        );
      }
    }
  });
});
