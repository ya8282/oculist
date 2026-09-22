// Galloping Throw beacon effect (oculist-nq1x.6): promotes fxHorseman (artifacts/
// prototypes/effects-playground.html, the accepted design from oculist-1ta.7's user-
// approved strict-spec redesign and oculist-1ta.31's pumpkin-as-head refinement) into
// extension/content.js as the fifth entry in the Halloween pack. A silhouetted rider
// gallops in from off-screen, rears, hurls a blazing jack-o'-lantern at the match, and
// rides off; the pumpkin rides at the rider's own collar as its head through the gallop
// and rear (oculist-1ta.31's own signature beat) and only becomes a projectile at the
// throw. The burst is four amber bands whose inner edges stop exactly at the match's own
// glyph box.
//
// Modeled on test/jackolantern_effect.test.js (this Halloween pack's own most recent
// sibling -- same fixture/helper shape, same Beacon-Size-from-the-rendered-box and pack-
// enumeration idioms) and test/cheshire_effect.test.js (the Animation.currentTime seek
// idiom used below for frame-by-frame verification of the pumpkin-as-head beat) and
// test/trail_effect.test.js (the fresh-tab, no-mouse-movement fixture for a cursor-
// independence check -- see the note on that below).
//
// TWO DELIBERATE DEPARTURES FROM THIS BEAD'S OWN EFFECT-SPECIFIC NOTES, found while
// reading fxHorseman (artifacts/prototypes/effects-playground.html) in full rather than
// trusting the bead text against stale line numbers:
//
// 1. NO START-POINT CASCADE. The bead's own notes say "the rider travels, so the
//    contract's rule 9 start-point cascade applies... the mirrored branch must work for
//    real." fxHorseman's own travel is NOT a cursor-to-match cascade the way animateTrail/
//    animateFlappy's is: it is a fixed OFF-SCREEN-EDGE-TO-OFF-SCREEN-EDGE entrance, with
//    the side chosen entirely from the match's own position in the viewport (direction/
//    stageNeed below) -- lastMouseX/lastMouseY is never read anywhere in the prototype
//    function. Porting a cursor-based start point in anyway would be inventing behavior
//    the prototype does not have, which the promotion contract does not license. What
//    rule 9 DOES apply to here is the "mirrored branch must work for real" half -- tested
//    below via the real near-left-edge geometry that forces it -- and this suite also
//    proves the entrance is cursor-INDEPENDENT (the actual, different property fxHorseman
//    really has), since that is exactly what the bead's claim would have masked.
// 2. NO BELOW-LANDING FALLBACK. The bead's own notes say "oculist-1ta.8 fixed a mist fade-
//    out that tinted the match in the below-landing fallback... assert that fallback path
//    hardest." oculist-1ta.8's own bead body (line 3173 of the playground, "mist", "sides
//    and above all fail their fit tests") describes a totally different prototype --
//    oculist-1ta.1's Bat Flight, not oculist-1ta.7's Headless Horseman. fxHorseman has
//    exactly two placement branches (stage left / stage right-mirrored), never an above/
//    below choice, and no mist element anywhere in its source. There is no below-landing
//    path to assert here. What this suite asserts hardest instead is the real analogue for
//    THIS effect: the match's own glyph pixels (outerHTML) staying byte-for-byte unchanged
//    across the full sequence, plus the burst bands' and the horse's own rendered boxes
//    never overlapping the match rect at their closest approach.
//
// Needs a real browser for the same reasons as those two: WAAPI, offset-path, real layout,
// and Lite Mode/pack toggles only exist for real in Chromium via chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, waitForCondition } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// #target: plenty of room on the left (margin-left 420 against a 1200px viewport) --
// forces the NORMAL (unmirrored) entrance. #edgeTarget: close to the left edge (margin-
// left 20) -- forces the MIRRORED entrance (stageNeed at Beacon Size M is ~195px; see
// animateHorseman's own stageNeed/direction computation in extension/content.js).
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:400px"></div>
<p style="margin-left:420px;">filler text <span id="target">quarklet</span></p>
<div style="height:200px"></div>
<p style="margin-left:20px;">filler text <span id="edgeTarget">zeptogram</span></p>
<div style="height:2000px"></div>`;

const VIEWPORT = { width: 1200, height: 800 };

const INPUT = '#oc-wrap >> .oc-input';
const GEAR_BTN = '#oc-wrap >> button[title="Options"]';
const SETTINGS_PANEL = '#oc-wrap >> #oc-settings-panel';
const HORSEMAN_EFFECT_ROW = '#oc-wrap >> [data-oc-key="effect:horseman"]';

describe('Galloping Throw: a silhouetted rider gallops in, rears, and hurls a blazing pumpkin at the match', () => {
  let server, ctx, page, client, isolatedContextId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;

    // channel:'chromium' is load-bearing -- the default bundled build is the headless
    // shell, which silently loads no extensions at all.
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: VIEWPORT,
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
    await waitForCondition(() => isolatedContextId, Boolean, {
      timeout: POLL_TIMEOUT,
      message: 'never observed the content script isolated execution context',
    });

    await setSettings({ effect: 'horseman', enabledPacks: ['halloween'] });

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
      .send('Runtime.evaluate', { expression, contextId: ctxId, awaitPromise: true, returnByValue: true })
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

  // Same production cancellation path as jackolantern_effect.test.js's own replay():
  // cancels any in-flight beacon through window.__ocTest.cancelBeacons() (the exact
  // function animate() itself calls first), then presses Enter to (re-)fire.
  async function replay(predicate, arg) {
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.keyboard.press('Enter');
    const handle = await page.waitForFunction(
      predicate || (() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null)),
      arg !== undefined ? arg : null,
      { timeout: POLL_TIMEOUT }
    );
    return handle.jsonValue();
  }

  // Pauses and seeks EVERY WAAPI animation on EVERY top-level beacon element this effect
  // creates (the rider `outer`, the projectile `pumpkin`, and the four burst bands -- six
  // independent .oc-beacon-transient elements, not one shared root the way Cheshire/Jack-
  // o'-Lantern's single <svg> is) to a fixed point on its own timeline, the same
  // Animation.currentTime idiom test/cheshire_effect.test.js's own grinPopBox()/
  // seekAndSample() use, generalized across multiple roots.
  function seekAll(t) {
    document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
      el.getAnimations({ subtree: true }).forEach((a) => {
        a.pause();
        a.currentTime = t;
      });
    });
  }

  function switchToTarget(id) {
    return async () => {
      await page.locator(INPUT).fill('');
      await page.locator(INPUT).type(id === 'target' ? 'quarklet' : 'zeptogram', { delay: 30 });
      await waitForMatchCount(page);
    };
  }

  test('document-space correctness: on a scrolled page, the rider path and the burst bands carry a real "+ window.scrollY" term', async () => {
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY;
    });
    try {
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 300)), targetDocY);

      // Measured JUST BEFORE firing, post-scroll, in viewport space -- the same live rect
      // animate() itself hands to animateHorseman -- so the expected values below are
      // derived from the real geometry, not recomputed from a second copy of the formula.
      const preFire = await page.evaluate(() => {
        const r = document.getElementById('target').getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right, width: r.width, height: r.height, scrollY: window.scrollY };
      });

      const geom = await replay(() => {
        const outer = document.querySelector('.oc-beacon-transient[data-horseman-direction]');
        if (!outer) return null;
        const path = getComputedStyle(outer).offsetPath || outer.style.offsetPath;
        const m = /M\s*([-\d.]+)\s+([-\d.]+)\s*L\s*([-\d.]+)\s+([-\d.]+)/.exec(path || '');
        if (!m) return null;
        const burst = document.querySelectorAll('.oc-beacon-transient');
        return {
          direction: outer.getAttribute('data-horseman-direction'),
          pathStartY: parseFloat(m[2]),
          pathEndY: parseFloat(m[4]),
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          burstCount: burst.length,
          burstTop: parseFloat(burst[2].style.top), // [0]=rider, [1]=pumpkin, [2..5]=burst bands
        };
      });
      assert.ok(geom, 'expected a mounted rider');
      assert.ok(geom.scrollY > 0, `sanity check: the page must actually be scrolled, got scrollY=${geom.scrollY}`);
      assert.strictEqual(geom.direction, 'normal', 'sanity check: #target must force the normal (unmirrored) entrance');

      // The motion path's own Y (CENTER_Y in animateHorseman: rect.top + rect.height*0.3,
      // viewport space) is fixed for the whole horizontal traverse -- both M and L share it
      // -- so both must equal the SAME real "+ window.scrollY" term, computed from the live
      // pre-fire rect rather than a coincidental threshold: a missing scrollY term would
      // otherwise collapse pathStartY to the small pre-scroll viewport value, which this
      // exact-value comparison catches regardless of how far the page happens to be scrolled.
      const expectedCenterY = preFire.top + preFire.height * 0.3 + preFire.scrollY;
      assert.ok(
        Math.abs(geom.pathStartY - expectedCenterY) <= 2,
        `path Y: expected ~${expectedCenterY} (viewport CENTER_Y + real scrollY), got ${geom.pathStartY}`
      );
      assert.strictEqual(geom.pathStartY, geom.pathEndY, 'the path\'s start and end Y must be identical (one fixed CENTER_Y)');

      assert.strictEqual(geom.burstCount, 6, 'expected 6 top-level .oc-beacon-transient elements (rider + pumpkin + 4 burst bands)');
      const burstPad = 10;
      const expectedBurstTop = preFire.top - burstPad + preFire.scrollY; // first band: r.top - burstPad
      assert.ok(
        Math.abs(geom.burstTop - expectedBurstTop) <= 2,
        `a burst band's own top: expected ~${expectedBurstTop} (viewport position + real scrollY), got ${geom.burstTop}`
      );
    } finally {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('normal entrance: on an UNSCROLLED page, direction/staging match the shipped fit formula and the match DOM is untouched', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const geom = await replay(() => {
      const outer = document.querySelector('.oc-beacon-transient[data-horseman-direction]');
      if (!outer) return null;
      const svg = outer.querySelector('svg[data-horseman-role="sprite"]');
      return {
        direction: outer.getAttribute('data-horseman-direction'),
        mirroredTransform: svg.style.transform || '',
      };
    });
    assert.ok(geom, 'expected a mounted rider');
    assert.strictEqual(geom.direction, 'normal', 'a match with plenty of room on the left must use the normal (unmirrored) entrance');
    assert.strictEqual(geom.mirroredTransform, '', 'the normal entrance must not mirror the sprite');

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM (#target outerHTML) must never be mutated by this effect');

    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('mirrored entrance: a match near the viewport\'s left edge stages the rider on the right, mirrors the sprite for real, and the pumpkin still lands on the match', async () => {
    await switchToTarget('edgeTarget')();
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = await page.evaluate(() => document.getElementById('edgeTarget').outerHTML);

    try {
      const geom = await replay(() => {
        const outer = document.querySelector('.oc-beacon-transient[data-horseman-direction]');
        if (!outer) return null;
        const svg = outer.querySelector('svg[data-horseman-role="sprite"]');
        return {
          direction: outer.getAttribute('data-horseman-direction'),
          mirroredTransform: svg.style.transform || '',
        };
      });
      assert.ok(geom, 'expected a mounted rider');
      assert.strictEqual(geom.direction, 'mirrored', 'a match near the left edge must force the mirrored entrance');
      assert.ok(geom.mirroredTransform.indexOf('scaleX(-1)') !== -1, `the mirrored entrance must actually mirror the sprite, got transform "${geom.mirroredTransform}"`);

      // "Must work for real, not just compile": seek to well past the burst and confirm the
      // pumpkin's own flight actually reached (approximately) the match's own centre, not
      // just that the mirrored CSS was set.
      const landed = await page.evaluate(() => {
        const pumpkin = document.querySelectorAll('.oc-beacon-transient')[1];
        const anims = pumpkin.getAnimations({ subtree: true });
        anims.forEach((a) => { a.pause(); a.currentTime = 1600; }); // burstStart(1560)+40, just past landing
        const rect = pumpkin.getBoundingClientRect();
        const target = document.getElementById('edgeTarget').getBoundingClientRect();
        return { pumpCx: rect.left + rect.width / 2, targetCx: target.left + target.width / 2 };
      });
      assert.ok(
        Math.abs(landed.pumpCx - landed.targetCx) < 20,
        `mirrored pumpkin must land near the match's own centre (${landed.targetCx}), got ${landed.pumpCx}`
      );

      const after = await page.evaluate(() => document.getElementById('edgeTarget').outerHTML);
      assert.strictEqual(after, before, 'the match DOM (#edgeTarget outerHTML) must never be mutated by this effect');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await switchToTarget('target')();
    }
  });

  test('the entrance geometry is independent of cursor position (fxHorseman never reads lastMouseX/lastMouseY, unlike animateTrail/animateFlappy)', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));

    const noMouse = await replay(() => {
      const outer = document.querySelector('.oc-beacon-transient[data-horseman-direction]');
      if (!outer) return null;
      return { left: outer.style.left, offsetPath: getComputedStyle(outer).offsetPath || outer.style.offsetPath };
    });
    assert.ok(noMouse, 'expected a mounted rider');

    await page.mouse.move(30, 700); // far from the match, bottom-left corner of the viewport
    const withMouse = await replay(() => {
      const outer = document.querySelector('.oc-beacon-transient[data-horseman-direction]');
      if (!outer) return null;
      return { left: outer.style.left, offsetPath: getComputedStyle(outer).offsetPath || outer.style.offsetPath };
    });
    assert.ok(withMouse, 'expected a mounted rider');

    assert.strictEqual(
      withMouse.offsetPath,
      noMouse.offsetPath,
      'the rider\'s own motion path must not change with cursor position -- this effect stages purely from the match\'s own position in the viewport'
    );
  });

  test('viewport edges: at a small 500x300 viewport, the rider\'s rendered box stays on screen and the match glyphs stay untouched', async () => {
    await page.setViewportSize({ width: 500, height: 300 });
    try {
      const targetDocY = await page.evaluate(() => {
        const r = document.getElementById('target').getBoundingClientRect();
        return r.top + window.scrollY;
      });
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 100)), targetDocY);

      const before = await page.evaluate(() => document.getElementById('target').outerHTML);

      const geom = await replay(() => {
        const outer = document.querySelector('.oc-beacon-transient[data-horseman-direction]');
        return outer ? true : null;
      });
      assert.ok(geom, 'expected a mounted rider even at a tiny viewport');

      // Seek to the rear hold (well inside the viewport-clamped staging position) and
      // confirm the rider's own rendered box never exceeds the viewport bounds.
      const box = await page.evaluate(() => {
        const outer = document.querySelectorAll('.oc-beacon-transient')[0];
        outer.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1200; });
        const rect = outer.getBoundingClientRect();
        return { left: rect.left, right: rect.right, vw: window.innerWidth };
      });
      assert.ok(box.right <= box.vw + 2, `rider's right edge (${box.right}) must stay within the ${box.vw}px-wide viewport at the rear hold`);

      const after = await page.evaluate(() => document.getElementById('target').outerHTML);
      assert.strictEqual(after, before, 'the match DOM must never be mutated by this effect, even at a tiny viewport');
    } finally {
      await evalInContentScript('window.__ocTest.cancelBeacons()');
      await page.setViewportSize(VIEWPORT);
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  test('the pumpkin rides as the rider\'s head through gallop and rear, detaches at the throw, and the collar is empty for the exit (oculist-1ta.31)', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const mounted = await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null));
    assert.ok(mounted, 'sanity check: the rider must actually mount before it can be sampled frame by frame');

    // t=500: mid-gallop. headNormal (the collar head in the un-rotated pose) must be
    // visible and co-located with the rider's own rendered box; the free pumpkin must not
    // be visible yet.
    const gallop = await page.evaluate(() => {
      const outer = document.querySelectorAll('.oc-beacon-transient')[0];
      const pumpkin = document.querySelectorAll('.oc-beacon-transient')[1];
      outer.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 500; });
      pumpkin.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 500; });
      const headNormal = outer.querySelector('[data-horseman-part="head-normal"]');
      const outerRect = outer.getBoundingClientRect();
      const headRect = headNormal.getBoundingClientRect();
      return {
        headOpacity: parseFloat(getComputedStyle(headNormal).opacity),
        headCx: headRect.left + headRect.width / 2,
        headCy: headRect.top + headRect.height / 2,
        outerLeft: outerRect.left, outerRight: outerRect.right, outerTop: outerRect.top, outerBottom: outerRect.bottom,
        pumpkinOpacity: parseFloat(getComputedStyle(pumpkin).opacity),
      };
    });
    assert.ok(gallop.headOpacity > 0.9, `gallop: the collar head must be visible, got opacity ${gallop.headOpacity}`);
    assert.ok(
      gallop.headCx >= gallop.outerLeft - 2 && gallop.headCx <= gallop.outerRight + 2 &&
      gallop.headCy >= gallop.outerTop - 2 && gallop.headCy <= gallop.outerBottom + 2,
      `gallop: the collar head must sit inside the rider's own rendered box (${JSON.stringify(gallop)})`
    );
    assert.strictEqual(gallop.pumpkinOpacity, 0, 'gallop: the free-flying pumpkin must not be visible yet -- it is still the head');

    // t=1005: near the peak of the rear rise (850-1010, ease-out) but before the RISE_END-1
    // (1009ms) hard cut to the throwing hand -- animateHorseman's own comment describes this
    // as a deliberate "duplicate keyframe at a 1-frame offset" idiom (the same one
    // armCocked/armThrow use), so there is no broad plateau to sample; this is the one
    // instant the rear-pose head is actually at (near-)full opacity.
    const rear = await page.evaluate(() => {
      const outer = document.querySelectorAll('.oc-beacon-transient')[0];
      outer.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1005; });
      const headNormal = outer.querySelector('[data-horseman-part="head-normal"]');
      const headRear = outer.querySelector('[data-horseman-part="head-rear"]');
      return {
        headNormalOpacity: parseFloat(getComputedStyle(headNormal).opacity),
        headRearOpacity: parseFloat(getComputedStyle(headRear).opacity),
      };
    });
    assert.ok(rear.headRearOpacity > 0.85, `rear: the rear-pose head must be (near-)fully visible just before the throw's own hard cut, got opacity ${rear.headRearOpacity}`);
    assert.ok(rear.headNormalOpacity < 0.1, `rear: the gallop-pose head must be gone, got opacity ${rear.headNormalOpacity}`);

    // t=1100: just after RISE_END (1010), i.e. after the throw's own detach instant. Both
    // heads must be gone from the collar, and the free pumpkin must now be visible and
    // flying.
    const detached = await page.evaluate(() => {
      const outer = document.querySelectorAll('.oc-beacon-transient')[0];
      const pumpkin = document.querySelectorAll('.oc-beacon-transient')[1];
      outer.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1100; });
      pumpkin.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1100; });
      const headNormal = outer.querySelector('[data-horseman-part="head-normal"]');
      const headRear = outer.querySelector('[data-horseman-part="head-rear"]');
      return {
        headNormalOpacity: parseFloat(getComputedStyle(headNormal).opacity),
        headRearOpacity: parseFloat(getComputedStyle(headRear).opacity),
        pumpkinOpacity: parseFloat(getComputedStyle(pumpkin).opacity),
      };
    });
    assert.ok(detached.headNormalOpacity < 0.1, `post-throw: the gallop-pose head must stay gone, got ${detached.headNormalOpacity}`);
    assert.ok(detached.headRearOpacity < 0.1, `post-throw: the rear-pose head must be gone (detached), got ${detached.headRearOpacity}`);
    assert.ok(detached.pumpkinOpacity > 0.9, `post-throw: the free-flying pumpkin must now be visible, got ${detached.pumpkinOpacity}`);

    // t=2300: well into the exit. The collar must stay empty (rule 3 of oculist-1ta.31 --
    // the headless silhouette reads in the exit frames).
    const exit = await page.evaluate(() => {
      const outer = document.querySelectorAll('.oc-beacon-transient')[0];
      outer.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 2300; });
      const headNormal = outer.querySelector('[data-horseman-part="head-normal"]');
      const headRear = outer.querySelector('[data-horseman-part="head-rear"]');
      return {
        headNormalOpacity: parseFloat(getComputedStyle(headNormal).opacity),
        headRearOpacity: parseFloat(getComputedStyle(headRear).opacity),
      };
    });
    assert.ok(exit.headNormalOpacity < 0.1, `exit: the collar must stay empty, got gallop-head opacity ${exit.headNormalOpacity}`);
    assert.ok(exit.headRearOpacity < 0.1, `exit: the collar must stay empty, got rear-head opacity ${exit.headRearOpacity}`);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('the burst never paints inside the match rect, and the match DOM stays untouched across the whole sequence', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = await page.evaluate(() => document.getElementById('target').outerHTML);

    const mounted = await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null));
    assert.ok(mounted, 'sanity check: the rider must mount before the burst can be sampled');

    // The four burst bands' own CSS boxes (side[0..3] in animateHorseman) are constructed
    // to sit fully OUTSIDE the match rect by burstPad, before any clip-path is even
    // applied -- so their rendered getBoundingClientRect(), read here at the burst's own
    // peak keyframe (burstStart + 0.4*BURST_DUR = 1688), must never overlap the match.
    const burst = await page.evaluate(() => {
      document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
        el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1688; });
      });
      const bands = Array.from(document.querySelectorAll('.oc-beacon-transient')).slice(2); // outer, pumpkin, then 4 bands
      const target = document.getElementById('target').getBoundingClientRect();
      return {
        target,
        bands: bands.map((b) => b.getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
      };
    });
    assert.strictEqual(burst.bands.length, 4, 'expected exactly 4 burst bands');
    burst.bands.forEach((b, i) => {
      const overlapsX = b.left < burst.target.right && b.right > burst.target.left;
      const overlapsY = b.top < burst.target.bottom && b.bottom > burst.target.top;
      assert.ok(
        !(overlapsX && overlapsY),
        `burst band ${i} (${JSON.stringify(b)}) must not overlap the match rect (${JSON.stringify(burst.target)})`
      );
    });

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

    const after = await page.evaluate(() => document.getElementById('target').outerHTML);
    assert.strictEqual(after, before, 'the match DOM (#target outerHTML) must never be mutated across the whole sequence');
  });

  test('Beacon Size M/L/XL, set for real through chrome.storage.sync: the rider\'s and pumpkin\'s RENDERED boxes scale together', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));

    async function renderedBoxes() {
      await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null));
      return page.evaluate(() => {
        const outer = document.querySelectorAll('.oc-beacon-transient')[0];
        const rect = outer.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    }

    try {
      // getBeaconScale() (content.js): 'm' -> 1, 'l' -> 1.5, 'xl' -> 2.25. Measured from the
      // RENDERED box, not recomputed from animateHorseman's own SPRITE_H/beaconScale
      // formula, so a bug in that formula cannot cancel out against an identical
      // recomputation here.
      const base = await renderedBoxes();
      const SIZES = [['l', 1.5], ['xl', 2.25]];
      for (const [size, scale] of SIZES) {
        await setVisionSettings({ beaconSize: size });
        const geom = await renderedBoxes();
        assert.ok(
          Math.abs(geom.width / base.width - scale) < 0.05,
          `Beacon Size ${size}: rider's rendered width must scale ~${scale}x the default's (${base.width}), got ${geom.width}`
        );
        assert.ok(
          Math.abs(geom.height / base.height - scale) < 0.05,
          `Beacon Size ${size}: rider's rendered height must scale ~${scale}x the default's (${base.height}), got ${geom.height}`
        );
      }
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
      await evalInContentScript('window.__ocTest.cancelBeacons()');
    }
  });

  test('Beacon Size M/L/XL: the burst still clears the match rect at every size', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));

    async function burstClearance() {
      await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null));
      return page.evaluate(() => {
        document.querySelectorAll('.oc-beacon-transient').forEach((el) => {
          el.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1688; });
        });
        const bands = Array.from(document.querySelectorAll('.oc-beacon-transient')).slice(2);
        const target = document.getElementById('target').getBoundingClientRect();
        return bands.map((b) => b.getBoundingClientRect()).map((r) => {
          const overlapsX = r.left < target.right && r.right > target.left;
          const overlapsY = r.top < target.bottom && r.bottom > target.top;
          return !(overlapsX && overlapsY);
        });
      });
    }

    try {
      for (const size of ['l', 'xl']) {
        await setVisionSettings({ beaconSize: size });
        const clears = await burstClearance();
        assert.ok(clears.every(Boolean), `Beacon Size ${size}: every burst band must still clear the match rect, got ${JSON.stringify(clears)}`);
      }
    } finally {
      await setVisionSettings({ beaconSize: 'm' });
      await evalInContentScript('window.__ocTest.cancelBeacons()');
    }
  });

  test('Lite Mode, set for real through chrome.storage.sync: a no-op -- same rendered geometry and the same animation count in both modes', async () => {
    async function snapshot() {
      const mounted = await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null));
      assert.ok(mounted, 'expected a mounted rider');
      return page.evaluate(() => {
        const outer = document.querySelectorAll('.oc-beacon-transient')[0];
        const rect = outer.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          totalAnimCount: Array.from(document.querySelectorAll('.oc-beacon-transient'))
            .reduce((sum, el) => sum + el.getAnimations({ subtree: true }).length, 0),
        };
      });
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    const full = await snapshot();

    try {
      await setSettings({ performanceMode: true });
      const lite = await snapshot();
      assert.strictEqual(lite.totalAnimCount, full.totalAnimCount, 'Lite Mode must not drop or add any animation -- this effect has no glow/box-shadow/multi-state flicker to cut');
      assert.strictEqual(lite.width, full.width, 'Lite Mode must not change the rider\'s rendered width');
      assert.strictEqual(lite.height, full.height, 'Lite Mode must not change the rider\'s rendered height');
    } finally {
      await setSettings({ performanceMode: false });
      await evalInContentScript('window.__ocTest.cancelBeacons()');
    }
  });

  test('cancellation mid-animation: no .oc-beacon-transient nodes survive, and every WAAPI animation on every element is actually canceled', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const mounted = await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null));
    assert.ok(mounted, 'sanity check: the rider must actually mount before it can be cancelled');

    const animCount = await page.evaluate(() => {
      window.__horsemanTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__horsemanTestAnims.length;
    });
    // 22 on the rider (legs x7, core x4, arms x6, head x3, outer motion+lift x2) + 4 on the
    // pumpkin (fade-in, flight, spin, fade-out) + 4 burst bands x1 each = 30.
    assert.strictEqual(animCount, 30, `expected 30 live WAAPI animations before cancellation, got ${animCount}`);

    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

    const states = await page.evaluate(() => window.__horsemanTestAnims.map((a) => a.playState));
    assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled (playState 'idle') after cancelBeacons(), got: ${[...new Set(states)].join(', ')}`);

    await page.evaluate(() => { delete window.__horsemanTestAnims; });
  });

  test('overlay close: pressing Escape with no dialog open tears down the whole finder, and no rider, pumpkin, or animation survives', async () => {
    const mounted = await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null));
    assert.ok(mounted, 'sanity check: the rider must actually mount before the overlay closes');

    const animCount = await page.evaluate(() => {
      window.__horsemanOverlayTestAnims = Array.from(document.querySelectorAll('.oc-beacon-transient'))
        .flatMap((el) => el.getAnimations({ subtree: true }));
      return window.__horsemanOverlayTestAnims.length;
    });
    assert.ok(animCount > 0, 'sanity check: the rider must have live animations before the overlay closes');

    try {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('oc-wrap'), null, { timeout: POLL_TIMEOUT });

      const states = await page.evaluate(() => window.__horsemanOverlayTestAnims.map((a) => a.playState));
      assert.ok(states.every((s) => s === 'idle'), `every animation must be canceled after an overlay close, got: ${[...new Set(states)].join(', ')}`);
      const remaining = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient').length);
      assert.strictEqual(remaining, 0, 'no .oc-beacon-transient node may survive an overlay close');
    } finally {
      await openFinder(page);
      await page.locator(INPUT).type('quarklet', { delay: 30 });
      await waitForMatchCount(page);
    }
  });

  test('rapid refire: pressing Enter repeatedly, with no explicit cancel in between, never leaves more than one rider mounted at once', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Enter');
      const count = await page.evaluate(() => document.querySelectorAll('.oc-beacon-transient[data-horseman-direction]').length);
      assert.ok(count <= 1, `expected at most one rider mounted at once during rapid refire, got ${count} after press ${i + 1}`);
    }
    await evalInContentScript('window.__ocTest.cancelBeacons()');
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  test('natural completion: nothing remains in the DOM once the full sequence finishes, with no cancel', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const mounted = await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? true : null));
    assert.ok(mounted, 'sanity check: the rider must actually mount before it can complete naturally');

    // No cancelBeacons() call here -- a genuine leak surfaces as this wait's own
    // TimeoutError. DUR is ~2890ms; POLL_TIMEOUT comfortably covers it.
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
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
      await setSettings({ enabledPacks: [] });
      let keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.strictEqual(keys.indexOf('horseman'), -1, 'horseman must be absent from availableEffects() while its pack is disabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(HORSEMAN_EFFECT_ROW).count(),
        0,
        'horseman must be absent from the settings-panel picker while its pack is disabled'
      );
      await closeSettings();

      await setSettings({ enabledPacks: ['halloween'] });
      keys = await evalInContentScript('window.__ocTest.getAvailableEffectKeys()');
      assert.notStrictEqual(keys.indexOf('horseman'), -1, 'horseman must be present in availableEffects() once its pack is enabled');

      await openSettings();
      assert.strictEqual(
        await page.locator(HORSEMAN_EFFECT_ROW).count(),
        1,
        'horseman must appear in the settings-panel picker once its pack is enabled'
      );
      await closeSettings();

      // Runtime fallback while disabled: settings.effect stays 'horseman' (a real,
      // registered -- just currently unavailable -- key), so firing must fall back to some
      // other effect rather than mount a rider or throw.
      await setSettings({ effect: 'horseman', enabledPacks: [] });
      let geom = await replay(() => (document.querySelector('.oc-beacon-transient') ? {
        riderMounted: !!document.querySelector('.oc-beacon-transient[data-horseman-direction]'),
      } : null));
      assert.strictEqual(geom.riderMounted, false, 'while the pack is disabled, the runtime fallback must not render a rider');
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });

      // Selection restored on re-enable: no explicit re-selection of 'horseman' here.
      await setSettings({ enabledPacks: ['halloween'] });
      geom = await replay(() => (document.querySelector('.oc-beacon-transient[data-horseman-direction]') ? { riderMounted: true } : null));
      assert.strictEqual(geom.riderMounted, true, 'the stored horseman selection must survive the disable/re-enable round trip');

      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon-transient').length === 0, null, { timeout: POLL_TIMEOUT });
    } finally {
      // chrome.storage only fires onChanged when the stored value actually differs -- route
      // through a sentinel value first so both writes are genuine changes regardless of
      // which line above (if any) threw.
      await setSettings({ enabledPacks: ['__oc_horseman_test_reset__'] });
      await setSettings({ effect: 'horseman', enabledPacks: ['halloween'] });
    }
  });
});
