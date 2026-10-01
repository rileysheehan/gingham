// Colour lives in dist/tokens.css (DESIGN.md → "Colour lives in tokens.css"). These keep it there: one copy of each
// value, the same names in both themes, and every page reading it.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tokens = read('dist/tokens.css');
const block = opening => { const at = tokens.indexOf(opening); assert.ok(at >= 0, opening); return tokens.slice(at + opening.length, tokens.indexOf('}', at)); };
const declarations = css => css.replace(/\/\*[\s\S]*?\*\//g, '').split(';').map(d => d.trim()).filter(Boolean);
const names = css => declarations(css).map(d => d.split(':')[0]).sort();

test('The dark theme is the same for the wall and the phone, and has every name the light one has', () => {
  const light = block('\n:root,.theme-light{'), phoneDark = block('(prefers-color-scheme:dark){:root{'), wallDark = block('\n.theme-dark{');
  assert.deepEqual(declarations(phoneDark), declarations(wallDark));
  assert.deepEqual(names(wallDark), names(light));
});

test('The pages declare no colour tokens of their own', () => {
  // Every semantic token: the themed ones, and the ones the same in both themes (the sky's defaults, the sun, the rain…).
  const sharedAt = tokens.lastIndexOf(':root{', tokens.indexOf('--sky-top:')), shared = tokens.slice(sharedAt + 6, tokens.indexOf('}', sharedAt));
  const semantic = names(block('\n:root,.theme-light{')).concat(names(shared));
  assert.ok(semantic.includes('--sky-ink') && semantic.includes('--sun'), 'the shared block is read');
  for (const file of ['dist/style.css', 'dist/setup.css']) {
    const declared = [...read(file).matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]);
    assert.deepEqual(declared.filter(name => semantic.includes(name)), [], file);
  }
});

test('Every page links tokens.css before its own stylesheet', () => {
  const pages = fs.readdirSync(path.join(root, 'dist')).filter(f => f.endsWith('.html')).map(f => 'dist/' + f).concat('setup.js');
  for (const page of pages) {
    const sheets = [...read(page).matchAll(/<link rel="stylesheet" href="\/([^"]+)">/g)].map(m => m[1]);
    assert.ok(sheets.length, page + ' links no stylesheet');
    assert.equal(sheets[0], 'tokens.css', page);
  }
});
