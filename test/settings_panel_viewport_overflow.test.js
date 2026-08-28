// Regression for oculist-6cd: content.js's ':host { position: fixed; overflow: hidden }'
// (no max-height, no scrollable ancestor above the host) meant the settings panel's own
// intrinsic height — bar + #oc-settings-panel, both flex children of the host — simply
// tracked its content, with nothing bounding the HOST to the viewport. This predates
// oculist-dvt entirely and is independent of effectsRegistry size: a real-browser
// investigation at the pre-epic commit (9 effects) found the host already measured 686.4px
// tall against a 600px viewport, 86.4px over. oculist-dvt.5 (see
// settings_panel_effect_list_overflow.test.js) capped .oc-radio-list, one level down, but
// deliberately left this whole-panel problem out of scope.
//
// The failure is unrecoverable, not merely ugly: a position: fixed host with no scrollable
// ancestor means content past the fold cannot be reached by any page scroll at all. The two
// bar anchor directions fail in different, opposite ways:
//   - top-anchored (tl/tr): host top pinned at 0, grows downward past the viewport bottom —
//     the panel's footer (its last fields/rows) is clipped and unreachable.
//   - bottom-anchored (bl/br): host bottom pinned at 0 (from the viewport's bottom edge),
//     and BECAUSE the host is a flex column-reverse growing upward from that anchor, an
//     oversized host pushes its own TOP — including the bar itself, not just the panel's
//     header — above y=0 and off-screen. A real-browser measurement found hostTop -74.4px
//     at vh=600 for this case.
//
// The fix (content.js, #oc-settings-panel CSS): max-height + overflow-y: auto on the panel
// itself, mirroring the same idiom oculist-dvt.5 used for .oc-radio-list. barChromePx (see
// the comment beside its declaration in injectHighlightStyles()) is a fixed, deterministic
// literal — not measured live off the real bar element, because the very first
// injectHighlightStyles() call of a session runs before '.oc-bar button' (which pins the
// bar's height) has ever been attached to the shadow root, so a live measurement at that
// point would read the bar's *unstyled* height and bake a too-small number in for the rest
// of the session (this was caught during development of this fix, not asserted here directly
// — a live-measurement regression would surface as this file's own host-bounds assertions
// failing intermittently across the whole suite, which is what those assertions guard).
//
// This file checks all four POS_DATA positions, not just one — top- and bottom-anchored
// bars fail in the two structurally different ways described above, and a fix that only
// works for one anchor direction (e.g. one that clips the panel's max-height to the
// viewport without also accounting for a column-reverse host pushing its top edge upward)
// would still leave the other broken.
//
// Needs a real browser for the same reasons as settings_panel_effect_list_overflow.test.js:
// real layout, a real shadow root, and real scrollable-content behaviour — jsdom gives none
// of that.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

const PAGE = '<!doctype html><meta charset="utf-8"><p>hello quarklet world, nothing else on this page.</p>';

const VIEWPORT = { width: 1280, height: 600 };
const EPS = 1; // subpixel-rounding tolerance, same order of magnitude as the sibling overflow test's EPS

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';

const POSITIONS = ['tr', 'tl', 'br', 'bl'];

describe('Settings panel at a 600px viewport (oculist-6cd): the whole panel, not just the effect list, stays reachable', () => {
  let server, ctx, page;

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

  // Same retry-Control+f-until-the-input-appears rationale as
  // settings_panel_effect_list_overflow.test.js (no CDP session in this file to gate on).
  async function openFinder() {
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
  }

  async function openSettings() {
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
  }

  // Sets settings.position and waits for the rebuild (rebuildSettingsPanelPreservingFocus(),
  // content.js) to land — the position buttons live inside the panel they themselves cause
  // to be torn down and re-appended, so waiting on the host's class (set synchronously by
  // applyWrapPosition() before the rebuild) is the reliable signal rather than polling for
  // the (recreated) panel element's mere existence.
  async function setPosition(pos) {
    if (pos === 'tr') return; // settings.position defaults to 'tr'; nothing to do
    await page.locator(`#oc-wrap >> [data-oc-key="position:${pos}"]`).click();
    await page.waitForFunction(
      (p) => {
        const host = document.getElementById('oc-wrap');
        return !!host && host.classList.contains('pos-' + p);
      },
      pos,
      { timeout: POLL_TIMEOUT }
    );
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
  }

  // The last effect row (.oc-radio-list's last .oc-radio-item) is the deepest real control
  // in the panel: col1 (site toggle, theme, scroll behaviour, then the effect picker) is
  // taller than col2 (position, colors, donate/feedback links) — the CSS grid row stretches
  // col2 to match col1's height, but col2's own *content* stops well short of the panel's
  // true bottom, so col2's last control is not actually the deepest reachable point. The
  // effect list's last row also already has its own inner scroll container
  // (.oc-radio-list, oculist-dvt.5) nested inside this outer one, so reaching it exercises
  // both scroll levels together.
  async function getPanelGeometry() {
    return page.evaluate(() => {
      const host = document.getElementById('oc-wrap');
      const root = host.shadowRoot;
      const panel = root.querySelector('#oc-settings-panel');
      const header = root.querySelector('.oc-settings-header');
      const rows = Array.from(root.querySelectorAll('.oc-radio-item'));
      const lastRow = rows[rows.length - 1];
      return {
        hostRect: host.getBoundingClientRect(),
        panelRect: panel.getBoundingClientRect(),
        headerRect: header.getBoundingClientRect(),
        panelScrollTop: panel.scrollTop,
        panelScrollHeight: panel.scrollHeight,
        panelClientHeight: panel.clientHeight,
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
    await page.goto(origin);
    await openFinder();
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // Every test starts from a closed overlay, so panel/focus/position state never leaks
  // between tests (same rationale/retry loop as settings_panel_effect_list_overflow.test.js
  // — a single Escape only closes the panel, not the whole overlay).
  beforeEach(async () => {
    for (let attempts = 0; attempts < 5 && (await page.locator('#oc-wrap').count()) > 0; attempts++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page
        .waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: 300 })
        .catch(() => {});
    }
    await waitForOverlayClosed();
    await openFinder();
  });

  POSITIONS.forEach((pos) => {
    test(`position "${pos}": panel host stays within the 600px viewport, header is visible unscrolled, and the footer is reachable by scrolling`, async () => {
      await openSettings();
      await setPosition(pos);

      const geo = await getPanelGeometry();

      // The core regression: with no max-height on the panel, the whole host (bar + panel,
      // both position: fixed with no scrollable ancestor) grows past the viewport. Top-
      // anchored bars (tl/tr) push the bottom past 600; bottom-anchored bars (bl/br), being
      // a flex column-reverse anchored at the viewport's bottom edge, push their OWN TOP
      // (bar included) above y=0 instead. Both are checked here since they fail oppositely.
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
      // own visible box — otherwise "the footer is reachable" would pass vacuously because
      // nothing needed scrolling in the first place (same rationale as the sibling effect-
      // list overflow test's analogous self-check).
      assert.ok(
        geo.panelScrollHeight > geo.panelClientHeight + 1,
        `position ${pos}: panel content (scrollHeight=${geo.panelScrollHeight}) must exceed its visible box ` +
        `(clientHeight=${geo.panelClientHeight}) — otherwise this test cannot tell a real scroll container ` +
        'from an accidentally-oversized one'
      );

      // The header must be visible without any scrolling — a freshly-opened panel starts
      // at scrollTop 0, so the header (the panel's first child) must already sit at or
      // below the panel's own top edge.
      assert.strictEqual(geo.panelScrollTop, 0, `position ${pos}: panel must start unscrolled`);
      assert.ok(
        geo.headerRect.top >= geo.panelRect.top - EPS && geo.headerRect.top >= -EPS,
        `position ${pos}: header (top=${geo.headerRect.top}) must not be clipped above the panel's visible box ` +
        `(panel top=${geo.panelRect.top}) or the viewport`
      );

      // The footer (the last effect row, the panel's deepest real control — see
      // getPanelGeometry() above) must become reachable once scrolled to — this is the
      // assertion that actually exercises "clipped content is recoverable", not just that
      // heights compare favourably. scrollIntoView({block:'nearest'}) walks every scrollable
      // ancestor it needs to (both the inner .oc-radio-list, oculist-dvt.5, and this outer
      // #oc-settings-panel) — the fixed-position host above both is not scrollable, so this
      // cannot mask a genuinely off-screen host.
      await page.evaluate(() => {
        const host = document.getElementById('oc-wrap');
        const root = host.shadowRoot;
        const rows = Array.from(root.querySelectorAll('.oc-radio-item'));
        rows[rows.length - 1].scrollIntoView({ block: 'nearest' });
      });

      const afterScroll = await getPanelGeometry();
      assert.ok(
        afterScroll.panelScrollTop > 0,
        `position ${pos}: scrolling to the last effect row must actually move the panel's scroll ` +
        'position (scrollTop stayed 0) — otherwise the row was already visible and this assertion is vacuous'
      );
      assert.ok(
        afterScroll.lastRowRect.top >= afterScroll.panelRect.top - EPS &&
        afterScroll.lastRowRect.bottom <= afterScroll.panelRect.bottom + EPS,
        `position ${pos}: last effect row must be within the panel's visible scroll bounds after being ` +
        `scrolled to — row rect ${JSON.stringify(afterScroll.lastRowRect)}, panel rect ${JSON.stringify(afterScroll.panelRect)}`
      );
      assert.ok(
        afterScroll.lastRowRect.top >= -EPS && afterScroll.lastRowRect.bottom <= VIEWPORT.height + EPS,
        `position ${pos}: last effect row must also land within the ${VIEWPORT.height}px viewport itself ` +
        `once scrolled to — row rect ${JSON.stringify(afterScroll.lastRowRect)}`
      );
    });
  });
});
