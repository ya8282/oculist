// Measured-contrast gating for the dim (inactive-term) highlight treatment (oculist-l6m.17).
//
// oculist-l6m.6 introduced two dim treatments — a 35%-alpha background wash, and a
// full-strength dotted underline — but gated between them on
// settings.visionProfile === 'low-vision'. That missed pale colours entirely: tritanopia's
// match colour (#ffcbd1) is itself near-white, so the wash blends to roughly 1:1 against a
// light page and is effectively invisible. This file verifies the fix: the gate is now the
// ACTUAL measured contrast of the blended dim colour against the page background (WCAG 2.2
// SC 1.4.11, 3:1 non-text minimum), plus an independent prefers-contrast: more trigger — by
// reading the live injected stylesheet and recomputing contrast in the test itself (never
// by calling back into content.js's own contrast functions), so a broken threshold or a
// broken blend would show up here too, not just echo the implementation back at itself.
//
// Needs a real browser for the same reasons as dim_highlight.test.js: the CSS this reads is
// injected into a live page by the content script, and prefers-contrast emulation needs a
// real browser context.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION = path.resolve(__dirname, '../extension');
const INPUT = '#oc-wrap >> .oc-input';
const CHIP_TERM = '#oc-wrap >> .oc-chip-term';

// Sourced directly from popup.js's own PRESETS object (not hand-copied), so this test
// tracks whatever built-in profiles actually exist rather than a list that can drift out of
// sync with the real one.
function loadBuiltInProfiles() {
  const src = fs.readFileSync(path.resolve(__dirname, '../extension/popup.js'), 'utf8');
  const m = /const PRESETS = (\{[\s\S]*?\n  \});/.exec(src);
  assert.ok(m, 'could not locate PRESETS in popup.js — source shape changed, update the extraction regex');
  const PRESETS = new Function('return ' + m[1])();
  return Object.keys(PRESETS);
}

// --- Independent WCAG 2.2 SC 1.4.11 contrast math. Deliberately reimplemented here rather
// than imported from content.js: the point of this test is to catch a broken formula,
// threshold, or blend in the implementation, not to restate it. ---
function relativeLuminance(rgb) {
  const srgb = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}
function contrastRatio(rgbA, rgbB) {
  const lA = relativeLuminance(rgbA);
  const lB = relativeLuminance(rgbB);
  const hi = Math.max(lA, lB);
  const lo = Math.min(lA, lB);
  return (hi + 0.05) / (lo + 0.05);
}
function blend(fgRgb, alpha, bgRgb) {
  return fgRgb.map((v, i) => alpha * v + (1 - alpha) * bgRgb[i]);
}
function hexToRgb(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const n = parseInt(c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function extractRule(css, name) {
  const re = new RegExp('::highlight\\(' + name + '\\)\\s*\\{([^}]*)\\}');
  const m = re.exec(css);
  return m ? m[1] : null;
}

// Reads the two facts each test needs straight from the live injected stylesheet: the raw
// matchColor (from oculist-match, always full-strength/unblended, so it's a reliable source
// for the "what colour is this profile actually using" question) and how oculist-dim-match
// is currently rendering.
function readDimState(css) {
  const matchRule = extractRule(css, 'oculist-match');
  assert.ok(matchRule, 'oculist-match rule missing from injected stylesheet');
  const matchHexM = /background-color:\s*(#[0-9a-fA-F]{3,6})/.exec(matchRule);
  assert.ok(matchHexM, 'could not read matchColor back out of the oculist-match rule');

  const dimRule = extractRule(css, 'oculist-dim-match');
  assert.ok(dimRule, 'oculist-dim-match rule missing from injected stylesheet');

  if (/text-decoration-line/.test(dimRule)) {
    return { matchHex: matchHexM[1], treatment: 'underline' };
  }
  const washM = /background-color:\s*rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(dimRule);
  assert.ok(washM, 'oculist-dim-match rule is neither the underline nor the rgba wash treatment: ' + dimRule);
  return {
    matchHex: matchHexM[1],
    treatment: 'wash',
    rgb: [parseFloat(washM[1]), parseFloat(washM[2]), parseFloat(washM[3])],
    alpha: parseFloat(washM[4]),
  };
}

describe('Dim treatment is gated on measured contrast, not vision profile name (oculist-l6m.17)', () => {
  let server, ctx, page, extId, origin;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url === '/dark') {
        // A near-black page background: the one case where a 35%-alpha wash can still
        // clear a 3:1 non-text contrast minimum (see the "alpha wash survives" test below).
        res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#191919;font:16px/1.6 system-ui,sans-serif;padding:40px;}</style><p>cat cats dog</p>');
      } else if (req.url === '/contrast-light') {
        // A properly accessible light theme: dark text explicitly set on a white background
        // (not relying on UA defaults), so this fixture's own text-vs-background contrast is
        // itself >= 3:1 — the premise oculist-32d's currentColor fix depends on.
        res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#ffffff;color:#111111;font:16px/1.6 system-ui,sans-serif;padding:40px;}</style><p>cat cats dog</p>');
      } else if (req.url === '/contrast-dark') {
        // A properly accessible dark theme: light text explicitly set on a near-black
        // background. Distinct from '/dark' above, which sets only a background colour and
        // relies on the UA default (black) text colour — useless for proving currentColor
        // inherits an accessible page, since that fixture's own text isn't accessible.
        res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0a0a0a;color:#f5f5f5;font:16px/1.6 system-ui,sans-serif;padding:40px;}</style><p>cat cats dog</p>');
      } else if (req.url === '/adaptive') {
        // Two containers with independently-set, opposite text/background colours on the
        // same page: proves text-decoration-color: currentColor resolves PER ELEMENT inside
        // a single global ::highlight() rule, not once for the whole page.
        res.end(
          '<!doctype html><meta charset="utf-8">' +
          '<style>body{margin:0;background:#ffffff;font:16px/1.6 system-ui,sans-serif;}' +
          '#p-light{color:#111111;background:#ffffff;padding:40px;margin:0;}' +
          '#p-dark{color:#eeeeee;background:#111111;padding:40px;margin:0;}</style>' +
          '<p id="p-light">cat dog</p><p id="p-dark">cat dog</p>'
        );
      } else {
        res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px/1.6 system-ui,sans-serif;padding:40px;}</style><p>cat cats dog</p>');
      }
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
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    extId = sw.url().split('/')[2];
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (ctx) await ctx.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function openFinderOn(url) {
    if (page) await page.close().catch(() => {});
    page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.locator(INPUT).fill('cat');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  }

  async function currentCss() {
    return page.evaluate(() => document.getElementById('oc-global-highlight-styles').textContent);
  }

  // oculist-32d: like openFinderOn, but adds a SECOND term and explicitly activates the
  // first one via its chip, so the second term lands in oculist-dim-match instead of
  // oculist-match — needed to have an actual dim-highlighted range to read a rendered
  // colour off of.
  async function openFinderWithDimTermOn(url) {
    if (page) await page.close().catch(() => {});
    page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.locator(INPUT).fill('cat');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.locator(INPUT).fill('dog');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.locator(CHIP_TERM).nth(0).click(); // activate 'cat', leaving 'dog' dim
    await page.waitForTimeout(250);
  }

  // Reads the RENDERED colour the dim underline actually paints text-decoration-color:
  // currentColor with, for the paragraph the dim match lives in. Read straight off
  // getComputedStyle rather than assumed from the fixture's own CSS literal, so this
  // measures what the browser actually resolved, not what the test expects it to resolve to.
  async function readDimRenderedColor(selector) {
    return page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).color, selector || 'p');
  }

  function rgbStringToArray(str) {
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(str);
    assert.ok(m, 'could not parse computed color string: ' + str);
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  }

  // Mirrors the proven-reliable pattern from dim_highlight.test.js's own profile-switch
  // test: a fixed settle window rather than a content diff, because two different built-in
  // profiles can legitimately render byte-identical CSS (e.g. 'none' and 'low-vision' share
  // colorPalette: 'default', so their matchColor/activeColor — and therefore the whole
  // injected stylesheet — are identical), which would make a "wait until the text changes"
  // check hang for exactly the pairing this test most needs to exercise.
  async function setVisionProfile(profileKey) {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#vision-profile');
    await popup.selectOption('#vision-profile', profileKey);
    await popup.waitForTimeout(300);
    await popup.close();
    await page.bringToFront();
    await page.waitForTimeout(300);
  }

  async function setCustomMatchColor(hex) {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#configure-drawer');
    // #color-palette lives inside the collapsed <details> drawer — open it before trying
    // to interact with anything inside.
    await popup.evaluate(() => { document.getElementById('configure-drawer').open = true; });
    await popup.waitForSelector('#color-palette', { state: 'visible' });
    await popup.selectOption('#vision-profile', 'custom');
    await popup.waitForTimeout(150);
    await popup.selectOption('#color-palette', 'custom');
    await popup.waitForTimeout(150);
    await popup.evaluate((value) => {
      const el = document.getElementById('custom-match-color');
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, hex);
    await popup.waitForTimeout(300);
    await popup.close();
    await page.bringToFront();
    await page.waitForTimeout(300);
  }

  test('every built-in vision profile either clears 3:1 contrast or falls back to the underline treatment (measured, white page background)', async () => {
    await openFinderOn(origin);
    const bgRgb = [255, 255, 255]; // this fixture sets no background; unstyled pages render white
    const profiles = loadBuiltInProfiles();
    assert.ok(profiles.length >= 5, 'sanity check: expected the "none" preset plus every named built-in profile');

    const results = {};
    for (const profileKey of profiles) {
      await setVisionProfile(profileKey);
      const css = await currentCss();
      const state = readDimState(css);
      const wouldBeRatio = contrastRatio(blend(hexToRgb(state.matchHex), 0.35, bgRgb), bgRgb);
      results[profileKey] = { treatment: state.treatment, wouldBeRatio };

      if (wouldBeRatio >= 3) {
        assert.strictEqual(
          state.treatment,
          'wash',
          profileKey + ': blended contrast ' + wouldBeRatio.toFixed(3) + ' clears 3:1, expected the alpha wash'
        );
        const measured = contrastRatio(blend(state.rgb, state.alpha, bgRgb), bgRgb);
        assert.ok(measured >= 3, profileKey + ': measured wash contrast ' + measured.toFixed(3) + ' unexpectedly below 3:1');
      } else {
        assert.strictEqual(
          state.treatment,
          'underline',
          profileKey + ': blended contrast ' + wouldBeRatio.toFixed(3) + ' is below 3:1 — dim would be effectively ' +
            'invisible with the alpha wash, so the underline fallback must be active, but it was not'
        );
      }
    }

    // The regression this bead exists to fix: tritanopia's match colour (#ffcbd1) blends to
    // near-white and must fail 3:1, landing on the underline.
    assert.ok('color-blind-tritanopia' in results, 'tritanopia preset missing from PRESETS — cannot verify the regression this bead fixes');
    assert.strictEqual(results['color-blind-tritanopia'].treatment, 'underline');
    assert.ok(
      results['color-blind-tritanopia'].wouldBeRatio < 1.2,
      'tritanopia\'s blended wash contrast should be roughly 1.13:1 against white, got ' +
        results['color-blind-tritanopia'].wouldBeRatio.toFixed(3)
    );

    // oculist-l6m.17 removes the settings.visionProfile === 'low-vision' name check —
    // low-vision must now land on the underline because ITS blended colour also measures
    // below 3:1 on this white page (its colorPalette is 'default', the same pale matchColor
    // as every other non-tritanopia profile here), not because of any special-casing by
    // name. 'none' landing on the identical treatment for the identical reason is the proof
    // that the gate is contrast-driven: if it were still keyed on the profile name, only
    // 'low-vision' would come out underlined here.
    assert.strictEqual(results['low-vision'].treatment, 'underline', 'low-vision must still get the underline via the measured path');
    assert.strictEqual(results.none.treatment, 'underline');

    await setVisionProfile('none'); // leave a clean profile for the next test
  });

  test('a pale custom match colour gets the underline treatment automatically, without any profile-name special-casing', async () => {
    await openFinderOn(origin);
    const bgRgb = [255, 255, 255];

    await setCustomMatchColor('#fffbe6'); // very pale, deliberately not one of the built-in palette colours
    await page.waitForFunction(
      () => /oculist-dim-match[^}]*text-decoration-line/.test(document.getElementById('oc-global-highlight-styles').textContent),
      null,
      { timeout: 5000 }
    );

    const css = await currentCss();
    const state = readDimState(css);
    assert.strictEqual(state.matchHex.toLowerCase(), '#fffbe6');
    assert.strictEqual(state.treatment, 'underline');
    const ratio = contrastRatio(blend(hexToRgb(state.matchHex), 0.35, bgRgb), bgRgb);
    assert.ok(ratio < 3, 'sanity check: this custom colour should genuinely fail 3:1, got ' + ratio.toFixed(3));

    await setVisionProfile('none');
  });

  test('the alpha wash survives when the blended colour genuinely clears 3:1 (dark page background)', async () => {
    await openFinderOn(origin + 'dark');
    const bgRgb = [25, 25, 25]; // matches the fixture's body{background:#191919}

    await setCustomMatchColor('#ffffff');
    await page.waitForFunction(
      () => /oculist-dim-match[^}]*background-color:\s*rgba/.test(document.getElementById('oc-global-highlight-styles').textContent),
      null,
      { timeout: 5000 }
    );

    const css = await currentCss();
    const state = readDimState(css);
    assert.strictEqual(state.matchHex.toLowerCase(), '#ffffff');
    assert.strictEqual(state.treatment, 'wash', 'white match colour on a near-black page should clear 3:1 and keep the alpha wash');
    const ratio = contrastRatio(blend(state.rgb, state.alpha, bgRgb), bgRgb);
    assert.ok(ratio >= 3, 'sanity check: this combination should genuinely clear 3:1, got ' + ratio.toFixed(3));

    await setVisionProfile('none');
  });

  test('prefers-contrast: more forces the underline treatment even when the wash would otherwise clear 3:1', async () => {
    if (page) await page.close().catch(() => {});
    page = await ctx.newPage();
    await page.emulateMedia({ contrast: 'more' });
    await page.goto(origin + 'dark');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+f');
    await page.waitForSelector(INPUT, { timeout: 5000 });
    await page.locator(INPUT).fill('cat');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);

    // Same colour/background combination that stayed a wash in the previous test — the
    // only difference here is prefers-contrast: more.
    await setCustomMatchColor('#ffffff');
    await page.waitForFunction(
      () => /oculist-dim-match[^}]*text-decoration-line/.test(document.getElementById('oc-global-highlight-styles').textContent),
      null,
      { timeout: 5000 }
    );

    const css = await currentCss();
    const state = readDimState(css);
    assert.strictEqual(
      state.treatment,
      'underline',
      'prefers-contrast: more must force the underline treatment independently of the measured contrast ratio'
    );

    await setVisionProfile('none');
  });

  // oculist-32d: the underline branch is now painted in currentColor rather than matchColor.
  // The tests above only ever asserted which BRANCH got selected; these prove the branch, as
  // RENDERED, is actually visible — which is what the bead's done-criteria demands.
  describe('oculist-32d: the dim underline is painted in currentColor, so it renders at the page\'s own contrast', () => {
    test('the underline colour adapts PER ELEMENT: pixel-identical to that element\'s own text colour hardcoded in, on both a light-text and a dark-text container sharing one global rule', async () => {
      if (page) await page.close().catch(() => {});
      page = await ctx.newPage();
      await page.goto(origin + 'adaptive');
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+f');
      await page.waitForSelector(INPUT, { timeout: 5000 });
      await page.locator(INPUT).fill('dog');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await page.locator(INPUT).fill('cat');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await page.locator(CHIP_TERM).nth(0).click(); // activate 'dog', leaving 'cat' dim in both paragraphs
      await page.waitForTimeout(250);
      // Activating a chip fires a transient ~3s attention "beacon" glow (a Web Animation) at
      // the newly-active match. It self-removes when the animation finishes, but until then
      // its radial glow paints over both paragraphs and is by itself enough to make two
      // otherwise-identical screenshots differ. Wait for it to fully leave the DOM so the
      // only thing that can make two screenshots of the same element differ is the
      // stylesheet edits this test makes on purpose.
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: 5000 });

      const originalCss = await currentCss();
      assert.match(
        originalCss,
        /oculist-dim-match[^}]*text-decoration-color:\s*currentColor/,
        'sanity check: expected the underline branch painted in currentColor on this fixture'
      );

      // #oc-wrap (the finder overlay, roughly [x=800, y=0, w=480, h=76]) overlaps
      // #p-light's screenshot region here; it is static for the duration of this test and
      // captured identically in every buffer compared below, so it cannot cause a false
      // pass or fail today — but a future animation in the finder bar's top-right corner
      // would flake this test with a confusing failure. #p-dark does not overlap it.
      const pLight = page.locator('#p-light');
      const pDark = page.locator('#p-dark');

      const lightColor = await readDimRenderedColor('#p-light');
      const darkColor = await readDimRenderedColor('#p-dark');
      assert.notStrictEqual(lightColor, darkColor, 'sanity check: the two containers must have genuinely different text colours for this test to prove anything');

      async function setDimUnderlineColor(colorCss) {
        await page.evaluate(
          ({ base, color }) => {
            document.getElementById('oc-global-highlight-styles').textContent = base.replace(
              /(oculist-dim-match[^}]*text-decoration-color:\s*)currentColor/,
              '$1' + color
            );
          },
          { base: originalCss, color: colorCss }
        );
      }
      async function restoreDimUnderline() {
        await page.evaluate((base) => {
          document.getElementById('oc-global-highlight-styles').textContent = base;
        }, originalCss);
      }

      // Baseline: both elements rendered with the real currentColor rule.
      const bufLightCurrent = await pLight.screenshot();
      const bufDarkCurrent = await pDark.screenshot();

      // Hardcode the SAME global rule to each element's own computed colour, one at a time,
      // and re-screenshot just that element — proving currentColor already rendered exactly
      // what a fixed, per-element-correct colour would have.
      await setDimUnderlineColor(lightColor);
      const bufLightHardcoded = await pLight.screenshot();
      await restoreDimUnderline();

      await setDimUnderlineColor(darkColor);
      const bufDarkHardcoded = await pDark.screenshot();
      await restoreDimUnderline();

      assert.ok(
        bufLightCurrent.equals(bufLightHardcoded),
        'light-on-white paragraph: currentColor underline must render pixel-identical to the same rule hardcoded to that element\'s own computed colour'
      );
      assert.ok(
        bufDarkCurrent.equals(bufDarkHardcoded),
        'dark-container paragraph: currentColor underline must render pixel-identical to the same rule hardcoded to that element\'s own computed colour'
      );

      // Control: an obviously wrong colour must NOT be pixel-identical — proves the
      // screenshot comparison is actually sensitive to the underline's colour, not a
      // trivially-always-equal comparison (e.g. because the underline is too thin/antialiased
      // to move any pixels).
      await setDimUnderlineColor('red');
      const bufLightRed = await pLight.screenshot();
      await restoreDimUnderline();
      assert.ok(!bufLightCurrent.equals(bufLightRed), 'control: a red underline must render differently from the currentColor baseline on the light paragraph');

      await setDimUnderlineColor('red');
      const bufDarkRed = await pDark.screenshot();
      await restoreDimUnderline();
      assert.ok(!bufDarkCurrent.equals(bufDarkRed), 'control: a red underline must render differently from the currentColor baseline on the dark-container paragraph');
    });

    // The previous test proves currentColor adapts per element for whatever profile happens
    // to be active, but only ever exercised the default profile — leaving tritanopia's own
    // RENDERED case resting on an argument (the emitted underline CSS is a single
    // non-parameterised string literal at content.js's dimHighlightCss, so every profile
    // shares the exact same code path) rather than a measurement. This test closes that gap
    // by parameterising the pixel-identity proof over every built-in profile, sourced from
    // loadBuiltInProfiles() so the set can't drift.
    //
    // The full screenshot-based proof (currentColor render, hardcoded-to-computed-colour
    // render, red control) costs ~3.3s per profile; running all six would add ~20s to this
    // file for marginal signal given the single-code-path argument above. Pixel-prove
    // 'color-blind-tritanopia' — this bead's headline regression, whose #ffcbd1 measured
    // ~1.43:1 at full opacity before the fix — plus 'none' as an ordinary baseline profile,
    // and confirm every OTHER built-in profile via the currentColor CSS-literal check, which
    // is fast (no screenshots) and still reads the exact string the browser resolves
    // currentColor from.
    test('the underline is pixel-proven as RENDERED for tritanopia and an ordinary profile, and confirmed via the currentColor literal for every other built-in profile (oculist-32d)', async () => {
      const profiles = loadBuiltInProfiles();
      assert.ok(profiles.length >= 5, 'sanity check: expected the "none" preset plus every named built-in profile');
      assert.ok(
        profiles.includes('color-blind-tritanopia'),
        'tritanopia preset missing from PRESETS — cannot pixel-prove this bead\'s headline regression'
      );

      const PIXEL_PROVEN = ['color-blind-tritanopia', 'none'];

      await openFinderWithDimTermOn(origin + 'contrast-light');
      // Same transient attention-beacon concern as the adaptivity test above: wait for it to
      // fully leave the DOM before any screenshot is taken.
      await page.waitForFunction(() => document.querySelectorAll('.oc-beacon').length === 0, null, { timeout: 5000 });

      const p = page.locator('p');

      for (const profileKey of profiles) {
        await setVisionProfile(profileKey);
        const css = await currentCss();
        assert.match(
          css,
          /oculist-dim-match[^}]*text-decoration-color:\s*currentColor/,
          profileKey + ': underline must be painted in currentColor, not matchColor'
        );

        if (!PIXEL_PROVEN.includes(profileKey)) continue;

        const originalCss = css;
        const renderedColor = await readDimRenderedColor('p');

        async function setDimUnderlineColor(colorCss) {
          await page.evaluate(
            ({ base, color }) => {
              document.getElementById('oc-global-highlight-styles').textContent = base.replace(
                /(oculist-dim-match[^}]*text-decoration-color:\s*)currentColor/,
                '$1' + color
              );
            },
            { base: originalCss, color: colorCss }
          );
        }
        async function restoreDimUnderline() {
          await page.evaluate((base) => {
            document.getElementById('oc-global-highlight-styles').textContent = base;
          }, originalCss);
        }

        const bufCurrent = await p.screenshot();

        await setDimUnderlineColor(renderedColor);
        const bufHardcoded = await p.screenshot();
        await restoreDimUnderline();

        assert.ok(
          bufCurrent.equals(bufHardcoded),
          profileKey + ': currentColor underline must render pixel-identical to the same rule hardcoded to this element\'s own computed colour'
        );

        // Control: an obviously wrong colour must NOT be pixel-identical to the baseline —
        // proves the screenshot comparison actually moves pixels for this profile too.
        await setDimUnderlineColor('red');
        const bufRed = await p.screenshot();
        await restoreDimUnderline();
        assert.ok(
          !bufCurrent.equals(bufRed),
          profileKey + ': control — a red underline must render differently from the currentColor baseline'
        );
      }

      await setVisionProfile('none');
    });

    test('every built-in profile\'s RENDERED dim underline measures at least 3:1 against the page background, on a light page and a dark page', async () => {
      const profiles = loadBuiltInProfiles();
      assert.ok(profiles.length >= 5, 'sanity check: expected the "none" preset plus every named built-in profile');

      const pages = [
        { url: origin + 'contrast-light', bgRgb: [255, 255, 255], label: 'light page' },
        { url: origin + 'contrast-dark', bgRgb: [10, 10, 10], label: 'dark page' },
      ];

      for (const { url, bgRgb, label } of pages) {
        await openFinderWithDimTermOn(url);
        for (const profileKey of profiles) {
          await setVisionProfile(profileKey);
          const css = await currentCss();
          const state = readDimState(css);

          // The practical consequence of oculist-32d: every built-in profile's matchColor is
          // pale (by design, so it reads as a highlight rather than solid text), so every one
          // of them fails the wash's 3:1 gate on every background and always takes the
          // underline branch. That is expected here, not a bug.
          assert.strictEqual(
            state.treatment,
            'underline',
            profileKey + ' on ' + label + ': every built-in profile is expected to fail the wash gate and take the underline branch'
          );
          assert.match(
            css,
            /oculist-dim-match[^}]*text-decoration-color:\s*currentColor/,
            profileKey + ' on ' + label + ': underline must be painted in currentColor, not matchColor'
          );

          const colorStr = await readDimRenderedColor('p');
          const rgb = rgbStringToArray(colorStr);
          const ratio = contrastRatio(rgb, bgRgb);
          assert.ok(
            ratio >= 3,
            profileKey + ' on ' + label + ': rendered dim underline colour ' + colorStr + ' measures ' + ratio.toFixed(3) +
              ':1 against the page background [' + bgRgb.join(',') + '], below the WCAG 2.2 SC 1.4.11 3:1 minimum'
          );
        }
      }

      await setVisionProfile('none');
    });
  });
});
