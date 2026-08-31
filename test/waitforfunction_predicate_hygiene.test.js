// Structural guard against the oculist-66m defect shape: page.waitForFunction() predicates
// that return a Promise. A Promise is always truthy, so Playwright's polling loop resolves
// on the very first tick regardless of whether the awaited condition is actually true —
// page.waitForFunction(() => chrome.storage.sync.get(...).then(...)) is the canonical
// example (see test/wizard_no_clinical_persistence.test.js for the full writeup). That bug
// was found by hand in 16 places; this test makes the whole class self-policing by scanning
// every waitForFunction( call site under test/, at run time, for a predicate whose body
// contains `async`, `.then(`, or `await`.
//
// This is a static-analysis test, not a browser one: it reads and lexes the real .js files
// under test/ on every run, so it catches the defect shape in any file added after this test
// was written, not just the ones known to have had it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;

// ---- Minimal JS lexer, just enough to strip comments and string/template contents -----
//
// Replaces the *contents* of // line comments, /* */ block comments, and '...'/"..."/`...`
// string literals with spaces (preserving every newline and the overall string length), so:
//   - a comment merely describing the bad pattern (e.g. the one in
//     test/wizard_no_clinical_persistence.test.js documenting why it's avoided) cannot trip
//     this scan — its text is gone before any pattern matching happens.
//   - real parentheses left standing in the masked text are exactly the parentheses that
//     matter for balancing a call's own argument list; a stray ')' or '(' inside a string
//     argument can no longer throw off that count.
//   - line numbers computed against the *original* source (which this function never
//     shortens or lengthens) stay valid against offsets found in the masked text.
//
// Two deliberate simplifications, both verified safe against this repo's current test/
// corpus (see oculist-0ha):
//   - Regex literals (/.../ ) are not specially lexed. The only regex literals that appear
//     inside a waitForFunction(...) call in this codebase contain no parentheses and no
//     forbidden keywords, so leaving their characters as plain code is harmless here.
//   - A template literal is treated as one opaque span from its opening backtick to the
//     next *unescaped* backtick — a ${...} interpolation is not parsed as nested code. No
//     template literal in this corpus contains a nested backtick or straddles a
//     waitForFunction(...) call, so this is safe today; a future template literal whose
//     ${} expression contains an unbalanced paren could evade detection.
function maskNonCode(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let state = 'code'; // 'code' | 'line' | 'block' | "'" | '"' | '`'
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';

    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        out[i] = ' ';
        i += 1;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        i += 1;
        continue;
      }
      out[i] = ' ';
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        state = 'code';
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }

    // Inside a '...'/"..."/`...` literal: `state` holds the delimiter character.
    if (c === '\\') {
      out[i] = ' ';
      if (i + 1 < n) out[i + 1] = ' ';
      i += 2;
      continue;
    }
    if (c === state) {
      state = 'code';
      i += 1;
      continue;
    }
    if (c !== '\n') out[i] = ' ';
    i += 1;
  }
  return out.join('');
}

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

function listJsFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Finds every `waitForFunction(` call site in already-masked `code` and returns each one's
// full, paren-balanced argument-list text plus the source index of its opening '(' (for
// line-number lookup against the original file).
function extractWaitForFunctionCalls(code) {
  const calls = [];
  const callRe = /\bwaitForFunction\s*\(/g;
  let m;
  while ((m = callRe.exec(code))) {
    const openParenIndex = m.index + m[0].length - 1;
    let depth = 0;
    let i = openParenIndex;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push({ openParenIndex, argsText: code.slice(openParenIndex + 1, i) });
  }
  return calls;
}

// The predicate is always waitForFunction()'s first argument. Splits it off at the first
// comma that sits outside every (), {} and [] nesting — the same rule a real argument list
// splits on — so a predicate like `() => { ... }` isn't confused with the `arg, options`
// that may follow it.
function firstArgument(argsText) {
  let depth = 0;
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) return argsText.slice(0, i);
  }
  return argsText;
}

const FORBIDDEN_PATTERNS = [
  { label: 'async', re: /\basync\b/ },
  { label: 'await', re: /\bawait\b/ },
  { label: '.then(', re: /\.then\s*\(/ },
];

test('no page.waitForFunction() predicate returns a Promise (async/await/.then())', () => {
  const files = listJsFilesRecursive(TEST_DIR).filter((f) => f !== __filename);
  const violations = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const masked = maskNonCode(raw);
    for (const call of extractWaitForFunctionCalls(masked)) {
      const predicate = firstArgument(call.argsText);
      for (const { label, re } of FORBIDDEN_PATTERNS) {
        if (re.test(predicate)) {
          violations.push(
            `${path.relative(process.cwd(), file)}:${lineAt(raw, call.openParenIndex)} — ` +
              `waitForFunction() predicate contains ${label}, which makes the wait vacuous ` +
              `(a Promise is always truthy, so it resolves on the first poll)`
          );
        }
      }
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `found vacuous waitForFunction() predicate(s):\n${violations.join('\n')}`
  );
});
