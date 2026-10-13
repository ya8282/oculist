// oculist-xwq4.1: the unreleased 'hollow' pack was merged into 'halloween'.
// normalizeOcSettings() rewrites a stored 'hollow' to 'halloween' and drops seededHollowPack.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeOcSettings } = require('../extension/settings-migration.js');

const run = (enabledPacks, extra) => {
  const s = Object.assign({ enabledPacks }, extra);
  const changed = normalizeOcSettings(s);
  return { s, changed };
};

for (const [input, expected] of [
  [['hollow'], ['halloween']],
  [['halloween', 'hollow'], ['halloween']],
  [['hollow', 'halloween'], ['halloween']],
  [['adventure', 'hollow'], ['adventure', 'halloween']],
  [['hollow', 'hollow'], ['halloween']],
]) {
  test(`${JSON.stringify(input)} becomes ${JSON.stringify(expected)}`, () => {
    const { s, changed } = run(input);
    assert.deepStrictEqual(s.enabledPacks, expected);
    assert.strictEqual(changed, true);
  });
}

for (const input of [['halloween'], [], ['adventure'], ['halloween', 'adventure']]) {
  test(`${JSON.stringify(input)} is left unchanged`, () => {
    const { s, changed } = run(input.slice());
    assert.deepStrictEqual(s.enabledPacks, input);
    assert.strictEqual(changed, false);
  });
}

test('seededHollowPack is deleted', () => {
  const { s, changed } = run(['halloween'], { seededHollowPack: true });
  assert.ok(!('seededHollowPack' in s));
  assert.strictEqual(changed, true);
});

test('a non-array enabledPacks does not throw and is left alone', () => {
  for (const bad of [undefined, null, 'hollow', 5, { hollow: true }]) {
    const { s } = run(bad);
    assert.strictEqual(s.enabledPacks, bad);
  }
});

test('content.js registers all 16 Halloween effects and no hollow pack remains', () => {
  const src = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
  assert.strictEqual((src.match(/pack: 'halloween'/g) || []).length, 16);
  assert.ok(!/pack: 'hollow'/.test(src));
});
