// Regression (oculist-44y, Site A): same hazard family as oculist-rbx (3ddc082),
// oculist-tz6 (80f2a30), and oculist-7uc (3ab9005), but at a fourth site — the bare
// `setTimeout(function () { animate(freshRect); }, 50)` in highlightActiveRange()'s
// instant-scroll-behavior sub-branch (the `behavior !== 'smooth'` else, taken when
// settings.scrollBehavior === 'instant'). Unlike the smooth-scroll branch a few lines
// above, this timer had no module-level handle at all — nothing for any teardown to
// reach, so neither __ocDestroy() nor a superseding navigation could cancel it.
//
// scrollBehavior: 'instant' is user-selectable from the settings panel (the
// 'smooth'/'instant' option group next to i18n.scrollBehavior), so this path is
// reachable from normal UI, not just theoretically.
//
// Reachable in practice via the same window.__ocToggle() close+reopen path as
// oculist-tz6: element.scrollIntoView({behavior:'auto', ...}) jumps synchronously, but
// the bare 50ms timer that draws the border afterward is still pending. Closing and
// reopening within that window (__ocToggle() calls __ocDestroy() then buildUI() in the
// same module instance) pre-fix left the orphaned timer to paint a stale border onto
// the freshly rebuilt, empty overlay.
//
// Needs a real browser for the same reasons as the sibling stale-draw tests: real
// layout/scrolling and 'scrollend' don't exist in jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// m1 is in view at load (no scroll branch, exercises the ordinary in-viewport draw).
// mfar sits 6000px below so it needs a scroll; distance itself is irrelevant to this
// bug (an 'auto' scrollIntoView jumps synchronously regardless of distance) but keeps
// it safely out of the initial viewport.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<p id="m1">quarklet</p>
<div style="height:6000px"></div>
<p id="mfar">quarklet</p>
<div style="height:6000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('closing and reopening within an instant-behavior scroll draws only the legitimate match (oculist-44y)', () => {
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
    await waitForIsolatedContext();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function waitForIsolatedContext() {
    const deadline = Date.now() + POLL_TIMEOUT;
    while (!isolatedContextId) {
      if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

  async function setSettings(patch) {
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, ' + JSON.stringify(patch) + ');' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
  }

  // Same rationale as the sibling stale-draw tests: borderStyle:'thick' with the
  // magnifier/labels off leaves exactly one non-transient `.oc-beacon` (the border)
  // drawn per animate() call, which is what the redraw counter below watches for.
  async function setVisionSettings(patch) {
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var vs = Object.assign({}, current.visionSettings || {}, ' + JSON.stringify(patch) + ');' +
        'var next = Object.assign({}, current, { visionSettings: vs });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
  }

  async function openFinder() {
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        // Intentional unscaled sub-poll: the scaled waitForSelector below surfaces
        // the real timeout error if all 20 attempts fail.
        await page.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
  }

  // Arms a MutationObserver that counts every time a brand-new, non-transient border
  // overlay (`.oc-beacon`, no id) lands in the DOM, and records the timestamp of the
  // most recent one so callers can wait for the count to go quiet instead of guessing a
  // fixed duration.
  async function armRedrawCounter() {
    await page.evaluate(() => {
      window.__ocRedrawCount = 0;
      window.__ocRedrawAt = performance.now();
      if (window.__ocRedrawObserver) window.__ocRedrawObserver.disconnect();
      window.__ocRedrawObserver = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (
              n.nodeType === 1 &&
              n.classList &&
              n.classList.contains('oc-beacon') &&
              !n.classList.contains('oc-beacon-transient') &&
              !n.id
            ) {
              window.__ocRedrawCount++;
              window.__ocRedrawAt = performance.now();
            }
          }
        }
      });
      window.__ocRedrawObserver.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  async function waitForRedrawCountToSettle() {
    const QUIET_MS = 400;
    await page.waitForFunction(
      (quiet) => window.__ocRedrawCount > 0 && performance.now() - window.__ocRedrawAt > quiet,
      QUIET_MS,
      { timeout: POLL_TIMEOUT }
    );
    return page.evaluate(() => window.__ocRedrawCount);
  }

  test('close+reopen within an in-flight instant scroll draws only the legitimate in-view match, never a stale one', async () => {
    await setSettings({ scrollBehavior: 'instant' });
    await setVisionSettings({ borderStyle: 'thick', magnifier: false, textLabels: false, motionSensitivity: 'full' });
    await openFinder();

    await page.locator(INPUT).fill('quarklet');
    // Wait for the draft debounce to actually land a real match count before firing,
    // instead of guessing its duration.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    await armRedrawCounter();

    // Enter #1: commits the typed term as a chip, landing on m1 — already in view, no
    // scroll branch, draws once.
    await page.keyboard.press('Enter');
    // Let m1's own draw land for real before moving on, so the count below isolates
    // this bug (mfar's orphaned instant-branch timer) instead of conflating it with a
    // second, still-pending in-viewport draw of its own (oculist-44y Site B, covered by
    // its own regression test).
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Enter #2: findNext() to mfar — out of view, takes the instant-behavior branch,
    // jumps synchronously, and arms the bare 50ms draw timer under test.
    await page.keyboard.press('Enter');

    // Close, then reopen, via window.__ocToggle() directly — the same function the
    // Ctrl+F command and the 'toggle'/'destroy' runtime messages invoke, well within
    // mfar's 50ms window. Pre-fix, __ocDestroy() leaves that orphaned timer armed; it
    // fires later and paints a stale border onto the freshly rebuilt, empty overlay.
    await evalInContentScript('window.__ocToggle()'); // destroy
    await evalInContentScript('window.__ocToggle()'); // rebuild

    // Confirm the reopen actually happened (a fresh #oc-wrap/.oc-input exist) before
    // trusting the draw count below — otherwise a failed reopen would pass vacuously.
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    const reopenedInputValue = await page.locator(INPUT).inputValue();
    assert.strictEqual(reopenedInputValue, '', 'the reopened overlay must start with an empty, un-searched input');

    const count = await waitForRedrawCountToSettle();

    assert.strictEqual(
      count,
      1,
      'closing and reopening mid instant-scroll must not leave behind a stale draw for the ' +
        'match the in-flight scroll was navigating to — only the initial in-view match should ever draw'
    );
  });
});
