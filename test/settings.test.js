const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createSettings, DEFAULTS} = require('../settings');

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-')), 'settings.json');

test('Settings start at the defaults, which match how the frame behaved before settings existed', () => {
  assert.deepEqual(createSettings({file: tempFile()}).read(), DEFAULTS);
  assert.equal(DEFAULTS.rest, 'photos'); assert.equal(DEFAULTS.restAfter, 5); assert.equal(DEFAULTS.mornings, 0);
});

test('Only listed values are stored; anything else is ignored, not saved', () => {
  const file = tempFile(), settings = createSettings({file});
  const next = settings.update({rest: 'calendar', restAfter: 7, photoEvery: '60', appearance: 'dark', sneaky: 'x'});
  assert.equal(next.rest, 'calendar');
  assert.equal(next.restAfter, DEFAULTS.restAfter, 'a value that is not an option is ignored');
  assert.equal(next.photoEvery, DEFAULTS.photoEvery, 'a string is not a number');
  assert.equal(next.appearance, 'dark');
  assert.equal('sneaky' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
  assert.equal(createSettings({file}).read().rest, 'calendar', 'survives a restart');
});

test('A damaged settings file falls back to the defaults instead of breaking the frame', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(createSettings({file}).read(), DEFAULTS);
});

test('Design-review mode keeps settings in memory and never writes the live file', () => {
  const file = tempFile(), settings = createSettings({file, persist: false});
  assert.equal(settings.update({mornings: 9}).mornings, 9);
  assert.equal(fs.existsSync(file), false);
});
