// Four sites hand-list every effect in extension/content.js's effectsRegistry
// (extension/welcome.html's settings prose paragraph, extension/welcome.html's
// settings-panel <select> mockup, and two spots in docs/index.html), and one of
// them also spells out the registry size as a digit. Nothing ties those sites to
// the registry itself, so a 14th effect can land in the registry while all sites
// silently go stale — exactly what happened when Bloom/Trail were added to the
// registry while both docs lists sat frozen at 7. Each site is scanned within its
// own scoped slice (not the whole file) so a missing/extra label is reported
// against the right site, and each site is checked both for missing labels (via
// assertLabelsInOrder) and for orphaned labels left behind by a registry removal
// (via assertNoOrphanLabels). This is a static source scan, like
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

// Splits a plain comma-delimited human list ("A, B, and C." / "A, B, C.") into
// its individual name tokens, stripping the optional "and " conjunction before
// the last item and any trailing period/whitespace.
function extractDelimitedNames(text) {
  return text
    .split(',')
    .map((part) =>
      part
        .replace(/^\s*and\s+/i, '')
        .replace(/[.\s]+$/, '')
        .trim()
    )
    .filter((name) => name.length > 0);
}

// Asserts that every name in `names` is one of registryLabels — i.e. the site
// lists no label that effectsRegistry no longer declares. This is what catches
// a registry entry being *removed*: assertLabelsInOrder alone can't see that,
// since a shorter registry list is trivially still "in order" inside a site
// that kept the stale extra label around.
function assertNoOrphanLabels(names, registryLabels, siteDescription) {
  const registrySet = new Set(registryLabels);
  for (const name of names) {
    assert.ok(
      registrySet.has(name),
      `${siteDescription} lists "${name}", which is not one of the ${registryLabels.length} ` +
        `labels effectsRegistry in extension/content.js currently declares. It looks like a ` +
        `stale/orphaned label left behind after a registry entry was renamed or removed.`
    );
  }
}

test('welcome.html and docs/index.html stay in sync with effectsRegistry', () => {
  const contentJsSource = fs.readFileSync(CONTENT_JS, 'utf8');
  const registryLabels = extractRegistryLabels(contentJsSource);

  const welcomeHtml = fs.readFileSync(WELCOME_HTML, 'utf8');
  const docsIndexHtml = fs.readFileSync(DOCS_INDEX_HTML, 'utf8');

  // Site 1: welcome.html's "Make it yours" settings prose — "Choose from N
  // effects — A, B, ..., and Z." Scoped to just this paragraph (not the whole
  // file) so a label deleted here is reported against this site with the
  // correct label name, instead of drifting into whatever the next unrelated
  // match in the file happens to be.
  const proseSiteDescription = 'extension/welcome.html (settings prose paragraph, near line 226)';
  const proseMarkerMatch = welcomeHtml.match(/Choose from \d+ effects\s*—\s*/);
  assert.ok(
    proseMarkerMatch,
    'extension/welcome.html: could not find the "Choose from N effects — " prose lead-in — did the wording change?'
  );
  const proseListStart = welcomeHtml.indexOf(proseMarkerMatch[0]) + proseMarkerMatch[0].length;
  const proseListEnd = welcomeHtml.indexOf('</p>', proseListStart);
  assert.notStrictEqual(
    proseListEnd,
    -1,
    'extension/welcome.html: could not find the closing </p> for the "Choose from N effects" paragraph'
  );
  const proseSlice = welcomeHtml.slice(proseListStart, proseListEnd);
  assertLabelsInOrder(proseSlice, registryLabels, proseSiteDescription);

  // The effect list is one sentence ending in a period. Bound the orphan-name
  // slice there instead of at </p>, so an ordinary sentence appended after the
  // list inside the same <p> (e.g. "...and Cyber-Vision. All are GPU-friendly.")
  // isn't parsed as a bogus trailing "label".
  const proseSentenceEnd = welcomeHtml.indexOf('.', proseListStart);
  const proseNamesSlice =
    proseSentenceEnd !== -1 && proseSentenceEnd < proseListEnd
      ? welcomeHtml.slice(proseListStart, proseSentenceEnd)
      : proseSlice;
  assertNoOrphanLabels(extractDelimitedNames(proseNamesSlice), registryLabels, proseSiteDescription);

  // Site 2: welcome.html's settings-panel mockup <select> (Step 4 live
  // preview) — a separate, independently-maintained <option> list that names
  // every effect again. Scoped to the <select>...</select> block.
  const mockupSiteDescription = 'extension/welcome.html (settings-panel mockup <option> list, near line 291)';
  const mockupSelectStart = welcomeHtml.indexOf('<select id="preview-effect"');
  assert.notStrictEqual(
    mockupSelectStart,
    -1,
    'extension/welcome.html: could not find the "#preview-effect" settings-panel mockup <select> — did it get renamed?'
  );
  const mockupSelectEnd = welcomeHtml.indexOf('</select>', mockupSelectStart);
  assert.notStrictEqual(
    mockupSelectEnd,
    -1,
    'extension/welcome.html: could not find the closing </select> for the "#preview-effect" mockup dropdown'
  );
  const mockupSlice = welcomeHtml.slice(mockupSelectStart, mockupSelectEnd);
  assertLabelsInOrder(mockupSlice, registryLabels, mockupSiteDescription);

  const optionPattern = /<option[^>]*>([^<]*)<\/option>/g;
  const mockupNames = [];
  let optionMatch;
  while ((optionMatch = optionPattern.exec(mockupSlice)) !== null) {
    mockupNames.push(optionMatch[1].trim());
  }
  assert.ok(
    mockupNames.length > 0,
    'extension/welcome.html: found no <option> entries inside the "#preview-effect" mockup dropdown — the parser is broken'
  );
  assertNoOrphanLabels(mockupNames, registryLabels, mockupSiteDescription);

  // docs/index.html enumerates the full effect list twice: once in the "Make
  // it yours" style intro paragraph (site 3), and once in the "Effects"
  // section's "Showing: ... Also included: ..." summary line (site 4). Both
  // must independently stay in sync with the registry.
  const introSiteDescription = 'docs/index.html ("Make it yours" intro paragraph, near line 497)';
  const introMarker = 'Pick the one that fits and switch anytime from the settings panel.';
  const introEnd = docsIndexHtml.indexOf(introMarker);
  assert.notStrictEqual(
    introEnd,
    -1,
    'docs/index.html: could not find the "Make it yours" intro paragraph marker ' +
      '("Pick the one that fits and switch anytime from the settings panel.") — did it get reworded?'
  );
  const introListStartTag = docsIndexHtml.lastIndexOf('<p>', introEnd);
  assert.notStrictEqual(
    introListStartTag,
    -1,
    'docs/index.html: could not find the opening <p> of the "Make it yours" intro paragraph'
  );
  const introSlice = docsIndexHtml.slice(introListStartTag + '<p>'.length, introEnd);
  assertLabelsInOrder(introSlice, registryLabels, introSiteDescription);

  // Bound the orphan-name slice at the list's first label rather than at <p>,
  // so a lead-in clause added before the list (still inside the same <p>)
  // isn't parsed as a bogus leading "label".
  const introListStart = docsIndexHtml.indexOf(registryLabels[0], introListStartTag);
  assert.notStrictEqual(
    introListStart,
    -1,
    `docs/index.html: could not find the first effect label "${registryLabels[0]}" inside the ` +
      '"Make it yours" intro paragraph'
  );
  const introNamesSlice = docsIndexHtml.slice(introListStart, introEnd);
  assertNoOrphanLabels(extractDelimitedNames(introNamesSlice), registryLabels, introSiteDescription);

  const showingSiteDescription = 'docs/index.html ("Showing / Also included" Effects section line, near line 578)';
  const showingMarker = 'Showing: Anime Laser (default)';
  const showingStart = docsIndexHtml.indexOf(showingMarker);
  assert.notStrictEqual(
    showingStart,
    -1,
    'docs/index.html: could not find the "Showing: Anime Laser (default)" marker ' +
      'in the Effects section — did it get reworded?'
  );
  const showingEnd = docsIndexHtml.indexOf('</p>', showingStart);
  assert.notStrictEqual(
    showingEnd,
    -1,
    'docs/index.html: could not find the closing </p> for the "Showing / Also included" line'
  );
  const showingSlice = docsIndexHtml.slice(showingStart, showingEnd);
  assertLabelsInOrder(showingSlice, registryLabels, showingSiteDescription);

  // "Showing: Anime Laser (default) · Also included: B, C, ..." — the first
  // name sits before the comma-delimited "Also included" list, so it's pulled
  // out separately rather than by extractDelimitedNames.
  const showingNameMatch = showingSlice.match(/^Showing:\s*([^(]+?)\s*\(default\)[\s\S]*Also included:\s*([\s\S]*)$/);
  assert.ok(
    showingNameMatch,
    'docs/index.html: could not parse the "Showing / Also included" line structure — did the wording change?'
  );
  const showingNames = [showingNameMatch[1].trim(), ...extractDelimitedNames(showingNameMatch[2])];
  assertNoOrphanLabels(showingNames, registryLabels, showingSiteDescription);
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
