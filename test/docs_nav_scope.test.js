// A bare `nav {` rule also styles <nav class="footer-links"> (sticky, 60px, border).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

for (const f of ['index.html', 'packs.html']) {
  test(`docs/${f} has no bare nav rule that styles the footer nav`, () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../docs', f), 'utf8');
    assert.ok(html.includes('<nav class="footer-links"'), 'footer nav missing; test is vacuous');
    const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(',')).map((s) => s.trim());
    assert.ok(!selectors.includes('nav'), 'bare nav rule matches the footer nav');
  });
}
