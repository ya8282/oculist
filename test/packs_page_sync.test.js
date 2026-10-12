// docs/packs.html lists every effect by name. This ties each list to the
// effectsRegistry in extension/content.js (same source-scan style as
// effect_enumeration_sync.test.js) so the page cannot drift.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const content = fs.readFileSync(path.resolve(__dirname, '../extension/content.js'), 'utf8');
const page = fs.readFileSync(path.resolve(__dirname, '../docs/packs.html'), 'utf8');

function registry() {
  const start = content.indexOf('var effectsRegistry = {');
  const block = content.slice(start, content.indexOf('\n  };', start));
  return [...block.matchAll(/\{([^}]*)\}/g)].map(([, body]) => {
    const key = body.match(/label:\s*i18n\.(\w+)/)[1];
    const label = content.match(new RegExp(key + ":\\s*'((?:[^'\\\\]|\\\\.)*)'"))[1].replace(/\\(.)/g, '$1');
    const pack = body.match(/pack:\s*'(\w+)'/);
    return { label, pack: pack ? pack[1] : null };
  });
}

const names = (html) => [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);

test('docs/packs.html effect lists match the registry for each pack', () => {
  const entries = registry();
  const packIds = [...new Set(entries.filter((e) => e.pack).map((e) => e.pack))];
  assert.ok(packIds.length > 0, 'registry has no packed entries; parser broken');
  const cards = [...page.matchAll(/<section class="pack" data-pack="(\w+)">([\s\S]*?)<\/section>/g)];
  assert.deepStrictEqual(cards.map((c) => c[1]), packIds, 'page pack cards differ from registry pack ids');
  for (const [, id, body] of cards) {
    assert.deepStrictEqual(
      names(body),
      entries.filter((e) => e.pack === id).map((e) => e.label),
      `docs/packs.html pack "${id}" differs from the registry`
    );
  }
  const core = page.match(/<div class="core" id="core">[\s\S]*?<p>([^<]*)\.<\/p>/)[1].split(', ');
  assert.deepStrictEqual(core, entries.filter((e) => !e.pack).map((e) => e.label), 'core effects line differs from the registry');
});
