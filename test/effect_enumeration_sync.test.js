// Three prose sites hand-list every effect in extension/content.js's effectsRegistry
// (extension/welcome.html, and two spots in docs/index.html), and one of them also
// spells out the registry size as a digit. Nothing ties those sites to the registry
// itself, so a 14th effect can land in the registry while all three sites silently
// go stale — exactly what happened when Bloom/Trail were added to the registry
// while both docs lists sat frozen at 7. This is a static source scan, like
// privacy_invariants.test.js, not a browser test — no page/fixture/timeout budget.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CONTENT_JS = path.resolve(__dirname, '../extension/content.js');
const WELCOME_HTML = path.resolve(__dirname, '../extension/welcome.html');
const DOCS_INDEX_HTML = path.resolve(__dirname, '../docs/index.html');

// Pulls the ordered list of effect label strings straight out of content.js's
// source text: first the `label: i18n.<key>` references inside the
// effectsRegistry object literal (in declaration order), then each key's
// literal string value from the i18n object above it.
function extractRegistryLabels(contentJsSource) {
  const registryStart = contentJsSource.indexOf('var effectsRegistry = {');
  assert.ok(
    registryStart !== -1,
    `could not find "var effectsRegistry = {" in ${CONTENT_JS} — did it get renamed?`
  );
  const registryEnd = contentJsSource.indexOf('\n  };', registryStart);
  assert.ok(
    registryEnd !== -1,
    `could not find the closing "  };" for effectsRegistry in ${CONTENT_JS}`
  );
  const registryBlock = contentJsSource.slice(registryStart, registryEnd);

  const keyPattern = /label:\s*i18n\.(\w+)/g;
  const keys = [];
  let match;
  while ((match = keyPattern.exec(registryBlock)) !== null) {
    keys.push(match[1]);
  }
  assert.ok(
    keys.length > 0,
    `found no "label: i18n.<key>" entries inside effectsRegistry in ${CONTENT_JS} — the parser is broken`
  );

  return keys.map((key) => {
    const literalPattern = new RegExp('\\b' + key + '\\s*:\\s*\'([^\']*)\'');
    const literalMatch = contentJsSource.match(literalPattern);
    assert.ok(
      literalMatch,
      `effectsRegistry references i18n.${key}, but no "${key}: '...'" literal exists in ${CONTENT_JS}`
    );
    return literalMatch[1];
  });
}

// Asserts every label appears in fileContent, in the same relative order as
// registryLabels. Search position only moves forward, so a label instance
// used to satisfy one entry can't also satisfy a later, out-of-order entry.
function assertLabelsInOrder(fileContent, registryLabels, siteDescription) {
  let cursor = 0;
  for (let i = 0; i < registryLabels.length; i++) {
    const label = registryLabels[i];
    const idx = fileContent.indexOf(label, cursor);
    assert.notStrictEqual(
      idx,
      -1,
      `${siteDescription} is missing the effect label "${label}" ` +
        `(or it appears out of registry order, before an earlier effect it should follow). ` +
        `effectsRegistry declares it at position ${i + 1} of ${registryLabels.length}.`
    );
    cursor = idx + label.length;
  }
}

test('welcome.html and docs/index.html stay in sync with effectsRegistry', () => {
  const contentJsSource = fs.readFileSync(CONTENT_JS, 'utf8');
  const registryLabels = extractRegistryLabels(contentJsSource);

  const welcomeHtml = fs.readFileSync(WELCOME_HTML, 'utf8');
  const docsIndexHtml = fs.readFileSync(DOCS_INDEX_HTML, 'utf8');

  assertLabelsInOrder(welcomeHtml, registryLabels, 'extension/welcome.html');

  // docs/index.html enumerates the full effect list twice: once in the "Make
  // it yours" style intro paragraph, and once in the "Effects" section's
  // "Showing: ... Also included: ..." summary line. Both must independently
  // stay in sync with the registry.
  const introMarker = 'Pick the one that fits and switch anytime from the settings panel.';
  const introEnd = docsIndexHtml.indexOf(introMarker);
  assert.notStrictEqual(
    introEnd,
    -1,
    'docs/index.html: could not find the "Make it yours" intro paragraph marker ' +
      '("Pick the one that fits and switch anytime from the settings panel.") — did it get reworded?'
  );
  assertLabelsInOrder(
    docsIndexHtml.slice(0, introEnd),
    registryLabels,
    'docs/index.html ("Make it yours" intro paragraph, near line 497)'
  );

  const showingMarker = 'Showing: Anime Laser (default)';
  const showingStart = docsIndexHtml.indexOf(showingMarker);
  assert.notStrictEqual(
    showingStart,
    -1,
    'docs/index.html: could not find the "Showing: Anime Laser (default)" marker ' +
      'in the Effects section — did it get reworded?'
  );
  assertLabelsInOrder(
    docsIndexHtml.slice(showingStart),
    registryLabels,
    'docs/index.html ("Showing / Also included" Effects section line, near line 578)'
  );
});

test('welcome.html "Choose from N effects" count matches effectsRegistry size', () => {
  const contentJsSource = fs.readFileSync(CONTENT_JS, 'utf8');
  const registryLabels = extractRegistryLabels(contentJsSource);

  const welcomeHtml = fs.readFileSync(WELCOME_HTML, 'utf8');
  const countMatch = welcomeHtml.match(/Choose from (\d+) effects/);
  assert.ok(
    countMatch,
    'extension/welcome.html: could not find a "Choose from N effects" phrase — did the wording change?'
  );

  const statedCount = Number(countMatch[1]);
  assert.strictEqual(
    statedCount,
    registryLabels.length,
    `extension/welcome.html says "Choose from ${statedCount} effects", but ` +
      `effectsRegistry in extension/content.js currently declares ${registryLabels.length} effects. ` +
      `extension/welcome.html is stale.`
  );
});
