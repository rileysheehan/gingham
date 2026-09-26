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

test('The calendar view is a household setting: Week unless chosen, Agenda once chosen, kept across a restart', () => {
  const file = tempFile(), settings = createSettings({file});
  assert.equal(settings.read().calendarView, 'week');
  assert.equal(settings.update({calendarView: 'list'}).calendarView, 'week', 'only the two views are accepted');
  assert.equal(settings.update({calendarView: 'agenda'}).calendarView, 'agenda');
  assert.equal(createSettings({file}).read().calendarView, 'agenda', 'survives a restart');
});

test('Text size is a household setting: Standard unless chosen, one of three, kept across a restart', () => {
  const file = tempFile(), settings = createSettings({file});
  assert.equal(settings.read().textSize, 'standard');
  assert.equal(settings.update({textSize: 'huge'}).textSize, 'standard', 'only the three sizes are accepted');
  assert.equal(settings.update({textSize: 1.12}).textSize, 'standard', 'a number is not a size');
  assert.equal(settings.update({textSize: 'smaller'}).textSize, 'smaller');
  assert.equal(settings.update({calendarView: 'agenda'}).textSize, 'smaller', 'changing another setting keeps it');
  assert.equal(createSettings({file}).read().textSize, 'smaller', 'survives a restart');
  assert.equal(settings.update({textSize: 'larger'}).textSize, 'larger');
});

// The play page (DESIGN.md → "A play page, for one household"): set only in the household's settings.json, never through
// the API, and dropped unless it is a plain https address.
const {cleanPlayPage} = require('../settings');

test('Play page: absent by default, and a valid one is read from the file with three minutes unless given', () => {
  assert.equal('playPage' in createSettings({file: tempFile()}).read(), false, 'no household has one unless it is written');
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({rest: 'calendar', playPage: {url: 'https://example.com/play/'}}));
  assert.deepEqual(createSettings({file}).read().playPage, {url: 'https://example.com/play/', returnAfterMinutes: 3});
  fs.writeFileSync(file, JSON.stringify({playPage: {url: ' https://Example.com ', returnAfterMinutes: 10}}));
  assert.deepEqual(createSettings({file}).read().playPage, {url: 'https://example.com/', returnAfterMinutes: 10}, 'tidied to one form');
});

test('Play page: only https, with no credentials in the address; anything else is dropped whole', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>hi</b>', 'http://example.com/', 'file:///etc/passwd',
    'ftp://example.com/', 'intent://example.com#Intent;end', 'https://user:pass@example.com/', 'https://user@example.com/', '//example.com/',
    'example.com', '', 'https://', 'https://example.com/' + 'x'.repeat(2000)])
    assert.equal(cleanPlayPage({url}), null, url);
  for (const value of [null, undefined, 'https://example.com/', ['https://example.com/'], {url: 42}, {href: 'https://example.com/'}])
    assert.equal(cleanPlayPage(value), null, JSON.stringify(value));
  for (const [given, kept] of [[0, 3], [31, 3], [2.5, 3], ['5', 3], [-1, 3], [1, 1], [30, 30]])
    assert.equal(cleanPlayPage({url: 'https://example.com/', returnAfterMinutes: given}).returnAfterMinutes, kept, String(given));
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({mornings: 9, playPage: {url: 'javascript:alert(1)'}}));
  const read = createSettings({file}).read();
  assert.equal('playPage' in read, false);
  assert.equal(read.mornings, 9, 'a bad play page costs nothing else in the file');
});

test('Play page: the frame can neither set nor change it, and a change it makes keeps it', () => {
  const file = tempFile(), settings = createSettings({file});
  assert.equal('playPage' in settings.update({playPage: {url: 'https://example.com/'}}), false, 'a household without one cannot be given one');
  fs.writeFileSync(file, JSON.stringify({playPage: {url: 'https://example.com/play/', returnAfterMinutes: 5}}));
  const next = settings.update({textSize: 'larger', playPage: {url: 'https://example.org/elsewhere'}});
  assert.equal(next.textSize, 'larger');
  assert.deepEqual(next.playPage, {url: 'https://example.com/play/', returnAfterMinutes: 5}, 'kept as the file had it');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).playPage, {url: 'https://example.com/play/', returnAfterMinutes: 5});
  fs.writeFileSync(file, JSON.stringify({playPage: {url: 'http://example.com/typo'}}));
  assert.equal('playPage' in settings.update({textSize: 'smaller'}), false, 'an invalid one is never served');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).playPage, {url: 'http://example.com/typo'}, 'but a Settings change does not erase it');
});

test('Play page: over HTTP, the household\'s frame reads it and a POST cannot write it', async () => {
  const {startServer, makeData, writeHousehold} = require('./server-harness');
  const data = makeData('frame-play-'), dir = writeHousehold(data, 'home');
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{}');
  const s = await startServer({data});
  try {
    const get = async () => (await fetch(s.url + '/api/settings')).json();
    assert.equal('playPage' in await get(), false, 'absent by default');
    const post = await fetch(s.url + '/api/settings', {method: 'POST', headers: {'x-gingham': '1', 'content-type': 'application/json'}, body: JSON.stringify({playPage: {url: 'https://example.com/'}})});
    assert.equal(post.status, 200);
    assert.equal('playPage' in await get(), false, 'the API never sets it');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({playPage: {url: 'https://example.com/play/'}}));
    assert.deepEqual((await get()).playPage, {url: 'https://example.com/play/', returnAfterMinutes: 3});
  } finally { await s.stop(); }
});
