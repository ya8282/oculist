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
// oculist-7db extends the scan from the flat test/*.test.js glob to also cover
// test/helpers/*.js: node --test runs each *.test.js file in its own process, so the
// invariant is really per-process, and a helper that launches a context is just as able to
// get an unscaled default timeout as a test file is. A file inside test/helpers/ requiring
// its sibling wait.js writes `require('./wait')`, not `require('./helpers/wait')`, so each
// scanned file is checked against the require form that is actually correct for its own
// directory — never a looser combined pattern. test/helpers/wait.js itself is exempted by
// name below: it performs the monkeypatch, so it has no reason to require itself, and its
// own header comment mentions `launchPersistentContext(...)`, which would otherwise trip
// the launch-call check.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const HELPERS_DIR = path.join(TEST_DIR, 'helpers');
const WAIT_HELPER_FILE = path.join(HELPERS_DIR, 'wait.js');
const LAUNCH_CALL_RE = /\.launchPersistentContext\s*\(/;
const WAIT_REQUIRE_RE = /require\(\s*['"]\.\/helpers\/wait['"]\s*\)/;
const SIBLING_WAIT_REQUIRE_RE = /require\(\s*['"]\.\/wait['"]\s*\)/;

test('every test/*.test.js and test/helpers/*.js file calling launchPersistentContext also requires helpers/wait', () => {
  const topLevelTargets = fs
    .readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(TEST_DIR, name))
    // Exclude this guard's own file: its failure-message text mentions both patterns by
    // name, so scanning it would make the guard's result depend on how that message is
    // worded rather than on any real test file.
    .filter((file) => file !== __filename)
    .map((file) => ({ file, waitRe: WAIT_REQUIRE_RE, fix: "require('./helpers/wait')" }));

  const helperTargets = fs
    .readdirSync(HELPERS_DIR)
    // .cjs/.mjs too: a helper that launches a context is unchecked whatever its extension,
    // and a guard's whole job is catching the file someone forgot about.
    .filter((name) => /\.(js|cjs|mjs)$/.test(name))
    .map((name) => path.join(HELPERS_DIR, name))
    // Exclude wait.js itself — see the oculist-7db comment above.
    .filter((file) => file !== WAIT_HELPER_FILE)
    .map((file) => ({ file, waitRe: SIBLING_WAIT_REQUIRE_RE, fix: "require('./wait')" }));

  const targets = [...topLevelTargets, ...helperTargets].sort((a, b) => a.file.localeCompare(b.file));
  // Without this the whole test passes vacuously if the scan ever finds no files.
  assert.ok(targets.length > 0, `found no scannable files under ${TEST_DIR} — the invariant proved nothing`);

  const missingWaitImport = [];
  for (const { file, waitRe, fix } of targets) {
    const raw = fs.readFileSync(file, 'utf8');
    if (LAUNCH_CALL_RE.test(raw) && !waitRe.test(raw)) {
      missingWaitImport.push(`${path.relative(TEST_DIR, file)} (fix: add \`const { POLL_TIMEOUT } = ${fix};\`)`);
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
