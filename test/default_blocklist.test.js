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
    await page.waitForTimeout(600);
    return page;
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
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
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
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(600);
    assert.strictEqual(
      await page.evaluate(() => !!document.getElementById('oc-wrap')),
      false,
      'the finder should not open on github.com'
    );
    await page.close();
  });

  test('other sites are unaffected', async () => {
    const page = await openPage('https://example.com/');
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
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
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    assert.strictEqual(
      await page.evaluate(() => !!document.getElementById('oc-wrap')),
      true,
      'a user who re-enables github.com should get the finder back'
    );
    await page.close();
  });
});
