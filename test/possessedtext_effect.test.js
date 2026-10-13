// Retired effect: stored selections must migrate without changing pack preferences.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeOcSettings } = require('../extension/settings-migration.js');

test('retired Possessed Text migrates to Anime Laser once, preserving preferences', () => {
  for (const enabledPacks of [[], ['halloween'], ['adventure']]) {
    const settings = { effect: 'possessedtext', enabledPacks, theme: 'dark' };
    assert.equal(normalizeOcSettings(settings), true);
    assert.equal(settings.effect, 'hud');
    assert.deepEqual(settings.enabledPacks, enabledPacks);
    assert.equal(settings.theme, 'dark');
    assert.equal(normalizeOcSettings(settings), false);
  }
});

test('other effect selections are unaffected by retirement', () => {
  for (const effect of ['ghostsweep', 'hud', 'cursedrune']) {
    const settings = { effect, enabledPacks: [] };
    assert.equal(normalizeOcSettings(settings), false);
    assert.equal(settings.effect, effect);
  }
});

test('Possessed Text is absent from runnable effects and current user-facing catalogs', () => {
  for (const file of ['extension/content.js', 'extension/welcome.html', 'docs/index.html', 'docs/packs.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(/possessedtext|effectPossessedText|animatePossessedText|Possessed Text/.test(source), false, file);
  }
});
