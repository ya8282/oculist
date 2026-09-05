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
//
// oculist-tdj: effectsRegistry entries may now carry an optional `pack` field
// (absent means core — see availableEffects() in extension/content.js). That
// splits every site's enumeration in two: the twelve core effects, listed the
// same way they always were, and any packed effects, listed separately under a
// dedicated "Optional effect packs: ..." sentence (or, in the settings-panel
// mockup <select>, a dedicated block of <option> tags appended after a marker
// comment). Both halves are still checked for missing entries (assertLabelsInOrder)
// and orphaned leftovers (assertNoOrphanLabels) — packs do not weaken either
// property, they just aim each property at two label sets instead of one. Today
// no registry entry carries a `pack`, so every packed slice is empty and every
// site's "Optional effect packs:" sentence reads the literal placeholder "None in
// this release." — PACKED_EMPTY_PLACEHOLDER below — which is treated as zero
// names rather than parsed as a bogus one, so the empty case doesn't itself count
// as an orphan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CONTENT_JS = path.resolve(__dirname, '../extension/content.js');
const WELCOME_HTML = path.resolve(__dirname, '../extension/welcome.html');
const DOCS_INDEX_HTML = path.resolve(__dirname, '../docs/index.html');

// The literal sentence used by every site's "packed effects" slice when no
// registry entry currently carries a `pack`. Must match assertNoOrphanLabels'
// input for that slice being empty, i.e. this exact string does not get treated
// as a name.
const PACKED_EMPTY_PLACEHOLDER = 'None in this release';

// Pulls every effectsRegistry entry out of content.js's source text, in
// declaration order, as { label, pack }. `label` comes from resolving the
// entry's `label: i18n.<key>` reference against the key's literal string value
// in the i18n object above it; `pack` is the entry's `pack: '...'` literal, or
// null when the entry carries no `pack` field (core).
function extractRegistryEntries(contentJsSource) {
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

  // Each entry is `key: { label: i18n.X, run: fn }` or `key: { label: i18n.X,
  // run: fn, pack: 'id' }`, with no nested braces, so a non-greedy `[^}]*` scan
  // between `{` and `}` reliably captures one entry's body regardless of
  // whether it's spread across one line or several.
  const entryPattern = /\{([^}]*)\}/g;
  const entryBodies = [];
  let entryMatch;
  while ((entryMatch = entryPattern.exec(registryBlock)) !== null) {
    entryBodies.push(entryMatch[1]);
  }
  assert.ok(
    entryBodies.length > 0,
    `found no "{ label: i18n.<key>, ... }" entries inside effectsRegistry in ${CONTENT_JS} — the parser is broken`
  );

  return entryBodies.map((body) => {
    const labelKeyMatch = body.match(/label:\s*i18n\.(\w+)/);
    assert.ok(
      labelKeyMatch,
      `an effectsRegistry entry has no "label: i18n.<key>" field in ${CONTENT_JS}: ${body}`
    );
    const key = labelKeyMatch[1];
    const literalPattern = new RegExp('\\b' + key + '\\s*:\\s*\'([^\']*)\'');
    const literalMatch = contentJsSource.match(literalPattern);
    assert.ok(
      literalMatch,
      `effectsRegistry references i18n.${key}, but no "${key}: '...'" literal exists in ${CONTENT_JS}`
    );
    const packMatch = body.match(/pack:\s*'([^']*)'/);
    return { label: literalMatch[1], pack: packMatch ? packMatch[1] : null };
  });
}

// Asserts every label appears in fileContent, in the same relative order as
// labels. Search position only moves forward, so a label instance used to
// satisfy one entry can't also satisfy a later, out-of-order entry. A no-op
// when labels is empty (the packed slices today, since no entry carries a
// `pack` yet).
function assertLabelsInOrder(fileContent, labels, siteDescription) {
  let cursor = 0;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const idx = fileContent.indexOf(label, cursor);
    assert.notStrictEqual(
      idx,
      -1,
      `${siteDescription} is missing the effect label "${label}" ` +
        `(or it appears out of order, before an earlier effect it should follow). ` +
        `effectsRegistry declares it at position ${i + 1} of ${labels.length} in this group.`
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

// Same as extractDelimitedNames, but treats the packed-slice empty placeholder
// as zero names instead of one bogus name — otherwise the placeholder text
// itself would fail assertNoOrphanLabels the moment there are genuinely no
// packed effects to list.
function extractPackedNames(text) {
  if (text.trim() === PACKED_EMPTY_PLACEHOLDER) {
    return [];
  }
  return extractDelimitedNames(text);
}

// Asserts that every name in `names` is one of `labels` — i.e. the site lists
// no label that effectsRegistry no longer declares. This is what catches a
// registry entry being *removed*: assertLabelsInOrder alone can't see that,
// since a shorter label list is trivially still "in order" inside a site that
// kept the stale extra label around.
function assertNoOrphanLabels(names, labels, siteDescription) {
  const labelSet = new Set(labels);
  for (const name of names) {
    assert.ok(
      labelSet.has(name),
      `${siteDescription} lists "${name}", which is not one of the ${labels.length} ` +
        `labels effectsRegistry in extension/content.js currently declares for this group. ` +
        `It looks like a stale/orphaned label left behind after a registry entry was renamed, ` +
        `removed, or moved between core and a pack.`
    );
  }
}

// Scans one "Optional effect packs: A, B, and C." (or "...: None in this
// release.") sentence within fileContent[searchFrom, searchTo), and asserts it
// stays in sync with packedLabels. Used by welcome.html's prose paragraph and
// both docs/index.html sites — every prose site's packed slice is bounded the
// same way as its core slice: from just after the "Optional effect packs:"
// lead-in to the sentence's own closing period, so trailing sentences appended
// after it in the same <p> aren't parsed as bogus labels.
function assertPackedProseSite(fileContent, searchFrom, searchTo, packedLabels, siteDescription) {
  const region = fileContent.slice(searchFrom, searchTo);
  const markerText = 'Optional effect packs:';
  const markerIdx = region.indexOf(markerText);
  assert.notStrictEqual(
    markerIdx,
    -1,
    `${siteDescription}: could not find the "Optional effect packs:" sentence — did it get removed or reworded?`
  );
  const listStart = searchFrom + markerIdx + markerText.length;
  const listEnd = fileContent.indexOf('.', listStart);
  assert.notStrictEqual(
    listEnd,
    -1,
    `${siteDescription}: could not find the closing period of the "Optional effect packs:" sentence`
  );
  const slice = fileContent.slice(listStart, listEnd);
  assertLabelsInOrder(slice, packedLabels, siteDescription + ' (packed effects)');
  assertNoOrphanLabels(extractPackedNames(slice), packedLabels, siteDescription + ' (packed effects)');
}

test('welcome.html and docs/index.html stay in sync with effectsRegistry', () => {
  const contentJsSource = fs.readFileSync(CONTENT_JS, 'utf8');
  const registryEntries = extractRegistryEntries(contentJsSource);
  const coreLabels = registryEntries.filter((e) => !e.pack).map((e) => e.label);
  const packedLabels = registryEntries.filter((e) => e.pack).map((e) => e.label);

  const welcomeHtml = fs.readFileSync(WELCOME_HTML, 'utf8');
  const docsIndexHtml = fs.readFileSync(DOCS_INDEX_HTML, 'utf8');

  // Site 1: welcome.html's "Make it yours" settings prose — "Choose from N
  // core effects — A, B, ..., and Z." Scoped to just this paragraph (not the
  // whole file) so a label deleted here is reported against this site with
  // the correct label name, instead of drifting into whatever the next
  // unrelated match in the file happens to be.
  const proseSiteDescription = 'extension/welcome.html (settings prose paragraph, near line 290)';
  const proseMarkerMatch = welcomeHtml.match(/Choose from \d+ core effects\s*—\s*/);
  assert.ok(
    proseMarkerMatch,
    'extension/welcome.html: could not find the "Choose from N core effects — " prose lead-in — did the wording change?'
  );
  const proseListStart = welcomeHtml.indexOf(proseMarkerMatch[0]) + proseMarkerMatch[0].length;
  const proseListEnd = welcomeHtml.indexOf('</p>', proseListStart);
  assert.notStrictEqual(
    proseListEnd,
    -1,
    'extension/welcome.html: could not find the closing </p> for the "Choose from N core effects" paragraph'
  );
  const proseSlice = welcomeHtml.slice(proseListStart, proseListEnd);
  assertLabelsInOrder(proseSlice, coreLabels, proseSiteDescription);

  // The core list is one sentence ending in a period. Bound the orphan-name
  // slice there instead of at </p>, so an ordinary sentence appended after the
  // list inside the same <p> (e.g. "...and Cyber-Vision. All are GPU-friendly.")
  // isn't parsed as a bogus trailing "label".
  const proseSentenceEnd = welcomeHtml.indexOf('.', proseListStart);
  const proseNamesSlice =
    proseSentenceEnd !== -1 && proseSentenceEnd < proseListEnd
      ? welcomeHtml.slice(proseListStart, proseSentenceEnd)
      : proseSlice;
  assertNoOrphanLabels(extractDelimitedNames(proseNamesSlice), coreLabels, proseSiteDescription);

  // Site 1's packed effects live in the next paragraph: "Optional effect
  // packs: A, B, and C." (or the empty placeholder). Scoped from the end of
  // the core paragraph to the end of the file's <body> is generous but safe:
  // welcome.html only has one "Optional effect packs:" sentence.
  assertPackedProseSite(welcomeHtml, proseListEnd, welcomeHtml.length, packedLabels, proseSiteDescription);

  // Site 2: welcome.html's settings-panel mockup <select> (Step 4 live
  // preview) — a separate, independently-maintained <option> list that names
  // every effect again. Scoped to the <select>...</select> block, and split at
  // the marker comment into a core sub-slice and a packed sub-slice.
  const mockupSiteDescription = 'extension/welcome.html (settings-panel mockup <option> list, near line 423)';
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

  const packedOptionMarker = '<!-- oculist-tdj: optional effect-pack <option> entries append below this';
  const packedOptionMarkerIdx = mockupSlice.indexOf(packedOptionMarker);
  assert.notStrictEqual(
    packedOptionMarkerIdx,
    -1,
    'extension/welcome.html: could not find the "optional effect-pack <option> entries append below" ' +
      'marker comment inside the "#preview-effect" mockup dropdown — did it get removed?'
  );
  const mockupCoreSlice = mockupSlice.slice(0, packedOptionMarkerIdx);
  const mockupPackedSlice = mockupSlice.slice(packedOptionMarkerIdx);

  assertLabelsInOrder(mockupCoreSlice, coreLabels, mockupSiteDescription);
  assertLabelsInOrder(mockupPackedSlice, packedLabels, mockupSiteDescription + ' (packed effects)');

  const optionPattern = /<option[^>]*>([^<]*)<\/option>/g;
  const extractOptionNames = (slice) => {
    const names = [];
    let optionMatch;
    optionPattern.lastIndex = 0;
    while ((optionMatch = optionPattern.exec(slice)) !== null) {
      names.push(optionMatch[1].trim());
    }
    return names;
  };
  const mockupCoreNames = extractOptionNames(mockupCoreSlice);
  const mockupPackedNames = extractOptionNames(mockupPackedSlice);
  assert.ok(
    mockupCoreNames.length > 0,
    'extension/welcome.html: found no core <option> entries inside the "#preview-effect" mockup dropdown — the parser is broken'
  );
  assertNoOrphanLabels(mockupCoreNames, coreLabels, mockupSiteDescription);
  assertNoOrphanLabels(mockupPackedNames, packedLabels, mockupSiteDescription + ' (packed effects)');

  // docs/index.html enumerates the full core effect list twice: once in the
  // "Make it yours" style intro paragraph (site 3), and once in the "Effects"
  // section's "Showing: ... Also included: ..." summary line (site 4). Both
  // must independently stay in sync with the registry, core and packed alike.
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
  assertLabelsInOrder(introSlice, coreLabels, introSiteDescription);

  // Bound the orphan-name slice at the list's first label rather than at <p>,
  // so a lead-in clause added before the list (still inside the same <p>)
  // isn't parsed as a bogus leading "label".
  const introListStart = docsIndexHtml.indexOf(coreLabels[0], introListStartTag);
  assert.notStrictEqual(
    introListStart,
    -1,
    `docs/index.html: could not find the first core effect label "${coreLabels[0]}" inside the ` +
      '"Make it yours" intro paragraph'
  );
  // The core list ends at the first " — " (em dash) after the last core label,
  // introduced to append the "twelve core effects, on by default" aside — the
  // rest of the <p> (including the trailing "Optional effect packs:" sentence)
  // must not be parsed as orphan core names.
  const introCoreListEnd = docsIndexHtml.indexOf(' —', introListStart);
  assert.notStrictEqual(
    introCoreListEnd,
    -1,
    'docs/index.html: could not find the " — twelve core effects" aside after the core effect list'
  );
  const introNamesSlice = docsIndexHtml.slice(introListStart, introCoreListEnd);
  assertNoOrphanLabels(extractDelimitedNames(introNamesSlice), coreLabels, introSiteDescription);

  const introEndTag = docsIndexHtml.indexOf('</p>', introEnd);
  assert.notStrictEqual(
    introEndTag,
    -1,
    'docs/index.html: could not find the closing </p> for the "Make it yours" intro paragraph'
  );
  assertPackedProseSite(docsIndexHtml, introEnd, introEndTag, packedLabels, introSiteDescription);

  const showingSiteDescription = 'docs/index.html ("Showing / Also included" Effects section line, near line 610)';
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
  assertLabelsInOrder(showingSlice, coreLabels, showingSiteDescription);

  // "Showing: Anime Laser (default) · Also included: B, C, ..." — the first
  // name sits before the comma-delimited "Also included" list, so it's pulled
  // out separately rather than by extractDelimitedNames.
  const showingNameMatch = showingSlice.match(/^Showing:\s*([^(]+?)\s*\(default\)[\s\S]*Also included:\s*([\s\S]*)$/);
  assert.ok(
    showingNameMatch,
    'docs/index.html: could not parse the "Showing / Also included" line structure — did the wording change?'
  );
  const showingNames = [showingNameMatch[1].trim(), ...extractDelimitedNames(showingNameMatch[2])];
  assertNoOrphanLabels(showingNames, coreLabels, showingSiteDescription);

  // Site 4's packed effects live in the dedicated "Optional effect packs: ..."
  // <p> that immediately follows the "Showing / Also included" paragraph.
  const showingBlockEnd = docsIndexHtml.indexOf('</div>', showingEnd);
  assert.notStrictEqual(
    showingBlockEnd,
    -1,
    'docs/index.html: could not find the closing "Effects" section </div> after the "Showing / Also included" line'
  );
  assertPackedProseSite(docsIndexHtml, showingEnd, showingBlockEnd, packedLabels, showingSiteDescription);
});

test('welcome.html "Choose from N core effects" count matches effectsRegistry\'s core entries', () => {
  const contentJsSource = fs.readFileSync(CONTENT_JS, 'utf8');
  const registryEntries = extractRegistryEntries(contentJsSource);
  const coreLabels = registryEntries.filter((e) => !e.pack).map((e) => e.label);

  const welcomeHtml = fs.readFileSync(WELCOME_HTML, 'utf8');
  const countMatch = welcomeHtml.match(/Choose from (\d+) core effects/);
  assert.ok(
    countMatch,
    'extension/welcome.html: could not find a "Choose from N core effects" phrase — did the wording change?'
  );

  const statedCount = Number(countMatch[1]);
  assert.strictEqual(
    statedCount,
    coreLabels.length,
    `extension/welcome.html says "Choose from ${statedCount} core effects", but ` +
      `effectsRegistry in extension/content.js currently declares ${coreLabels.length} core (unpacked) effects. ` +
      `extension/welcome.html is stale.`
  );
});
