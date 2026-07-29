// The shadow host is a width:auto column flex, so its width is whatever its widest child
// needs. Anything that stacks under the find bar — the notice, the settings panel — will
// therefore stretch the whole popover unless it is kept out of that calculation. Both use
// `width: 0; min-width: 100%` for exactly that reason; these tests pin the behaviour down.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');

// The no-match notice only appears on a page with substantial visible text, so pad it out.
const PAGE = `<!doctype html><meta charset="utf-8">
<p style="padding:40px">hello quarklet world.
${'This paragraph exists only to push the visible text length past the threshold that gates the no-match notice. '.repeat(12)}</p>`;

const INPUT = '#oc-wrap >> .oc-input';
const GEAR = '#oc-wrap >> [aria-label="Options"]';

const hostWidth = (page) =>
  page.evaluate(() => document.getElementById('oc-wrap').getBoundingClientRect().width);

describe('Popover keeps the find bar width', () => {
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
      viewport: { width: 1280, height: 800 },
    });
    page = await ctx.newPage();
    await page.goto(origin);
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.waitForTimeout(300);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('opening the settings panel does not widen the popover', async () => {
    const closed = await hostWidth(page);

    await page.locator(GEAR).click();
    await page.waitForSelector('#oc-wrap >> #oc-settings-panel', { timeout: 5000 });
    await page.waitForTimeout(600); // panel open animation

    const open = await hostWidth(page);
    assert.strictEqual(open, closed, `settings panel widened the popover: ${closed} -> ${open}`);

    // A width that collapsed to nothing would also be "unchanged" in spirit but broken;
    // make sure the panel actually laid out inside the bar's width.
    const panel = await page.evaluate(
      () => document.getElementById('oc-wrap').shadowRoot.querySelector('#oc-settings-panel').getBoundingClientRect().width
    );
    assert.ok(panel > closed - 10, `panel should fill the bar width, got ${panel} against ${closed}`);

    await page.locator(GEAR).click(); // close again for the next test
    await page.waitForTimeout(400);
  });

  test('the no-match notice does not widen the popover', async () => {
    const before = await hostWidth(page);

    await page.locator(INPUT).fill('');
    await page.locator(INPUT).type('zzzznotpresentzzzz', { delay: 20 });
    await page.waitForSelector('#oc-wrap >> .oc-notice', { timeout: 5000 });
    await page.waitForTimeout(300);

    const after = await hostWidth(page);
    assert.strictEqual(after, before, `notice widened the popover: ${before} -> ${after}`);

    // The message has to go somewhere — confirm it wrapped instead of being clipped.
    const lines = await page.evaluate(
      () => document.getElementById('oc-wrap').shadowRoot.querySelector('.oc-notice').getBoundingClientRect().height
    );
    assert.ok(lines > 25, `expected the notice text to wrap to multiple lines, height was ${lines}`);
  });
});
