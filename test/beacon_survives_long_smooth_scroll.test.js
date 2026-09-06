// Regression (oculist-z8n): a beacon drawn after a long auto-scroll used to fade almost
// immediately, well before its intended lifetime.
//
// highlightActiveRange() (content.js) calls triggerAutoScrollFlag() before it starts an
// out-of-viewport navigation's scrollIntoView(), which sets isAutoScrolling for a flat
// 800ms so handleScroll() ignores the scroll events that scrollIntoView() itself generates.
// Chrome's native smooth scroll can run well past 800ms on an ordinary distance (the bead
// measured 1034ms at 3000px and 1546ms at 12000px), so on a long enough scroll the
// suppression window closes while the browser is still animating, the extension's own
// trailing 'scroll' events reach handleScroll() with isAutoScrolling already false, and
// fadeActiveBeacons() dissolves the beacon that highlightActiveRange() only just drew.
//
// This test uses a match far enough below the fold (20000px) that the native smooth scroll
// reliably outlasts 800ms, and asserts the drawn beacon is still alive (attached, non-zero
// opacity) most of the way through its own intended ~2100ms lifetime (the default 'hud'
// effect's own self-removal timer — see animateAnimeLaser in content.js) rather than having
// been faded within a second or so of appearing.
//
// Needs a real browser for the same reason as the other scroll-timing tests in this suite:
// real layout/scrolling, native 'scrollend', and the WAAPI-driven beacon effect don't exist
// in jsdom.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { POLL_TIMEOUT, LONG_TIMEOUT, TIMEOUT_SCALE } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');

// 20000px of filler well past the bead's own measured 12000px/1546ms data point, so the
// native smooth scrollIntoView animation has plenty of margin to outlast the 800ms
// suppression window regardless of machine speed.
// "zephyrite" sits at a moderate 4000px — far enough to take the smooth-scroll branch (and
// engage triggerAutoScrollFlag/isAutoScrolling) but close enough that the native scroll
// finishes with plenty of the beacon's own ~2100ms lifetime left over, so a genuine
// subsequent user scroll's fade can be told apart from the beacon's own natural expiry.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>body { margin: 0; font: 16px/1.6 system-ui, sans-serif; padding: 40px; }</style>
<div style="height:4000px"></div>
<p id="moderate">zephyrite</p>
<div style="height:16000px"></div>
<p id="target">quarklet</p>
<div style="height:2000px"></div>`;

const INPUT = '#oc-wrap >> .oc-input';

describe('a beacon drawn after a long smooth scroll survives its full intended lifetime (oculist-z8n)', () => {
  let server, ctx, page, origin;

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
    await page.goto(origin);
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

  // Arms a MutationObserver that records performance.now() and a handle to the element the
  // first time a `.oc-beacon-transient` (the beacon effect itself, not any persistent
  // accessibility overlay) is appended to the document — content.js appends it directly to
  // document.documentElement, in the page's main world, so this is observable without a CDP
  // isolated-context eval.
  async function armBeaconAppearanceProbe() {
    await page.evaluate(() => {
      window.__ocBeaconAppearedAt = null;
      window.__ocBeaconEl = null;
      if (window.__ocBeaconObserver) window.__ocBeaconObserver.disconnect();
      window.__ocBeaconObserver = new MutationObserver((records) => {
        if (window.__ocBeaconAppearedAt) return;
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType === 1 && n.classList && n.classList.contains('oc-beacon-transient')) {
              window.__ocBeaconAppearedAt = performance.now();
              window.__ocBeaconEl = n;
              return;
            }
          }
        }
      });
      window.__ocBeaconObserver.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  async function waitForBeaconAppearance() {
    await page.waitForFunction(() => window.__ocBeaconAppearedAt !== null, null, { timeout: LONG_TIMEOUT });
    return page.evaluate(() => window.__ocBeaconAppearedAt);
  }

  // True if the beacon element recorded by the probe above is still attached with a
  // non-zero rendered opacity. fadeActiveBeacons() sets `.oc-beacon-transient` elements'
  // inline opacity to '0' the instant a scroll fades them (and detaches them ~50ms later),
  // so this is the direct signal for "has this beacon been faded/removed".
  async function beaconStillAlive() {
    return page.evaluate(() => {
      const el = window.__ocBeaconEl;
      return !!el && el.isConnected && parseFloat(getComputedStyle(el).opacity) > 0;
    });
  }

  // Polls window.scrollY until it has stopped changing for QUIET_MS — used to wait out both
  // the native smooth-scroll animation itself and (the guard under test) the grace period
  // the fixed isAutoScrolling suppression now runs for after the last real 'scroll' event,
  // so the genuine wheel scroll fired afterward is unambiguously a *new*, separate scroll
  // rather than a continuation of the auto-scroll.
  async function waitForScrollToSettle() {
    const QUIET_MS = 500;
    const deadline = Date.now() + LONG_TIMEOUT;
    let lastY = null;
    let lastChangeAt = Date.now();
    for (;;) {
      const y = await page.evaluate(() => window.scrollY);
      if (y !== lastY) {
        lastY = y;
        lastChangeAt = Date.now();
      }
      if (Date.now() - lastChangeAt > QUIET_MS) return;
      if (Date.now() > deadline) throw new Error('scroll position never settled');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  test('beacon fired by a long out-of-viewport navigation is still alive near the end of its own ~2100ms lifetime', async () => {
    await openFinder();
    await armBeaconAppearanceProbe();

    await page.locator(INPUT).fill('quarklet');
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    // Commits the typed term as a chip and navigates to the only match, 20000px below the
    // fold — this takes highlightActiveRange()'s smooth-scroll branch and calls
    // triggerAutoScrollFlag() before scrollIntoView({behavior:'smooth'}) starts a long
    // native scroll animation.
    await page.keyboard.press('Enter');

    const appearedAt = await waitForBeaconAppearance();

    // Default 'hud' effect (animateAnimeLaser) self-removes at getBeaconDuration(2100) after
    // it was appended — i.e. ~2100ms after appearedAt at the default 'normal' animation
    // speed. Check at appearedAt + 1900ms: comfortably inside the beacon's own intended
    // lifetime, and comfortably past the ~800-900ms mark where the pre-fix suppression
    // window closes mid-scroll and the extension's own trailing scroll events fade it.
    //
    // checkAt is a deadline sitting inside the beacon's real-wall-clock 2100ms lifetime, not a
    // timeout — it must NOT scale with OCULIST_TEST_TIMEOUT_SCALE (scaling it risks pushing the
    // check past the beacon's own expiry). Only the outer poll budget below is allowed to grow.
    //
    // performance.now() and the aliveness check are read in a single in-page evaluation once
    // the deadline is reached, rather than polling via repeated Node<->page round trips and then
    // making a *second* round trip to check aliveness — that combination was measured eating
    // most of the ~200ms nominal headroom below getBeaconDuration(2100), leaving only ~140-170ms.
    const checkAt = appearedAt + 1900;
    const aliveAtDeadline = await page.waitForFunction(
      (deadline) => {
        if (performance.now() < deadline) return undefined;
        const el = window.__ocBeaconEl;
        return { alive: !!el && el.isConnected && parseFloat(getComputedStyle(el).opacity) > 0 };
      },
      checkAt,
      { timeout: LONG_TIMEOUT, polling: 30 }
    );

    assert.ok(
      (await aliveAtDeadline.jsonValue()).alive,
      'the beacon drawn for a match reached via a long smooth scroll must survive most of its ' +
        'own ~2100ms intended lifetime, not fade shortly after appearing once the fixed 800ms ' +
        'auto-scroll suppression window closes mid-scroll'
    );
  });

  // Guards the other direction: extending the auto-scroll suppression to survive a long
  // scroll must not leave it stuck on forever. Once the auto-scroll genuinely settles (the
  // grace period in extendAutoScrollFlag/clearAutoScrollFlag, content.js, has run out), a
  // real subsequent user scroll must still fade the beacon exactly as it always has.
  test('once the auto-scroll settles, a genuine subsequent user scroll still fades the beacon', async () => {
    await page.goto(origin); // fresh load: resets scrollY to 0 and the overlay state.
    await openFinder();
    await armBeaconAppearanceProbe();

    await page.locator(INPUT).fill('zephyrite');
    await page.waitForFunction(
      () => {
        const root = document.getElementById('oc-wrap');
        const count = root && root.shadowRoot ? root.shadowRoot.querySelector('.oc-count') : null;
        return !!count && /of \d+/.test(count.textContent);
      },
      null,
      { timeout: POLL_TIMEOUT }
    );

    // Navigates to the moderate-distance match — out of view, so this also takes the
    // smooth-scroll branch and engages triggerAutoScrollFlag/isAutoScrolling.
    await page.keyboard.press('Enter');
    await waitForBeaconAppearance();
    assert.ok(await beaconStillAlive(), 'sanity check: expected the beacon to be drawn and alive right after appearing');

    // Wait out both the native scroll animation and the suppression's own grace period so
    // the wheel scroll below is unambiguously a fresh, separate, genuine user scroll.
    await waitForScrollToSettle();

    await page.mouse.wheel(0, 400);

    // fadeActiveBeacons() sets the beacon's inline style.opacity to '0' synchronously,
    // inside the same scroll-handler task that decides to fade it — well under 100ms after
    // the wheel event, long before the beacon's own natural ~2100ms self-removal timer could
    // fire. Asserting on the inline style specifically (not isConnected, and not computed
    // opacity, which only reaches 0 after fadeActiveBeacons' own 50ms transition) with a
    // short timeout distinguishes "the scroll actually faded it" from "it happened to expire
    // on its own schedule around the same time" — a stuck-forever isAutoScrolling bug would
    // leave this false until the natural ~2100ms timer just removes the element outright,
    // never setting style.opacity along the way.
    await page.waitForFunction(
      () => {
        const el = window.__ocBeaconEl;
        return !!el && el.style.opacity === '0';
      },
      null,
      { timeout: 600 * TIMEOUT_SCALE }
    );
  });
});
