// Usage: node scripts/screenshots.js
// Captures 5 store screenshots at 1280×800 into repo/screenshots/ (Chrome Web Store's
// hard cap). Order is chosen for store conversion: (1) core interaction, (2) the
// multi-term chip list — the headline v1.7.0 feature — with its dim/active highlight
// treatment visible, (3) a new v1.7.0 effect, (4) the settings panel, (5) the toolbar
// popup's vision-profile picker composited over a styled page.
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

// Beacon effects mount .oc-beacon elements on documentElement and remove them a moment
// after their animation ends, so a shot taken too early catches streaks or a half-faded
// spotlight vignette across the page.
//
// Ask the Web Animations API directly rather than watching the element count: Spotlight
// holds a constant two elements for its whole 2-4s run (longer still under Low Vision's
// "slow" speed), so a "count stopped changing" check reports settled while the effect is
// mid-flight. Waiting for zero elements is no good either — Low Vision's border and match
// label are meant to stay on screen. Running animations is the signal that means what we
// want in both cases.
async function waitForBeaconsToSettle(page, timeoutMs = 15000) {
  await page.waitForTimeout(300); // effects can be scheduled a tick after the keypress
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running')
          .every((a) => {
            const target = a.effect && a.effect.target;
            return !(target && target.classList && target.classList.contains('oc-beacon'));
          }),
      null,
      { timeout: timeoutMs }
    )
    .catch(() => console.warn(`  ! beacon animations still running after ${timeoutMs}ms`));
  await page.waitForTimeout(500); // effects clear their elements on a short timeout after
}

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

  // 02 — the v1.7.0 headline feature: a multi-term chip list with the dim/active
  // highlight treatment visible on the page. Each term is committed as its own chip by
  // pressing Enter with different input text; addChipTerm() pushes a new chip only when
  // the input differs from the currently active chip, so the input is cleared between
  // terms exactly like a user retyping the field (Enter never clears it on its own).
  // The last term committed lands as the active chip — its matches get the bright
  // active-color highlight while the earlier two terms fall back to the dimmed
  // oculist-dim-match treatment, which is the contrast this screenshot exists to sell.
  await page.locator(INPUT).type('browser', { delay: 60 });
  await page.keyboard.press('Enter');
  await waitForBeaconsToSettle(page);
  await page.locator(INPUT).fill('');
  await page.locator(INPUT).type('web', { delay: 60 });
  await page.keyboard.press('Enter');
  await waitForBeaconsToSettle(page);
  await page.locator(INPUT).fill('');
  await page.locator(INPUT).type('history', { delay: 60 });
  await page.keyboard.press('Enter');
  await waitForBeaconsToSettle(page);
  await page.screenshot({ path: `${OUT}/02-multi-term-list.png` });

  // 03 — beacon mid-animation, showcasing a new v1.7.0 effect (Chrono Tunnel) in blue
  // color. The input still holds 'history', matching the active chip from step 02, so
  // this Enter takes the plain next-match path (findNext) rather than committing another
  // chip — exactly what re-fires the beacon under the newly selected effect.
  await page.locator(GEAR).click();
  await page.waitForTimeout(300);
  await page.locator('#oc-wrap >> text=Chrono Tunnel').first().click();
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
  await page.screenshot({ path: `${OUT}/03-beacon-chrono-tunnel.png` });

  // 04 — settings panel open. This one is about the panel, so the page behind it must be
  // quiet: let the Chrono Tunnel beacon fired above finish before opening the gear, or
  // its streaks are still crossing the page underneath.
  await waitForBeaconsToSettle(page);
  await page.locator(GEAR).click();
  await page.waitForSelector('#oc-wrap >> #oc-settings-panel', { timeout: 5000 });
  await page.waitForTimeout(600); // panel open animation
  await page.screenshot({ path: `${OUT}/04-settings.png` });
  await page.locator(GEAR).click(); // close settings before the popup section below
  await page.waitForTimeout(200);

  // 05 — vision accessibility profiles. These live in the toolbar popup, not the
  // in-page gear panel, so this one is composited: the popup is only 320px wide and
  // a store screenshot must be exactly 1280×800. Shoot both, then lay the popup over
  // a page backdrop in a throwaway page and shoot that.
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];

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

  // The backdrop is shot AFTER the profile lands, not before — otherwise the popup
  // advertises Low Vision over a page rendered with default settings. The storage
  // listener re-injects styles but does not re-run the search, so retype the term to
  // repaint matches with thick outlines and count labels. Then wait out the beacon:
  // its animation is transient, the outlines and labels are what the profile is
  // actually selling, and a settled frame captures them deterministically.
  await page.bringToFront();
  await page.waitForTimeout(500);
  await page.locator(INPUT).fill('');
  await page.locator(INPUT).type('browser', { delay: 30 });
  await page.waitForTimeout(600);
  // Enter is what draws the thick border and the "Match #n of m" label — they hang off
  // the beacon draw cycle, not the highlight pass. Both fade in with fill:'forwards' and
  // persist until the next search, so settling leaves the durable overlays on screen with
  // the transient beacon (animationSpeed is 'slow' under this profile) already gone.
  await page.keyboard.press('Enter');
  await waitForBeaconsToSettle(page);
  await page.waitForTimeout(400); // let the border/label fade-in finish
  const backdrop = (await page.screenshot()).toString('base64');

  const composite = await ctx.newPage();
  await composite.setViewportSize({ width: 1280, height: 800 });
  await composite.setContent(`
    <style>
      html,body { margin:0; padding:0; width:1280px; height:800px; overflow:hidden; }
      .bg { position:absolute; inset:0; width:1280px; height:800px; }
      /* No dim layer over the backdrop. It made the popup pop, but in a shot whose whole
         subject is the Low Vision profile it read as a product behaviour — as if picking
         that profile greys the page out. The popup is dark on a light page and carries its
         own shadow, so it separates fine on its own. */
      .popup {
        position:absolute; top:16px; right:24px; width:320px;
        border-radius:10px; box-shadow:0 18px 50px rgba(0,0,0,0.55);
      }
    </style>
    <img class="bg" src="data:image/png;base64,${backdrop}">
    <img class="popup" src="data:image/png;base64,${popupShot}">
  `);
  await composite.waitForTimeout(400);
  await composite.screenshot({ path: `${OUT}/05-vision-profiles.png` });

  await ctx.close();
  console.log(`Screenshots written to ${OUT}`);
})();
