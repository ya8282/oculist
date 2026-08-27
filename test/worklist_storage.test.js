// Working-list session storage plumbing: content.js's loadWorkList/saveWorkList wrap
// chrome.storage.session under the 'oc-worklist' key. Content scripts can't read
// chrome.storage.session at all unless background.js's service-worker startup call to
// setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS') has run — so this needs a real
// browser with the real extension loaded, the same way color_picker_persistence.test.js
// does. A mocked chrome.storage would never exercise that access-level gate.
//
// Content scripts execute in an isolated JS world: nothing outside content.js's IIFE
// (including page.evaluate(), which runs in the page's main world) can call
// loadWorkList/saveWorkList directly, or even see window.__ocLoadWorkList — Chrome's
// isolated-world model does not expose content-script state to the page. There is also
// no extension-API bridge available here: chrome.scripting.executeScript needs a host
// permission or a fresh user gesture (activeTab) that this test cannot manufacture, and
// the manifest deliberately requests neither (per this bead's "no new permissions"
// constraint). The bridge that actually works, with zero extension-permission
// involvement, is raw CDP: attach a CDPSession, find the isolated execution context
// Chrome created for this extension's content script, and call Runtime.evaluate against
// that context directly. That runs genuinely inside content.js's isolated world — a real
// content-script-context call, not a mock.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world</p>';

const INPUT = '#oc-wrap >> .oc-input';

describe('Working-list session storage (oc-worklist)', () => {
  let server, ctx, page, client, isolatedContextId;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP and watch for execution-context creation *before* navigating, so the
    // event for the content script's isolated world (created once the extension injects
    // at document_idle) is never missed.
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    client.on('Runtime.executionContextCreated', (event) => {
      const c = event.context;
      // Every frame also gets a "default" (main-world) context and Playwright's own
      // utility-world context; the content script's world is the isolated one whose
      // origin is the extension itself, not the page.
      if (c.auxData && c.auxData.type === 'isolated' && c.origin && c.origin.indexOf('chrome-extension://') === 0) {
        isolatedContextId = c.id;
      }
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // The real precondition for Control+f doing anything is the content script's isolated
    // world existing at all — poll the execution-context-created flag instead of guessing
    // how long injection takes.
    {
      const deadline = Date.now() + 5000;
      while (!isolatedContextId) {
        if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    // Confirms the content script (and its window.__ocLoadWorkList/__ocSaveWorkList
    // hooks) has actually mounted before any test tries to reach into its world. Retry
    // Control+f itself (a keypress a not-yet-attached listener would otherwise silently
    // swallow) until the input actually appears, instead of trusting a single press.
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        await page.waitForSelector(INPUT, { timeout: 250 });
        break;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: 5000 });

    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function evalInContentScript(expression) {
    return client
      .send('Runtime.evaluate', {
        expression: expression,
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

  test('a read with no stored value yields the empty default', async () => {
    // Explicitly clear first — chrome.storage.session persists for the whole browser
    // session, not just this page load, so a prior test's write would otherwise leak in.
    await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.remove('oc-worklist', resolve))"
    );

    const result = await evalInContentScript(
      'new Promise((resolve) => window.__ocLoadWorkList((list) => resolve(list)))'
    );

    assert.deepStrictEqual(result, { terms: [], activeIndex: -1 });
  });

  test('a working list saved from a content-script context round-trips through loadWorkList', async () => {
    const saved = { terms: ['alpha', 'beta'], activeIndex: 1 };

    const result = await evalInContentScript(
      '(' +
        function () {
          return new Promise((resolve, reject) => {
            window.__ocSaveWorkList({ terms: ['alpha', 'beta'], activeIndex: 1 });
            // saveWorkList has no completion callback by design (its signature is
            // saveWorkList(list)) — poll the underlying chrome.storage.session write
            // directly until it actually lands, instead of guessing how long the async
            // set() call takes, before reading it back through loadWorkList. A generous
            // deadline: chrome.storage's IPC round trip to the extension/browser process
            // can lag well past a same-process JS timer under heavy CPU contention.
            var deadline = Date.now() + 15000;
            (function poll() {
              chrome.storage.session.get('oc-worklist', function (data) {
                var stored = data && data['oc-worklist'];
                if (stored && stored.terms && stored.terms.length === 2) {
                  window.__ocLoadWorkList(function (loaded) { resolve(loaded); });
                  return;
                }
                if (Date.now() > deadline) {
                  reject(new Error('chrome.storage.session write from saveWorkList() never landed'));
                  return;
                }
                setTimeout(poll, 30);
              });
            })();
          });
        }.toString() +
        ')()'
    );

    assert.deepStrictEqual(result, saved);

    // Confirm it is genuinely sitting in chrome.storage.session (not just echoed back by
    // an in-memory shortcut) — read it back directly, bypassing loadWorkList entirely.
    const stored = await evalInContentScript(
      "new Promise((resolve) => chrome.storage.session.get('oc-worklist', (data) => resolve(data['oc-worklist'])))"
    );
    assert.deepStrictEqual(stored, saved);
  });
});
