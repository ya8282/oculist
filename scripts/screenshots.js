// Usage: node scripts/screenshots.js
// Captures 6 store screenshots at 1280×800 into repo/screenshots/.
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
    // channel:'chromium' is load-bearing — Playwright's default bundled browser is the
    // headless *shell*, which silently loads no extensions at all, so every selector
    // below times out. The full Chromium build loads them fine headless.
    channel: 'chromium',
    headless: true,
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
  // Press Ctrl+F for real rather than dispatching a synthetic KeyboardEvent — it is
  // what a user does, and it works the same headed or headless.
  await page.keyboard.press('Control+f');
  await page.waitForSelector(INPUT, { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01-find-bar.png` });

  // 02 — matches highlighted while typing
  await page.locator(INPUT).type('browser', { delay: 60 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/02-matches.png` });

  // 03 — beacon mid-animation (Warp Drive effect in blue color)
  await page.locator(GEAR).click();
  await page.waitForTimeout(300);
  await page.locator('#oc-wrap >> text=Warp Drive').first().click();
  await page.waitForTimeout(200);

  // Change beacon color to a vibrant blue
  const beaconInput = page.locator('#oc-wrap >> .oc-color-badge:has-text("Beacon") >> .oc-color-input');
  await beaconInput.evaluate((el) => {
    el.value = '#3b82f6';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);

  await page.locator(GEAR).click(); // Close options
  await page.waitForTimeout(300);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(380);
  await page.screenshot({ path: `${OUT}/03-beacon-warp.png` });

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

  // 06 — vision accessibility profiles. These live in the toolbar popup, not the
  // in-page gear panel, so this one is composited: the popup is only 320px wide and
  // a store screenshot must be exactly 1280×800. Shoot both, then lay the popup over
  // a page backdrop in a throwaway page and shoot that.
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];

  const backdrop = (await page.screenshot()).toString('base64');

  const popupPage = await ctx.newPage();
  await popupPage.setViewportSize({ width: 320, height: 700 });
  await popupPage.goto(`chrome-extension://${extId}/popup.html`);
  await popupPage.waitForSelector('#vision-profile');
  await popupPage.selectOption('#vision-profile', 'low-vision');
  await popupPage.locator('#configure-drawer').evaluate((el) => { el.open = true; });
  await popupPage.waitForTimeout(500);
  // Viewport-sized, not fullPage: the drawer is taller than 800px and a fullPage shot
  // gets clipped by the canvas. 700px fits under the 16px top offset.
  const popupShot = (await popupPage.screenshot()).toString('base64');
  await popupPage.close();

  const composite = await ctx.newPage();
  await composite.setViewportSize({ width: 1280, height: 800 });
  await composite.setContent(`
    <style>
      html,body { margin:0; padding:0; width:1280px; height:800px; overflow:hidden; }
      .bg { position:absolute; inset:0; width:1280px; height:800px; }
      .dim { position:absolute; inset:0; background:rgba(9,9,11,0.45); }
      .popup {
        position:absolute; top:16px; right:24px; width:320px;
        border-radius:10px; box-shadow:0 18px 50px rgba(0,0,0,0.55);
      }
    </style>
    <img class="bg" src="data:image/png;base64,${backdrop}">
    <div class="dim"></div>
    <img class="popup" src="data:image/png;base64,${popupShot}">
  `);
  await composite.waitForTimeout(400);
  await composite.screenshot({ path: `${OUT}/06-vision-profiles.png` });

  await ctx.close();
  console.log(`Screenshots written to ${OUT}`);
})();
