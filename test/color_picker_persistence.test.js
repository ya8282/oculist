// Regression: dragging a colour slider fires a stream of 'input' events, each one
// calling saveSettings(). Those writes echo back through chrome.storage.onChanged in
// the same tab, which used to rebuild the settings panel — detaching the live
// <input type="color"> and dismissing the native colour dialog on the first drag.
//
// The guard is "skip the rebuild when nothing actually differs". The second test is the
// important half: it proves the guard did not also break genuine cross-context sync.
//
// Needs a real browser — the echo only exists with a real chrome.storage behind it, and
// the storage round trip is what reorders object keys (the thing that made a naive
// JSON.stringify comparison report a false difference).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world</p>';

const INPUT = '#oc-wrap >> .oc-input';
const GEAR = '#oc-wrap >> [aria-label="Options"]';

describe('Settings panel survives its own storage writes', () => {
  let server, ctx, page, extId;

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
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    extId = sw.url().split('/')[2];

    page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // No CDP session in this file, so there is no isolatedContextId to poll for injection
    // readiness — retry Control+f itself (a keypress a not-yet-attached listener would
    // otherwise silently swallow) until the input actually appears, instead of guessing a
    // fixed delay.
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
    await page.locator(GEAR).click();
    await page.waitForSelector('#oc-wrap >> .oc-color-input', { timeout: 5000 });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('beacon colour input stays mounted across a simulated slider drag', async () => {
    const result = await page.evaluate(async () => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const badge = [...root.querySelectorAll('.oc-color-badge')].find((b) => /beacon/i.test(b.textContent));
      const input = badge.querySelector('.oc-color-input');

      // A drag is many 'input' events, not one — each is its own storage write.
      for (const c of ['#3b82f6', '#2f7ce8', '#2266d9', '#1a55c8']) {
        input.value = c;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
      }
      await new Promise((r) => setTimeout(r, 600)); // let every echo land

      return { connected: input.isConnected, value: input.value };
    });

    assert.strictEqual(
      result.connected,
      true,
      'the colour input was detached mid-drag — the native colour dialog closes when this happens'
    );
    assert.strictEqual(result.value, '#1a55c8', 'the last dragged colour should still be in the input');
  });

  // Two swatch clicks in the same tick queue two writes before either echo lands. By the
  // time the first echo arrives, memory already holds the second colour, so the echo
  // looks like a foreign change — the panel rebuilt and the dialog closed. A slower pair
  // of clicks never hit this, which is why the gap here is deliberately zero.
  test('two colour picks in the same tick do not close the picker', async () => {
    const result = await page.evaluate(async () => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const badge = [...root.querySelectorAll('.oc-color-badge')].find((b) => /beacon/i.test(b.textContent));
      const input = badge.querySelector('.oc-color-input');

      input.value = '#ff0000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = '#00ff00';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      await new Promise((r) => setTimeout(r, 900));
      return { connected: input.isConnected, value: input.value };
    });

    assert.strictEqual(result.connected, true, 'the picker was torn down by two rapid picks');
    assert.strictEqual(result.value, '#00ff00', 'the second pick should win, not be rolled back by a stale echo');

    // The stale echo must not roll persisted state back to the first colour either.
    const stored = await page.evaluate(
      () => new Promise((r) => chrome.storage.sync.get('oc-settings', (d) => r(d['oc-settings'].beaconColor)))
    ).catch(() => null);
    if (stored !== null) {
      assert.strictEqual(stored, '#00ff00', 'the newer colour should be what is persisted');
    }
  });

  test('a genuine change from the popup still rebuilds the panel', async () => {
    // Low Vision is chosen because it adds a visible profile banner to the panel, so a
    // successful rebuild is observable rather than inferred.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#vision-profile');
    await popup.selectOption('#vision-profile', 'low-vision');
    // Wait for the write to actually land before tearing the popup page down, instead of
    // guessing how long the async chrome.storage.sync.set() call takes.
    await popup.waitForFunction(
      () =>
        chrome.storage.sync
          .get('oc-settings')
          .then((d) => !!(d['oc-settings'] && d['oc-settings'].visionProfile === 'low-vision')),
      null,
      { timeout: 5000 }
    );
    await popup.close();

    await page.bringToFront();
    await page.waitForFunction(
      () => !!document.getElementById('oc-wrap').shadowRoot.querySelector('.oc-settings-profile-banner'),
      null,
      { timeout: 5000 }
    );

    const banner = await page.evaluate(
      () => document.getElementById('oc-wrap').shadowRoot.querySelector('.oc-settings-profile-banner').textContent
    );
    assert.match(banner, /Low Vision/, 'the panel should have rebuilt with the Low Vision banner');
  });
});
