// oculist-h1ns: the beacon must be drawn once the WHOLE navigation scroll has settled, not at
// the first relevant scrollend (nested window + inner scroller, slotted shadow scroller, mid-scroll
// layout shift), and a user wheel/key interrupting the smooth scroll draws no beacon.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForCondition, POLL_TIMEOUT } = require('./helpers/wait');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const TOLERANCE = 20; // one 18px line plus rounding slack
const TERM = 'zqxjvmarker';

const lines = (n, at) => Array.from({ length: n }, (_, i) => 'line ' + i + (i === at ? ' ' + TERM : ''));
const STYLE = '<style>body{margin:0}pre{margin:0;font:14px/18px monospace}#c{height:300px;overflow:auto;border:0}</style>';
const PAGES = {
  nested: `<!doctype html>${STYLE}<div style="height:2000px"></div><div id=c><pre>${lines(400, 300).join('\n')}</pre></div><div style="height:4000px"></div>`,
  // Short spacer: the inner scroller settles with the match already visible while the window still moves.
  nestedShort: `<!doctype html>${STYLE}<div style="height:900px"></div><div id=c><pre>${lines(400, 10).join('\n')}</pre></div><div style="height:4000px"></div>`,
  slot: `<!doctype html>${STYLE}<div style="height:2000px"></div><script>customElements.define('x-s',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<div style="height:300px;overflow:auto"><slot></slot></div>'}})</script><x-s><pre>${lines(400, 300).join('\n')}</pre></x-s><div style="height:4000px"></div>`,
  shift: `<!doctype html>${STYLE}<pre id=p>${lines(300, 150).join('\n')}</pre>`,
  area: `<!doctype html>${STYLE}<textarea id=t rows=3></textarea><pre id=p>${lines(400, 300).join('\n')}</pre>`,
  // oculist-u6x3: match in a fixed element clipped by the viewport bottom; the page scrolls itself.
  fixedClipped: `<!doctype html>${STYLE}<div id=f style="position:fixed;left:0;top:785px;height:40px;font:14px/18px monospace">${TERM}</div><pre id=p>${lines(300, 150).join('\n')}</pre>`,
  wide: `<!doctype html>${STYLE}<div style="width:4000px;height:1px"></div><pre id=p>${lines(400, 300).join('\n')}</pre>`,
  // oculist-7ki8: focusable controls above the match; the navigation scrolls them off-screen.
  controls: `<!doctype html>${STYLE}<input id=n type=number value=5><input id=r type=range><input id=d type=date><input id=cb type=checkbox><input id=em type=email value="hello"><input type=radio name=g id=r1><input id=btn type=button value=b><input id=rod type=date readonly><input id=ron type=number value=5 readonly><select id=s><option>a<option>b<option>c</select><pre id=p>${lines(400, 300).join('\n')}</pre>`,
  hscroll: `<!doctype html>${STYLE}<div id=h tabindex=0 style="width:300px;height:30px;overflow-x:auto;white-space:nowrap"><div style="width:2000px">x</div></div><pre id=p>${lines(400, 300).join('\n')}</pre>`,
  areaScrolled: `<!doctype html>${STYLE}<textarea id=t rows=3></textarea><pre id=p>${lines(400, 300).join('\n')}</pre>`,
  oneline: `<!doctype html>${STYLE}<textarea id=t rows=3>abcd</textarea><pre id=p>${lines(400, 300).join('\n')}</pre>`,
  // oculist-wnn3: one logical line (no newline) that soft-wraps to several visual lines in a 3-row textarea.
  softwrap: `<!doctype html>${STYLE}<textarea id=t rows=3 cols=20>${Array.from({ length: 60 }, () => 'word').join(' ')}</textarea><pre id=p>${lines(400, 300).join('\n')}</pre>`,
  caretarea: `<!doctype html>${STYLE}<textarea id=t rows=3>${Array.from({ length: 40 }, () => 'abcd').join('\n')}</textarea><pre id=p>${lines(400, 300).join('\n')}</pre>`,
  wheel: `<!doctype html>${STYLE}<pre id=p>${lines(400, 300).join('\n')}</pre>`,
};

describe('beacon waits for the whole navigation scroll (oculist-h1ns)', () => {
  let server, ctx, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES[req.url.slice(1)] || '');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}/`;
    ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function open(name) {
    const page = await ctx.newPage();
    await page.goto(origin + name);
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.keyboard.press('Control+f');
      try {
        await page.waitForSelector(INPUT, { timeout: 250 });
        break;
      } catch (e) {
        // keep retrying
      }
    }
    await page.waitForSelector(INPUT, { timeout: POLL_TIMEOUT });
    await page.evaluate(() => {
      window.__beacon = null;
      new MutationObserver((records) => {
        if (window.__beacon) return;
        for (const r of records) for (const n of r.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('oc-beacon-transient')) {
            const b = n.getBoundingClientRect();
            window.__beacon = { mid: b.top + b.height / 2 };
            return;
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
    return page;
  }

  const matchOnScreen = (page) => page.evaluate(() => {
    const r = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });

  // Beacon mid must be within a line of the active match once everything has stopped moving.
  async function assertBeaconAtSettledMatch(page, requireOnScreen = true) {
    await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
    const sample = () => page.evaluate(() => {
      const r = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
      return Math.round(r.top + window.scrollY);
    });
    let prev = -1, stable = 0;
    await waitForCondition(async () => {
      const y = await sample();
      stable = y === prev ? stable + 1 : 0;
      prev = y;
      return stable >= 6;
    }, Boolean, { timeout: POLL_TIMEOUT, interval: 100, message: 'layout never settled' });
    await new Promise((r) => setTimeout(r, 1200));
    const { beacon, settled } = await page.evaluate(() => {
      const r = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
      return { beacon: window.__beacon.mid, settled: r.top + r.height / 2 };
    });
    assert.ok(Math.abs(beacon - settled) <= TOLERANCE, `beacon at ${beacon}, match settled at ${settled}`);
    if (requireOnScreen) assert.ok(await matchOnScreen(page), 'match is off-screen after the navigation');
  }

  for (const name of ['nested', 'nestedShort', 'slot']) {
    test(name + ': window scroll plus inner scroller draws at the settled match', async () => {
      const page = await open(name);
      try {
        await page.fill(INPUT, TERM);
        await page.keyboard.press('Enter');
        await assertBeaconAtSettledMatch(page);
      } finally {
        await page.close();
      }
    });
  }

  test('layout shift mid-scroll still ends with the match on screen and the beacon on it', async () => {
    const page = await open('shift');
    try {
      await page.evaluate(() => {
        window.addEventListener('scroll', () => {
          if (window.__shifted) return;
          window.__shifted = true;
          setTimeout(() => {
            const d = document.createElement('div');
            d.style.height = '600px';
            document.body.insertBefore(d, document.getElementById('p'));
          }, 200);
        }, { once: false });
      });
      await page.fill(INPUT, TERM);
      await page.keyboard.press('Enter');
      await assertBeaconAtSettledMatch(page);
      const onScreen = await page.evaluate(() => {
        const r = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      assert.ok(onScreen, 'match is off-screen after the navigation');
    } finally {
      await page.close();
    }
  });

  // oculist-88su: the wheel row has no scroll bound on purpose. Chromium (headless, shell and headed) delivers the wheel event
  // to the page mid-scroll (scrollY ~100-1500) but does not let it cancel a programmatic smooth scroll: with
  // the extension unloaded, a page's own scrollTo({behavior:'smooth'}) also runs on to its target under
  // mouse.wheel (-100, -3000, repeated), CDP dispatchMouseEvent mouseWheel and synthesizeScrollGesture, while PageUp does stop it. So the page ending at the match
  // (~5009) is browser behaviour, not the extension resuming the scroll. The row's only checkable effect is
  // the extension's interrupt handler, which the beacon-null assertion covers.
  const refocusNothing = (page) => page.evaluate(() => document.activeElement.blur());
  for (const [label, interrupt, bound] of [
    ['wheel', (page) => page.mouse.wheel(0, -100)],
    ['PageDown', (page) => refocusNothing(page).then(() => page.keyboard.press('PageDown')), { min: (y0) => y0 + 400, max: 3000 }],
    ['PageDown with focus in the find input', (page) => page.keyboard.press('PageDown'), { min: (y0) => y0 + 400, max: 3000 }],
    ['End with focus in the find input', (page) => page.keyboard.press('End'), { min: () => 5500 }],
  ]) {
    test('a user ' + label + ' interrupting the smooth scroll draws no beacon and keeps the highlight', async () => {
      const page = await open('wheel');
      try {
        await page.fill(INPUT, TERM);
        await page.mouse.move(400, 400);
        await page.keyboard.press('Enter');
        await new Promise((r) => setTimeout(r, 200));
        const y0 = await page.evaluate(() => window.scrollY);
        await interrupt(page);
        await new Promise((r) => setTimeout(r, 2500));
        const res = await page.evaluate(() => ({
          beacon: window.__beacon,
          active: CSS.highlights.has('oculist-active-match'),
          scrolled: window.scrollY,
        }));
        assert.ok(res.scrolled > 0, 'premise: the navigation scroll never started');
        assert.strictEqual(res.beacon, null, 'beacon was drawn for an interrupted navigation');
        assert.ok(res.active, 'active highlight was dropped');
        // Measured: honoured PageDown ends ~860-1360, End 6400 (page bottom); a pull-back to the match ends ~5009.
        if (bound) {
          assert.ok(res.scrolled >= bound.min(y0), `page ended at ${res.scrolled}, key was sent at ${y0}: key not honoured`);
          if (bound.max) assert.ok(res.scrolled < bound.max, `page ended at ${res.scrolled}: navigation pulled it back to the match (~5009)`);
        }
      } finally {
        await page.close();
      }
    });
  }

  test('a scroll key in a page textarea interrupting the smooth scroll draws no beacon', async () => {
    const page = await open('area');
    try {
      await page.fill(INPUT, TERM);
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 200));
      await page.evaluate(() => document.getElementById('t').focus({ preventScroll: true }));
      await page.keyboard.press('PageDown');
      await new Promise((r) => setTimeout(r, 2500));
      assert.strictEqual(await page.evaluate(() => window.__beacon), null, 'beacon was drawn for an interrupted navigation');
    } finally {
      await page.close();
    }
  });

  for (const key of ['ArrowLeft', 'ArrowDown', 'Space']) {
    test(key + ' typed in the find input mid-navigation still draws the beacon at the match', async () => {
      const page = await open('wheel');
      try {
        await page.fill(INPUT, TERM);
        await page.keyboard.press('Enter');
        await new Promise((r) => setTimeout(r, 200));
        await page.keyboard.press(key);
        await assertBeaconAtSettledMatch(page);
      } finally {
        await page.close();
      }
    });
  }

  // oculist-o639: keys that do not scroll the page (no horizontal overflow, caret moves in an
  // empty textarea) are not a takeover; Cmd+G/F3 navigate with focus outside the find input.
  const offInput = (page) => page.evaluate(() => document.activeElement.blur());
  const focusId = (id) => (page) => page.evaluate((i) => document.getElementById(i).focus({ preventScroll: true }), id);
  // The key's scroll races the smooth navigation scroll, so a takeover row only checks that the
  // navigation ran and drew nothing; the controls start scrolled off-screen so the key sees them off-screen.
  // The navigation only scrolls down toward the match, so a scroll back up after the keydown is the key revealing the textarea.
  const focusRecordingReveal = (page) => page.evaluate(() => {
    document.getElementById('t').focus({ preventScroll: true });
    window.__revealed = false;
    let down = null;
    window.addEventListener('keydown', () => { down = scrollY; }, true);
    window.addEventListener('scroll', () => { if (down !== null && scrollY < down) window.__revealed = true; }, true);
  });
  const revealed = (page) => page.evaluate(() => window.__revealed === true);
  const caretAt = (n) => (page) => page.evaluate((c) => {
    const t = document.getElementById('t');
    t.focus({ preventScroll: true });
    t.setSelectionRange(c < 0 ? t.value.length + c + 1 : c, c < 0 ? t.value.length + c + 1 : c);
    window.__revealed = false;
    let down = null;
    window.addEventListener('keydown', () => { down = scrollY; }, true);
    window.addEventListener('scroll', () => { if (down !== null && scrollY < down) window.__revealed = true; }, true);
  }, n);
  const navigated = (page) => page.evaluate(() => CSS.highlights.has('oculist-active-match'));
  const START = { controls: 1500, caretarea: 1500, areaScrolled: 1500, oneline: 1500, softwrap: 1500 };
  for (const [label, name, focus, key, takeover, premise, offScreenOk] of [
    ['ArrowRight with body focus on a page with no horizontal overflow', 'wheel', offInput, 'ArrowRight', false],
    ['ArrowLeft with body focus on a page with no horizontal overflow', 'wheel', offInput, 'ArrowLeft', false],
    // oculist-1ihf: an arrow in an off-screen empty textarea scrolls the page back to reveal it: a takeover
    ['ArrowDown in an empty page textarea', 'areaScrolled', focusRecordingReveal, 'ArrowDown', true, revealed],
    ['ArrowUp in an empty page textarea with the page scrolled down', 'areaScrolled', focusRecordingReveal, 'ArrowUp', true, revealed],
    ['ArrowDown in an off-screen one-line textarea with the caret at the end', 'oneline', (page) => page.evaluate(() => { const t = document.getElementById('t'); t.focus({ preventScroll: true }); t.setSelectionRange(4, 4); }), 'ArrowDown', false],
    ['ArrowUp in an off-screen textarea with the caret at 0', 'caretarea', (page) => page.evaluate(() => { const t = document.getElementById('t'); t.focus({ preventScroll: true }); t.setSelectionRange(0, 0); }), 'ArrowUp', false],
    // oculist-wnn3: measured chromium+webkit: on a soft-wrapped single logical line the browser moves the caret
    // (and reveals the textarea) exactly when it is not at 0 (Up) / the end (Down), whatever visual line it is on
    ['ArrowUp in a soft-wrapped textarea with the caret at 0', 'softwrap', caretAt(0), 'ArrowUp', false],
    ['ArrowDown in a soft-wrapped textarea with the caret at the end', 'softwrap', caretAt(-1), 'ArrowDown', false],
    ['ArrowUp in a soft-wrapped textarea with the caret on a middle visual line', 'softwrap', caretAt(120), 'ArrowUp', true, revealed],
    ['ArrowDown in a soft-wrapped textarea with the caret on a middle visual line', 'softwrap', caretAt(120), 'ArrowDown', true, revealed],
    ['ArrowUp in a soft-wrapped textarea with the caret on the first visual line but not at 0', 'softwrap', caretAt(5), 'ArrowUp', true, revealed],
    ['ArrowDown in a soft-wrapped textarea with the caret on the last visual line but not at the end', 'softwrap', caretAt(-4), 'ArrowDown', true, revealed],
    ['ArrowRight in an empty page textarea', 'area', focusId('t'), 'ArrowRight', false],
    ['ArrowRight with body focus on a page that overflows horizontally', 'wide', offInput, 'ArrowRight', true, async (page) => (await page.evaluate(() => window.scrollX)) > 0],
    // oculist-7ki8: exemptions per key and type
    ...['ArrowUp', 'ArrowDown'].map((k) => [k + ' in an off-screen number input', 'controls', focusId('n'), k, false]),
    ...['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map((k) => [k + ' in an off-screen range input', 'controls', focusId('r'), k, false]),
    ...['ArrowUp', 'ArrowDown'].map((k) => [k + ' in an off-screen date input', 'controls', focusId('d'), k, false]),
    ['Space on an off-screen checkbox', 'controls', focusId('cb'), 'Space', false],
    ['Space on an off-screen radio', 'controls', focusId('r1'), 'Space', false],
    ['Space on an off-screen button', 'controls', focusId('btn'), 'Space', false],
    ['ArrowDown on a focused select', 'controls', focusId('s'), 'ArrowDown', false],
    ['ArrowUp on a focused select', 'controls', focusId('s'), 'ArrowUp', false],
    ['ArrowRight on a horizontal scroller already at max scrollLeft', 'hscroll', (page) => page.evaluate(() => { const h = document.getElementById('h'); h.scrollLeft = 1e5; h.focus({ preventScroll: true }); }), 'ArrowRight', false],
    ['ArrowLeft on a horizontal scroller already at scrollLeft 0', 'hscroll', focusId('h'), 'ArrowLeft', false],
    // must still cancel: the key scrolls the page
    ['ArrowRight on a horizontal scroller with room to scroll', 'hscroll', focusId('h'), 'ArrowRight', true, (page) => page.evaluate(() => document.getElementById('h').scrollLeft > 0)],
    ...['ArrowRight', 'Space'].map((k) => ['' + k + ' in an off-screen number input', 'controls', focusId('n'), k, true, navigated]),
    ['ArrowUp in an off-screen readonly date input', 'controls', focusId('rod'), 'ArrowUp', true, navigated],
    ['ArrowDown in an off-screen readonly number input', 'controls', focusId('ron'), 'ArrowDown', true, navigated],
    ['ArrowRight in an off-screen date input', 'controls', focusId('d'), 'ArrowRight', true, navigated],
    ['Space on an off-screen range input', 'controls', focusId('r'), 'Space', true, navigated],
    ...['ArrowUp', 'ArrowDown'].map((k) => [k + ' on an off-screen checkbox', 'controls', focusId('cb'), k, true, navigated]),
    ['ArrowDown on an off-screen button', 'controls', focusId('btn'), 'ArrowDown', true, navigated],
    ['ArrowDown in an off-screen email input', 'controls', focusId('em'), 'ArrowDown', true, navigated],
    ['ArrowDown in an off-screen textarea with the caret mid-text', 'caretarea', (page) => page.evaluate(() => { const t = document.getElementById('t'); t.focus({ preventScroll: true }); t.setSelectionRange(60, 60); }), 'ArrowDown', true, navigated],
    ['ArrowDown with body focus', 'wheel', offInput, 'ArrowDown', true, navigated],
    ['Space with body focus', 'wheel', offInput, 'Space', true, navigated],
  ]) {
    test(label + (takeover ? ' is a takeover: no beacon' : ' still draws the beacon at the match'), async () => {
      const page = await open(name);
      try {
        await page.fill(INPUT, TERM);
        await focus(page);
        if (START[name]) {
          // scroll after focusing: Chromium ignores preventScroll on some controls (date)
          await page.evaluate((y) => window.scrollTo(0, y), START[name]);
          assert.ok(await page.evaluate(() => document.activeElement.getBoundingClientRect().bottom < 0), 'premise: the focused control is not off-screen above the viewport');
        }
        await page.keyboard.press('F3');
        await new Promise((r) => setTimeout(r, 200));
        await page.keyboard.press(key);
        if (takeover) {
          await new Promise((r) => setTimeout(r, 2500));
          assert.ok(await premise(page), 'premise: the key never scrolled the page');
          assert.strictEqual(await page.evaluate(() => window.__beacon), null, 'beacon was drawn after a real takeover');
        } else {
          await assertBeaconAtSettledMatch(page, !offScreenOk);
        }
      } finally {
        await page.close();
      }
    });
  }

  test('a scroll-anchoring shift with nothing to scroll toward does not delay the beacon to the 3s cap', async () => {
    const page = await open('fixedClipped');
    try {
      await page.evaluate(() => {
        window.scrollTo(0, 500);
        window.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          window.__t0 = Date.now();
          setTimeout(() => {
            const d = document.createElement('div');
            d.style.height = '300px';
            document.body.insertBefore(d, document.getElementById('p'));
          }, 100);
        }, true);
      });
      await page.evaluate(() => new Promise((resolve) => {
        let last = -1, stable = 0;
        const tick = () => {
          stable = window.scrollY === last && last === 500 ? stable + 1 : 0;
          last = window.scrollY;
          stable >= 10 ? resolve() : requestAnimationFrame(tick);
        };
        tick();
      }));
      await page.fill(INPUT, TERM);
      await page.keyboard.press('Enter');
      const t0 = await page.evaluate(() => window.__t0);
      await waitForCondition(() => page.evaluate(() => window.__beacon), Boolean, { timeout: POLL_TIMEOUT, interval: 20, message: 'no beacon drawn' });
      const latency = Date.now() - t0;
      assert.ok(await page.evaluate(() => window.scrollY) > 500, 'premise: the anchoring shift never scrolled the page');
      assert.ok(latency < 1000, `beacon drawn ${latency}ms after Enter`);
    } finally {
      await page.close();
    }
  });

  // oculist-r425: page script cancels the smooth scroll within one frame of Enter (scrollend fires
  // almost at once with the match unmoved); the retry must still bring the match on screen.
  test('a page cancelling the smooth scroll within a frame of Enter still ends on screen with the beacon drawn', async () => {
    const page = await open('wheel');
    try {
      await page.evaluate(() => {
        window.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || window.__cancelled) return;
          window.__cancelled = true;
          requestAnimationFrame(() => window.scrollTo({ top: window.scrollY, behavior: 'instant' }));
        }, true);
      });
      await page.fill(INPUT, TERM);
      await page.keyboard.press('Enter');
      await assertBeaconAtSettledMatch(page);
      const onScreen = await page.evaluate(() => {
        const r = [...CSS.highlights.get('oculist-active-match')][0].getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      assert.ok(onScreen, 'match is off-screen after the navigation');
    } finally {
      await page.close();
    }
  });
});
