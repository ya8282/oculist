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
// the set requiring helpers/wait. Scoped to test/*.test.js — the flat glob `npm test` (see
// package.json) actually runs — not test/helpers/*.js, which are library code, not files
// npm test executes directly.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const LAUNCH_CALL_RE = /\.launchPersistentContext\s*\(/;
const WAIT_REQUIRE_RE = /require\(\s*['"]\.\/helpers\/wait['"]\s*\)/;

test('every test/*.test.js file calling launchPersistentContext also requires helpers/wait', () => {
  const files = fs
    .readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.js'))
    // Exclude this guard's own file: its failure-message text mentions both patterns by
    // name, so scanning it would make the guard's result depend on how that message is
    // worded rather than on any real test file.
    .filter((name) => path.join(TEST_DIR, name) !== __filename)
    .sort();
  // Without this the whole test passes vacuously if the scan ever finds no test files.
  assert.ok(files.length > 0, `found no *.test.js files under ${TEST_DIR} — the invariant proved nothing`);

  const missingWaitImport = [];
  for (const name of files) {
    const raw = fs.readFileSync(path.join(TEST_DIR, name), 'utf8');
    if (LAUNCH_CALL_RE.test(raw) && !WAIT_REQUIRE_RE.test(raw)) {
      missingWaitImport.push(name);
    }
  }

  assert.deepStrictEqual(
    missingWaitImport,
    [],
    `file(s) call chromium.launchPersistentContext() without requiring test/helpers/wait, so ` +
      `the OCULIST_TEST_TIMEOUT_SCALE monkeypatch (test/helpers/wait.js) is not guaranteed to ` +
      `apply to their context: ${missingWaitImport.join(', ')}. Fix: add ` +
      `\`const { POLL_TIMEOUT } = require('./helpers/wait');\` (or any export it provides) to ` +
      `each listed file.`
  );
});
