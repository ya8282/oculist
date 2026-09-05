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

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
  }

  // Same retry-Control+f-until-the-input-appears rationale as several sibling browser
  // tests (e.g. settings_panel_viewport_overflow.test.js) — no CDP session in this file to
  // gate on content-script readiness instead.
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
    await openFinder();
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
    await waitForOverlayClosed();
    await openFinder();

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
