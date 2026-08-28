// PRIVACY.md and docs/privacy.html both make an absolute claim: "Oculist writes to
// no other storage area — it never touches chrome.storage.local." That claim only
// holds if no source file anywhere in extension/ (including inline <script> blocks
// in the HTML files) ever calls localStorage or sessionStorage. This is a static
// source scan, not a browser test, so it needs no page/fixture/timeout budget.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_DIR = path.resolve(__dirname, '../extension');
const SCANNABLE_EXTENSIONS = new Set(['.js', '.html']);
const FORBIDDEN_PATTERN = /\b(localStorage|sessionStorage)\b/g;

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (SCANNABLE_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

test('no file under extension/ touches localStorage or sessionStorage', () => {
  const files = walk(EXTENSION_DIR);
  // Without this the whole test passes vacuously if the walk ever returns nothing.
  assert.ok(files.length > 0, `scanned no files under ${EXTENSION_DIR} — the invariant proved nothing`);
  const offenses = [];

  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8');
    const lines = contents.split('\n');
    lines.forEach((line, index) => {
      if (FORBIDDEN_PATTERN.test(line)) {
        offenses.push(`${path.relative(EXTENSION_DIR, file)}:${index + 1}: ${line.trim()}`);
      }
      FORBIDDEN_PATTERN.lastIndex = 0;
    });
  }

  assert.deepStrictEqual(
    offenses,
    [],
    'PRIVACY.md and docs/privacy.html both state that Oculist writes to no storage ' +
      'area other than the chrome.storage.* ones they list — this file uses ' +
      'localStorage/sessionStorage, which would make that claim false:\n' +
      offenses.join('\n')
  );
});
