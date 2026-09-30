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

  // Beacon mid must be within a line of the active match once everything has stopped moving.
  async function assertBeaconAtSettledMatch(page) {
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

  const refocusNothing = (page) => page.evaluate(() => document.activeElement.blur());
  for (const [label, interrupt, movesPage] of [
    ['wheel', (page) => page.mouse.wheel(0, -100)],
    ['PageDown', (page) => refocusNothing(page).then(() => page.keyboard.press('PageDown')), true],
    ['PageDown with focus in the find input', (page) => page.keyboard.press('PageDown'), true],
    ['End with focus in the find input', (page) => page.keyboard.press('End'), true],
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
        if (movesPage) assert.ok(res.scrolled >= y0 + 400, `page ended at ${res.scrolled}, key was sent at ${y0}: navigation pulled it back`);
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
});
