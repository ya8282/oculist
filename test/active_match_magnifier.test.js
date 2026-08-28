// Magnifier overlay (oculist-l6m.39): a companion overlay to the "N of M" counter label
// that renders the currently active match's own text enlarged in a card beside it, so a
// user working through a multi-term list can tell which term the beacon is on at a
// glance. drawActiveMatchMagnifier() is called from drawActiveOverlays() directly — it is
// NOT an effectsRegistry entry — and absorbs drawActiveMatchLabel()'s counter whenever it
// successfully draws.
//
// Needs a real browser for the same reasons as resize_overlays.test.js/prefers_reduced_
// motion.test.js: CSS.highlights, real layout (getBoundingClientRect/getComputedStyle) and
// the real Web Animations API only exist in real Chromium, not jsdom.
//
// Settings are seeded directly through chrome.storage.sync from inside the content
// script's own isolated execution context (the same mechanism the real popup uses under
// the hood) rather than driving the popup UI — this exercises the identical storage path
// a real settings change takes. Applying a change to the live content script is
// eventually-consistent (see untilTrue() below), so tests re-check a real, observable
// effect rather than trusting any fixed propagation delay.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, TIMEOUT_SCALE } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// Section 1 ("alpha beta gamma") is the very first text in the document, so it holds the
// very first whitespace run in the page's flattened search index — load-bearing for the
// empty/whitespace-match guard test below, which searches for a single space.
//
// Section 2 ("titanium") sits on the second line with no top padding, so its match rect
// sits only ~25px from the viewport top — too little room for the magnifier card to fit
// above it, forcing the flip-below path.
//
// Section 3 ("quarklet") lives in a 60%-width column with heavy filler on both sides, the
// same rewrap-on-narrow technique resize_overlays.test.js uses, for the resize/reposition
// test. It also doubles as the target for the motion (full/reduced/off) tests, comfortably
// clear of the viewport top so the default above-placement applies.
//
// Section 4 ("PEANUT") is real mixed-case page text findable via the lowercase search
// term "peanut" — search is case-insensitive/accent-folded, so this is the real-casing
// regression target.
//
// Section 5 (font-{mid,low,high}-target, oculist-l6m.41) each wraps its own matched word
// in a <span> with an explicit inline font-size on that span itself — the *immediate*
// parent of the text node the match range starts in, not merely an ancestor. This mirrors
// drawActiveMatchMagnifier()'s own `matchEl = startNode.parentElement` read exactly, so a
// regression that instead walked up to an ancestor, or rode getBeaconScale() the way chip
// sizing wrongly did (oculist-l6m.11), would show up as a wrong computed font-size. The
// three sizes are chosen so the x2.5 arithmetic lands in a different regime for each:
//   - font-mid-target:  10px -> 25px (10*2.5), inside both clamp bounds (16..48)
//   - font-low-target:   4px -> 16px (4*2.5=10, clamped up to the 16px floor)
//   - font-high-target: 40px -> 48px (40*2.5=100, clamped down to the 48px ceiling)
//
// Section 6 (trunc24-target/trunc25-target) are single unbroken "words" so search matches
// them as an exact, whitespace-free substring — trunc24 is exactly 24 characters (the
// truncation boundary: must render untouched, no ellipsis), trunc25 is exactly 25 (must
// truncate to its first 24 characters plus '…').
const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; }
  .col { width: 60%; margin: 40px auto; }
</style>
<p id="ws-line" style="margin:0">alpha beta gamma</p>
<p id="flip-line" style="margin:0">delta <span id="flip-target">titanium</span> epsilon</p>
<div class="col">
  <p>${'filler words to push things around. '.repeat(60)}
  <span id="quarklet-target">quarklet</span>
  ${'more filler to keep the paragraph long. '.repeat(60)}</p>
</div>
<p>${'more page filler text. '.repeat(10)} <span id="peanut-target">PEANUT</span> ${'trailing filler text. '.repeat(10)}</p>
<p id="font-mid-line">omega <span id="font-mid-target" style="font-size:10px">fontmidword</span> psi</p>
<p id="font-low-line">omega <span id="font-low-target" style="font-size:4px">fontlowword</span> psi</p>
<p id="font-high-line">omega <span id="font-high-target" style="font-size:40px">fonthighword</span> psi</p>
<p id="trunc24-line">omega trunctwentyfourcharsxxxx psi</p>
<p id="trunc25-line">omega trunctwentyfivecharsxxxxx psi</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const MAGNIFIER = '#oc-active-match-magnifier';
const LABEL = '#oc-active-match-label';

describe('Active-match magnifier overlay', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  async function waitForContentScriptReady() {
    const deadline = Date.now() + POLL_TIMEOUT;
    for (;;) {
      if (isolatedContextId) {
        try {
          const ready = await evalInContentScript("typeof window.__ocToggle === 'function'");
          if (ready) return;
        } catch (e) {
          // Context can still be settling right after creation — keep polling.
        }
      }
      if (Date.now() > deadline) {
        throw new Error('content script never finished booting (window.__ocToggle never appeared)');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function waitForOverlayClosed() {
    await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });
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

  // Merges `patch` into the persisted visionSettings and resolves once the write itself
  // has committed — this is the exact chrome.storage.sync.set() path the real popup takes
  // under the hood. Deliberately does NOT wait for a chrome.storage.onChanged echo:
  // chrome.storage only fires onChanged when the stored value actually differs, so a test
  // that (correctly) requests the same settings a previous test already left in place would
  // wait forever for an event that will never come. Any residual lag before content.js's
  // own onChanged listener applies the change is covered by redrawUntil()/waitFor*()
  // below re-checking a real, observable effect rather than trusting this resolves in sync
  // with that listener.
  function setVisionSettings(patch) {
    return evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var vs = Object.assign({}, current.visionSettings || {}, ' + JSON.stringify(patch) + ');' +
        'var next = Object.assign({}, current, { visionSettings: vs });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
  }

  // content.js's own DEFAULTS.visionSettings (extension/content.js) — kept here as a
  // literal rather than read from the content script, so a test file bug can never make
  // this "reset" silently agree with whatever the content script currently thinks its
  // defaults are.
  const DEFAULT_VISION_SETTINGS = {
    beaconSize: 'm',
    animationSpeed: 'normal',
    textLabels: false,
    magnifier: false,
    motionSensitivity: 'full',
    colorPalette: 'default',
    borderStyle: 'none',
    customColors: {
      matchColor: '#fef08a',
      activeColor: '#f59e0b',
      beaconColor: '#fbbf24',
    },
  };

  // Restores visionSettings to its shipped defaults through the exact same
  // chrome.storage.sync.set() path setVisionSettings() uses (not chrome.storage.sync.
  // clear(), which would also wipe unrelated keys like 'effect'/'position' this suite
  // never touches) — used between tests (oculist-l6m.41) so a test that failed partway
  // through, after calling setVisionSettings() but before restoring it, can never leak a
  // non-default vision setting into the next test.
  function resetVisionSettings() {
    return evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var next = Object.assign({}, current, { visionSettings: ' +
        JSON.stringify(DEFAULT_VISION_SETTINGS) +
        ' });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
  }

  // Mirrors chip_count_accessibility.test.js's own helper of the same name: loadWorkList()
  // also runs implicitly from buildUI() on a fresh mount, but awaiting it explicitly here
  // confirms that async round trip against the just-cleared storage has actually settled
  // before a test's own actions run, rather than trusting mount timing.
  function waitForWorkListLoad() {
    return evalInContentScript("new Promise(function (resolve) { window.__ocTest.loadWorkList(resolve); })");
  }

  async function openBar() {
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
  }

  async function search(term) {
    await page.locator(INPUT).fill(term);
    await page.keyboard.press('Enter');
  }

  // Cycles to the next match, redrawing the active-match overlays from the current
  // (possibly just-changed) settings — used to force a fresh draw after setVisionSettings()
  // without re-typing the search term.
  async function advanceMatch() {
    await page.keyboard.press('Control+g');
  }

  function magnifierWordText() {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.children[0].textContent : null;
    }, MAGNIFIER);
  }

  function magnifierCounterText() {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.children[1].textContent : null;
    }, MAGNIFIER);
  }

  // setVisionSettings() resolves as soon as the write itself commits, which is not the
  // same moment content.js's own live onChanged listener has necessarily applied it — a
  // content script running an independently-scheduled listener callback can genuinely lag
  // a keypress issued immediately after. Rather than guess at that lag, retry the real
  // action (a redraw or a fresh search) and re-check a real, observable condition until it
  // holds, bounded by a deadline — not a fixed sleep.
  async function untilTrue(actionFn, checkFn, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || POLL_TIMEOUT);
    for (;;) {
      await actionFn();
      if (await checkFn()) return;
      if (Date.now() > deadline) {
        throw new Error('untilTrue: condition never became true after repeated attempts');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Cycles to the next match and waits for whichever of the magnifier/label the redraw
  // settles on to exist, then hands off to checkFn — used to force a fresh draw after
  // setVisionSettings() without re-typing the search term.
  function redrawUntil(checkFn, timeoutMs) {
    return untilTrue(
      async () => {
        await advanceMatch();
        await page.waitForFunction(
          (sels) => !!(document.querySelector(sels.magnifier) || document.querySelector(sels.label)),
          { magnifier: MAGNIFIER, label: LABEL },
          { timeout: POLL_TIMEOUT }
        );
      },
      checkFn,
      timeoutMs
    );
  }

  // Re-issues the search itself until the magnifier shows the expected word — covers the
  // same live-settings lag as redrawUntil(), but for a test's very first search right after
  // a setVisionSettings() call, before any element exists yet to redraw from.
  //
  // oculist-nw4: text alone is not a sufficient gate — drawActiveMatchMagnifier() removes
  // and recreates the card on every animate() call, but untilTrue() re-issues search(term)
  // (the SAME term, every retry) on a failed check, and highlightActiveRange()'s simple
  // 50ms-path setTimeout is not tracked/cancellable the way the scroll-settle path's timer
  // is — so an *earlier* call's still-in-flight deferred animate() can land *after* a later
  // one and repaint the card with the right text (text alone can't tell old from new when
  // the term never changes) at a stale rect. Cross-check the card's own rendered left
  // position against drawActiveMatchMagnifier()'s own placement formula (content.js),
  // applied to searchRanges[activeIndex]'s *live* rect (read via oculist-active-match's
  // Highlight Range, the same range highlightActiveRange() set synchronously and animate()
  // eventually measures) — so this gate only passes once the magnifier has actually
  // redrawn at the right spot, not just with the right text. Mirrors the horizontal
  // clamp-to-page-edge content.js itself applies (see the "flips below" test's near-left-
  // edge 'titanium' fixture), not just an unclamped center, since a small target close to
  // the page edge legitimately never gets a perfectly centered card.
  // Shared core: re-issues search(term) until the magnifier's rendered text satisfies
  // textCheckFn AND the card has actually redrawn at the right spot (see the cross-check
  // below) — extracted from searchUntilMagnifierWord so a caller whose "is this ready"
  // condition is weaker than exact-string-equality (e.g. the truncation test below, whose
  // whole point is that the exact string is what's under test, not what gates readiness)
  // can still reuse the same real, observable readiness gate instead of a fixed sleep.
  function searchUntilMagnifierTextMatches(term, textCheckFn) {
    return untilTrue(
      () => search(term),
      async () => {
        const text = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el && el.children[0] ? el.children[0].textContent : null;
        }, MAGNIFIER);
        if (text === null || !textCheckFn(text)) return false;

        const rangeRect = await evalInContentScript(`
          (function () {
            var h = CSS.highlights.get('oculist-active-match');
            var r = h ? Array.from(h)[0] : null;
            if (!r) return null;
            var b = r.getBoundingClientRect();
            if (!b || (b.width === 0 && b.height === 0)) return null;
            return { top: b.top, left: b.left, width: b.width, height: b.height };
          })()
        `);
        if (!rangeRect) return false;

        return page.evaluate(
          (args) => {
            const card = document.querySelector(args.sel);
            if (!card) return false;
            const c = card.getBoundingClientRect();
            // Mirrors drawActiveMatchMagnifier()'s own cx computation and edge clamp.
            const rawCxDoc = args.rangeRect.left + window.scrollX + args.rangeRect.width / 2 - c.width / 2;
            const maxLeftDoc = Math.max(0, document.documentElement.scrollWidth - c.width - 10);
            const expectedCxDoc = Math.min(Math.max(10, rawCxDoc), maxLeftDoc);
            const expectedLeft = expectedCxDoc - window.scrollX;
            return Math.abs(c.left - expectedLeft) < 6;
          },
          { sel: MAGNIFIER, rangeRect: rangeRect }
        );
      }
    );
  }

  function searchUntilMagnifierWord(term, expected) {
    return searchUntilMagnifierTextMatches(term, (text) => text === expected);
  }

  // highlightActiveRange() never calls animate() synchronously — only from inside a
  // setTimeout, either the 50ms in-viewport path or the up-to-600ms scroll-settle path
  // (content.js:3269) — and animate() is the sole place that creates a '.oc-beacon'
  // element (drawStaticActiveBorder(), gated on motion === 'off', same as this file's
  // tests). Waiting for that beacon to actually appear is a direct, principled proxy for
  // "the pending redraw fired", correct regardless of which of the two deferred paths was
  // taken — unlike a fixed sleep sized for only the faster of the two.
  async function waitForPendingRedraw() {
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  // Polls fn() until it returns a truthy value or the deadline passes, then resolves with
  // whatever the last call returned — deliberately never throws/times out itself. Used by
  // the oculist-l6m.42 regression tests below so a fix-absent run fails on a clean
  // assert.strictEqual mismatch instead of a Playwright waitFor timeout error.
  async function pollUntil(fn, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000 * TIMEOUT_SCALE);
    for (;;) {
      const result = await fn();
      if (result || Date.now() > deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

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

    page = await ctx.newPage();

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
    await waitForContentScriptReady();
    await openBar();
    assert.ok(isolatedContextId, 'never observed the content script isolated execution context');
    await page.keyboard.press('Escape');
    await waitForOverlayClosed();
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  // Every test starts from a closed overlay so searchRanges/activeIndex never leak
  // between tests. Scroll position also resets: a previous test's auto-scroll-to-match
  // otherwise leaks into this one, which the viewport-top-relative flip test in
  // particular depends on starting from (0, 0).
  //
  // oculist-l6m.41: this whole file shares one browser page/content-script instance
  // across every test in it (see the "Needs a real browser" note up top for why — a
  // fresh page per test would multiply the real wall-clock and contention cost of that
  // setup for a diagnostics-quality benefit, and this suite already flakes under
  // parallel load on constrained boxes, tracked as oculist-li8). So beyond the overlay,
  // visionSettings and the working list are explicitly reset to their shipped defaults
  // here too, through the exact chrome.storage paths a real settings/list change takes —
  // not just relying on "every test that cares sets what it needs" (true today, but a
  // test that fails partway through, after changing one of these and before restoring
  // it, would otherwise leak that non-default state into whichever test runs next).
  beforeEach(async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await waitForOverlayClosed();
    await page.evaluate(() => window.scrollTo(0, 0));

    await resetVisionSettings();
    await evalInContentScript(
      "new Promise(function (resolve) { chrome.storage.session.remove('oc-worklist', resolve); })"
    );

    await openBar();
    await waitForWorkListLoad();
  });

  test('shows the real page text with its original casing, not the typed term', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });
    await searchUntilMagnifierWord('peanut', 'PEANUT');

    const word = await magnifierWordText();
    assert.strictEqual(word, 'PEANUT', 'must show the page\'s real casing, not the typed "peanut"');
  });

  test('absorbs the counter: the label never double-draws with the magnifier, and the label returns when the magnifier is off', async () => {
    // textLabels on throughout: proves the magnifier truly absorbs/suppresses the label
    // (not merely that the label was independently off) and that turning the magnifier
    // back off genuinely restores it, rather than the label's own separate setting.
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off', textLabels: true });
    await searchUntilMagnifierWord('peanut', 'PEANUT');

    assert.strictEqual(await page.locator(LABEL).count(), 0, 'the plain label must not draw while the magnifier is showing');
    const counter = await magnifierCounterText();
    assert.strictEqual(counter, 'Match #1 of 1', 'the magnifier must render the counter itself');

    // Turning the magnifier off and forcing a redraw must restore the plain label and
    // remove the magnifier card — proving this is a real toggle, not a one-way absorption.
    await setVisionSettings({ magnifier: false });
    await redrawUntil(() => page.evaluate((sel) => !document.querySelector(sel), MAGNIFIER));
    await page.waitForSelector(LABEL, { timeout: POLL_TIMEOUT });
    assert.strictEqual(
      await page.locator(LABEL).first().textContent(),
      'Match #1 of 1',
      'the label must show the same counter the magnifier absorbed'
    );
  });

  test('full motion scales and lifts; reduced and off motion settings produce no scale or lift', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'full' });
    await searchUntilMagnifierWord('quarklet', 'quarklet');

    const fullKeyframes = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el.getAnimations().map((a) => a.effect.getKeyframes());
    }, MAGNIFIER);
    const fullHasTransform = fullKeyframes.some((kfs) => kfs.some((kf) => 'transform' in kf));
    assert.ok(
      fullHasTransform,
      'full motion must scale/lift the card in — if this fails, the zoom-lift animation regressed'
    );

    function hasTransformKeyframe() {
      return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el.getAnimations().some((a) => a.effect.getKeyframes().some((kf) => 'transform' in kf));
      }, MAGNIFIER);
    }

    await setVisionSettings({ motionSensitivity: 'reduced' });
    await redrawUntil(async () => !(await hasTransformKeyframe()));

    assert.strictEqual(
      await hasTransformKeyframe(),
      false,
      'reduced motion must fade in at final size/position with no scale or lift keyframes'
    );

    // Checked via the element's own inline style rather than getComputedStyle()/
    // getAnimations().length: the 'off' path is the only one that ever sets
    // card.style.opacity directly (both 'full' and 'reduced' drive opacity purely through
    // a WAAPI animation, leaving the inline style at its initial '0'), and a finished,
    // unreferenced WAAPI animation is not guaranteed to still be reported once settled —
    // so "no animations left" alone cannot reliably distinguish "off" from "reduced, and
    // already finished".
    await setVisionSettings({ motionSensitivity: 'off' });
    await redrawUntil(() => page.evaluate((sel) => document.querySelector(sel).style.opacity === '1', MAGNIFIER));

    const offAnimCount = await page.evaluate((sel) => document.querySelector(sel).getAnimations().length, MAGNIFIER);
    assert.strictEqual(offAnimCount, 0, 'off motion must draw statically with no animation at all');
    const offOpacity = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).opacity, MAGNIFIER);
    assert.strictEqual(offOpacity, '1', 'off motion must render at full opacity immediately');
  });

  test('the card is aria-hidden', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });
    await searchUntilMagnifierWord('quarklet', 'quarklet');

    const ariaHidden = await page.evaluate((sel) => document.querySelector(sel).getAttribute('aria-hidden'), MAGNIFIER);
    assert.strictEqual(ariaHidden, 'true');
  });

  test('flips below the match when there is no room above it, near the viewport top', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });

    // Baseline: a match with plenty of room above it draws the card above, matching
    // drawActiveMatchLabel's own default placement.
    await searchUntilMagnifierWord('quarklet', 'quarklet');
    const above = await page.evaluate((sel) => {
      const card = document.querySelector(sel);
      const target = document.getElementById('quarklet-target');
      const c = card.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      return { cardBottom: c.bottom, targetTop: t.top };
    }, MAGNIFIER);
    assert.ok(
      above.cardBottom <= above.targetTop + 2,
      `expected the card above the match by default, cardBottom=${above.cardBottom}, targetTop=${above.targetTop}`
    );

    // The near-top match has no room above it and must flip below instead of clamping on
    // top of the match.
    await searchUntilMagnifierWord('titanium', 'titanium');
    const flipped = await page.evaluate((sel) => {
      const card = document.querySelector(sel);
      const target = document.getElementById('flip-target');
      const c = card.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      return { cardTop: c.top, targetBottom: t.bottom };
    }, MAGNIFIER);
    assert.ok(
      flipped.cardTop >= flipped.targetBottom - 2,
      `expected the card flipped below the near-top match, cardTop=${flipped.cardTop}, targetBottom=${flipped.targetBottom}`
    );
  });

  test('repositions on resize instead of stranding in old document coordinates', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });
    await searchUntilMagnifierWord('quarklet', 'quarklet');

    const offset = () =>
      page.evaluate((sel) => {
        const card = document.querySelector(sel);
        const target = document.getElementById('quarklet-target');
        if (!card) return null;
        const c = card.getBoundingClientRect();
        const t = target.getBoundingClientRect();
        return {
          dx: c.left + c.width / 2 - (t.left + t.width / 2),
          targetLeft: t.left,
        };
      }, MAGNIFIER);

    const before = await offset();
    assert.ok(before, 'expected the magnifier to be drawn');
    assert.ok(Math.abs(before.dx) < 6, `card should start centered on the match, dx=${before.dx}`);

    await page.setViewportSize({ width: 700, height: 800 });

    // Poll for the real post-resize state (the 100ms resize debounce in content.js) rather
    // than sleeping a guessed duration.
    await page.waitForFunction(
      (args) => {
        const target = document.getElementById(args.targetId);
        return target && Math.abs(target.getBoundingClientRect().left - args.beforeLeft) > 20;
      },
      { targetId: 'quarklet-target', beforeLeft: before.targetLeft },
      { timeout: POLL_TIMEOUT }
    );
    await page.waitForFunction(
      (sel) => {
        const card = document.querySelector(sel);
        const target = document.getElementById('quarklet-target');
        if (!card || !target) return false;
        const c = card.getBoundingClientRect();
        const t = target.getBoundingClientRect();
        const dx = Math.abs(c.left + c.width / 2 - (t.left + t.width / 2));
        return dx < 6;
      },
      MAGNIFIER,
      { timeout: POLL_TIMEOUT }
    );

    const after = await offset();
    assert.ok(
      Math.abs(after.targetLeft - before.targetLeft) > 20,
      `the resize must actually move the match, otherwise this test proves nothing (before=${before.targetLeft}, after=${after.targetLeft})`
    );
    assert.ok(Math.abs(after.dx) < 6, `card drifted off the match after resize, dx=${after.dx}`);

    // Restore the viewport so later tests in this file see the same layout they expect.
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForFunction(
      (args) => {
        const target = document.getElementById(args.targetId);
        return target && Math.abs(target.getBoundingClientRect().left - args.beforeLeft) < 5;
      },
      { targetId: 'quarklet-target', beforeLeft: before.targetLeft },
      { timeout: POLL_TIMEOUT }
    );
  });

  test('is removed on teardown, caught by the same .oc-beacon sweep as every other overlay', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });
    await searchUntilMagnifierWord('quarklet', 'quarklet');

    assert.strictEqual(await page.locator(MAGNIFIER).count(), 1);

    await page.keyboard.press('Escape');
    await waitForOverlayClosed();

    assert.strictEqual(
      await page.locator(MAGNIFIER).count(),
      0,
      '#oc-active-match-magnifier must be removed by teardown, not just #oc-wrap'
    );

    await openBar();
  });

  test('a match whose text is empty or whitespace-only does not render an empty card', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });

    // Confirms the magnifier setting has genuinely taken effect before relying on its
    // absence below — otherwise a magnifier that failed to enable at all would make this
    // test pass for the wrong reason.
    await searchUntilMagnifierWord('quarklet', 'quarklet');

    // A single space matches the page's own literal whitespace (search collapses runs of
    // whitespace to one space on both the typed term and the page index — see
    // findRanges()/buildPageIndex()), so the resulting active match's real text is
    // whitespace-only. maybeAddChipFromInput() silently declines to commit a
    // whitespace-only chip, so Enter falls through to findNext(), which drives the search
    // exactly like a real user pressing Enter on a stray space would.
    await page.locator(INPUT).fill(' ');
    await page.keyboard.press('Enter');

    // Wait for the real whitespace search to actually land, not the "quarklet" sanity
    // check's stale "1 of 1" count above (which already matches a plain /of \d+/ check) —
    // a single space matches dozens of times across this page's filler text, so requiring
    // a total greater than "quarklet"'s single match distinguishes a genuinely fresh count
    // from the leftover one.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap').shadowRoot;
        const count = root.querySelector('.oc-count');
        if (!count) return false;
        const m = /of (\d+)/.exec(count.textContent);
        return !!m && Number(m[1]) > 1;
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    // highlightActiveRange() updates the count synchronously but defers the actual overlay
    // redraw (animate() -> drawActiveOverlays()) by a setTimeout (or a scroll-end debounce),
    // so the magnifier from the "quarklet" sanity check is still on screen for a moment
    // after the count above already reflects the new whitespace search. Wait for that
    // deferred redraw to actually land — either the stale card is gone, or the guard
    // failed and a new (still-labelled "quarklet") one never got removed — before asserting.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#oc-active-match-magnifier');
        return !el || !el.children[0] || el.children[0].textContent !== 'quarklet';
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    const magnifierCount = await page.locator(MAGNIFIER).count();
    assert.strictEqual(magnifierCount, 0, 'a whitespace-only match must never render a magnifier card');
  });

  // Regression for oculist-l6m.42: the chrome.storage.onChanged listener in content.js
  // updated `settings` and repositioned the wrap/viewport markers on a relevant settings
  // change, but never redrew the active match's own overlays (border/label/magnifier) — so
  // flipping the magnifier toggle with a match already on screen produced no visible
  // change until the next navigation or redraw (e.g. Ctrl+G). Deliberately does NOT call
  // advanceMatch()/redrawUntil() (unlike the other tests in this file) or re-issue the
  // search after setVisionSettings() — the whole point is to prove the card appears/
  // disappears from the settings write alone, with no further user action.
  test('a vision-settings change redraws the active match magnifier in place, without navigating (oculist-l6m.42)', async () => {
    await setVisionSettings({ magnifier: false, textLabels: false, motionSensitivity: 'off' });
    await search('quarklet');

    // Confirm the match actually landed (activeIndex set, count updated) before touching
    // vision settings — otherwise a race between the search landing and the settings
    // write below could let this test pass for the wrong reason.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap').shadowRoot;
        const count = root.querySelector('.oc-count');
        return !!count && /of 1\b/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
    // highlightActiveRange() updates the count synchronously above but defers its own
    // animate() redraw by a setTimeout (see content.js). That deferred call reads
    // `settings` at the moment it *fires*, not at schedule time — so without waiting it
    // out, a settings write issued right after the count update could land before that
    // pending timeout fires and get incidentally picked up by it, making this test pass
    // even without repositionActiveOverlays() wired into the storage listener. Wait for
    // the pending redraw's own observable effect instead of guessing its duration.
    await waitForPendingRedraw();
    assert.strictEqual(await page.locator(MAGNIFIER).count(), 0, 'sanity: magnifier must not be showing yet');

    // Foreign settings write — same chrome.storage.sync.set path the popup takes — with
    // the match still on screen and nothing else touching the page afterward.
    await setVisionSettings({ magnifier: true });
    const appeared = await pollUntil(() => page.locator(MAGNIFIER).count().then((c) => c > 0));
    assert.strictEqual(
      appeared,
      true,
      'the magnifier card must appear in place after the settings change, without navigating'
    );
    const word = await magnifierWordText();
    assert.strictEqual(word, 'quarklet', 'the redrawn magnifier must show the currently active match');

    // Reverse direction: the bead only names the ON case, but OFF must equally take
    // effect in place.
    await setVisionSettings({ magnifier: false });
    const disappeared = await pollUntil(() => page.locator(MAGNIFIER).count().then((c) => c === 0));
    assert.strictEqual(
      disappeared,
      true,
      'toggling the magnifier off must remove the card in place, without navigating'
    );
  });

  // Same regression, for the plain label (drawActiveMatchLabel()) — a separate function
  // from the magnifier's, reached through the same drawActiveOverlays() call inside
  // repositionActiveOverlays(), so this exercises a genuinely different render path rather
  // than duplicating the magnifier assertions above.
  test('a vision-settings change redraws the active match label in place, without navigating (oculist-l6m.42)', async () => {
    await setVisionSettings({ magnifier: false, textLabels: false, motionSensitivity: 'off' });
    await search('quarklet');

    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap').shadowRoot;
        const count = root.querySelector('.oc-count');
        return !!count && /of 1\b/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
    // See the magnifier test above: wait out highlightActiveRange()'s own deferred
    // animate() call before writing settings, so that pending redraw can't be mistaken
    // for the one under test.
    await waitForPendingRedraw();
    assert.strictEqual(await page.locator(LABEL).count(), 0, 'sanity: label must not be showing yet');

    await setVisionSettings({ textLabels: true });
    const appeared = await pollUntil(() => page.locator(LABEL).count().then((c) => c > 0));
    assert.strictEqual(
      appeared,
      true,
      'the plain label must appear in place after the settings change, without navigating'
    );

    await setVisionSettings({ textLabels: false });
    const disappeared = await pollUntil(() => page.locator(LABEL).count().then((c) => c === 0));
    assert.strictEqual(
      disappeared,
      true,
      'toggling textLabels off must remove the label in place, without navigating'
    );
  });

  // Reads the magnifier word element's COMPUTED font-size (getComputedStyle), not its
  // inline style string — the assertion must survive a change in *how* the style gets
  // applied (e.g. a CSS class instead of cssText), not just in the arithmetic that
  // produces the value. Returns a bare number (px) so a mismatch reports the actual
  // observed size rather than failing via an opaque wait timeout.
  function magnifierFontSizePx() {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.children[0] ? parseFloat(getComputedStyle(el.children[0]).fontSize) : null;
    }, MAGNIFIER);
  }

  // oculist-l6m.41: pins fontSize = clamp(16, baseFontSize * 2.5, 48), reading
  // baseFontSize from the MATCH's own computed font-size (matchEl = startNode.
  // parentElement), not getBeaconScale() — the same knob bead .11 records being wrongly
  // reused for chip sizing. A regression that swapped in getBeaconScale() (or any other
  // multiplier) here would leave this test's mid-range case observably wrong (e.g. 25 vs
  // 20) while still passing the two clamp-bound cases below, which is why this case is
  // asserted separately from them.
  test('scales the magnifier font to 2.5x the matched text\'s own computed font-size (mid-range, neither clamp active)', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });
    await searchUntilMagnifierWord('fontmidword', 'fontmidword');

    const size = await magnifierFontSizePx();
    assert.strictEqual(size, 25, `expected 10px match font-size * 2.5 = 25px, got ${size}px`);
  });

  test('clamps the magnifier font to a 16px floor when 2.5x the match font-size would be smaller', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });
    await searchUntilMagnifierWord('fontlowword', 'fontlowword');

    const size = await magnifierFontSizePx();
    assert.strictEqual(
      size,
      16,
      `expected the 16px floor to override 4px match font-size * 2.5 = 10px, got ${size}px`
    );
  });

  test('clamps the magnifier font to a 48px ceiling when 2.5x the match font-size would be larger', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });
    await searchUntilMagnifierWord('fonthighword', 'fonthighword');

    const size = await magnifierFontSizePx();
    assert.strictEqual(
      size,
      48,
      `expected the 48px ceiling to override 40px match font-size * 2.5 = 100px, got ${size}px`
    );
  });

  // oculist-l6m.41: pins the >24-character truncation and its own boundary in the same
  // test — a fix that always truncates (never leaving a match untouched) would pass a
  // one-sided test that only checked the over-limit case, so both halves are asserted
  // here together. Both fixture words are literal, whitespace-free "words" so search
  // matches them as an exact substring with no whitespace-collapse involved.
  //
  // The 25-character half's readiness gate deliberately does NOT wait for the exact
  // truncated string (unlike searchUntilMagnifierWord elsewhere in this file) — the exact
  // string is the very thing under test here, and gating on it would mean a truncation
  // regression (the mutation `text.length > 24` -> `> 240` this test exists to catch)
  // fails as an opaque "untilTrue: condition never became true" timeout instead of a
  // value mismatch, which is exactly the failure mode oculist-l6m.41 calls out as
  // ambiguous under load. Instead it gates on a 24-character prefix common to both the
  // truncated and (bug-)untouched renderings — truncation only ever appends '…' after
  // that prefix, never edits it — so the gate is satisfied by either outcome, and the
  // real comparison below is a plain assert.strictEqual reporting the actual string.
  test('truncates matches longer than 24 characters with an ellipsis, and leaves a 24-character match untouched', async () => {
    await setVisionSettings({ magnifier: true, motionSensitivity: 'off' });

    // Boundary: exactly 24 characters must render exactly as-is, with no ellipsis.
    await searchUntilMagnifierTextMatches(
      'trunctwentyfourcharsxxxx',
      (t) => t.indexOf('trunctwentyfourcharsxxxx') === 0
    );
    const untouched = await magnifierWordText();
    assert.strictEqual(
      untouched,
      'trunctwentyfourcharsxxxx',
      'a 24-character match must not be truncated'
    );

    // Over the limit: 25 characters must truncate to the first 24 plus '…'.
    await searchUntilMagnifierTextMatches(
      'trunctwentyfivecharsxxxxx',
      (text) => text.indexOf('trunctwentyfivecharsxxxx') === 0
    );
    const truncated = await magnifierWordText();
    assert.strictEqual(
      truncated,
      'trunctwentyfivecharsxxxx…',
      'a 25-character match must truncate to its first 24 characters plus an ellipsis'
    );
  });
});
