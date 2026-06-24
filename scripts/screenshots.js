// Usage: node scripts/screenshots.js
// Captures 5 store screenshots at 1280×800 into repo/screenshots/.
// ponytail: fixed waitForTimeout for animations — swap for waitForSelector
//           on a stable post-animation element if timing proves flaky.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXTENSION = path.resolve(__dirname, '../extension');
const OUT = path.resolve(__dirname, '../screenshots');

// Playwright pierces open shadow roots with >> css selectors.
// The bar lives inside #oc-wrap's shadow DOM.
const GEAR  = '#oc-wrap >> [aria-label="Options"]';
const INPUT = '#oc-wrap >> .oc-input';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
    ],
    viewport: { width: 1280, height: 800 },
  });

  const page = await ctx.newPage();
  await page.goto('https://en.wikipedia.org/wiki/Web_browser');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // 01 — find bar open on a content-rich page
  // Extension commands live in the browser shell; __ocToggle is in isolated world.
  // Dispatch a synthetic Ctrl+F — DOM events cross JS context boundaries so the
  // content script's capture listener picks it up and opens the overlay.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true
    }));
  });
  await page.waitForSelector(INPUT, { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01-find-bar.png` });

  // 02 — matches highlighted while typing
  await page.locator(INPUT).type('browser', { delay: 60 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/02-matches.png` });

  // 03 — beacon mid-animation (default effect)
  await page.keyboard.press('Enter');
  await page.waitForTimeout(380);
  await page.screenshot({ path: `${OUT}/03-beacon-laser.png` });

  // 04 — settings panel open
  await page.locator(GEAR).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/04-settings.png` });

  // 05 — Spotlight effect beacon for variety
  const spotlightLabel = page.locator('#oc-wrap >> text=Spotlight').first();
  if (await spotlightLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
    await spotlightLabel.click();
    await page.waitForTimeout(200);
  }
  await page.locator(GEAR).click(); // close settings
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(380);
  await page.screenshot({ path: `${OUT}/05-beacon-spotlight.png` });

  await ctx.close();
  console.log(`Screenshots written to ${OUT}`);
})();
