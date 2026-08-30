// Regression coverage for oculist-rnr.12: the persisted 'oc-settings' object used to carry
// clinical labels under two different fields — 'visionProfile' (e.g.
// 'color-blind-deuteranopia', 'low-vision', 'eye-strain') and
// 'visionSettings.colorPalette' ('deuteranopia'/'protanopia'/'tritanopia') — both
// self-reported health facts once they round-trip through chrome.storage.sync into the
// user's Google account. content.js now migrates both fields, in the same pass, on the
// first content-script load that observes either one: visionProfile becomes 'displayPreset'
// (the legacy field is deleted), and colorPalette's three clinical values become their
// functional replacements (the field name itself is unchanged). This must run in a real
// browser: the migration lives inside content.js's own
// chrome.storage.sync.get('oc-settings', ...) boot path, which only exists once the
// extension is loaded into a real Chromium instance (no jsdom equivalent), and has to be
// observed through the real chrome.storage.sync API, not re-derived from source.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT, LONG_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const PAGE = '<!doctype html><meta charset="utf-8"><p>alpha beta gamma</p>';

// Every legacy visionProfile value this bead's migration table must translate, and the
// functional displayPreset value it must become. Mirrors content.js's own
// LEGACY_DISPLAY_PRESET_MAP — kept as a literal here (not imported) so this test would
// actually notice content.js's table drifting, rather than trivially agreeing with itself.
const LEGACY_CASES = [
  { legacy: 'low-vision', expected: 'high-contrast' },
  { legacy: 'color-blind-deuteranopia', expected: 'rg-adjust-deut' },
  { legacy: 'color-blind-protanopia', expected: 'rg-adjust-prot' },
  { legacy: 'color-blind-tritanopia', expected: 'by-adjust' },
  { legacy: 'eye-strain', expected: 'reduced-motion' },
  { legacy: 'custom', expected: 'custom' },
];

// Every legacy visionSettings.colorPalette value this bead's migration table must
// translate, and the functional value it must become. Mirrors content.js's own
// LEGACY_COLOR_PALETTE_MAP, kept as a literal here for the same reason as LEGACY_CASES
// above. 'default'/'warm'/'custom' were already functional and are deliberately not in
// this list — they must survive migration completely untouched.
const LEGACY_PALETTE_CASES = [
  { legacy: 'deuteranopia', expected: 'amber-sky' },
  { legacy: 'protanopia', expected: 'amber-indigo' },
  { legacy: 'tritanopia', expected: 'rose-cyan' },
];

describe('displayPreset + colorPalette migration (oculist-rnr.12)', () => {
  let server, ctx, origin, sw, extId;
  const pageErrors = [];
  const consoleErrors = [];

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
    sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: LONG_TIMEOUT }));
    extId = sw.url().split('/')[2];

    // An empty user-data dir means this counts as a fresh install, so background.js's own
    // onInstalled listener fires and seeds the default blocklist. That write races this
    // file's own seedOcSettings() calls below — wait for it to land first (same pattern as
    // default_blocklist.test.js), or the extension's own seed can clobber this file's first
    // legacy-value seed before the first page ever loads.
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
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // Replaces the whole 'oc-settings' value in chrome.storage.sync (not a merge) — every
  // case below starts from a clean, fully-specified legacy-shaped object, rather than risk
  // leftover fields from a previous case/migration bleeding into the next assertion.
  function seedOcSettings(sw, value) {
    return sw.evaluate(
      (v) => new Promise((resolve) => chrome.storage.sync.set({ 'oc-settings': v }, resolve)),
      value
    );
  }

  function readOcSettings(sw) {
    return sw.evaluate(() => new Promise((resolve) => chrome.storage.sync.get('oc-settings', (d) => resolve(d['oc-settings']))));
  }

  // Opens a fresh page (a fresh content-script instance, and therefore a fresh run of
  // content.js's boot-time chrome.storage.sync.get('oc-settings', ...) migration branch),
  // tracking page/console errors so "does not throw" is actually checked, not assumed from
  // the absence of a thrown Promise rejection.
  async function openTrackedPage() {
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.goto(origin);
    await page.waitForLoadState('load');
    return page;
  }

  for (const { legacy, expected } of LEGACY_CASES) {
    test(`legacy visionProfile ${JSON.stringify(legacy)} migrates to displayPreset ${JSON.stringify(expected)}`, async () => {
      await seedOcSettings(sw, {
        disabledSites: [],
        performanceMode: false,
        visionProfile: legacy,
        visionSettings: {},
        setupWizardCompleted: true,
        seededDefaultBlocklist: true,
      });

      const page = await openTrackedPage();
      const migrated = await waitForCondition(
        () => readOcSettings(sw),
        (s) => !!s && Object.prototype.hasOwnProperty.call(s, 'displayPreset'),
        { timeout: POLL_TIMEOUT, message: `migration for legacy value ${legacy} never landed` }
      );

      assert.strictEqual(migrated.displayPreset, expected, `legacy '${legacy}' must migrate to displayPreset '${expected}'`);
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(migrated, 'visionProfile'),
        false,
        `the legacy 'visionProfile' field must be deleted from storage after migrating '${legacy}'`
      );

      await page.close();
    });
  }

  test('migration is idempotent: a second content-script load leaves an already-migrated displayPreset untouched', async () => {
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      visionProfile: 'eye-strain',
      visionSettings: {},
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    // First load: performs the migration.
    const firstPage = await openTrackedPage();
    const afterFirstLoad = await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && Object.prototype.hasOwnProperty.call(s, 'displayPreset'),
      { timeout: POLL_TIMEOUT, message: 'first-load migration never landed' }
    );
    assert.strictEqual(afterFirstLoad.displayPreset, 'reduced-motion');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(afterFirstLoad, 'visionProfile'), false);
    await firstPage.close();

    // Second load against the now-migrated storage: 'visionProfile' is already gone, so the
    // migration branch must not fire again, and displayPreset must survive unchanged.
    const secondPage = await openTrackedPage();
    // No positive edge to wait on (the point is that nothing changes) — give content.js's
    // boot path a bounded window to run, then assert the settled state.
    await secondPage.waitForTimeout(300);
    const afterSecondLoad = await readOcSettings(sw);
    assert.strictEqual(afterSecondLoad.displayPreset, 'reduced-motion', 'a second load must not alter an already-migrated displayPreset');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(afterSecondLoad, 'visionProfile'),
      false,
      'a second load must not resurrect the legacy visionProfile field'
    );
    await secondPage.close();
  });

  test('an absent visionProfile field (never ran the wizard / mid-wizard) loads without throwing, and displayPreset stays null', async () => {
    pageErrors.length = 0;
    consoleErrors.length = 0;
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      visionSettings: {},
      setupWizardCompleted: false,
      seededDefaultBlocklist: true,
    });

    const page = await openTrackedPage();
    await page.waitForSelector('body');
    // No visionProfile key at all means the migration branch never fires, so nothing writes
    // storage back at all — settle on a bounded window rather than a positive edge, then
    // assert nothing was thrown and displayPreset is never a (migrated-looking) clinical
    // string. content.js's in-memory default (null) is never persisted unless something
    // actually changes, so the stored field is legitimately just absent (undefined) here,
    // not written out as an explicit null — either way it must never hold a legacy value.
    await page.waitForTimeout(300);
    const stored = await readOcSettings(sw);
    assert.ok(
      stored.displayPreset === null || stored.displayPreset === undefined,
      'displayPreset must be null/absent, never a clinical value, when no legacy field was ever present'
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'visionProfile'), false);
    await page.close();

    assert.deepStrictEqual(pageErrors, [], 'loading with an absent visionProfile field must not throw');
  });

  test('an explicit legacy visionProfile: null loads without throwing, migrates to displayPreset: null, and deletes the legacy field', async () => {
    pageErrors.length = 0;
    consoleErrors.length = 0;
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      visionProfile: null,
      visionSettings: {},
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    const page = await openTrackedPage();
    const migrated = await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && !Object.prototype.hasOwnProperty.call(s, 'visionProfile'),
      { timeout: POLL_TIMEOUT, message: 'migration of an explicit legacy null visionProfile never landed' }
    );
    assert.strictEqual(migrated.displayPreset, null);
    await page.close();

    assert.deepStrictEqual(pageErrors, [], 'loading with an explicit legacy visionProfile: null must not throw');
  });

  test('an unrecognized legacy visionProfile value migrates defensively to displayPreset: null instead of throwing', async () => {
    pageErrors.length = 0;
    consoleErrors.length = 0;
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      visionProfile: 'some-future-value-this-build-does-not-know-about',
      visionSettings: {},
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    const page = await openTrackedPage();
    const migrated = await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && !Object.prototype.hasOwnProperty.call(s, 'visionProfile'),
      { timeout: POLL_TIMEOUT, message: 'migration of an unrecognized legacy visionProfile value never landed' }
    );
    assert.strictEqual(migrated.displayPreset, null, 'an unrecognized legacy value must fall back to null, not throw or pass the raw string through');
    await page.close();

    assert.deepStrictEqual(pageErrors, [], 'loading with an unrecognized legacy visionProfile value must not throw');
  });

  for (const { legacy, expected } of LEGACY_PALETTE_CASES) {
    test(`legacy colorPalette ${JSON.stringify(legacy)} migrates to ${JSON.stringify(expected)}`, async () => {
      await seedOcSettings(sw, {
        disabledSites: [],
        performanceMode: false,
        displayPreset: null,
        visionSettings: { colorPalette: legacy },
        setupWizardCompleted: true,
        seededDefaultBlocklist: true,
      });

      const page = await openTrackedPage();
      const migrated = await waitForCondition(
        () => readOcSettings(sw),
        (s) => !!s && s.visionSettings && s.visionSettings.colorPalette === expected,
        { timeout: POLL_TIMEOUT, message: `migration for legacy colorPalette ${legacy} never landed` }
      );

      assert.strictEqual(
        migrated.visionSettings.colorPalette,
        expected,
        `legacy colorPalette '${legacy}' must migrate to '${expected}'`
      );

      await page.close();
    });
  }

  test('colorPalette values that were already functional (default/warm/custom) survive migration untouched', async () => {
    for (const already of ['default', 'warm', 'custom']) {
      await seedOcSettings(sw, {
        disabledSites: [],
        performanceMode: false,
        displayPreset: null,
        visionSettings: { colorPalette: already },
        setupWizardCompleted: true,
        seededDefaultBlocklist: true,
      });

      const page = await openTrackedPage();
      await page.waitForSelector('body');
      // No positive edge to wait on (the point is that nothing changes) — settle on a
      // bounded window, then assert the value never moved.
      await page.waitForTimeout(300);
      const stored = await readOcSettings(sw);
      assert.strictEqual(
        stored.visionSettings.colorPalette,
        already,
        `an already-functional colorPalette value ('${already}') must not be rewritten by migration`
      );
      await page.close();
    }
  });

  test('a mid-migration user (one field already functional, the other still legacy) ends the same pass with BOTH fields migrated', async () => {
    // displayPreset already migrated by an earlier load (visionProfile long gone), but
    // colorPalette is still the legacy 'protanopia' — the exact asymmetric state this
    // bead's single needsMigration pass must not leave half-fixed.
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      displayPreset: 'reduced-motion',
      visionSettings: { colorPalette: 'protanopia' },
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    let page = await openTrackedPage();
    let migrated = await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && s.visionSettings && s.visionSettings.colorPalette === 'amber-indigo',
      { timeout: POLL_TIMEOUT, message: 'colorPalette side of the asymmetric migration never landed' }
    );
    assert.strictEqual(migrated.displayPreset, 'reduced-motion', 'the already-migrated displayPreset must be undisturbed');
    assert.strictEqual(migrated.visionSettings.colorPalette, 'amber-indigo');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, 'visionProfile'), false);
    await page.close();

    // The reverse asymmetry: colorPalette already functional, visionProfile still legacy.
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      visionProfile: 'low-vision',
      visionSettings: { colorPalette: 'amber-sky' },
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    page = await openTrackedPage();
    migrated = await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && !Object.prototype.hasOwnProperty.call(s, 'visionProfile'),
      { timeout: POLL_TIMEOUT, message: 'displayPreset side of the reverse asymmetric migration never landed' }
    );
    assert.strictEqual(migrated.displayPreset, 'high-contrast');
    assert.strictEqual(migrated.visionSettings.colorPalette, 'amber-sky', 'the already-functional colorPalette must be undisturbed');
    await page.close();
  });

  test('a single legacy oc-settings object with BOTH fields still clinical migrates both in one atomic pass', async () => {
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      visionProfile: 'color-blind-tritanopia',
      visionSettings: { colorPalette: 'tritanopia' },
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    const page = await openTrackedPage();
    const migrated = await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && !Object.prototype.hasOwnProperty.call(s, 'visionProfile'),
      { timeout: POLL_TIMEOUT, message: 'combined visionProfile + colorPalette migration never landed' }
    );

    // Both fields must have migrated together — never one without the other.
    assert.strictEqual(migrated.displayPreset, 'by-adjust');
    assert.strictEqual(migrated.visionSettings.colorPalette, 'rose-cyan');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(migrated, 'visionProfile'), false);
    await page.close();

    // Idempotent as a pair: a second load must leave both settled values untouched and
    // must not resurrect the legacy visionProfile field.
    const secondPage = await openTrackedPage();
    await secondPage.waitForTimeout(300);
    const afterSecondLoad = await readOcSettings(sw);
    assert.strictEqual(afterSecondLoad.displayPreset, 'by-adjust');
    assert.strictEqual(afterSecondLoad.visionSettings.colorPalette, 'rose-cyan');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(afterSecondLoad, 'visionProfile'), false);
    await secondPage.close();
  });

  // oculist-rnr.16: direct coverage for the hasOwnProperty precedence branch in
  // settings-migration.js's normalizeOcSettings() (lines ~69-76) — up to now it was only
  // verified by inspection. Unlike the 'review gap 2' scenario below (which derives this
  // state across two separate events: a popup reselect, then a later content-script boot),
  // this seeds a SINGLE stored object that already has both 'visionProfile' (stale legacy)
  // and 'displayPreset' (a fresh, different value) present together from the very first
  // read. If the precedence check were missing or inverted, the stale legacy value would
  // overwrite the fresh displayPreset and silently discard real user data.
  test('a stored object with both a stale legacy visionProfile and an already-set displayPreset keeps displayPreset and discards the stale legacy value', async () => {
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      // If the legacy field were (wrongly) allowed to win, this would compute to
      // 'high-contrast' — deliberately different from displayPreset below so the two
      // outcomes are unambiguous.
      visionProfile: 'low-vision',
      displayPreset: 'reduced-motion',
      visionSettings: {},
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    const page = await openTrackedPage();
    const migrated = await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && !Object.prototype.hasOwnProperty.call(s, 'visionProfile'),
      { timeout: POLL_TIMEOUT, message: 'migration of the simultaneous visionProfile + displayPreset case never landed' }
    );

    assert.strictEqual(
      migrated.displayPreset,
      'reduced-motion',
      'an already-present displayPreset must win over a stale legacy visionProfile, not be overwritten by it'
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(migrated, 'visionProfile'),
      false,
      'the stale legacy visionProfile must still be deleted even though its value was discarded unused'
    );
    await page.close();
  });

  // Review gap 1 regression: content scripts do not re-inject into already-open tabs after
  // an extension update, so a legacy user's popup — not a content-script boot — can be the
  // very first thing to read a pre-update settings object. Exercises the real popup.js
  // read path directly (no content-script page opened at all), rather than seeding storage
  // and inferring correctness from a content-script boot.
  test('a legacy user who opens the popup first (no content script run) is migrated correctly and does not show "None"', async () => {
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      visionProfile: 'low-vision',
      visionSettings: {},
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    const popup = await ctx.newPage();
    popup.on('pageerror', (err) => pageErrors.push(err));
    pageErrors.length = 0;
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#vision-profile');

    // The dropdown must show the migrated preset, not fall back to "None" because
    // displayPreset read as undefined.
    assert.strictEqual(
      await popup.locator('#vision-profile').inputValue(),
      'low-vision',
      'a legacy visionProfile must still resolve to its preset in the popup, not show as None'
    );

    // Opening the popup must itself have normalised and persisted the correction, even
    // with no toggle from the user at all.
    const stored = await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && Object.prototype.hasOwnProperty.call(s, 'displayPreset'),
      { timeout: POLL_TIMEOUT, message: 'popup-first migration never landed in storage' }
    );
    assert.strictEqual(stored.displayPreset, 'high-contrast');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'visionProfile'), false);
    await popup.close();

    assert.deepStrictEqual(pageErrors, [], 'a legacy-only settings object must not throw when the popup reads it first');
  });

  // Review gap 2 regression: a user's freshly-made choice must never be reverted by a
  // later content-script boot re-deriving displayPreset from a stale legacy visionProfile.
  // Reproduces the exact narrative: legacy user opens the popup (no content script yet),
  // reselects a different preset through the real dropdown, THEN a content-script boot
  // happens (a real page loads) — the fresh choice must still be what is stored.
  test('a user who reselects a preset in the popup is not reverted by a later content-script boot', async () => {
    await seedOcSettings(sw, {
      disabledSites: [],
      performanceMode: false,
      visionProfile: 'low-vision',
      visionSettings: {},
      setupWizardCompleted: true,
      seededDefaultBlocklist: true,
    });

    // Popup-first: migrates 'low-vision' -> 'high-contrast' and deletes visionProfile,
    // exactly as the previous test proves.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#vision-profile');
    await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && s.displayPreset === 'high-contrast',
      { timeout: POLL_TIMEOUT, message: 'popup-first migration never landed before the reselect' }
    );

    // The user then picks a different preset through the real dropdown.
    await popup.selectOption('#vision-profile', 'eye-strain');
    await waitForCondition(
      () => readOcSettings(sw),
      (s) => !!s && s.displayPreset === 'reduced-motion',
      { timeout: POLL_TIMEOUT, message: 'the reselected preset was never persisted' }
    );
    await popup.close();

    // A content-script boot happens after the reselect (a real page loads). It must leave
    // the fresh choice alone — there is no legacy visionProfile left for it to revert from.
    const page = await openTrackedPage();
    await page.waitForTimeout(300);
    const stored = await readOcSettings(sw);
    assert.strictEqual(
      stored.displayPreset,
      'reduced-motion',
      'a later content-script boot must not revert the user\'s fresh choice back to the stale legacy value'
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'visionProfile'), false);
    await page.close();
  });
});

// oculist-rnr.22: structural hardening of the canonical mapping table itself, not the
// migration behaviour above — these load extension/settings-migration.js directly via
// Node's require() (its module.exports branch) rather than driving a real browser, since
// they only need to inspect the exported table, not exercise a content-script boot.
describe('LEGACY_DISPLAY_PRESET_MAP structural invariants (oculist-rnr.22)', () => {
  const OculistSettingsMigration = require('../extension/settings-migration.js');

  test('LEGACY_DISPLAY_PRESET_MAP and LEGACY_COLOR_PALETTE_MAP are frozen, so a future write through an alias cannot corrupt the canonical table', () => {
    assert.strictEqual(Object.isFrozen(OculistSettingsMigration.LEGACY_DISPLAY_PRESET_MAP), true);
    assert.strictEqual(Object.isFrozen(OculistSettingsMigration.LEGACY_COLOR_PALETTE_MAP), true);
  });

  // popup.js derives its FUNCTIONAL_TO_LEGACY_PRESET reverse lookup by inverting this table
  // at load time. That inversion is only lossless while every forward value is distinct — a
  // future duplicate value would silently drop a reverse entry with nothing failing. Asserts
  // against the module's real export (not a copy) so a drift in the actual table is caught.
  test('every value in LEGACY_DISPLAY_PRESET_MAP is distinct, so inverting it (as popup.js does) loses no entries', () => {
    const map = OculistSettingsMigration.LEGACY_DISPLAY_PRESET_MAP;
    const values = Object.values(map);
    assert.strictEqual(
      new Set(values).size,
      Object.keys(map).length,
      'a duplicate forward value would make popup.js\'s reverse-derived FUNCTIONAL_TO_LEGACY_PRESET silently drop an entry'
    );
  });
});
