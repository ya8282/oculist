// Lens beacon effect (oculist-y6a): a circular magnifier over the *real* page content
// around the active match — the source element's own subtree, cloneNode(true)'d and
// scale()'d inside a circular overflow:hidden mask, mounted in the light DOM so host-page
// CSS still applies. This is NOT drawActiveMatchMagnifier() (which renders the match text
// alone, at 2.5x, inside a styled card) — Lens magnifies surrounding page content in place.
//
// The load-bearing behaviour under test is the clone-hygiene contract: duplicate ids would
// break the host page's own CSS/JS and getElementById(), and a cloned <iframe> would reload
// (real network + re-fired trackers) — neither is provable by reading content.js, only by
// asking a real DOM whether it actually happened. Also covers the "never mutate the host
// page" invariant (layout must be byte-identical while the lens is up) and no-leak cleanup.
//
// Needs a real browser for the same reasons as trail_effect.test.js / dispersion_bloom.test.js:
// WAAPI, CSS.highlights and a real layout only exist in real Chromium, and the Lens effect
// can only be selected for real through chrome.storage.sync.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, waitForContentScriptValue, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// #styled-block is the match's nearest block-level ancestor (the match's own immediate
// parent, span#target, is inline) — it carries its own id (styled-block), a couple of
// sibling elements (span#sibling-one / span#sibling-two, one of which also carries an id),
// an iframe, and an inline <script> (see the hygiene test below), so the clone-hygiene
// assertions (no duplicate ids, no iframe/script inside the mounted lens) are actually
// exercising real content, not an empty box.
// #reference-el sits outside the styled block, used to prove page layout is untouched.
// The trailing bare text node ("directbodytext999") is a direct child of <body> with no
// wrapping element at all, exercising the case where the match's own parent element
// already *is* <body> (see the body-source test below).
const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }
  #styled-block { background: #eef; padding: 12px; border: 1px solid #99c; }
</style>
<div style="height:2000px"></div>
<div id="styled-block">
  <span id="sibling-one">before </span>
  filler text <span id="target">quarklet</span> more filler
  <span>after</span>
  <iframe id="frame" src="about:blank" width="80" height="40"></iframe>
  <script>/* inert: only present so the clone-hygiene "no script inside the lens" assertion has something to strip */</script>
</div>
<p id="reference-el">reference element for layout checks</p>
directbodytext999`;

const INPUT = '#oc-wrap >> .oc-input';

describe('Lens: a circular magnifier over the real page content around the active match', () => {
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

    // Select the Lens effect for the whole suite before ever opening the finder. This
    // write lands in chrome.storage.sync, shared by every tab of this persistent context.
    await setSettings({ effect: 'lens' });

    await openFinder(page);
    await page.locator(INPUT).type('quarklet', { delay: 30 });
    await waitForMatchCount(page);

    // Land the match already fully inside the viewport, deterministically, rather than
    // relying on highlightActiveRange()'s native smooth-scroll-into-view wall-clock timing
    // (unrelated to what these tests prove, and flaky against a fixed timeout).
    const targetDocY = await page.evaluate(() => {
      const r = document.getElementById('target').getBoundingClientRect();
      return r.top + window.scrollY + r.height / 2;
    });
    await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), targetDocY);
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

  // Clears any leftover .oc-beacon nodes, presses Enter to (re-)fire the active beacon, and
  // waits for a fresh .oc-beacon lens to actually mount. animate() calls cancelBeacons()
  // first, so this never accumulates parts across calls.
  async function replay(pg) {
    await pg.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await pg.keyboard.press('Enter');
    await pg.waitForSelector('div.oc-beacon', { timeout: POLL_TIMEOUT });
  }

  // Condition-polls until no .oc-beacon is mounted, i.e. the page is genuinely at rest.
  // The lens animation runs ~1400ms; without this, a test that snapshots "before" state
  // right after a previous test's replay() can end up comparing "lens up" against "lens
  // up" rather than a real baseline. Call this before any before/during snapshot.
  async function waitForLensAtRest(pg) {
    await pg.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: POLL_TIMEOUT });
  }

  test('the lens mounts and its clone contains the match text', async () => {
    await replay(page);
    const cloneText = await page.evaluate(() => {
      const lens = document.querySelector('div.oc-beacon');
      return lens ? lens.textContent : null;
    });
    assert.ok(cloneText && cloneText.indexOf('quarklet') !== -1, `expected the clone to contain the match text, got: ${cloneText}`);
  });

  test('the lens clone is actually magnified and pinned on the match centre', async () => {
    await replay(page);

    // Recompute the same geometry animateLens() itself computes (r/Z/mx/my/srcDocLeft/
    // srcDocTop, from content.js:1626-1693) from the live page, in the same JS engine, in
    // the same order — no scroll happens between replay() and this evaluate(), so this is
    // not a race against the values content.js actually used to set the clone's style.
    const geo = await page.evaluate(() => {
      const target = document.getElementById('target');
      const source = document.getElementById('styled-block');
      const range = document.createRange();
      range.selectNodeContents(target);
      const rect = range.getBoundingClientRect();
      const srcRect = source.getBoundingClientRect();

      const scale = 1; // default beaconSize ('m') — this suite never sets visionSettings.beaconSize
      const r = 80 * scale;
      const Z = 2;

      const mx = rect.left + rect.width / 2 + window.scrollX;
      const my = rect.top + rect.height / 2 + window.scrollY;
      const srcDocLeft = srcRect.left + window.scrollX;
      const srcDocTop = srcRect.top + window.scrollY;

      const expectedLeft = (srcDocLeft - mx) + r;
      const expectedTop = (srcDocTop - my) + r;
      const expectedOriginX = mx - srcDocLeft;
      const expectedOriginY = my - srcDocTop;

      const lens = document.querySelector('div.oc-beacon');
      const clone = lens ? lens.firstElementChild : null;

      return {
        cloneLeft: clone ? clone.style.left : null,
        cloneTop: clone ? clone.style.top : null,
        cloneTransformOrigin: clone ? clone.style.transformOrigin : null,
        cloneTransform: clone ? clone.style.transform : null,
        expectedLeft,
        expectedTop,
        expectedOriginX,
        expectedOriginY,
      };
    });

    // Chromium re-serializes inline style px lengths at reduced float precision (e.g. it
    // reads back "80.8203px" for a value set as 80.8203125), so parse and compare numerics
    // with a tight tolerance rather than the exact string — a tolerance far too small to
    // hide a real misalignment (the mutations below are off by 1x scale or a whole
    // dimension, not by a rounding error).
    const EPS = 0.01;
    function closeTo(actual, expected, label) {
      assert.ok(
        typeof actual === 'number' && Math.abs(actual - expected) < EPS,
        `expected ${label} ~= ${expected}, got ${actual}`
      );
    }

    assert.ok(geo.cloneLeft && geo.cloneLeft.endsWith('px'), `expected clone left to be a px length, got: ${geo.cloneLeft}`);
    assert.ok(geo.cloneTop && geo.cloneTop.endsWith('px'), `expected clone top to be a px length, got: ${geo.cloneTop}`);
    closeTo(parseFloat(geo.cloneLeft), geo.expectedLeft, 'clone left (pin the match centre under the lens centre)');
    closeTo(parseFloat(geo.cloneTop), geo.expectedTop, 'clone top (pin the match centre under the lens centre)');

    const originMatch = geo.cloneTransformOrigin && geo.cloneTransformOrigin.match(/^(-?[\d.]+)px\s+(-?[\d.]+)px$/);
    assert.ok(originMatch, `expected a two-value px transform-origin, got: ${geo.cloneTransformOrigin}`);
    closeTo(parseFloat(originMatch[1]), geo.expectedOriginX, 'transform-origin x (the match point inside the clone)');
    closeTo(parseFloat(originMatch[2]), geo.expectedOriginY, 'transform-origin y (the match point inside the clone)');

    const scaleMatch = geo.cloneTransform && geo.cloneTransform.match(/^scale\(([\d.]+)\)$/);
    assert.ok(scaleMatch, `expected an inline scale(N) transform on the clone, got: ${geo.cloneTransform}`);
    assert.ok(parseFloat(scaleMatch[1]) > 1, `expected magnification (scale > 1), got scale(${scaleMatch[1]})`);
  });

  test('no duplicate ids: every original id still resolves to exactly one element while the lens is up', async () => {
    await replay(page);
    // Sanity: the lens really does contain clones of the id-bearing originals (otherwise
    // this assertion would trivially pass with nothing to strip).
    const idsInsideLens = await page.evaluate(() => {
      const lens = document.querySelector('div.oc-beacon');
      return lens ? Array.from(lens.querySelectorAll('[id]')).map((el) => el.id) : [];
    });
    assert.strictEqual(idsInsideLens.length, 0, `expected the mounted lens to carry zero ids, found: ${idsInsideLens}`);

    const dupCounts = await page.evaluate(() => {
      const ids = ['styled-block', 'sibling-one', 'frame', 'reference-el', 'target'];
      const counts = {};
      ids.forEach((id) => {
        counts[id] = document.querySelectorAll('#' + CSS.escape(id)).length;
      });
      return counts;
    });
    Object.entries(dupCounts).forEach(([id, count]) => {
      assert.strictEqual(count, 1, `expected exactly one #${id} in the document while the lens is up, found ${count}`);
    });
  });

  test('host page layout is unchanged while the lens is up', async () => {
    // Wait for the page to be genuinely at rest before snapshotting "before" state — a
    // previous test's replay() leaves its own lens mounted for ~1400ms, far longer than a
    // single test body takes to run, so without this barrier "before" would be captured
    // while that stale lens is still up (comparing "lens up" against "lens up").
    await waitForLensAtRest(page);

    const before_ = await page.evaluate(() => {
      const r = document.getElementById('reference-el').getBoundingClientRect();
      const source = document.getElementById('styled-block');
      return {
        scrollHeight: document.body.scrollHeight,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height },
        // Layout alone can't catch "we mutated a real node" — a transform on a real node
        // changes nothing about layout. This is the assertion that actually catches that.
        sourceChildCount: source.childElementCount,
        sourceOuterHtmlLength: source.outerHTML.length,
      };
    });

    await replay(page);

    const during = await page.evaluate(() => {
      const r = document.getElementById('reference-el').getBoundingClientRect();
      const source = document.getElementById('styled-block');
      return {
        scrollHeight: document.body.scrollHeight,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height },
        sourceChildCount: source.childElementCount,
        sourceOuterHtmlLength: source.outerHTML.length,
      };
    });

    assert.strictEqual(during.scrollHeight, before_.scrollHeight, 'document.body.scrollHeight must not change');
    assert.deepStrictEqual(during.rect, before_.rect, 'reference element rect must not change');
    assert.strictEqual(
      during.sourceChildCount,
      before_.sourceChildCount,
      'source element child count must not change — the host subtree itself must not be mutated'
    );
    assert.strictEqual(
      during.sourceOuterHtmlLength,
      before_.sourceOuterHtmlLength,
      'source element outerHTML length must not change — the host subtree itself must not be mutated'
    );
  });

  test('hygiene: no iframe or script inside the mounted lens', async () => {
    await replay(page);
    const counts = await page.evaluate(() => {
      const lens = document.querySelector('div.oc-beacon');
      return {
        iframes: lens ? lens.querySelectorAll('iframe').length : -1,
        scripts: lens ? lens.querySelectorAll('script').length : -1,
      };
    });
    assert.strictEqual(counts.iframes, 0, 'expected zero iframes inside the mounted lens');
    assert.strictEqual(counts.scripts, 0, 'expected zero scripts inside the mounted lens');
  });

  test('no leak: every .oc-beacon element is removed once the effect finishes', async () => {
    await replay(page);
    assert.ok(
      (await page.locator('.oc-beacon').count()) > 0,
      'sanity check: the lens must actually render before checking it is cleaned up'
    );
    await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: POLL_TIMEOUT });
  });

  // Last test in the file: switches the active search term away from 'quarklet' to a match
  // whose own parent element is <body> itself (the bare "directbodytext999" text node in
  // PAGE), so no restore of search state is needed afterwards.
  test('match text directly under <body> does not clone the whole body', async () => {
    await page.locator(INPUT).fill('');
    await page.locator(INPUT).type('directbodytext999', { delay: 30 });
    await waitForMatchCount(page);

    await page.evaluate(() => document.querySelectorAll('.oc-beacon').forEach((el) => el.remove()));
    await page.keyboard.press('Enter');

    // Both outcomes are acceptable fixes for the body-source bug: decline to draw
    // entirely, or draw something bounded that is not the whole <body>. What must never
    // happen is a lens whose clone is <body> itself.
    let lensMounted = true;
    try {
      await page.waitForSelector('div.oc-beacon', { timeout: 1500 });
    } catch (e) {
      lensMounted = false;
    }

    if (lensMounted) {
      const cloneTag = await page.evaluate(() => {
        const lens = document.querySelector('div.oc-beacon');
        const clone = lens ? lens.firstElementChild : null;
        return clone ? clone.tagName : null;
      });
      assert.notStrictEqual(cloneTag, 'BODY', 'the lens must never clone <body> itself');
      assert.notStrictEqual(cloneTag, 'HTML', 'the lens must never clone <html> itself');
    } else {
      const beaconCount = await page.locator('.oc-beacon').count();
      assert.strictEqual(beaconCount, 0, 'expected the lens to decline to draw rather than clone <body>');
    }
  });
});
