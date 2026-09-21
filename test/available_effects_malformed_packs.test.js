// oculist-nq1x.1: availableEffects() (extension/content.js) reads
// settings.enabledPacks to decide whether a packed effectsRegistry entry is currently
// selectable. Before this bead it read `settings.enabledPacks || []`, which is only
// safe while no registry entry carries a `pack` field — the moment one does, indexOf
// becomes reachable against whatever chrome.storage.sync actually handed back, and a
// malformed stored value (not an array) either throws or silently produces the wrong
// answer. This file drives availableEffects() directly with six representative stored
// shapes and asserts every non-array one degrades to core-only, without throwing.
//
// No effectsRegistry entry ships with a `pack` on the real tree yet, so this file
// drives its own fixture instead of extension/content.js directly: a temp copy of
// extension/ whose content.js has its `cybervision` entry patched to carry
// `pack: 'seasonal'` — same idiom as pack_discovery_notice.test.js's
// createPackedFixtureExtension(). The real extension/content.js is never written to by
// this file.
//
// Needs a real browser: availableEffects() and settings.enabledPacks are both
// IIFE-internal closures in content.js, invisible to page.evaluate() (isolated JS
// world). The bridge is raw CDP, same as list_storage.test.js/trail_effect.test.js:
// attach a CDPSession, find the isolated execution context Chrome created for the
// extension's content script, and call Runtime.evaluate against that context directly.
// window.__ocTest.setEnabledPacksRaw/getAvailableEffectKeys (content.js, added by this
// bead) are the sanctioned test-only hooks this file calls through that bridge.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const REAL_EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

const INPUT = '#oc-wrap >> .oc-input';

// Every core (unpacked) effectsRegistry key on the real tree, minus the one this
// fixture patches to carry `pack: 'seasonal'` (cybervision) — kept in sync manually
// since this is a fixed, curated list rather than something parsed out of content.js
// (effect_enumeration_sync.test.js already owns keeping the registry's own labels in
// sync with docs; this file only needs the key set that availableEffects() must return
// when packs are unavailable).
const CORE_KEYS = [
  'hud', 'iris', 'sweep', 'flame', 'lightning', 'electron',
  'arrows', 'dispersion', 'trail', 'speedlines', 'chrono',
];
const PACKED_KEY = 'cybervision';

function sorted(arr) {
  return arr.slice().sort();
}

// Copies extension/ into a fresh temp dir and patches the copy's content.js so exactly
// one effectsRegistry entry (`cybervision`) carries `pack: 'seasonal'` — the one thing
// needed to make availableEffects()'s indexOf call reachable. Same fixture idiom as
// pack_discovery_notice.test.js / effect_pack_settings_control.test.js. Never touches
// extension/content.js itself.
function createPackedFixtureExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oculist-available-effects-'));
  fs.cpSync(REAL_EXTENSION, dir, { recursive: true });

  const contentJsPath = path.join(dir, 'content.js');
  const original = fs.readFileSync(contentJsPath, 'utf8');
  const target = "cybervision: { label: i18n.effectCyberVision, run: animateCyberVision }";
  const patched = "cybervision: { label: i18n.effectCyberVision, run: animateCyberVision, pack: 'seasonal' }";
  assert.ok(
    original.includes(target),
    'fixture setup: expected effectsRegistry.cybervision entry text not found in extension/content.js — did its shape change?'
  );
  fs.writeFileSync(contentJsPath, original.replace(target, patched), 'utf8');

  return dir;
}

describe('availableEffects() guards a malformed settings.enabledPacks (oculist-nq1x.1)', () => {
  let server, ctx, page, client, isolatedContextId, fixtureDir;

  before(async () => {
    fixtureDir = createPackedFixtureExtension();

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${fixtureDir}`, `--load-extension=${fixtureDir}`],
      viewport: { width: 1280, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP and watch for execution-context creation *before* navigating, so the
    // event for the content script's isolated world is never missed.
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
    const deadline = Date.now() + POLL_TIMEOUT;
    while (!isolatedContextId) {
      if (Date.now() > deadline) throw new Error('never observed the content script isolated execution context');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await openFinder();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    // Only ever removes the temp copy created above — never touches extension/ itself.
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
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
        returnByValue: true,
      })
      .then((res) => {
        if (res.exceptionDetails) {
          throw new Error('content-script eval failed: ' + JSON.stringify(res.exceptionDetails));
        }
        return res.result.value;
      });
  }

  // Sets settings.enabledPacks to `value` (an arbitrary, possibly-malformed shape) via
  // the sanctioned test hook, directly — bypassing chrome.storage and the load/
  // storage-change Array.isArray coercions entirely — then reads back
  // availableEffects()'s key set through the sibling hook. Returns
  // { keys, threw, error }: `threw`/`error` let a case assert "must not throw" as a
  // first-class outcome, distinct from "returned the wrong keys".
  async function setPacksAndGetAvailableKeys(value) {
    // JSON.stringify(undefined) is JS `undefined` (not the string "undefined"), so a
    // template literal renders it as the bare identifier `undefined` — still valid
    // syntax for "pass the JS value undefined" for every value below, including
    // undefined itself.
    const literal = JSON.stringify(value);
    await evalInContentScript(`window.__ocTest.setEnabledPacksRaw(${literal})`);
    try {
      const keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      return { keys, threw: false, error: null };
    } catch (err) {
      return { keys: null, threw: true, error: err };
    }
  }

  const NON_ARRAY_CASES = [
    // A string equal to the packed entry's own pack id: under the old
    // `settings.enabledPacks || []` this is truthy so it is kept as-is, and
    // String.prototype.indexOf('seasonal') on the string "seasonal" itself returns 0
    // (not -1) — silently and incorrectly admitting the packed effect. It does not
    // throw, but it does return the wrong key set, which is exactly what the done-
    // criteria requires this case to catch.
    { label: 'a string', value: 'seasonal' },
    // A number: `42 || []` keeps 42 (truthy), and Number.prototype has no indexOf, so
    // the old code throws a TypeError as soon as the packed entry's `pack` makes
    // indexOf reachable.
    { label: 'a number', value: 42 },
    // null is falsy, so `null || []` already produced [] under the old code too — this
    // case is not expected to fail red, it's included because the done-criteria lists
    // it as one of the six shapes the fix must handle.
    { label: 'null', value: null },
    // undefined is falsy for the same reason as null.
    { label: 'undefined', value: undefined },
    // A plain object: truthy, and Object.prototype has no indexOf, so the old code
    // throws a TypeError the same way the number case does.
    { label: 'a plain object', value: { seasonal: true } },
  ];

  NON_ARRAY_CASES.forEach(({ label, value }) => {
    test(`settings.enabledPacks as ${label} degrades to core-only effects, without throwing`, async () => {
      const result = await setPacksAndGetAvailableKeys(value);
      assert.strictEqual(
        result.threw,
        false,
        `availableEffects() must not throw when settings.enabledPacks is ${label} ` +
          `(${JSON.stringify(value)}) — it is on the load path and every settings-panel render. ` +
          `Got: ${result.error ? result.error.message : ''}`
      );
      assert.deepStrictEqual(
        sorted(result.keys),
        sorted(CORE_KEYS),
        `availableEffects() must return exactly the core effect keys when settings.enabledPacks is ` +
          `${label} (${JSON.stringify(value)}) — got ${JSON.stringify(sorted(result.keys))}`
      );
    });
  });

  test('a valid array containing the packed id is unchanged: the packed effect is offered', async () => {
    const result = await setPacksAndGetAvailableKeys(['seasonal']);
    assert.strictEqual(result.threw, false, 'a valid array must never throw');
    assert.deepStrictEqual(
      sorted(result.keys),
      sorted(CORE_KEYS.concat([PACKED_KEY])),
      'a valid array containing the packed id must offer every core effect plus the packed one'
    );
  });

  test('a valid, empty array is unchanged: still core-only', async () => {
    const result = await setPacksAndGetAvailableKeys([]);
    assert.strictEqual(result.threw, false, 'an empty array must never throw');
    assert.deepStrictEqual(
      sorted(result.keys),
      sorted(CORE_KEYS),
      'an empty array must offer only the core effects'
    );
  });
});
