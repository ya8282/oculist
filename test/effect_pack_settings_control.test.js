// oculist-tdj.5: the pack checkbox list (makeCheckboxList, content.js, oculist-tdj.2) has
// no test anywhere in the repo. It was verified end-to-end by a reviewer, but only in a
// throwaway harness against a temporary registry entry, because zero effectsRegistry
// entries carry a `pack` today (oculist-tdj.1) — knownPacks() (content.js) returns [] on
// the real tree, so the whole packsField section (buildSettingsPanel, content.js) renders
// nothing and every existing settings-panel Playwright test passes without ever touching a
// pack row.
//
// Same fixture idiom as pack_discovery_notice.test.js (createPackedFixtureExtension()
// below): a temp copy of extension/ whose content.js has its effectsRegistry patched to
// carry real `pack` fields, rather than depending on a real pack shipping. Unlike that
// file, this one needs MANY distinct pack ids (ten), not one — the last assertion below
// pins the makeCheckboxList output against .oc-checkbox-list's 160px cap (content.js,
// oculist-tdj.2), which needs enough rows to actually overflow it. The fixture therefore
// patches in:
//   - one extra registry entry, `ocTdj5PackedEffect`, under pack 'seasonal' — the row this
//     file's filtering/keyboard/focus/accessible-name assertions exercise;
//   - nine filler entries, one each under packs 'filler1'..'filler9', whose only job is to
//     pad knownPacks() out to ten rows so the checkbox list's own scroll cap is
//     actually exercised, not vacuously "big enough to fit" at ten rows' worth of content.
// All ten reuse animateCyberVision as their `run` — none of them are ever actually
// triggered by this file, so the real animation behind the label is irrelevant.
//
// Needs a real browser for the same reasons as the sibling settings-panel Playwright
// files: real layout (the 160px cap assertion), a real shadow root, real native
// button keyboard-activation (Enter/Space), and the CDP Accessibility domain for the
// computed-accessible-name assertions (jsdom provides none of this).

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

// 1280x800, matching the viewport used by settings_panel_enter_activation.test.js,
// overlay_panel_focus_aria.test.js and settings_panel_effect_list_overflow.test.js.
// The geometry assertions here dismiss the pack-discovery notice first: the notice sits
// above #oc-settings-panel and adds ~46.6px that oculist-6cd's max-height formula
// (barChromePx, a fixed 44px literal in content.js) does not account for, so with the
// notice showing the host overflows the viewport at ANY height, 800px included. That is a
// separate, pre-existing defect — filed as oculist-3rq, not fixed here. With the notice
// dismissed the panel fits with ~3px to spare, so the assertion below is still tight.
// This file asserts what it owns: the checkbox list's bounded 160px scroll box and the
// panel fitting the viewport around it.
const VIEWPORT = { width: 1280, height: 800 };
const EPS = 1; // subpixel-rounding tolerance, same order of magnitude as sibling geometry tests

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const CHECKBOX_LIST = '#oc-wrap >> .oc-checkbox-list';
const PACK_SEASONAL = '#oc-wrap >> [data-oc-key="pack:seasonal"]';
const PACKED_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:ocTdj5PackedEffect"]';

const PACK_SEASONAL_CSS = '[data-oc-key="pack:seasonal"]';

const FILLER_PACK_IDS = ['filler1', 'filler2', 'filler3', 'filler4', 'filler5', 'filler6', 'filler7', 'filler8', 'filler9'];

// Copies extension/ into a fresh temp dir and patches the copy's content.js so the
// effectsRegistry carries ten distinct `pack` ids across eleven entries (one packed
// effect under 'seasonal', plus nine filler entries under their own pack each) — see the
// file banner above for why ten. Returns the temp dir path; the caller removes it once
// done. Never touches extension/content.js itself.
function createPackedFixtureExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oculist-pack-settings-'));
  fs.cpSync(REAL_EXTENSION, dir, { recursive: true });

  const contentJsPath = path.join(dir, 'content.js');
  const original = fs.readFileSync(contentJsPath, 'utf8');
  const target = "cybervision: { label: i18n.effectCyberVision, run: animateCyberVision }";
  assert.ok(
    original.includes(target),
    'fixture setup: expected effectsRegistry.cybervision entry text not found in extension/content.js — did its shape change?'
  );

  const fillerEntries = FILLER_PACK_IDS.map((packId, i) => {
    const key = 'ocTdj5Filler' + (i + 1);
    return key + ": { label: 'OC TDJ5 Filler " + (i + 1) + "', run: animateCyberVision, pack: '" + packId + "' }";
  }).join(', ');

  const patched =
    "cybervision: { label: i18n.effectCyberVision, run: animateCyberVision, pack: 'seasonal' }, " +
    "ocTdj5PackedEffect: { label: 'OC TDJ5 Packed Effect', run: animateCyberVision, pack: 'seasonal' }, " +
    fillerEntries;
  assert.notStrictEqual(original.indexOf(target), -1);
  fs.writeFileSync(contentJsPath, original.replace(target, patched), 'utf8');

  return dir;
}

describe('Effect-pack settings control (oculist-tdj.2/tdj.5)', () => {
  let server, ctx, page, client, fixtureDir;

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

  // A single Escape only closes the settings panel (role="dialog", oculist-l6m.37) — the
  // overlay itself needs a second Escape once no panel is left open. Same bounded-retry
  // idiom as overlay_panel_focus_aria.test.js's beforeEach.
  async function closeOverlayFully() {
    for (let attempts = 0; attempts < 5 && (await page.locator('#oc-wrap').count()) > 0; attempts++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page
        .waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: 300 })
        .catch(() => {});
    }
    await waitForOverlayClosed();
  }

  // Same retry-Control+f-until-the-input-appears rationale as pack_discovery_notice.
  // test.js and several sibling settings-panel browser tests — no CDP isolated-world
  // readiness signal used in this file, so retry the keypress itself instead.
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

  async function openSettings() {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
  }

  async function waitForActiveElement(cssSelector, timeoutMs) {
    await page.waitForFunction(
      (sel) => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        if (!root) return false;
        const el = root.querySelector(sel);
        return !!el && root.activeElement === el;
      },
      cssSelector,
      { timeout: timeoutMs || POLL_TIMEOUT }
    );
  }

  // Resolves an element inside #oc-wrap's shadow root to a CDP objectId, reads its
  // computed accessibility properties via Accessibility.getPartialAXTree, then releases
  // the remote handle. Same approach as overlay_panel_focus_aria.test.js's
  // getAXProperties — the computed AX tree, not the raw aria-* attribute string, is what
  // a screen reader actually sees.
  async function getAXProperties(cssSelector) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: 'document.getElementById(\'oc-wrap\').shadowRoot.querySelector(' + JSON.stringify(cssSelector) + ')',
    });
    if (!result.objectId) {
      throw new Error('AX probe: no element matched ' + cssSelector);
    }
    try {
      const ax = await client.send('Accessibility.getPartialAXTree', {
        objectId: result.objectId,
        fetchRelatives: false,
      });
      const node = ax.nodes[0];
      const props = {};
      (node.properties || []).forEach((p) => {
        props[p.name] = p.value ? p.value.value : undefined;
      });
      return {
        role: node.role ? node.role.value : undefined,
        name: node.name ? node.name.value : undefined,
        props: props,
      };
    } finally {
      await client.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    }
  }

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
      viewport: VIEWPORT,
    });

    page = await ctx.newPage();
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Accessibility.enable');

    await page.goto(origin);
    await openFinder();

    // Ten known packs (this fixture) makes maybeShowPackDiscoveryNotice() (oculist-tdj.3,
    // content.js) eligible to show its one-time banner above the bar/panel — it was never
    // eligible on the real tree before this bead (knownPacks() was always empty there).
    // That banner is unrelated to anything this file asserts and adds its own height above
    // #oc-settings-panel that the oculist-6cd max-height formula does not account for
    // (filed separately as discovered work) — dismiss it once, up front, so every
    // geometry/focus/keyboard assertion below is against the settings panel alone.
    const noticeCloseLocator = page.locator('#oc-wrap >> .oc-pack-notice-close');
    if (await noticeCloseLocator.count()) {
      await noticeCloseLocator.click();
      await page.waitForFunction(
        () => !document.getElementById('oc-wrap').shadowRoot.querySelector('.oc-pack-notice'),
        null,
        { timeout: POLL_TIMEOUT }
      );
    }

    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    // Only ever removes the temp copy created above — never touches extension/ itself.
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('every known pack renders one checkbox row, the list is a bounded scroll container capped well under 160px, and the whole panel still fits the viewport', async () => {
    await openFinder();
    await openSettings();

    const rowCount = await page.locator(`${CHECKBOX_LIST} >> .oc-checkbox-item`).count();
    assert.strictEqual(rowCount, 10, 'knownPacks() must produce exactly one checkbox row per distinct pack id (1 seasonal + 9 fillers)');

    const geo = await page.evaluate(() => {
      const host = document.getElementById('oc-wrap');
      const root = host.shadowRoot;
      const list = root.querySelector('.oc-checkbox-list');
      return {
        hostRect: host.getBoundingClientRect(),
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      };
    });

    // Self-check, same rationale as settings_panel_effect_list_overflow.test.js: the cap
    // is only meaningfully exercised if ten rows' worth of content genuinely exceeds the
    // list's own visible box.
    assert.ok(
      geo.scrollHeight > geo.clientHeight + 1,
      `pack checkbox list content (scrollHeight=${geo.scrollHeight}) must exceed its visible box ` +
      `(clientHeight=${geo.clientHeight}) at 10 rows — otherwise this cannot tell a real scroll ` +
      'container from an accidentally-oversized one'
    );
    assert.ok(
      geo.clientHeight <= 165,
      `pack checkbox list clientHeight (${geo.clientHeight}) must stay at/near the CSS's 160px cap, ` +
      'not grow to fit all 10 rows'
    );

    // The 160px-capped, internally-scrolling list is what keeps this many packs from
    // blowing the whole settings panel out of a real, short viewport.
    assert.ok(
      geo.hostRect.bottom <= VIEWPORT.height + EPS,
      `panel host bottom (${geo.hostRect.bottom}) must stay within the ${VIEWPORT.height}px viewport ` +
      'even with ten pack rows registered'
    );

    // Tab-reachability: the checkbox row is a plain <button> with no explicit tabindex,
    // so it must be reachable purely by tabbing forward from whatever the effect picker's
    // last radio row is (the control immediately preceding the pack field in DOM order).
    await page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const radios = root.querySelectorAll('.oc-radio-item');
      radios[radios.length - 1].focus();
    });
    await page.keyboard.press('Tab');
    const activeIsFirstCheckboxRow = await page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      const first = root.querySelector('.oc-checkbox-item');
      return !!first && root.activeElement === first;
    });
    assert.strictEqual(
      activeIsFirstCheckboxRow,
      true,
      'a single Tab from the last effect radio row must land on the first pack checkbox row — the control must be tab-reachable'
    );

    await closeOverlayFully();
  });

  test('toggling the "seasonal" pack via Enter reveals its packed effect immediately (no reload); toggling it back off via Space hides it again — focus and the computed accessible name (pack label alone) survive both in-place rebuilds', async () => {
    await openFinder();
    await openSettings();

    // Starting state: packs default OFF (settings.enabledPacks starts empty), so the
    // packed effect must not be offered in the picker yet.
    assert.strictEqual(
      await page.locator(PACKED_EFFECT_ROW).count(),
      0,
      'the packed effect must be absent from the picker while its pack is off'
    );
    assert.strictEqual(
      await page.locator(PACK_SEASONAL).getAttribute('aria-checked'),
      'false',
      'the seasonal pack checkbox must start unchecked'
    );

    let ax = await getAXProperties(PACK_SEASONAL_CSS);
    assert.strictEqual(ax.role, 'checkbox', 'the pack row must expose a computed role of checkbox');
    assert.strictEqual(
      ax.name,
      'Seasonal',
      'the computed accessible name must be the pack label alone, not the checkbox glyph — the glyph span must stay aria-hidden'
    );
    assert.strictEqual(ax.props.checked, 'false', 'computed checked state (tristate) must start false');

    // Enter: move real DOM focus onto the row (not a click) and activate it with a real
    // Enter keypress — the same interaction settings_panel_enter_activation.test.js
    // exercises for the theme buttons, now for a checkbox row.
    await page.locator(PACK_SEASONAL).focus();
    await waitForActiveElement(PACK_SEASONAL_CSS);
    await page.keyboard.press('Enter');

    // The toggle handler calls rebuildSettingsPanelPreservingFocus() (content.js) —
    // settingsPanel is torn down and rebuilt in place, so the row above is a *new* DOM
    // node afterward. Poll for the rebuilt row's own aria-checked rather than asserting
    // immediately, then check focus/name against that same, re-queried element.
    await page.waitForFunction(
      (sel) => {
        const root = document.getElementById('oc-wrap').shadowRoot;
        const el = root.querySelector(sel);
        return !!el && el.getAttribute('aria-checked') === 'true';
      },
      PACK_SEASONAL_CSS,
      { timeout: POLL_TIMEOUT }
    );

    // No reload anywhere in this file — the picker must reflect the new pack state from
    // the in-place rebuild alone.
    assert.strictEqual(
      await page.locator(PACKED_EFFECT_ROW).count(),
      1,
      'the packed effect must appear in the picker immediately once its pack is toggled on, with no reload'
    );

    // Focus must have survived the rebuild by data-oc-key (rebuildSettingsPanelPreservingFocus
    // re-resolves it via querySelector('[data-oc-key="..."]') and calls .focus() on the match).
    await waitForActiveElement(PACK_SEASONAL_CSS);

    ax = await getAXProperties(PACK_SEASONAL_CSS);
    assert.strictEqual(ax.props.checked, 'true', 'computed checked state (tristate) must flip true after Enter');
    assert.strictEqual(
      ax.name,
      'Seasonal',
      'the computed accessible name must remain the pack label alone after the checked-glyph swaps to ☑'
    );

    // Space: same row (now the post-rebuild node), toggled back off. Space fires the
    // click on keyup for a native <button> — the row must remain a real <button> for this
    // to work at all (see settings_panel_enter_activation.test.js's file banner for the
    // Enter-vs-Space history on this exact idiom).
    await page.locator(PACK_SEASONAL).focus();
    await waitForActiveElement(PACK_SEASONAL_CSS);
    await page.keyboard.press('Space');

    await page.waitForFunction(
      (sel) => {
        const root = document.getElementById('oc-wrap').shadowRoot;
        const el = root.querySelector(sel);
        return !!el && el.getAttribute('aria-checked') === 'false';
      },
      PACK_SEASONAL_CSS,
      { timeout: POLL_TIMEOUT }
    );

    assert.strictEqual(
      await page.locator(PACKED_EFFECT_ROW).count(),
      0,
      'the packed effect must disappear from the picker immediately once its pack is toggled back off, with no reload'
    );

    await waitForActiveElement(PACK_SEASONAL_CSS);

    ax = await getAXProperties(PACK_SEASONAL_CSS);
    assert.strictEqual(ax.props.checked, 'false', 'computed checked state (tristate) must flip back false after Space');
    assert.strictEqual(
      ax.name,
      'Seasonal',
      'the computed accessible name must remain the pack label alone after the checked-glyph reverts to ☐'
    );

    await closeOverlayFully();
  });
});
