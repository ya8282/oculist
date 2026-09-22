// Bone Assembly beacon effect (oculist-nq1x.5): promotes fxBoneAssembly (artifacts/
// prototypes/effects-playground.html, the nq1x.4 redraw) into extension/content.js as the
// first entry in the Halloween pack. A scatter of loose bones flies in beside the match,
// snaps into a small standing skeleton, the skull detaches and rolls ahead while the
// headless body dashes to catch up, then the whole figure collapses into a heap and fades.
//
// Modeled on test/trail_effect.test.js (document-space + cancellation/completion + Lite
// Mode idioms) and test/effect_pack_settings_control.test.js (pack enumeration idioms),
// against the REAL extension — boneassembly is a genuine effectsRegistry entry under
// pack:'halloween', so no fixture copy is needed for either.
//
// Needs a real browser for the same reasons as those two: WAAPI, real layout, and
// chrome.storage.sync-driven settings only exist in real Chromium.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target sits deep enough into the page (420px left margin, on top of the tall spacer's
// own vertical push) that the default-viewport test has ample room to its right, while a
// narrowed viewport can still leave ample room to its LEFT — the same fixture drives both
// the right-placement and the left/mirrored-fallback placement tests via page.
// setViewportSize() alone, with #target's own document position never moving. The 3000px-
// wide wrapper gives the page real horizontal scrollable overflow (#target's own x
// position is unaffected — it is still governed by the inner paragraph's own margin, not
// the wrapper's width) so the document-space test can exercise window.scrollX too, not
// just scrollY.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="width:3000px;">
<div style="height:4000px"></div>
<p style="margin-left:420px;">filler text <span id="target">quarklet</span></p>
</div>`;

// A second, deliberately tiny fixture: #target sits right at the page's own left edge, so
// at a narrow-enough viewport BOTH the right fit (no room past the match) and the left fit
// (no room before the page's own left edge) fail — the "neither side fits" fallback branch
// (`landing = sideRight.fits ? sideRight : (sideLeft.fits ? sideLeft : sideRight)`), unlike
// the main fixture's left-mirrored case where only the right side is made to fail.
const PAGE_NARROW = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; padding: 10px; font: 16px/1.6 system-ui, sans-serif; }</style>
<span id="target">quarklet</span>`;

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const BONEASSEMBLY_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:boneassembly"]';

describe('Bone Assembly: a skeleton scatters in, snaps together, the skull rolls ahead, and it collapses into a heap', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url.indexOf('/narrow') === 0 ? PAGE_NARROW : PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing — the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1400, height: 800 },
    });

    page = await ctx.newPage();

    // Attach CDP before navigating so the isolated-world execution-context-created event
    // is never missed.
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
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });

    // Select Bone Assembly and turn its pack on for the whole suite before ever opening
    // the finder — every tab of this persistent context shares this chrome.storage.sync
    // write.
    await setSettings({ effect: 'boneassembly', enabledPacks: ['halloween'] });

    await openFinder(page);
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    await waitForMatchCount(page);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function openFinder(pg) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await pg.keyboard.press('Control+f');
      try {
        await pg.waitForSelector(INPUT, { timeout: 250 });
        return;
      } catch (e) {
        // keep retrying
      }
    }
    await pg.waitForSelector(INPUT, { timeout: POLL_TIMEOUT }); // surfaces the real timeout error
  }

  async function waitForMatchCount(pg) {
    await pg.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
  }

  function evalInContentScript(expression, target) {
    const c = (target && target.client) || client;
    const ctxId = (target && target.contextId) || isolatedContextId;
    return c
      .send('Runtime.evaluate', {
        expression,
        contextId: ctxId,
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

  async function armSettingsEcho() {
    return evalInContentScript(`
      (function () {
        if (!window.__ocSettingsEchoInstalled) {
          window.__ocSettingsEchoInstalled = true;
          window.__ocSettingsEchoes = 0;
          chrome.storage.onChanged.addListener(function (changes) {
            if (changes['oc-settings']) window.__ocSettingsEchoes++;
          });
        }
        return window.__ocSettingsEchoes;
      })()
    `);
  }

  async function waitForSettingsEcho(before) {
    return waitForCondition(() => evalInContentScript('window.__ocSettingsEchoes'), (v) => v > before, {
      timeout: POLL_TIMEOUT,
      message: 'oc-settings change never echoed into the content script',
    });
  }

  async function setSettings(patch) {
    const echoBefore = await armSettingsEcho();
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, ' + JSON.stringify(patch) + ');' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
    await waitForSettingsEcho(echoBefore);
  }

  // Same production cancellation path as trail_effect.test.js's replay(): cancels any
  // in-flight beacon through window.__ocTest.cancelBeacons() (the exact function animate()
  // itself calls first), then presses Enter to (re-)fire, waiting on `predicate` — folding
  // presence and geometry reads into one page-side tick (oculist-d5c) so nothing can
  // self-clean in a round-trip gap.
  async function replay(pg, predicate) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await pg.keyboard.press('Enter');
    const handle = await pg.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient') ? true : null)),
      null,
      { timeout: POLL_TIMEOUT }
    );
    return handle.jsonValue();
  }

  function figureSnapshot() {
    const fig = document.querySelector('.oc-beacon-transient');
    if (!fig) return null;
    const targetRect = document.getElementById('target').getBoundingClientRect();
    return {
      left: fig.style.left,
      top: fig.style.top,
      width: fig.style.width,
      height: fig.style.height,
      transform: fig.style.transform,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      targetLeft: targetRect.left,
      targetTop: targetRect.top,
      targetRight: targetRect.right,
      targetBottom: targetRect.bottom,
      targetWidth: targetRect.width,
      targetHeight: targetRect.height,
      pieceCount: document.querySelectorAll('[data-ba-piece]').length,
    };
  }

  test('mounts in document coordinates: the figure tracks a scrolled page, not just the viewport', async () => {
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });

    try {
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);

      const geom = await replay(page, figureSnapshot);
      assert.ok(geom, 'expected a mounted .oc-beacon-transient figure');
      assert.ok(geom.scrollY > 0, `sanity check: the page must actually be scrolled, got scrollY=${geom.scrollY}`);
      assert.strictEqual(geom.pieceCount, 8, 'expected all 8 named pieces (skull, ribcage, pelvis, spine, 2 legs, 2 arms)');

      // figHeight is a pure function of the match's own viewport height and the default
      // beacon scale (1.0, no vision-settings override in this fixture) — independent of
      // the clearance/placement math, so it can be predicted exactly without replicating
      // the whole reach derivation.
      const expectedFigHeight = Math.max(100, Math.min(110, 2.6 * geom.targetHeight));
      const actualHeight = parseFloat(geom.height);
      assert.ok(
        Math.abs(actualHeight - expectedFigHeight) <= 1,
        `figure height: expected ~${expectedFigHeight}, got ${actualHeight}`
      );

      // The figure is anchored at the match's own feet baseline (rect.bottom) minus its
      // own height, then converted to document space by adding window.scrollY exactly
      // once — a missing scrollY term here is the one thing a scrolled-page assertion
      // catches that an unscrolled one cannot.
      const expectedDocTop = geom.targetBottom - expectedFigHeight + geom.scrollY;
      const actualDocTop = parseFloat(geom.top);
      assert.ok(
        Math.abs(actualDocTop - expectedDocTop) <= 2,
        `figure document top: expected ~${expectedDocTop}, got ${actualDocTop}`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('mounts in document coordinates: horizontal position also tracks a scrolled page', async () => {
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });

    try {
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);

      const geom0 = await replay(page, figureSnapshot);
      assert.ok(geom0, 'expected a mounted figure at scrollX=0');
      assert.strictEqual(geom0.scrollX, 0, 'sanity check: starting scrollX must be 0');
      assert.strictEqual(geom0.transform.indexOf('scaleX(-1)'), -1, 'sanity check: the baseline firing must land unmirrored (right)');

      // A modest horizontal scroll — the fixture's #target sits ~545px into a 3000px-wide
      // page, and the viewport (1400px) has hundreds of px of slack past the match's own
      // right edge, so 150px of scrollX leaves the right-landing side selection (and so
      // the whole pivotX/figLeft formula) unchanged.
      //
      // #target's own DOCUMENT position never moves, so its VIEWPORT-relative rect shifts
      // by exactly -scrollDelta as scrollX increases (the viewport window slides right
      // over fixed content) — and since figLeft (viewport space) is derived from that same
      // rect, it shifts by -scrollDelta too. docLeft = figLeft + window.scrollX therefore
      // has the two terms cancel exactly: correct code predicts docLeft is INVARIANT
      // across this scroll. A missing "+ window.scrollX" term (the horizontal twin of the
      // scrollY term the sibling test above catches) would instead leave docLeft equal to
      // figLeft alone, which DOES shift by -scrollDelta — so that mutant moves the figure,
      // this correct code does not.
      await page.evaluate(() => window.scrollTo(150, window.scrollY));
      const geom1 = await replay(page, figureSnapshot);
      assert.ok(geom1, 'expected a mounted figure at scrollX=150');
      assert.strictEqual(geom1.scrollX, 150, `sanity check: the page must actually be scrolled horizontally, got scrollX=${geom1.scrollX}`);
      assert.strictEqual(
        geom1.transform.indexOf('scaleX(-1)'),
        -1,
        'this scroll amount must not flip the landing side, or the two firings are not comparable'
      );

      const actualDelta = parseFloat(geom1.left) - parseFloat(geom0.left);
      assert.ok(
        Math.abs(actualDelta) <= 2,
        `figure document left must stay invariant under horizontal scroll (the page's own content didn't move): expected ~0 shift, got ${actualDelta}`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('placement: lands to the right of the match by default, with plenty of room', async () => {
    await page.setViewportSize({ width: 1400, height: 800 });
    try {
      const geom = await replay(page, figureSnapshot);
      assert.ok(geom, 'expected a mounted figure');
      assert.strictEqual(
        geom.transform.indexOf('scaleX(-1)'),
        -1,
        'a right landing must not carry the mirror transform'
      );
      assert.ok(
        parseFloat(geom.left) - geom.scrollX >= geom.targetRight,
        'a right-landed figure must start at or past the match\'s own right edge'
      );
    } finally {
      await page.setViewportSize({ width: 1400, height: 800 });
    }
  });

  test('placement: mirrors to the left when the viewport leaves no room on the right (a viewport-edge fallback)', async () => {
    // #target sits ~545px into the page (420px margin + body padding + leading filler
    // text) — a 650px-wide viewport leaves only ~15px past the match's own right edge
    // (nowhere near the figure's own clearance requirement), while ~500px remains to the
    // match's left, comfortably enough for the mirrored landing to fit.
    await page.setViewportSize({ width: 650, height: 800 });
    try {
      const geom = await replay(page, figureSnapshot);
      assert.ok(geom, 'expected a mounted figure even with the right side unavailable');
      assert.notStrictEqual(
        geom.transform.indexOf('scaleX(-1)'),
        -1,
        'a left landing must carry the mirror transform'
      );
      assert.ok(
        parseFloat(geom.left) + parseFloat(geom.width) - geom.scrollX <= geom.targetLeft,
        'a left-landed figure must end at or before the match\'s own left edge'
      );
    } finally {
      await page.setViewportSize({ width: 1400, height: 800 });
    }
  });

  test('placement: falls back to a rendered (unmirrored) landing rather than disappearing when neither side fits', async () => {
    const page2 = await ctx.newPage();
    try {
      await page2.setViewportSize({ width: 220, height: 400 });
      await page2.goto(origin + 'narrow');
      await openFinder(page2);
      await page2.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page2);
      await page2.keyboard.press('Enter');

      // #target sits at the page's own left edge (10px body padding, no leading text) in
      // a 220px-wide viewport: the right side has under ~110px of room (far short of the
      // clearance a 100-110px-tall figure needs), and the left side has under ~10px
      // before the page's own left edge — both `.fits` checks fail by construction, so
      // this exercises the ternary's final `: sideRight` fallback, not a genuine fit.
      const handle = await page2.waitForFunction(
        () => {
          const fig = document.querySelector('.oc-beacon-transient');
          if (!fig) return null;
          return { transform: fig.style.transform, pieceCount: document.querySelectorAll('[data-ba-piece]').length };
        },
        null,
        { timeout: POLL_TIMEOUT }
      );
      const geom = await handle.jsonValue();
      assert.strictEqual(geom.pieceCount, 8, 'the fallback landing must still render the whole figure, not a partial one');
      assert.strictEqual(
        geom.transform.indexOf('scaleX(-1)'),
        -1,
        'the fallback landing defaults to the unmirrored (right) side'
      );
    } finally {
      await page2.close();
    }
  });

  test('the figure survives past the earliest scatter-in piece\'s own finish, stays mounted through the collapse, and is still present just before the natural end', async () => {
    const mounted = await replay(page, () => (document.querySelectorAll('[data-ba-piece]').length === 8 ? true : null));
    assert.ok(mounted, 'sanity check: the figure must actually mount before it can be checked mid-sequence');

    // At the default (normal) animation speed the earliest scatter-in piece (the skull,
    // STAGGER.skull=0) finishes at SNAP_DONE_T=640ms — if the figure's own removal were
    // wired to the first animation to finish rather than the last, it would already be
    // gone here.
    await page.waitForTimeout(800);
    let count = await page.evaluate(() => document.querySelectorAll('[data-ba-piece]').length);
    assert.strictEqual(
      count,
      8,
      'the figure must still be mounted at ~800ms, well past the earliest piece\'s own 640ms scatter-in finish'
    );

    // COLLAPSE_START is 1430ms — the roll/dash have already finished and the collapse is
    // underway.
    await page.waitForTimeout(700); // total elapsed ~1500ms
    count = await page.evaluate(() => document.querySelectorAll('[data-ba-piece]').length);
    assert.strictEqual(count, 8, 'the figure must still be mounted during the collapse (~1500ms)');

    // The whole beat sequence ends at ~2370ms (COLLAPSE_START + COLLAPSE_DUR + HEAP_HOLD +
    // FADE_DUR) — still present just before that.
    await page.waitForTimeout(750); // total elapsed ~2250ms
    count = await page.evaluate(() => document.querySelectorAll('[data-ba-piece]').length);
    assert.strictEqual(count, 8, 'the figure must still be mounted just before the natural end (~2250ms)');

    // Let it actually finish and clean up so it doesn't leak into the next test.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation is actually canceled', async () => {
    const mounted = await replay(page, () => (document.querySelectorAll('[data-ba-piece]').length === 8 ? true : null));
    assert.ok(mounted, 'sanity check: the figure must actually mount before it can be cancelled');

    // destroyBeacon() (content.js) always removes the element it's handed, regardless of
    // whether __waapiAnims lists every live animation — a missing entry there leaks a
    // still-running Animation on a detached node (waapi_beacon_cancel.test.js's own
    // header), invisible to a DOM-survival check alone. Snapshot every live Animation on
    // the figure BEFORE cancelling — getAnimations() would not necessarily include
    // animations on an already-detached element — and hold the references so their
    // playState can still be read after removal.
    const animCount = await page.evaluate(() => {
      const fig = document.querySelector('.oc-beacon-transient');
      window.__baTestAnims = fig.getAnimations({ subtree: true });
      return window.__baTestAnims.length;
    });
    assert.ok(animCount > 0, 'sanity check: the figure must have live animations before cancellation');

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });

    const states = await page.evaluate(() => window.__baTestAnims.map((a) => a.playState));
    assert.ok(
      states.every((s) => s === 'idle'),
      `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${states.join(', ')}`
    );
  });

  test('natural completion: nothing remains in the DOM once the beat sequence finishes', async () => {
    const mounted = await replay(page, () => (document.querySelectorAll('[data-ba-piece]').length === 8 ? true : null));
    assert.ok(mounted, 'sanity check: the figure must actually mount before it can complete');

    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
      timeout: POLL_TIMEOUT,
    });
  });

  test('Lite Mode keeps the same silhouette and full beat sequence — this effect has no glow or flicker to drop', async () => {
    const fullGeom = await replay(page, figureSnapshot);
    assert.strictEqual(fullGeom.pieceCount, 8, 'full mode must render all 8 pieces');

    try {
      await setSettings({ performanceMode: true });
      const liteGeom = await replay(page, figureSnapshot);
      assert.strictEqual(liteGeom.pieceCount, 8, 'Lite Mode must render the identical 8-piece silhouette — nothing decorative to drop');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('pack enumeration: absent while halloween is disabled, present once enabled, selection survives a disable/re-enable round trip, and the runtime falls back safely while disabled', async () => {
    async function openSettings() {
      await page.locator(GEAR_BTN).click();
      await page.waitForSelector(SETTINGS_PANEL, { timeout: POLL_TIMEOUT });
    }
    async function closeSettings() {
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => !document.getElementById('oc-wrap').shadowRoot.querySelector('#oc-settings-panel'),
        null,
        { timeout: POLL_TIMEOUT }
      );
    }

    try {
      // Disabled: absent from both availableEffects() and the picker DOM.
      await setSettings({ enabledPacks: [] });
      let keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.strictEqual(keys.indexOf('boneassembly'), -1, 'boneassembly must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(BONEASSEMBLY_EFFECT_ROW).count(),
        0,
        'boneassembly must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      // Enabled: present in both.
      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('boneassembly'), -1, 'boneassembly must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(BONEASSEMBLY_EFFECT_ROW).count(),
        1,
        'boneassembly must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'boneassembly' (a real,
      // registered — just currently unavailable — key, not a genuinely unknown one), so
      // firing must fall back to some other effect rather than mount a bone-assembly
      // figure or throw.
      await setSettings({ effect: 'boneassembly', enabledPacks: [] });
      let geom = await replay(page, () => {
        const fig = document.querySelector('.oc-beacon-transient');
        return fig ? { pieceCount: document.querySelectorAll('[data-ba-piece]').length } : null;
      });
      assert.strictEqual(
        geom.pieceCount,
        0,
        'while the pack is disabled, the runtime fallback must not render a bone-assembly figure'
      );
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });

      // Selection restored on re-enable: no explicit re-selection of 'boneassembly' here —
      // if the disable step above had rewritten settings.effect (it must not, per
      // isGenuinelyUnknownEffect()'s own contract), this would now fire whatever it was
      // rewritten to instead.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(page, () => {
        const count = document.querySelectorAll('[data-ba-piece]').length;
        return count === 8 ? { pieceCount: count } : null;
      });
      assert.strictEqual(geom.pieceCount, 8, 'the stored boneassembly selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs
      // (test/active_match_magnifier.test.js documents the same gotcha) — the happy path
      // above already leaves settings at exactly { effect: 'boneassembly', enabledPacks:
      // ['halloween'] }, so restoring straight to that value here would be a no-op write
      // that setSettings()'s echo-wait would hang on. Routing through a sentinel value
      // first guarantees both writes are genuine changes, regardless of which line above
      // (if any) actually threw.
      await setSettings({ enabledPacks: ['__oc_boneassembly_test_reset__'] });
      await setSettings({ effect: 'boneassembly', enabledPacks: ['halloween'] });
    }
  });
});
