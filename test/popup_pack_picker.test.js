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
    // Rule: the picker handlers are wired before status-text leaves 'Checking...', so ready means clickable.
    await popup.click('#pack-picker-toggle');
    return popup;
  };
  const stored = (p) => readStoredSettings(p);
  // Writes enabledPacks back so a failing test cannot leak its changes into later ones.
  const writePacks = (popup, packs) => popup.evaluate((packs) => new Promise((r) => chrome.storage.sync.get('oc-settings', (d) => {
    const s = d['oc-settings'];
    s.enabledPacks = packs;
    chrome.storage.sync.set({ 'oc-settings': s }, r);
  })), packs);

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

  test('closed picker leaves the popup within its max-height and the chevron tracks open state', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#pack-picker-toggle');
    await waitForPopupReady(popup);
    const fit = await popup.evaluate(() => ({
      scroll: document.body.scrollHeight,
      client: document.body.clientHeight,
      footerBottom: document.querySelector('.footer').getBoundingClientRect().bottom,
      bodyBottom: document.body.getBoundingClientRect().bottom,
    }));
    assert.ok(fit.scroll <= fit.client, `body scrolls: ${fit.scroll} > ${fit.client}`);
    assert.ok(fit.footerBottom <= fit.bodyBottom, `footer overflows body: ${fit.footerBottom} > ${fit.bodyBottom}`);
    const chevron = () => popup.evaluate(() => getComputedStyle(document.getElementById('pack-picker-toggle'), '::after').transform);
    const closed = await chevron();
    await popup.click('#pack-picker-toggle');
    await waitForCondition(chevron, (t) => t !== closed, { timeout: POLL_TIMEOUT, message: 'chevron did not change on open' });
    await popup.click('#pack-picker-toggle');
    await waitForCondition(chevron, (t) => t === closed, { timeout: POLL_TIMEOUT, message: 'chevron did not revert on close' });
    await popup.close();
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
    try {
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
    } finally {
      await writePacks(popup, before.enabledPacks);
      await popup.close();
    }
  });

  test('unchecking a pack in the popup removes its effects from an open page', async () => {
    await page.bringToFront();
    await page.locator(GEAR).click();
    await page.waitForSelector(BONE_ROW, { timeout: POLL_TIMEOUT });

    const popup = await openPopup();
    const original = (await stored(popup)).enabledPacks;
    try {
      await popup.uncheck('input[data-pack="halloween"]');
      await page.bringToFront();
      await page.waitForSelector(BONE_ROW, { state: 'detached', timeout: POLL_TIMEOUT });

      await popup.bringToFront();
      await popup.check('input[data-pack="halloween"]');
      await page.bringToFront();
      await page.waitForSelector(BONE_ROW, { timeout: POLL_TIMEOUT });
    } finally {
      await writePacks(popup, original);
      await popup.close();
    }
  });

  // Makes chrome.storage.sync.set fail asynchronously with runtime.lastError until restoreStorage().
  // With failNextGet, the next get() also reports lastError with no data.
  const stubFailingSet = (popup, { failNextGet = false } = {}) => popup.evaluate((failNextGet) => {
    const orig = { set: chrome.storage.sync.set, get: chrome.storage.sync.get };
    window.__orig = orig;
    const setLastError = (v) => Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, get: () => v });
    chrome.storage.sync.set = (items, cb) => setTimeout(() => { setLastError({ message: 'quota' }); cb && cb(); setLastError(undefined); }, 0);
    if (failNextGet) {
      let armed = true;
      chrome.storage.sync.get = (k, cb) => {
        if (!armed) return orig.get.call(chrome.storage.sync, k, cb);
        armed = false;
        setTimeout(() => { setLastError({ message: 'unreadable' }); cb(undefined); setLastError(undefined); }, 0);
      };
    }
  }, failNextGet);
  const restoreStorage = (popup) => popup.evaluate(() => {
    if (!window.__orig) return; // test failed before the stub was installed
    chrome.storage.sync.set = window.__orig.set;
    chrome.storage.sync.get = window.__orig.get;
  });

  test('a failed save (set reports lastError) reverts the checkbox, logs, shows the error and restores in-memory packs', async () => {
    const popup = await openPopup();
    const before = (await stored(popup)).enabledPacks;
    assert.ok(before.includes('adventure') && before.includes('hollow'), 'seed should enable adventure and hollow');
    const logged = [];
    popup.on('console', (m) => { if (m.type() === 'error' && m.text().includes('Failed to save pack choice')) logged.push(m.text()); });
    try {
      await stubFailingSet(popup);
      await popup.click('input[data-pack="adventure"]');
      await popup.waitForFunction(
        () => document.getElementById('pack-picker-error').textContent === 'Could not save pack choice. Try again.',
        null, { timeout: POLL_TIMEOUT }
      );
      assert.strictEqual(await popup.isChecked('input[data-pack="adventure"]'), true);
      assert.strictEqual(logged.length, 1, 'fail() should console.error once');
      await restoreStorage(popup);
      assert.deepStrictEqual((await stored(popup)).enabledPacks, before);

      // In-memory restore: with the next read unreadable, the toggle falls back to the popup's own
      // packs. A stale failed change (adventure dropped) would leak into storage.
      await stubFailingSet(popup, { failNextGet: true });
      await popup.evaluate(() => { chrome.storage.sync.set = window.__orig.set; });
      await popup.uncheck('input[data-pack="hollow"]');
      await waitForCondition(() => stored(popup), (s) => !s.enabledPacks.includes('hollow'), {
        timeout: POLL_TIMEOUT, message: 'enabledPacks never lost hollow',
      });
      assert.deepStrictEqual((await stored(popup)).enabledPacks, before.filter((p) => p !== 'hollow'));
    } finally {
      await restoreStorage(popup);
      await writePacks(popup, before);
      await popup.close();
    }
  });

  test('a synchronous storage throw also shows the inline error and leaves storage unchanged', async () => {
    // Distinct path: the popup's own read throws, so writeOcSettings is never reached.
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

  test('two rapid toggles both persist', async () => {
    const popup = await openPopup();
    const original = (await stored(popup)).enabledPacks;
    const flipped = (id, s) => original.includes(id) !== s.enabledPacks.includes(id);
    const bothFlipped = (s) => flipped('hollow', s) && flipped('adventure', s);
    try {
      await popup.evaluate(() => {
        for (const id of ['hollow', 'adventure']) {
          const b = document.querySelector(`input[data-pack="${id}"]`);
          b.checked = !b.checked; b.dispatchEvent(new Event('change'));
        }
      });
      await waitForCondition(() => stored(popup), bothFlipped, {
        timeout: POLL_TIMEOUT, message: 'one of two rapid toggles was lost',
      });
    } finally {
      // Let in-flight toggle writes land first, or they overwrite the restore.
      await waitForCondition(() => stored(popup), bothFlipped, { timeout: POLL_TIMEOUT }).catch(() => {});
      await writePacks(popup, original);
      await popup.close();
    }
  });

  test('a pack change made elsewhere while the popup is open survives a popup toggle', async () => {
    const popup = await openPopup();
    const original = (await stored(popup)).enabledPacks;
    assert.ok(original.includes('adventure') && original.includes('hollow'), 'seed should enable adventure and hollow');
    try {
      // Simulates the page settings panel dropping adventure after the popup loaded.
      const other = await ctx.newPage();
      await other.goto(`chrome-extension://${extId}/popup.html`);
      await writePacks(other, original.filter((p) => p !== 'adventure'));
      await other.close();

      await popup.uncheck('input[data-pack="hollow"]');
      await waitForCondition(() => stored(popup), (s) => !s.enabledPacks.includes('hollow'), {
        timeout: POLL_TIMEOUT, message: 'enabledPacks never lost hollow',
      });
      const after = (await stored(popup)).enabledPacks;
      assert.deepStrictEqual(after, original.filter((p) => p !== 'adventure' && p !== 'hollow'));
    } finally {
      await writePacks(popup, original);
      await popup.close();
    }
  });
});
