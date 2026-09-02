// oculist-8ou (commit c8db638) makes test/helpers/wait.js monkeypatch
// chromium.launchPersistentContext so every context it launches gets its default action
// timeout scaled by OCULIST_TEST_TIMEOUT_SCALE. That works only because playwright's
// exported `chromium` is a process-wide singleton and, at the time, every test file that
// called launchPersistentContext also required helpers/wait (for POLL_TIMEOUT/LONG_TIMEOUT).
// A test file that calls launchPersistentContext WITHOUT requiring helpers/wait would still
// pass today — the monkeypatch runs regardless, as long as *some* other file required
// helpers/wait first and node's require cache is warm — but that is a load-order accident,
// not a guarantee, and nothing currently checks it. This is a static source scan, not a
// browser test: it never launches Chromium, so it costs nothing to run on every `npm test`.
//
// DONE WHEN (oculist-du2): the set of files calling launchPersistentContext is a subset of
// the set requiring helpers/wait.
//
// oculist-7db extended the scan to also cover test/helpers/*.js, since node --test runs
// each file in its own process. oculist-2uk collapses both into one recursive walk of test/
// (so nested helpers and non-*.test.js top-level files aren't invisible) and derives the
// require specifier per file from its own directory via path.relative, rather than by which
// glob matched. test/helpers/wait.js is exempted by name: it performs the monkeypatch
// itself, and its header text would otherwise trip the launch-call check.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const HELPERS_DIR = path.join(TEST_DIR, 'helpers');
const WAIT_HELPER_FILE = path.join(HELPERS_DIR, 'wait.js');
const LAUNCH_CALL_RE = /\.launchPersistentContext\s*\(/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The require specifier that is correct for `file` depends only on its own directory.
const waitSpecifierFor = (file) => {
  const rel = path.relative(path.dirname(file), WAIT_HELPER_FILE).replace(/\.js$/, '').split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

test('every test/**/*.{js,cjs,mjs} file calling launchPersistentContext also requires helpers/wait', () => {
  // Recursive, and .cjs/.mjs too — a guard's whole job is catching the file someone forgot.
  const targets = fs
    .readdirSync(TEST_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => /\.(js|cjs|mjs)$/.test(file))
    // Exclude this guard's own file (its failure text names the require forms) and wait.js
    // itself (it performs the monkeypatch, so has no reason to require itself).
    .filter((file) => file !== __filename && file !== WAIT_HELPER_FILE)
    .sort((a, b) => a.localeCompare(b));
  // Without this the whole test passes vacuously if the scan ever finds no files.
  assert.ok(targets.length > 0, `found no scannable files under ${TEST_DIR} — the invariant proved nothing`);

  const missingWaitImport = [];
  for (const file of targets) {
    const raw = fs.readFileSync(file, 'utf8');
    const specifier = waitSpecifierFor(file);
    const waitRe = new RegExp(`require\\(\\s*['"]${escapeRe(specifier)}['"]\\s*\\)`);
    if (LAUNCH_CALL_RE.test(raw) && !waitRe.test(raw)) {
      missingWaitImport.push(`${path.relative(TEST_DIR, file)} (fix: add \`const { POLL_TIMEOUT } = require('${specifier}');\`)`);
    }
  }

  assert.deepStrictEqual(
    missingWaitImport,
    [],
    `file(s) call chromium.launchPersistentContext() without requiring test/helpers/wait, so ` +
      `the OCULIST_TEST_TIMEOUT_SCALE monkeypatch (test/helpers/wait.js) is not guaranteed to ` +
      `apply to their context: ${missingWaitImport.join(', ')}.`
  );
});
