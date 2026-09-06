// oculist-tdj.3: packs default OFF (settings.enabledPacks starts empty), so once a pack
// ships (knownPacks(), extension/content.js, returns something non-empty) the settings-
// panel toggle that turns it on (oculist-tdj.2) is otherwise undiscoverable — opt-in UI
// nobody has a reason to open. This is the single dismissible nudge toward that toggle.
//
// No effectsRegistry entry ships with a `pack` on the real tree today (oculist-tdj.1), so
// this file drives its own fixture instead of the real extension/content.js: a temp copy
// of extension/ whose content.js has exactly one registry entry (`cybervision`) patched
// to carry `pack: 'seasonal'`. See createPackedFixtureExtension() below. The real
// extension/content.js is never written to.
//
// Needs a real browser: settings.packsNoticeDismissed's persistence across an overlay
// close/reopen goes through a real chrome.storage.sync-backed write/read
// (OculistSettingsMigration.writeOcSettings(), extension/settings-migration.js), which
// jsdom has no equivalent of.

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
const NOTICE = '#oc-wrap >> .oc-pack-notice';
const NOTICE_CLOSE = '#oc-wrap >> .oc-pack-notice-close';
const NOTICE_CTA = '#oc-wrap >> .oc-pack-notice-cta';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';

const EPS = 1; // subpixel-rounding tolerance, same order of magnitude as sibling geometry tests

// Shared across all describe blocks below (each launches its own context/page against a
// freshly-dismissed profile) — same retry-Control+f-until-the-input-appears rationale as
// several sibling browser tests (e.g. settings_panel_viewport_overflow.test.js): no CDP
// session in this file to gate on content-script readiness instead.
async function openFinder(page) {
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

async function waitForOverlayClosed(page) {
  await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
}

// Same bounded-retry idiom as effect_pack_settings_control.test.js's closeOverlayFully: a
// single Escape only closes whichever panel (settings, in the CTA test below) is open on
// top — the overlay itself needs a second Escape once no panel is left open.
async function closeOverlayFully(page) {
  for (let attempts = 0; attempts < 5 && (await page.locator('#oc-wrap').count()) > 0; attempts++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: 300 }).catch(() => {});
  }
  await waitForOverlayClosed(page);
}

// Copies extension/ into a fresh temp dir and patches the copy's content.js so exactly
// one effectsRegistry entry carries `pack: 'seasonal'` — the one thing knownPacks() (see
// extension/content.js) needs to return something non-empty and make the notice eligible
// to show. Returns the temp dir path; the caller removes it once done.
function createPackedFixtureExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oculist-pack-notice-'));
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

describe('Pack discovery notice (oculist-tdj.3)', () => {
  let server, ctx, page, fixtureDir;

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
    await page.goto(origin);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    // Only ever removes the temp copy created above — never touches extension/ itself.
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('appears on first open, does not steal focus from the find input, is dismissible, and never reappears once dismissed', async () => {
    // First open: the notice must show, since a pack is available (the fixture's patched
    // `cybervision` entry) and nothing has dismissed it yet.
    await openFinder(page);
    await page.waitForSelector(NOTICE, { timeout: POLL_TIMEOUT });

    // Must not have stolen focus from the find input — the whole point of the overlay
    // (content.js's maybeShowPackDiscoveryNotice() deliberately never calls .focus()).
    const activeIsInput = await page.evaluate(() => {
      const root = document.getElementById('oc-wrap').shadowRoot;
      return root.activeElement === root.querySelector('.oc-input');
    });
    assert.strictEqual(
      activeIsInput,
      true,
      'opening the overlay with the pack-discovery notice showing must leave focus on the find input'
    );

    // Dismissible without acting on it: the close control alone removes it and answers
    // the prompt (settings.packsNoticeDismissed), with no need to visit the settings panel.
    await page.locator(NOTICE_CLOSE).click();
    await page.waitForFunction(
      () => !document.getElementById('oc-wrap').shadowRoot.querySelector('.oc-pack-notice'),
      null,
      { timeout: POLL_TIMEOUT }
    );

    // Close the whole overlay, then reopen it — the second open.
    await page.keyboard.press('Escape');
    await waitForOverlayClosed(page);
    await openFinder(page);

    // Assert-absence: give it a real beat to (not) reappear, then confirm it stayed gone.
    await page.waitForTimeout(500);
    const noticeCountOnSecondOpen = await page.locator(NOTICE).count();
    assert.strictEqual(
      noticeCountOnSecondOpen,
      0,
      'the pack-discovery notice must not reappear on the second overlay open once dismissed'
    );
  });
});

// oculist-tdj.6: the sibling describe above covers appearance, focus retention, and
// dismissal persistence (three of oculist-tdj.3's five done-criteria). The three describes
// below regression-guard the remaining two behaviours plus the CTA path, each verified
// correct by the tdj.3 reviewer but previously unguarded by any assertion. Each gets its
// own context/fixture/profile (rather than sharing the describe above's) because
// settings.packsNoticeDismissed persists for the lifetime of a profile once set — a test
// needs the notice un-dismissed and available to show, which a shared, already-dismissed
// page cannot provide again without reaching into extension storage directly.

describe('Pack discovery notice: reduced motion renders statically (oculist-tdj.6)', () => {
  let server, ctx, page, fixtureDir;

  before(async () => {
    fixtureDir = createPackedFixtureExtension();

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/`;

    // reducedMotion:'reduce' at launch, same as the OS-level prefers-reduced-motion query
    // effectiveMotion() (content.js) reads live — see prefers_reduced_motion.test.js for
    // the established way this repo drives the query. channel:'chromium' is load-bearing,
    // same note as the sibling describe above.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${fixtureDir}`, `--load-extension=${fixtureDir}`],
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });

    page = await ctx.newPage();
    await page.goto(origin);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('under prefers-reduced-motion the notice has no running Web Animations', async () => {
    await openFinder(page);
    await page.waitForSelector(NOTICE, { timeout: POLL_TIMEOUT });

    // getAnimations().length, not a duration value: a duration assertion would still pass
    // on a "shorter" animation, not a genuinely static render. maybeShowPackDiscoveryNotice()
    // (content.js) must skip its .animate() call entirely under reduced motion, the same
    // two-tier motion gate buildListsMenu() uses for its own entrance animation.
    const animationCount = await page.evaluate(() => {
      const notice = document.getElementById('oc-wrap').shadowRoot.querySelector('.oc-pack-notice');
      return notice.getAnimations().length;
    });
    assert.strictEqual(
      animationCount,
      0,
      'the pack-discovery notice must render statically (zero running animations) under prefers-reduced-motion'
    );
  });
});

describe('Pack discovery notice: does not reflow the host page (oculist-tdj.6)', () => {
  let server, ctx, page, fixtureDir;

  before(async () => {
    fixtureDir = createPackedFixtureExtension();

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/`;

    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${fixtureDir}`, `--load-extension=${fixtureDir}`],
      viewport: { width: 1280, height: 800 },
    });

    page = await ctx.newPage();
    await page.goto(origin);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('the notice lives only in the overlay shadow root and never touches the host page layout', async () => {
    // Baseline: scroll metrics of the actual host document, captured before the overlay
    // (and its notice) exist at all.
    const before = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docScrollHeight: document.documentElement.scrollHeight,
    }));

    await openFinder(page);
    await page.waitForSelector(NOTICE, { timeout: POLL_TIMEOUT });

    const afterMetrics = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      // Native querySelectorAll on the top document — unlike Playwright's own
      // shadow-piercing locators, this respects shadow-root encapsulation, so it only
      // finds a match if the notice actually leaked into the light DOM.
      lightDomNoticeCount: document.querySelectorAll('.oc-pack-notice').length,
    }));

    assert.deepStrictEqual(
      {
        bodyScrollWidth: afterMetrics.bodyScrollWidth,
        bodyScrollHeight: afterMetrics.bodyScrollHeight,
        docScrollWidth: afterMetrics.docScrollWidth,
        docScrollHeight: afterMetrics.docScrollHeight,
      },
      before,
      'the host page\'s own scroll metrics must not change when the pack-discovery notice appears'
    );
    assert.strictEqual(
      afterMetrics.lightDomNoticeCount,
      0,
      'the pack-discovery notice must never appear in the host page\'s light DOM, only inside the overlay shadow root'
    );
  });
});

describe('Pack discovery notice: Open Settings CTA (oculist-tdj.6)', () => {
  let server, ctx, page, fixtureDir;

  before(async () => {
    fixtureDir = createPackedFixtureExtension();

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/`;

    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${fixtureDir}`, `--load-extension=${fixtureDir}`],
      viewport: { width: 1280, height: 800 },
    });

    page = await ctx.newPage();
    await page.goto(origin);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('clicking Open Settings opens the settings panel and dismisses the notice permanently', async () => {
    await openFinder(page);
    await page.waitForSelector(NOTICE, { timeout: POLL_TIMEOUT });

    // The CTA's click handler (content.js) dismisses the notice before calling
    // openSettings(), so by the time the panel exists the notice is already gone — this
    // test never overlaps with the known oculist-3rq defect (the notice, while showing,
    // adds ~46.6px the settings-panel max-height formula does not subtract), since the
    // notice and the settings panel are never both on screen at once here.
    await page.locator(NOTICE_CTA).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });

    const noticeGoneAfterClick = await page.locator(NOTICE).count();
    assert.strictEqual(
      noticeGoneAfterClick,
      0,
      'the Open Settings CTA must dismiss the notice as part of opening the settings panel'
    );

    // Permanence: close the whole overlay (settings panel, then the overlay itself) and
    // reopen — the notice must not come back just because the CTA (rather than the close
    // control) was what dismissed it.
    await closeOverlayFully(page);
    await openFinder(page);
    await page.waitForTimeout(500);
    const noticeCountOnSecondOpen = await page.locator(NOTICE).count();
    assert.strictEqual(
      noticeCountOnSecondOpen,
      0,
      'the pack-discovery notice must not reappear after being dismissed via the Open Settings CTA'
    );
  });
});

// oculist-3rq: #oc-settings-panel's max-height cap (barChromePx, content.js) only subtracts
// the bar's own chrome, not the pack-discovery notice's height — when the notice is showing
// (undismissed, >=1 known pack) it renders BETWEEN the bar and the settings panel, so bar +
// notice + panel can overflow the viewport by roughly the notice's own ~46.6px, at any
// viewport height (the error is a constant-per-viewport formula gap, not something that
// scales with vh). Placed in this file rather than settings_panel_viewport_overflow.test.js
// (the oculist-6cd coverage) because that file has no packed-registry fixture at all and
// every one of its cases predates knownPacks() ever returning anything non-empty; this file
// already carries createPackedFixtureExtension() (single 'seasonal'-packed cybervision entry)
// and is where the notice's own geometry is otherwise exercised.
describe('Pack discovery notice: settings-panel height cap accounts for the notice (oculist-3rq)', () => {
  let server, ctx, page, fixtureDir;

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
    await page.goto(origin);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  // Default position ('tr', top-anchored) is enough here — settings_panel_viewport_overflow.
  // test.js already exercises all four POS_DATA anchors for the barChromePx mechanism itself;
  // this describe only needs to show the notice's height gets folded into the same cap, which
  // does not depend on which edge the bar is pinned to (per the bead: the overflow reproduced
  // identically at both 1280x800 and 1280x600).
  async function openSettingsWithNoticeShowing() {
    await openFinder(page);
    await page.waitForSelector(NOTICE, { timeout: POLL_TIMEOUT });
    await page.locator(GEAR_BTN).click();
    await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
  }

  async function hostBottom() {
    return page.evaluate(() => document.getElementById('oc-wrap').getBoundingClientRect().bottom);
  }

  // Every test below runs its assertions inside try/finally so a failed assertion still
  // leaves the overlay closed (and the viewport restored) for the next test in this describe
  // — otherwise a failure here would cascade into unrelated-looking timeouts downstream
  // (e.g. the settings panel already open from a previous test's aborted teardown, so the
  // next test's gear-button click toggles it closed instead of open).
  test('host bottom stays within an 800px viewport with the notice showing and the settings panel open', async () => {
    try {
      await openSettingsWithNoticeShowing();

      const bottom = await hostBottom();
      assert.ok(
        bottom <= 800 + EPS,
        `host bottom (${bottom}) must stay within the 800px viewport with the pack-discovery notice showing above ` +
        "#oc-settings-panel — the panel's max-height cap (barChromePx, content.js) must also subtract the notice's " +
        'own rendered height'
      );
    } finally {
      // Leaves the notice undismissed on purpose — the next test in this describe reuses
      // the same profile/page and needs it still eligible to show at a different viewport.
      await closeOverlayFully(page);
    }
  });

  test('the same holds at a shorter, 600px viewport (the overflow is viewport-height independent)', async () => {
    try {
      await page.setViewportSize({ width: 1280, height: 600 });
      await openSettingsWithNoticeShowing();

      const bottom = await hostBottom();
      assert.ok(
        bottom <= 600 + EPS,
        `host bottom (${bottom}) must stay within the 600px viewport with the pack-discovery notice showing`
      );
    } finally {
      await closeOverlayFully(page);
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  });

  test("dismissing the notice returns the panel's max-height cap to what barChromePx alone allows, not a permanently smaller cap", async () => {
    try {
      await openFinder(page);
      await page.waitForSelector(NOTICE, { timeout: POLL_TIMEOUT });

      const noticeHeight = await page.evaluate(() => {
        const notice = document.getElementById('oc-wrap').shadowRoot.querySelector('.oc-pack-notice');
        return notice.getBoundingClientRect().height;
      });

      await page.locator(GEAR_BTN).click();
      await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
      const maxHeightWithNotice = await page.evaluate(() => {
        const panel = document.getElementById('oc-wrap').shadowRoot.querySelector('#oc-settings-panel');
        return parseFloat(getComputedStyle(panel).maxHeight);
      });

      await page.locator(NOTICE_CLOSE).click();
      await page.waitForFunction(
        () => !document.getElementById('oc-wrap').shadowRoot.querySelector('.oc-pack-notice'),
        null,
        { timeout: POLL_TIMEOUT }
      );

      const maxHeightAfterDismiss = await page.evaluate(() => {
        const panel = document.getElementById('oc-wrap').shadowRoot.querySelector('#oc-settings-panel');
        return parseFloat(getComputedStyle(panel).maxHeight);
      });

      assert.ok(
        maxHeightAfterDismiss > maxHeightWithNotice + 1,
        'panel max-height must grow back once the notice is dismissed — with notice: ' +
        `${maxHeightWithNotice}px, after dismiss: ${maxHeightAfterDismiss}px`
      );
      assert.ok(
        Math.abs((maxHeightAfterDismiss - maxHeightWithNotice) - noticeHeight) <= 2,
        `the max-height regained after dismissal (${maxHeightAfterDismiss - maxHeightWithNotice}px) must match the ` +
        `notice's own measured height (${noticeHeight}px) within 2px`
      );
    } finally {
      await closeOverlayFully(page);
    }
  });
});
