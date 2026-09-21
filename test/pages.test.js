const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist');
const pages = fs.readdirSync(dist).filter(f => f.endsWith('.html'));

test('No page has two elements with one id, and every id a page\'s script asks for exists', () => {
  assert.ok(pages.length >= 5);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(dist, page), 'utf8');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    assert.deepEqual(twice, [], page + ' uses an id twice; the second one silently takes the first one\'s content');
    // $('some-id') in the page's own script must find something.
    for (const script of [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1])) {
      const code = fs.readFileSync(path.join(dist, script), 'utf8');
      const asked = [...new Set([...code.matchAll(/\$\('([a-z][a-z0-9-]*)'\)/g)].map(m => m[1]))];
      assert.deepEqual(asked.filter(id => !ids.includes(id)), [], script + ' asks ' + page + ' for ids it does not have');
    }
  }
});
