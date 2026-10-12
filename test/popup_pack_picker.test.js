// oculist-fl9x.3: the popup's "Load effect packs" picker. Packs are bundled in content.js,
// so the picker only flips settings.enabledPacks in oc-settings; the open page picks it up
// through its storage.onChanged path.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForPopupReady, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');
const { readStoredSettings } = require('./helpers/storage');

const EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world</p>';
const INPUT = '#oc-wrap >> .oc-input';
const GEAR = '#oc-wrap >> [aria-label="Options"]';
const BONE_ROW = '#oc-wrap >> [data-oc-key="effect:boneassembly"]';

describe('popup pack list matches content.js', () => {
  test('ids, labels and effect counts equal what content.js defines', async () => {
    const content = fs.readFileSync(path.join(EXTENSION, 'content.js'), 'utf8');
    const expected = {};
    for (const m of content.matchAll(/\bpack: '(\w+)'/g)) {
      expected[m[1]] = (expected[m[1]] || 0) + 1;
    }
    const labels = {};
    const block = content.match(/var PACK_LABELS = \{([^}]*)\}/)[1];
    for (const m of block.matchAll(/(\w+): '([^']*)'/g)) labels[m[1]] = m[2];

    const popupSrc = fs.readFileSync(path.join(EXTENSION, 'popup.js'), 'utf8');
    const list = popupSrc.match(/const PACKS = (\[[\s\S]*?\n  \]);/);
    assert.ok(list, 'popup.js must define `const PACKS = [...]`');
    const packs = new Function('return ' + list[1])();

    assert.deepStrictEqual(
      packs.map((p) => ({ id: p.id, label: p.label, count: p.count })).sort((a, b) => a.id.localeCompare(b.id)),
      Object.keys(expected).sort().map((id) => ({ id, label: labels[id], count: expected[id] }))
    );
  });
});

describe('popup pack picker', () => {
  let server, ctx, page, extId;

  const openPopup = async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#pack-picker-toggle');
    await waitForPopupReady(popup);
    // The picker wiring runs after popup.js's own storage read; aria-controls is its marker.
    await popup.click('#pack-picker-toggle');
    return popup;
  };
  const stored = (p) => readStoredSettings(p);

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
    extId = sw.url().split('/')[2];

    page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Control+f');
      try { await page.waitForSelector(INPUT, { timeout: 250 }); break; } catch (e) { /* retry */ }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('toggling a pack writes enabledPacks and leaves every other field unchanged', async () => {
    // Seed non-default fields first (the popup itself fills in an empty visionSettings on any write).
    const seeder = await ctx.newPage();
    await seeder.goto(`chrome-extension://${extId}/popup.html`);
    await seeder.evaluate(() => new Promise((r) => chrome.storage.sync.get('oc-settings', (d) => {
      const s = d['oc-settings'];
      s.visionSettings = { beaconSize: 'l' };
      s.performanceMode = true;
      chrome.storage.sync.set({ 'oc-settings': s }, r);
    })));
    await seeder.close();
    const popup = await openPopup();
    assert.strictEqual(await popup.getAttribute('#pack-picker-toggle', 'aria-expanded'), 'true');
    const before = await stored(popup);
    assert.ok(before.enabledPacks.includes('hollow'), 'seed should have enabled hollow');

    await popup.uncheck('input[data-pack="hollow"]');
    await waitForCondition(() => stored(popup), (s) => !s.enabledPacks.includes('hollow'), {
      timeout: POLL_TIMEOUT, message: 'enabledPacks never lost hollow',
    });
    const after = await stored(popup);
    const { enabledPacks: b, ...restBefore } = before;
    const { enabledPacks: a, ...restAfter } = after;
    assert.deepStrictEqual(a, b.filter((p) => p !== 'hollow'));
    assert.deepStrictEqual(restAfter, restBefore);

    await popup.check('input[data-pack="hollow"]');
    await waitForCondition(() => stored(popup), (s) => s.enabledPacks.includes('hollow'), {
      timeout: POLL_TIMEOUT, message: 'enabledPacks never regained hollow',
    });
    await popup.close();
  });

  test('unchecking a pack in the popup removes its effects from an open page', async () => {
    await page.bringToFront();
    await page.locator(GEAR).click();
    await page.waitForSelector(BONE_ROW, { timeout: POLL_TIMEOUT });

    const popup = await openPopup();
    await popup.uncheck('input[data-pack="halloween"]');
    await page.bringToFront();
    await page.waitForSelector(BONE_ROW, { state: 'detached', timeout: POLL_TIMEOUT });

    await popup.bringToFront();
    await popup.check('input[data-pack="halloween"]');
    await page.bringToFront();
    await page.waitForSelector(BONE_ROW, { timeout: POLL_TIMEOUT });
    await popup.close();
  });

  test('a failed save shows an inline error and reverts the checkbox', async () => {
    const popup = await openPopup();
    const before = await stored(popup);
    await popup.evaluate(() => { chrome.storage.sync.get = () => { throw new Error('boom'); }; });
    await popup.click('input[data-pack="adventure"]');
    await popup.waitForFunction(
      () => document.getElementById('pack-picker-error').textContent === 'Could not save pack choice. Try again.',
      null, { timeout: POLL_TIMEOUT }
    );
    assert.strictEqual(await popup.isChecked('input[data-pack="adventure"]'), true);
    const p2 = await ctx.newPage();
    await p2.goto(`chrome-extension://${extId}/popup.html`);
    assert.deepStrictEqual((await stored(p2)).enabledPacks, before.enabledPacks);
    await p2.close();
    await popup.close();
  });
});
