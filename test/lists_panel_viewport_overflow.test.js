// Regression for oculist-7de: #oc-lists-panel had the same class of pattern
// settings_panel_viewport_overflow.test.js (oculist-6cd) fixed for #oc-settings-panel — a
// fixed max-height (320px here, versus no cap at all pre-6cd for the settings panel) rather
// than one bound to whatever's actually left of the viewport once the bar (barChromePx,
// content.js) is accounted for. ':host { position: fixed; overflow: hidden }' still has no
// scrollable ancestor above the host, so the flat 320px cap only protects viewports taller
// than roughly 320px + barChromePx (~360px) — a shorter viewport (or a taller bar) pushes the
// whole host (bar + this panel, both flex children of the host) past the fold with nothing
// able to reach the clipped end, exactly like the settings panel's pre-6cd failure. This test
// runs at a 300px viewport specifically because it sits below that ~360px threshold: the old
// flat 320px cap demonstrably clips there (host bottom overflows top-anchored bars, host top
// goes negative for bottom-anchored ones), while the fixed calc(100vh - barChromePx) cap
// (256px of panel body at 300px, still overflowed by the 40 seeded rows) stays in bounds:
//   - top-anchored (tl/tr): host top pinned at 0, grows downward past the viewport bottom —
//     the panel's last saved-list row is clipped and unreachable.
//   - bottom-anchored (bl/br): host bottom pinned at 0, and because the host is a flex
//     column-reverse growing upward from that anchor, an oversized host pushes its own TOP —
//     the bar itself, not just the panel's header row — above y=0 and off-screen.
//
// The fix (content.js, #oc-lists-panel CSS): max-height: calc(100vh - barChromePx) +
// overflow-y: auto on the panel itself, the same idiom oculist-6cd used for
// #oc-settings-panel and oculist-dvt.5 used one level down for .oc-radio-list.
//
// This file checks all four POS_DATA positions for the same reason
// settings_panel_viewport_overflow.test.js does — top- and bottom-anchored bars fail in the
// two structurally different ways described above.
//
// Needs a real browser for the same reasons as the sibling settings-panel test: real layout,
// a real shadow root, and real scrollable-content behaviour — jsdom gives none of that. It
// also needs CDP (not just page.evaluate()) to seed enough saved lists to make the panel's
// content genuinely overflow — chrome.storage.sync is only reachable from the content
// script's isolated execution context, the same bridge list_storage.test.js uses.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, TIMEOUT_SCALE } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

// 300px is below the old flat 320px cap's own effective threshold (~320px + barChromePx,
// i.e. ~360px) — the one viewport size at which the old code demonstrably clips (verified:
// host bottom 361 > 300 for top-anchored bars, host top -61 for bottom-anchored ones) while
// the new calc(100vh - barChromePx) cap stays in bounds (bottom 297 / top 3). A 600px
// viewport, used by an earlier version of this test, never clips under the old code either
// (bar ~40px + flat 320px cap = ~360px, comfortably under 600) and so cannot tell the fixed
// code apart from the bug it's meant to catch.
const VIEWPORT = { width: 1280, height: 300 };
const EPS = 1; // subpixel-rounding tolerance, same order of magnitude as the sibling overflow test's EPS

// Comfortably more than enough rows (each ~30px) to overflow either the old flat 320px cap
// or the new calc(100vh - barChromePx) one (256px of panel body at this viewport) — the
// self-check below (panelScrollHeight > panelClientHeight) is what actually proves it, this
// count just needs to make that true under both.
const SEED_COUNT = 40;

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const LISTS_BTN = '#oc-wrap >> button[title="Saved Lists"]';
const LISTS_PANEL = '#oc-wrap >> #oc-lists-panel';

const POSITIONS = ['tr', 'tl', 'br', 'bl'];

describe('Lists panel at a 300px viewport, below the old flat cap\'s ~360px threshold (oculist-7de): the whole popover, not just its own scroll body, stays reachable', () => {
  let server, ctx, page, client, isolatedContextId;

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

  // Same retry-Control+f-until-the-input-appears rationale as the sibling overflow tests.
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

  // Same shape as list_storage.test.js's seedLists() — writes directly under 'oc-list-<id>'
  // sync-storage keys, bypassing the UI's own Save flow entirely (that flow only saves the
  // live working list one name at a time, far too slow for SEED_COUNT rows).
  function seedLists(count) {
    const batch = {};
    for (let i = 0; i < count; i++) {
      batch['oc-list-seed' + i] = { id: 'seed' + i, name: 'Seed list number ' + i, terms: ['x'] };
    }
    return evalInContentScript(`new Promise((resolve) => chrome.storage.sync.set(${JSON.stringify(batch)}, resolve))`);
  }

  function clearSavedLists() {
    return evalInContentScript(
      "new Promise((resolve) => chrome.storage.sync.get(null, (data) => {" +
      "  var keys = Object.keys(data || {}).filter((k) => k.indexOf('oc-list-') === 0);" +
      "  if (keys.length === 0) { resolve(); return; }" +
      "  chrome.storage.sync.remove(keys, resolve);" +
      "}))"
    );
  }

  async function openSettings() {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
  }

  // Same position-change idiom as settings_panel_viewport_overflow.test.js's setPosition():
  // wait on the host's class (set synchronously by applyWrapPosition() before the rebuild)
  // rather than polling for any one panel's mere existence.
  async function setPosition(pos) {
    if (pos === 'tr') return; // settings.position defaults to 'tr'; nothing to do
    await openSettings();
    await page.locator(`#oc-wrap >> [data-oc-key="position:${pos}"]`).click();
    await page.waitForFunction(
      (p) => {
        const host = document.getElementById('oc-wrap');
        return !!host && host.classList.contains('pos-' + p);
      },
      pos,
      { timeout: POLL_TIMEOUT }
    );
    // Escape closes only the (currently open) settings panel, leaving the overlay itself
    // mounted — same "one Escape, one panel" behaviour beforeEach below relies on.
    await page.keyboard.press('Escape');
    await page.waitForSelector(SETTINGS_PANEL, { state: 'detached', timeout: POLL_TIMEOUT });
  }

  async function openLists() {
    await page.locator(LISTS_BTN).click();
    await page.waitForSelector(LISTS_PANEL, { timeout: POLL_TIMEOUT });
    // buildListsPanel() renders its rows from an async listSavedLists() read (content.js) —
    // wait for the seeded rows to actually land rather than racing the panel's mere creation.
    await page.waitForFunction(
      (n) => {
        const host = document.getElementById('oc-wrap');
        const root = host && host.shadowRoot;
        return !!root && root.querySelectorAll('.oc-list-item').length >= n;
      },
      SEED_COUNT,
      { timeout: POLL_TIMEOUT }
    );
  }

  // The last saved-list row (.oc-list-items's last .oc-list-item) is the deepest real control
  // in the popover, mirroring the sibling settings-panel test's use of the last effect row.
  async function getPanelGeometry() {
    return page.evaluate(() => {
      const host = document.getElementById('oc-wrap');
      const root = host.shadowRoot;
      const panel = root.querySelector('#oc-lists-panel');
      const header = root.querySelector('.oc-list-save-row');
      const rows = Array.from(root.querySelectorAll('.oc-list-item'));
      const lastRow = rows[rows.length - 1];
      return {
        hostRect: host.getBoundingClientRect(),
        panelRect: panel.getBoundingClientRect(),
        headerRect: header.getBoundingClientRect(),
        panelScrollTop: panel.scrollTop,
        panelScrollHeight: panel.scrollHeight,
        panelClientHeight: panel.clientHeight,
        rowCount: rows.length,
        lastRowRect: lastRow.getBoundingClientRect(),
      };
    });
  }

  before(async () => {
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
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: VIEWPORT,
    });

    page = await ctx.newPage();

    // Attach CDP and watch for execution-context creation *before* navigating, so the
    // event for the content script's isolated world is never missed (same as
    // list_storage.test.js/worklist_storage.test.js).
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

    await seedLists(SEED_COUNT);

    await openFinder();
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
  });

  after(async () => {
    if (isolatedContextId) await clearSavedLists().catch(() => {});
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // Every test starts from a closed overlay, so panel/focus/position state never leaks
  // between tests (same rationale/retry loop as the sibling overflow tests — a single
  // Escape only closes whichever panel is open, not the whole overlay).
  beforeEach(async () => {
    for (let attempts = 0; attempts < 5 && (await page.locator('#oc-wrap').count()) > 0; attempts++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page
        .waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: 300 * TIMEOUT_SCALE })
        .catch(() => {});
    }
    await waitForOverlayClosed();
    await openFinder();
  });

  POSITIONS.forEach((pos) => {
    test(`position "${pos}": lists popover host stays within the 300px viewport, header is visible unscrolled, and the last saved list is reachable`, async () => {
      await setPosition(pos);
      await openLists();

      const geo = await getPanelGeometry();

      assert.strictEqual(geo.rowCount, SEED_COUNT, `position ${pos}: all ${SEED_COUNT} seeded rows must have rendered`);

      // The core regression: with a flat 320px cap that doesn't leave room for the bar, the
      // whole host (bar + panel, both position: fixed with no scrollable ancestor) can grow
      // past the viewport. Top-anchored bars (tl/tr) push the bottom past 300; bottom-
      // anchored bars (bl/br), being a flex column-reverse anchored at the viewport's bottom
      // edge, push their OWN TOP (bar included) above y=0 instead.
      assert.ok(
        geo.hostRect.top >= -EPS,
        `position ${pos}: host top (${geo.hostRect.top}) must not be pushed above the viewport — ` +
        `a bottom-anchored bar/panel taller than the viewport does exactly this`
      );
      assert.ok(
        geo.hostRect.bottom <= VIEWPORT.height + EPS,
        `position ${pos}: host bottom (${geo.hostRect.bottom}) must not extend past the ${VIEWPORT.height}px viewport — ` +
        `a top-anchored panel taller than the viewport does exactly this`
      );

      // Self-check: the fix is only meaningful if the panel's content genuinely exceeds its
      // own visible box — otherwise "the last row is reachable" would pass vacuously because
      // nothing needed scrolling in the first place (same rationale as the sibling overflow
      // tests' analogous self-check).
      assert.ok(
        geo.panelScrollHeight > geo.panelClientHeight + 1,
        `position ${pos}: panel content (scrollHeight=${geo.panelScrollHeight}) must exceed its visible box ` +
        `(clientHeight=${geo.panelClientHeight}) — otherwise this test cannot tell a real scroll container ` +
        'from an accidentally-oversized one'
      );

      // The header (Save current as… row) must be visible without any scrolling — a
      // freshly-opened panel starts at scrollTop 0, so the header (the panel's first child)
      // must already sit at or below the panel's own top edge.
      assert.strictEqual(geo.panelScrollTop, 0, `position ${pos}: panel must start unscrolled`);
      assert.ok(
        geo.headerRect.top >= geo.panelRect.top - EPS && geo.headerRect.top >= -EPS,
        `position ${pos}: header (top=${geo.headerRect.top}) must not be clipped above the panel's visible box ` +
        `(panel top=${geo.panelRect.top}) or the viewport`
      );

      // The last saved-list row must become reachable once scrolled to — this is the
      // assertion that actually exercises "clipped content is recoverable", not just that
      // heights compare favourably. scrollIntoView({block:'nearest'}) walks #oc-lists-panel
      // itself — the fixed-position host above it is not scrollable, so this cannot mask a
      // genuinely off-screen host.
      await page.evaluate(() => {
        const host = document.getElementById('oc-wrap');
        const root = host.shadowRoot;
        const rows = Array.from(root.querySelectorAll('.oc-list-item'));
        rows[rows.length - 1].scrollIntoView({ block: 'nearest' });
      });

      const afterScroll = await getPanelGeometry();
      assert.ok(
        afterScroll.panelScrollTop > 0,
        `position ${pos}: scrolling to the last saved-list row must actually move the panel's scroll ` +
        'position (scrollTop stayed 0) — otherwise the row was already visible and this assertion is vacuous'
      );
      assert.ok(
        afterScroll.lastRowRect.top >= afterScroll.panelRect.top - EPS &&
        afterScroll.lastRowRect.bottom <= afterScroll.panelRect.bottom + EPS,
        `position ${pos}: last saved-list row must be within the panel's visible scroll bounds after being ` +
        `scrolled to — row rect ${JSON.stringify(afterScroll.lastRowRect)}, panel rect ${JSON.stringify(afterScroll.panelRect)}`
      );
      assert.ok(
        afterScroll.lastRowRect.top >= -EPS && afterScroll.lastRowRect.bottom <= VIEWPORT.height + EPS,
        `position ${pos}: last saved-list row must also land within the ${VIEWPORT.height}px viewport itself ` +
        `once scrolled to — row rect ${JSON.stringify(afterScroll.lastRowRect)}`
      );
    });
  });
});
