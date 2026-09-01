// Cyber-Vision beacon effect (oculist-dvt.4): a targeting-HUD sweep over the viewport —
// a tint/scanline wash, a bright bar sweeping the full viewport height, a per-column
// staggered thermal false-colour grid over the match, and four corner brackets snapping
// inward onto the match then holding and fading, with a decorative readout beside them.
// One of the DOM/WAAPI effects in the oculist-dvt epic: one context, one finder
// session kept open across all tests, settings changed via direct chrome.storage.sync
// writes, and no test-side requestAnimationFrame poller ever competing with the effect's
// own WAAPI schedule.
//
// Needs a real browser for the same reasons as trail_effect.test.js:
// real layout, real WAAPI, real Accessibility tree, and Lite Mode can only be toggled for
// real through chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');
const { enableAccessibilityDomain } = require('./helpers/accessible_name');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target is the text the finder searches for and the beacon fires on. Long enough that
// the thermal grid (match width / 9, floored at 6 columns) has plenty of columns to stagger
// across.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; background:#06080D; color:#ccc; }</style>
<p>${'filler words to fill the page and give cyber-vision room to sweep. '.repeat(30)} <span id="target">phosphorescent</span> ${'more filler words trailing after the match. '.repeat(30)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const BRACKET = '.oc-cv-bracket';
const THERMAL = '.oc-cv-thermal';
const SCANLINES = '.oc-cv-scanlines';
const READOUT = '.oc-cv-readout';

// Mirrors content.js's own `pad` (content.js:2847, `var L = 15, pad = 11;`) — the fixed
// outward offset each bracket's meaningful corner sits from the match's corresponding
// corner, in the container's own untransformed (scale-1) frame. Deliberately does NOT need
// L (the bracket's own box side length) or the border width: a bracket's *meaningful*
// corner (see CORNER_SIGN below) is where its two remaining border edges meet, and that
// point sits exactly at the CSS left/top value passed to the element — position:absolute
// offsets the margin/border edge directly, so it is unaffected by which of the other two
// borders were zeroed out or how thick the surviving ones are.
const BRACKET_PAD = 11;
// Mirrors content.js's own bracket border (content.js:2857, `'border:2px solid ' + color`).
// Needed only for a bracket's "far" edge (its own right edge when the meaningful corner is
// on the right, or bottom edge when it's on the bottom): content-box sizing draws a border
// OUTSIDE the element's own `width`/`height`, so that edge sits BRACKET_BORDER px further
// out than `width`/`height` (here L=15) alone would suggest. A bracket's "near" edge (left
// when the meaningful corner is on the left, top when it's on top) is exactly the CSS
// left/top offset itself and needs no such correction — position:absolute placement is
// independent of border width. See CORNER_SIGN below for which edge is which per bracket.
const BRACKET_BORDER = 2;
// Sub-pixel/transform-compositing rounding tolerance, not a slack "somewhere near" window —
// see the per-corner assertion below for why this can be this tight.
const BRACKET_TOLERANCE = 3;

describe('Cyber-Vision: a targeting HUD sweep resolves onto the match', () => {
  let server, ctx, page, client, isolatedContextId, origin;

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

    // Attach CDP before navigating so the isolated-world execution-context-created event
    // is never missed.
    client = await ctx.newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await enableAccessibilityDomain(client);
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

    // Select the Cyber-Vision effect for the whole suite before ever opening the finder —
    // every test below assumes this baseline.
    await setSettings({ effect: 'cybervision' });

    await openFinder();
    await page.locator(INPUT).type('phosphorescent', { delay: 30 });
    // Wait for the draft debounce to actually land a real match count before any test
    // fires the beacon, instead of guessing its duration.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

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

  // chrome.storage.onChanged fires listeners in registration order, so observing our own
  // probe listener fire is a direct proxy for content.js's own listener (registered earlier,
  // at page load) having already applied the change.
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
    return waitForContentScriptValue(evalInContentScript, 'window.__ocSettingsEchoes', (v) => v > before, {
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

  // Merges `patch` into the nested visionSettings object (e.g. beaconSize) via
  // chrome.storage.sync.set — the same underlying write the popup/in-page settings panel
  // makes — and waits for content.js's own onChanged listener to actually apply it. Mirrors
  // chip_row.test.js's own setVisionSettings.
  async function setVisionSettings(patch) {
    const echoBefore = await armSettingsEcho();
    await evalInContentScript(
      'new Promise(function (resolve) {' +
        "chrome.storage.sync.get('oc-settings', function (data) {" +
        "var current = (data && data['oc-settings']) || {};" +
        'var vs = Object.assign({}, current.visionSettings || {}, ' + JSON.stringify(patch) + ');' +
        'var next = Object.assign({}, current, { visionSettings: vs });' +
        "chrome.storage.sync.set({ 'oc-settings': next }, resolve);" +
        '});' +
        '})'
    );
    await waitForSettingsEcho(echoBefore);
  }

  // Clears any leftover .oc-beacon nodes, presses Enter to (re-)fire the active beacon
  // (goToNext()/replay path — the only match on the page, so every Enter re-fires the same
  // active match), and waits for a fresh .oc-beacon container to actually exist. animate()
  // calls cancelBeacons() first, so this never accumulates parts across calls.
  async function replay() {
    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  // Waits for content.js's own cyberVisionBracketsSettled flag — flipped by a setTimeout
  // keyed to this run's own BRACKET_DELAY + BRACKET_DUR * 0.3 (content.js:2881-2884), the
  // exact moment each bracket's own keyframes (offset: 0.3) reach translate(0,0), i.e. fully
  // snapped in and holding, before their later fade-out. Not a guessed timeout: it is real
  // math derived from this run's own scheduled durations, so it cannot race the WAAPI
  // schedule it is reporting on. This is a completion signal only; it says nothing
  // about whether the geometry itself is correct, which the caller must still verify
  // independently.
  async function waitForBracketsSettled() {
    await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.cyberVisionBracketsSettled', (v) => v === true, {
      timeout: POLL_TIMEOUT,
      message: 'cyber-vision brackets never finished snapping in',
    });
  }

  // oculist-xi4: arms a race between a scroll dispatch and this run's own settle timer,
  // entirely from inside the isolated content-script world (the same execution context and
  // timer wheel content.js's own setTimeout calls use), so the two stay correlated even under
  // system load instead of racing across the Node<->CDP round trip a real page.mouse.wheel()
  // would add. A real hardware scroll cannot be timed to land inside fadeActiveBeacons()'s
  // fixed 50ms fade-to-removal window reliably (this suite has already been bitten by exactly
  // that kind of flake), but dispatching the 'scroll' Event that handleScroll() listens for
  // (content.js) is the real call path regardless of whether the event came from a wheel or
  // from script — handleScroll() only reacts to the event firing, not to any scroll delta.
  //
  // Watches for the beacon container's own creation (a MutationObserver microtask fires
  // essentially the instant animateCyberVision() finishes running, i.e. at the same moment its
  // settle setTimeout above is registered) rather than trusting a Node-side timestamp, then
  // schedules the scroll for SETTLE_MS - MARGIN_MS out from that moment: 25ms before the
  // ~710ms settle deadline (BRACKET_DELAY 440 + BRACKET_DUR 900 * 0.3 at this suite's default
  // 'normal' animationSpeed — the same figure the stale-timer test above relies on), landing
  // it in the middle of the 50ms window with ~25ms of slack on both sides. Resolves
  // synchronously (no awaited inner promise) so arming can never race the Enter keypress that
  // follows it; completion is observed separately via window.__ocRaceScrollFired.
  async function armScrollRace() {
    await evalInContentScript(`
      (function () {
        window.__ocRaceScrollFired = false;
        var SETTLE_MS = 440 + 900 * 0.3;
        var MARGIN_MS = 25;
        var obs = new MutationObserver(function () {
          var container = document.querySelector('.oc-beacon-transient');
          if (!container) return;
          obs.disconnect();
          setTimeout(function () {
            window.dispatchEvent(new Event('scroll'));
            window.__ocRaceScrollFired = true;
          }, SETTLE_MS - MARGIN_MS);
        });
        obs.observe(document.documentElement, { childList: true });
        return true;
      })()
    `);
  }

  // Content.js's own corner ordering (top-left, top-right, bottom-left, bottom-right — see
  // the `corners` array in animateCyberVision, content.js:2848-2853) matches document/
  // creation order, which querySelectorAll preserves. Each bracket has two of its four CSS
  // borders zeroed out (e.g. the top-left bracket is `border-right:0;border-bottom:0`, so
  // only its top and left borders are drawn); its *meaningful* corner — the one that
  // actually frames the match — is the box corner where those two surviving borders meet.
  // sx/sy pick out both which of that bracket's own box corners is meaningful (left vs
  // right, top vs bottom) and which direction it is expected to sit outside the
  // corresponding match corner.
  const CORNER_SIGN = [
    { sx: -1, sy: -1 }, // top-left bracket: meaningful corner is its own (left, top)
    { sx: 1, sy: -1 }, // top-right bracket: meaningful corner is its own (right, top)
    { sx: -1, sy: 1 }, // bottom-left bracket: meaningful corner is its own (left, bottom)
    { sx: 1, sy: 1 }, // bottom-right bracket: meaningful corner is its own (right, bottom)
  ];

  // Fires a fresh beacon, waits for the brackets to settle, and asserts each bracket's own
  // meaningful corner (CORNER_SIGN above) against its exact expected position: BRACKET_PAD
  // px outside the match's corresponding corner, scaled by `scale` around the match's own
  // centre — content.js's container.style.transform is a single `scale(...)` anchored at
  // the match centre (content.js:2746-2747), so under a non-1 beaconSize scale every bracket
  // corner's distance from that centre is multiplied by `scale`, not just its distance from
  // the match's near edge. Reads the *actual rendered* bounding boxes of the match and every
  // bracket directly off the live DOM (getBoundingClientRect, after the snap-in keyframe has
  // resolved) — not a flag content.js sets about itself. A bracket mutated to the wrong
  // position, or a beaconSize scale regression, must fail this regardless of what any
  // internal bookkeeping claims.
  async function assertBracketsLandOnMatch(scale, label) {
    await replay();
    await waitForBracketsSettled();

    const geometry = await page.evaluate((sel) => {
      const target = document.getElementById('target');
      const m = target.getBoundingClientRect();
      const brackets = Array.from(document.querySelectorAll(sel)).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      return { match: { left: m.left, top: m.top, right: m.right, bottom: m.bottom }, brackets };
    }, BRACKET);

    assert.strictEqual(geometry.brackets.length, 4, `expected exactly 4 corner brackets, got ${geometry.brackets.length}`);

    const cx = (geometry.match.left + geometry.match.right) / 2;
    const cy = (geometry.match.top + geometry.match.bottom) / 2;
    const halfW = (geometry.match.right - geometry.match.left) / 2;
    const halfH = (geometry.match.bottom - geometry.match.top) / 2;

    for (let i = 0; i < 4; i++) {
      const b = geometry.brackets[i];
      const { sx, sy } = CORNER_SIGN[i];
      const observed = { x: sx < 0 ? b.left : b.right, y: sy < 0 ? b.top : b.bottom };
      const expected = {
        x: cx + sx * scale * (halfW + BRACKET_PAD) + (sx > 0 ? scale * BRACKET_BORDER : 0),
        y: cy + sy * scale * (halfH + BRACKET_PAD) + (sy > 0 ? scale * BRACKET_BORDER : 0),
      };
      const dx = Math.abs(observed.x - expected.x);
      const dy = Math.abs(observed.y - expected.y);
      assert.ok(
        dx <= BRACKET_TOLERANCE && dy <= BRACKET_TOLERANCE,
        `[${label}] expected bracket ${i}'s meaningful corner within ${BRACKET_TOLERANCE}px of ` +
          `${JSON.stringify(expected)}; observed ${JSON.stringify(observed)} (dx=${dx}px, dy=${dy}px, ` +
          `bracket rect=${JSON.stringify(b)}, match rect=${JSON.stringify(geometry.match)})`
      );
    }
  }

  test('all four brackets land on the match: real rendered geometry, never off by a wide margin', async () => {
    await assertBracketsLandOnMatch(1, 'default beaconSize');
  });

  test('all four brackets land on the match at beaconSize "xl" (scale 2.25)', async () => {
    try {
      await setVisionSettings({ beaconSize: 'xl' });
      await assertBracketsLandOnMatch(2.25, 'beaconSize=xl');
    } finally {
      // Restore the default so no later test in this file inherits a non-default beacon
      // size (mirrors chip_row.test.js's own reset after its beaconSize sweep).
      await setVisionSettings({ beaconSize: 'm' });
    }
  });

  test('thermal blocks stagger in by column, not simultaneously', async () => {
    await replay();

    // Read every thermal block's real, scheduled WAAPI fade-in delay straight off the live
    // Animation objects (Element.getAnimations()), identified by its own data-oc-cv-col
    // attribute (content.js's own creation-order attribute) — not from any value content.js
    // reports about itself. Animation delay/timing is fixed at creation time, so this needs
    // no waiting and cannot race the animation's own playback.
    const blocks = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        const anims = el.getAnimations();
        const fade = anims.find((a) => a.effect.getKeyframes().some((kf) => 'opacity' in kf));
        return {
          col: Number(el.getAttribute('data-oc-cv-col')),
          delay: fade ? fade.effect.getTiming().delay : null,
        };
      });
    }, THERMAL);

    assert.ok(blocks.length >= 18, `sanity check: expected a real multi-column x 3-row thermal grid, got ${blocks.length} blocks`);
    assert.ok(
      blocks.every((b) => typeof b.delay === 'number' && !Number.isNaN(b.col)),
      `expected every thermal block to carry a real fade-in (opacity) animation and a column index; got ${JSON.stringify(blocks.slice(0, 5))}`
    );

    // Per-column stagger: the earliest (row-0) delay within each column must be strictly
    // later than the earliest delay of the previous column, so the grid visibly resolves
    // left to right rather than every column (or the whole grid) appearing at once.
    const minDelayByCol = new Map();
    for (const b of blocks) {
      const current = minDelayByCol.get(b.col);
      if (current === undefined || b.delay < current) minDelayByCol.set(b.col, b.delay);
    }
    const cols = Array.from(minDelayByCol.keys()).sort((a, b) => a - b);
    assert.ok(cols.length >= 6, `sanity check: expected at least 6 distinct columns, got ${cols.length}`);

    for (let i = 1; i < cols.length; i++) {
      const prevDelay = minDelayByCol.get(cols[i - 1]);
      const curDelay = minDelayByCol.get(cols[i]);
      assert.ok(
        curDelay > prevDelay,
        `expected column ${cols[i]}'s earliest delay (${curDelay}) to start strictly after column ${cols[i - 1]}'s (${prevDelay}) — the thermal grid must stagger in left to right, not simultaneously`
      );
    }
  });

  test('Lite Mode renders no thermal blocks and no scanline overlay', async () => {
    await replay();
    const fullThermalCount = await page.locator(THERMAL).count();
    const fullScanlineCount = await page.locator(SCANLINES).count();
    assert.ok(fullThermalCount > 0, `sanity check: expected thermal blocks in full mode, got ${fullThermalCount}`);
    assert.ok(fullScanlineCount > 0, `sanity check: expected a scanline overlay in full mode, got ${fullScanlineCount}`);

    try {
      await setSettings({ performanceMode: true });
      await replay();
      const liteThermalCount = await page.locator(THERMAL).count();
      const liteScanlineCount = await page.locator(SCANLINES).count();
      assert.strictEqual(liteThermalCount, 0, `expected Lite Mode to render zero thermal blocks, got ${liteThermalCount}`);
      assert.strictEqual(liteScanlineCount, 0, `expected Lite Mode to render zero scanline overlays, got ${liteScanlineCount}`);
    } finally {
      await setSettings({ performanceMode: false });
    }
  });

  test('the readout is aria-hidden and absent from the accessibility tree', async () => {
    await replay();
    await page.waitForSelector(READOUT, { timeout: POLL_TIMEOUT });

    const ariaHiddenAttr = await page.evaluate((sel) => document.querySelector(sel).getAttribute('aria-hidden'), READOUT);
    assert.strictEqual(ariaHiddenAttr, 'true', `expected the readout's aria-hidden attribute to be "true", got ${JSON.stringify(ariaHiddenAttr)}`);

    // Confirm the COMPUTED accessibility tree actually excludes it (not merely that the
    // attribute is set — see test/helpers/accessible_name.js's own reasoning for why the
    // two can diverge). Accessibility.getPartialAXTree on an aria-hidden element reports
    // ignored:true with an ariaHiddenElement reason, and no name at all.
    const evalResult = await client.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(READOUT)})`,
      returnByValue: false,
    });
    assert.ok(evalResult.result && evalResult.result.objectId, 'expected the readout element to resolve to a real DOM node');
    const ax = await client.send('Accessibility.getPartialAXTree', {
      objectId: evalResult.result.objectId,
      fetchRelatives: false,
    });
    const axNode = ax.nodes && ax.nodes[0];
    assert.ok(axNode, 'expected an accessibility node for the readout element');
    assert.strictEqual(axNode.ignored, true, `expected the readout to be ignored by the accessibility tree, got node ${JSON.stringify(axNode)}`);
    assert.ok(
      Array.isArray(axNode.ignoredReasons) && axNode.ignoredReasons.some((r) => r.name === 'ariaHiddenElement'),
      `expected the readout's ignoredReasons to include ariaHiddenElement, got ${JSON.stringify(axNode.ignoredReasons)}`
    );
    assert.strictEqual(axNode.name, undefined, `expected the readout to carry no computed accessible name, got ${JSON.stringify(axNode.name)}`);
  });

  // Does not press Escape — the scroll-cancellation test below it still needs the finder
  // open, and replay()'s own beacon-clear step already exercises the ordinary self-removal
  // path this test is verifying.
  test('every .oc-beacon element is removed once the effect finishes (no leak)', async () => {
    await replay();
    const initialCount = await page.locator('.oc-beacon').count();
    assert.ok(initialCount > 0, 'sanity check: the beacon must actually render before checking it is cleaned up');

    // Prefer waitForCondition (surfaces the last observed value on timeout) over a bare
    // page.waitForFunction — on this box a waitForFunction timeout is textually
    // indistinguishable from the documented ~15s flakes (oculist-li8), whereas this reports
    // exactly how many .oc-beacon elements were still present when it gave up.
    const finalCount = await waitForCondition(
      () => page.evaluate(() => document.querySelectorAll('.oc-beacon').length),
      (count) => count === 0,
      { timeout: POLL_TIMEOUT, message: 'expected every .oc-beacon element to be removed once Cyber-Vision finishes' }
    );
    assert.strictEqual(finalCount, 0, `expected zero .oc-beacon elements after completion, observed ${finalCount}`);
  });

  // oculist-3ae: animateCyberVision's early-return guard (rect missing or zero-sized)
  // used to sit BEFORE cyberVisionBracketsSettled was touched, so a skipped run left the
  // flag holding whatever the previous real run had last written -- the same class of bug
  // oculist-47e fixed for animateSpeedLines and oculist-3ae fixed for animateChronoTunnel's
  // four hooks (see chrono_tunnel.test.js's identical test, which this mirrors). This runs
  // a real beacon first (so the flag holds a genuine `true`), then drives the guard through
  // the extension's own normal call path -- no synthetic rect, no test-only export of the
  // effect renderer itself.
  test("a skipped run (zero-size rect) resets cyberVisionBracketsSettled instead of leaving the previous run's stale true", async () => {
    await replay();
    await waitForBracketsSettled();

    const before = await evalInContentScript('window.__ocTest.cyberVisionBracketsSettled');
    assert.strictEqual(before, true, 'sanity check: expected the prior run to have settled its brackets');

    // Drive the SAME early-return guard through the extension's real, normal call path
    // instead of a synthetic rect or an exported test-only closure. font-size:0 is
    // verified (in real Chromium) to yield a getBoundingClientRect of {width:0, height:0}
    // while the element stays indexed and remains the active match; no chip/term change
    // is needed.
    await page.evaluate(() => { document.getElementById('target').style.fontSize = '0'; });
    try {
      await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
      await page.keyboard.press('Enter');

      // No '.oc-beacon' will ever appear -- the guard returns before the container is
      // created -- so this cannot reuse replay()'s own waitForSelector('.oc-beacon'). Poll
      // cyberVisionBracketsSettled directly: it can only go from the prior run's stale
      // true back to false by this reset running, since no real run (and therefore no
      // later settle timer) is possible once the element is zero-sized.
      await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.cyberVisionBracketsSettled', (v) => v === false, {
        timeout: POLL_TIMEOUT,
        message: 'the zero-size-match run never reset cyberVisionBracketsSettled',
      });
    } finally {
      await page.evaluate(() => { document.getElementById('target').style.fontSize = ''; });
    }
  });

  // oculist-3ae review 2's actual root cause: cyberVisionBracketsSettled is flipped by a
  // plain setTimeout, not tied to the container's own lifecycle, so it is not
  // automatically cancelled when a later run's animate() -> cancelBeacons() call detaches
  // this run's container early. The dangerous case is a PRIOR run's settle timer that is
  // still PENDING -- not yet fired -- at the moment a later run resets the flag to false:
  // without a guard, that stale timer's own true assignment still fires on its original
  // schedule and clobbers the later run's fresh false. This cancels run A (via a second,
  // skipped run B) well before A's own ~710ms settle deadline, while A's timer is still
  // outstanding, then waits past that deadline and confirms the flag is never resurrected.
  test("a cancelled run's still-pending settle timer does not resurrect cyberVisionBracketsSettled after a later run resets it", async () => {
    await replay(); // run A: container created, its own settle timer now scheduled ~710ms out

    // Cancel A and fire skipped run B WHILE A's settle timer is still pending -- no wait
    // for A to settle first, unlike the reset test above. font-size:0 is verified (in real
    // Chromium) to yield a getBoundingClientRect of {width:0, height:0} while the element
    // stays indexed and remains the active match.
    await page.evaluate(() => { document.getElementById('target').style.fontSize = '0'; });
    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await page.keyboard.press('Enter');

    // highlightActiveRange()'s own animate(freshRect) call for this Enter press is itself
    // deferred by 50ms (content.js) and reads the match's rect fresh at THAT later time --
    // restoring font-size any sooner would let this deferred call read a real, non-zero
    // rect and fire an actual (non-skipped) run C instead of the skip this test needs,
    // which would settle on its own ~710ms later and be indistinguishable from a genuine
    // resurrection of A's timer (this raced and failed for exactly that reason during
    // authoring). Wait comfortably past that 50ms delay, then positively confirm run B
    // really was a skip -- no new .oc-beacon container ever appeared, since the guard
    // returns before creating one -- before restoring font-size. 200ms total from the
    // font-size:0 mutation to its restore below also stays safely under the page's own
    // MutationObserver debounce (350ms, content.js's domObserverTimer): holding a
    // genuinely zero-rect match open past that would let a background rescan's
    // findRanges() -- which filters matches by their live rendered rect, unrelated to this
    // bug -- drop the match out of searchRanges entirely.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(
      await page.locator('.oc-beacon').count(),
      0,
      'sanity check: expected the zero-rect run to be skipped (no new .oc-beacon container), not a real run'
    );
    assert.strictEqual(
      await evalInContentScript('window.__ocTest.cyberVisionBracketsSettled'),
      false,
      'sanity check: expected the skipped run to have reset cyberVisionBracketsSettled to false'
    );

    await page.evaluate(() => { document.getElementById('target').style.fontSize = ''; });

    // Positively confirm it stays false through run A's original settle deadline
    // (~710ms at default animationSpeed: BRACKET_DELAY 440 + BRACKET_DUR 900 * 0.3, well
    // inside this wait's budget) instead of being resurrected by A's still-pending stale
    // timer -- if the isConnected guard at that timer's call site were missing, this wait
    // would resolve (a false "still settling") instead of timing out.
    let resurrected = false;
    try {
      await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.cyberVisionBracketsSettled', (v) => v === true, {
        timeout: POLL_TIMEOUT,
      });
      resurrected = true;
    } catch (e) {
      if (!/timed out/.test(e.message)) throw e;
    }
    assert.strictEqual(
      resurrected,
      false,
      "expected cyberVisionBracketsSettled to stay false rather than being resurrected by run A's still-pending stale settle timer firing after run B's own reset"
    );
  });

  // oculist-qii: fadeActiveBeacons() (content.js, called from handleScroll()) is the
  // second of the two paths that remove a .oc-beacon element, and until this fix did so
  // with a bare .remove() — never cancelling the container's __waapiAnims first. A WAAPI
  // animation does NOT stop on its own when its target is detached from the document
  // (verified empirically; see cancelBeacons()'s own comment in content.js): playState
  // stays 'running' and currentTime keeps advancing on a removed element unless .cancel()
  // is called explicitly. Cyber-Vision is a WAAPI-driven effect (every tint/sweep/thermal/
  // bracket/readout animation is hung off container.__waapiAnims), so it is the
  // complementary case to chrono_tunnel.test.js's rAF/__rafId coverage of the same fix.
  //
  // Snapshots the live Animation objects *before* the scroll and holds onto those
  // references so their playState can still be read after the container itself is
  // detached and gone — document.getAnimations() would not necessarily surface animations
  // on an already-detached element, so the references have to be captured while the
  // beacon is still live (mirrors test/waapi_beacon_cancel.test.js's
  // snapshotBeaconAnimations()).
  test('a real scroll mid-flight cancels every WAAPI animation via fadeActiveBeacons(), not just removes the element', async () => {
    // This suite's page is exactly one viewport tall (scrollHeight === innerHeight), so a
    // real wheel scroll has nothing to scroll — window.scrollY would stay 0 and this test
    // would silently pass for the wrong reason (every animation reaching its own natural
    // 'finished' state, not fadeActiveBeacons() cancelling them). Padding the page taller
    // makes the scroll genuine before anything else runs.
    //
    // Centre the match first so this replay() never itself needs to auto-scroll the page
    // into view — highlightActiveRange() (content.js) only calls triggerAutoScrollFlag()
    // when the match is NOT already fully in the viewport, and that flag makes
    // handleScroll() ignore the very scroll this test is about to fire for 800ms. Centring
    // first guarantees replay()'s own Enter never sets it.
    await page.evaluate(() => {
      document.body.style.paddingBottom = '2000px';
      document.getElementById('target').scrollIntoView({ block: 'center', behavior: 'instant' });
    });

    try {
      await replay();

      const snapshotCount = await page.evaluate(() => {
        const beacons = Array.from(document.querySelectorAll('.oc-beacon'));
        const elems = beacons.flatMap((b) => [b, ...b.querySelectorAll('*')]);
        window.__waapiSnapshot = elems.flatMap((el) => el.getAnimations());
        return window.__waapiSnapshot.length;
      });
      assert.ok(snapshotCount > 0, 'sanity check: expected at least one live WAAPI animation under a .oc-beacon element, got 0');

      const before = await page.evaluate(() => window.__waapiSnapshot.map((a) => a.playState));
      assert.ok(
        before.some((s) => s === 'running'),
        `sanity check: expected at least one animation 'running' before the scroll, got ${JSON.stringify(before)}`
      );

      // A real wheel scroll, exactly as the bug reproduction used — not a synthetic
      // dispatchEvent('scroll'), which would prove nothing about the real browser scroll
      // path handleScroll() is wired to.
      const scrollYBefore = await page.evaluate(() => window.scrollY);
      await page.mouse.move(600, 400);
      await page.mouse.wheel(0, 300);
      await page.waitForFunction((y) => window.scrollY > y, scrollYBefore, { timeout: POLL_TIMEOUT });

      // fadeActiveBeacons() fades over 50ms, then removes on a setTimeout — wait past that
      // window for the container to actually be gone before reading the animation states.
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, {
        timeout: POLL_TIMEOUT,
      });

      const after = await page.evaluate(() => window.__waapiSnapshot.map((a) => a.playState));
      assert.ok(
        after.every((s) => s !== 'running'),
        `expected every WAAPI animation to be genuinely cancelled (not just detached) after a scroll-driven ` +
          `fadeActiveBeacons() removal; observed playStates ${JSON.stringify(after)}`
      );
    } finally {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.body.style.paddingBottom = '';
        delete window.__waapiSnapshot;
      });
    }
  });

  // oculist-xi4: reviewer residual from oculist-3ae. That fix's `container.isConnected`
  // guard tells a stale timer's container apart from a live one, but isConnected only goes
  // false once the container is actually removed — and fadeActiveBeacons() (unlike
  // cancelBeacons(), which detaches synchronously) removes on a 50ms fade-then-timeout, not
  // synchronously. A run cancelled by a scroll (with no later search to cancelBeacons() it)
  // is therefore still isConnected for up to 50ms after it was cancelled. If this run's own
  // settle timer fires inside that window, the isConnected-only guard cannot tell it apart
  // from a genuinely live run and flips cyberVisionBracketsSettled true anyway, for a run
  // that no longer represents anything on screen. See armScrollRace() above for how the
  // timing is made deterministic instead of racing a real hardware scroll.
  test("a run cancelled by a scroll mid-fade never resurrects cyberVisionBracketsSettled inside fadeActiveBeacons()'s 50ms removal window", async () => {
    // Same centring as the WAAPI-cancel test above, and for the same reason: replay()'s own
    // Enter must never trigger highlightActiveRange()'s triggerAutoScrollFlag(), which would
    // make handleScroll() ignore the scroll this test fires (isAutoScrolling, content.js).
    await page.evaluate(() => {
      document.body.style.paddingBottom = '2000px';
      document.getElementById('target').scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));

    try {
      await armScrollRace();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.oc-beacon', { timeout: POLL_TIMEOUT });

      await waitForContentScriptValue(evalInContentScript, 'window.__ocRaceScrollFired', (v) => v === true, {
        timeout: POLL_TIMEOUT,
        message: 'the scroll scheduled inside the settle-timer race window never fired',
      });

      // Sanity: the scroll actually cancelled a real, live run (a container really did exist,
      // really did fade, and really was removed) rather than this racing against nothing.
      const finalCount = await waitForCondition(
        () => page.evaluate(() => document.querySelectorAll('.oc-beacon').length),
        (count) => count === 0,
        { timeout: POLL_TIMEOUT, message: 'expected the scroll-cancelled beacon to still be removed once its fade finished' }
      );
      assert.strictEqual(finalCount, 0, `expected zero .oc-beacon elements after the scroll-cancelled fade, observed ${finalCount}`);

      // Positively confirm the flag stays false through and past the original settle deadline,
      // rather than checking it once at an arbitrary moment — mirrors the stale-timer test
      // above: a timeout here IS the passing outcome, a resolve is the bug.
      let resurrected = false;
      try {
        await waitForContentScriptValue(evalInContentScript, 'window.__ocTest.cyberVisionBracketsSettled', (v) => v === true, {
          timeout: POLL_TIMEOUT,
        });
        resurrected = true;
      } catch (e) {
        if (!/timed out/.test(e.message)) throw e;
      }
      assert.strictEqual(
        resurrected,
        false,
        "expected cyberVisionBracketsSettled to stay false for a run cancelled by a scroll mid-fade, not resurrected by its own settle timer firing while the container was still isConnected but already cancelled"
      );
    } finally {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.body.style.paddingBottom = '';
      });
    }
  });
});
