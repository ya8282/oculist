// github.com re-renders through its own client-side router in a way the finder cannot
// follow, so it ships disabled. This is a default rather than a hard block: the per-site
// popup toggle still turns it on, and a seeded flag stops a later extension update from
// undoing that choice.
//
// github.com is served locally via request interception, so the suite stays offline.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const BODY = '<!doctype html><meta charset="utf-8"><p>hello quarklet world</p>';

const INPUT = '#oc-wrap >> .oc-input';

describe('Default site blocklist', () => {
  let ctx;

  const openPage = async (url) => {
    const page = await ctx.newPage();
    // Serve both hosts locally — no network, and the page still reports the real hostname,
    // which is the only thing the disabled check looks at.
    await page.route('**/*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: BODY })
    );
    await page.goto(url);
    return page;
  };

  // No CDP session in this file, so there is no isolatedContextId to poll for injection
  // readiness — retry Control+f itself (a keypress a not-yet-attached listener would
  // otherwise silently swallow) until the input actually appears, instead of guessing a
  // fixed delay. Used by the tests that expect the finder to actually open.
  const openFinder = async (page) => {
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
  };

  before(async () => {
    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
    // An empty user-data dir means this counts as a fresh install, so onInstalled fires
    // and seeds the blocklist. Wait for that to land before asserting anything.
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
    await sw.evaluate(
      () =>
        new Promise((resolve) => {
          const poll = () =>
            chrome.storage.sync.get('oc-settings', (d) => {
              if (d && d['oc-settings'] && d['oc-settings'].seededDefaultBlocklist) resolve();
              else setTimeout(poll, 100);
            });
          poll();
        })
    );
  });

  after(async () => {
    if (ctx) await ctx.close();
  });

  test('github.com ships disabled, so Ctrl+F falls through to the browser', async () => {
    const page = await openPage('https://github.com/anthropics/claude-code');
    // No positive signal to wait on here (the point is that nothing happens) — press
    // Control+f repeatedly over a bounded window instead of a single guessed-duration
    // attempt, so a content script that simply was not finished injecting yet (a false
    // "blocked" reading) cannot be mistaken for the real disabled-site behaviour under
    // test: if it were only "not ready", a later retry in this same loop would open it.
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.keyboard.press('Control+f');
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (await page.evaluate(() => !!document.getElementById('oc-wrap'))) break;
    }
    assert.strictEqual(
      await page.evaluate(() => !!document.getElementById('oc-wrap')),
      false,
      'the finder should not open on github.com'
    );
    await page.close();
  });

  test('other sites are unaffected', async () => {
    const page = await openPage('https://example.com/');
    await openFinder(page);
    assert.strictEqual(await page.evaluate(() => !!document.getElementById('oc-wrap')), true);
    await page.close();
  });

  test('the block is a default, not a lock — re-enabling github.com works', async () => {
    // Same data path the popup's per-site toggle writes.
    const sw = ctx.serviceWorkers()[0];
    await sw.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.storage.sync.get('oc-settings', (d) => {
            const s = d['oc-settings'];
            s.disabledSites = s.disabledSites.filter((h) => h !== 'github.com');
            chrome.storage.sync.set({ 'oc-settings': s }, resolve);
          });
        })
    );

    const page = await openPage('https://github.com/anthropics/claude-code');
    await openFinder(page);
    assert.strictEqual(
      await page.evaluate(() => !!document.getElementById('oc-wrap')),
      true,
      'a user who re-enables github.com should get the finder back'
    );
    await page.close();
  });
});
