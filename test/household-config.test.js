// A household's config kept in the deployment's repository (households.js, settings.js → OVERLAY; DESIGN.md → "Household
// config lives in git"): what it may set, that it wins over settings.json and over Settings, that the value it replaces
// is taken out of settings.json once and logged, and that a household without one is exactly as it was.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createSettings, overlayFrom, OVERLAY} = require('../settings');
const {createHouseholds, validId, CONFIG_DIR} = require('../households');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'household-config-'));
const PLAY = {url: 'https://example.com/play/', returnAfterMinutes: 3};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('Household config: only the listed keys, each checked as settings.json’s would be; null means none', () => {
  assert.deepEqual(Object.keys(OVERLAY), ['playPage'], 'one key so far; adding one is a decision, not a typo');
  const good = overlayFrom({playPage: {url: ' https://Example.com/play/ '}});
  assert.deepEqual(good.values, {playPage: PLAY}, 'tidied, and three minutes unless given');
  assert.deepEqual([good.owned, good.retire, good.ignored, good.invalid], [['playPage'], ['playPage'], [], []]);
  const bad = overlayFrom({playPage: {url: 'javascript:alert(1)'}, rest: 'calendar', anything: 1});
  assert.deepEqual(bad.values, {});
  assert.deepEqual(bad.owned, ['playPage'], 'an invalid value still owns its key: the household has none until it is fixed');
  assert.deepEqual(bad.retire, [], 'but nothing is taken out of settings.json on the strength of a typo');
  assert.deepEqual(bad.invalid, ['playPage']);
  assert.deepEqual(bad.ignored, ['rest', 'anything'], 'Settings’ own choices are the family’s, not the config’s');
  const none = overlayFrom({playPage: null});
  assert.deepEqual([none.values, none.owned, none.retire], [{}, ['playPage'], ['playPage']]);
  for (const junk of [null, [], 'text', 42]) assert.deepEqual(overlayFrom(junk).owned, [], JSON.stringify(junk));
  for (const url of ['http://example.com/', 'https://user:pass@example.com/', 'data:text/html,hi', 'https://'])
    assert.deepEqual(overlayFrom({playPage: {url}}).values, {}, url);
});

test('Household config: it wins over settings.json, and Settings can neither change it nor copy it into the file', () => {
  const dir = scratch(), file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({textSize: 'larger', playPage: {url: 'https://elsewhere.example/'}}));
  const settings = createSettings({file, overlay: overlayFrom({playPage: PLAY})});
  assert.deepEqual(settings.read().playPage, PLAY, 'the config’s page, not the file’s');
  assert.equal(settings.read().textSize, 'larger', 'the family’s own choices are untouched');
  const next = settings.update({textSize: 'smaller', playPage: {url: 'https://evil.example/'}});
  assert.equal(next.textSize, 'smaller');
  assert.deepEqual(next.playPage, PLAY);
  assert.equal('playPage' in readJson(file), false, 'the config’s value lives in the config, never in settings.json');
  // Set to none by the config: nothing is served, whatever the file says.
  fs.writeFileSync(file, JSON.stringify({playPage: {url: 'https://elsewhere.example/'}}));
  assert.equal('playPage' in createSettings({file, overlay: overlayFrom({playPage: null})}).read(), false);
  // An invalid value in the config: none, not the file's.
  assert.equal('playPage' in createSettings({file, overlay: overlayFrom({playPage: {url: 'http://typo.example/'}})}).read(), false);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('Household config: the value it replaces is taken out of settings.json once, and only a valid config does that', () => {
  const dir = scratch(), file = path.join(dir, 'settings.json');
  const handWritten = {url: 'https://by-hand.example/?frame', returnAfterMinutes: 3};
  fs.writeFileSync(file, JSON.stringify({rest: 'calendar', playPage: handWritten}));
  const settings = createSettings({file, overlay: overlayFrom({playPage: PLAY})});
  assert.deepEqual(settings.retire(), {playPage: handWritten}, 'what was removed, for the log');
  assert.deepEqual(readJson(file), {rest: 'calendar'}, 'everything else in the file stays');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.deepEqual(settings.retire(), {}, 'once: the second time there is nothing to do');
  // A config with a broken value owns the key but throws nothing away.
  fs.writeFileSync(file, JSON.stringify({playPage: handWritten}));
  assert.deepEqual(createSettings({file, overlay: overlayFrom({playPage: {url: 'ftp://nope/'}})}).retire(), {});
  assert.deepEqual(readJson(file).playPage, handWritten);
  // No settings.json at all: none is made.
  const empty = path.join(dir, 'none.json');
  assert.deepEqual(createSettings({file: empty, overlay: overlayFrom({playPage: PLAY})}).retire(), {});
  assert.equal(fs.existsSync(empty), false);
  fs.rmSync(dir, {recursive: true, force: true});
});

// Two households on one server, one with a config file and one without, as households.js opens them.
function twoHouseholds(configFiles) {
  const data = scratch(), config = path.join(data, 'config'), logged = [];
  fs.mkdirSync(config);
  for (const [id, body] of Object.entries(configFiles)) fs.writeFileSync(path.join(config, id + '.json'), typeof body === 'string' ? body : JSON.stringify(body));
  for (const id of ['ours', 'theirs']) {
    const dir = path.join(data, 'households', id);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({name: id, calendars: [], projects: []}));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({mornings: 9, playPage: {url: 'https://by-hand.example/', returnAfterMinutes: 5}}));
  }
  const households = createHouseholds({root: path.join(data, 'households'), config, log: m => logged.push(m)});
  return {data, households, logged, settingsFile: id => path.join(data, 'households', id, 'settings.json')};
}

test('Household config: applied when the household is opened, the cleanup logged, and a household without one unchanged', () => {
  const h = twoHouseholds({ours: {playPage: PLAY}});
  const ours = h.households.get('ours'), theirs = h.households.get('theirs');
  assert.deepEqual(ours.settings.read().playPage, PLAY);
  assert.equal(ours.settings.read().mornings, 9);
  assert.deepEqual(readJson(h.settingsFile('ours')), {mornings: 9}, 'the hand-written value is gone from the file');
  assert.deepEqual(h.logged, ['ours: playPage is set in its household config now; removed it from settings.json, where it was {"url":"https://by-hand.example/","returnAfterMinutes":5}']);
  // The other household: no config, so its own settings.json is read as it always was, and nothing touches the file.
  assert.deepEqual(theirs.settings.read().playPage, {url: 'https://by-hand.example/', returnAfterMinutes: 5});
  assert.deepEqual(readJson(h.settingsFile('theirs')), {mornings: 9, playPage: {url: 'https://by-hand.example/', returnAfterMinutes: 5}});
  // Opened again (the same process): nothing more to do, nothing more said.
  h.households.get('ours');
  assert.equal(h.logged.length, 1);
  fs.rmSync(h.data, {recursive: true, force: true});
});

test('Household config: a broken file or an unknown key is said in the log and costs the household nothing else', () => {
  let h = twoHouseholds({ours: '{"playPage": {"url": "https://example.com/"'});
  assert.deepEqual(h.households.get('ours').settings.read().playPage, {url: 'https://by-hand.example/', returnAfterMinutes: 5}, 'unreadable: none of it applies');
  assert.match(h.logged.join('\n'), /^ours: its household config \(.*ours\.json\) could not be read, so none of it applies: /);
  assert.equal(readJson(h.settingsFile('ours')).playPage.url, 'https://by-hand.example/', 'and nothing is taken out');
  fs.rmSync(h.data, {recursive: true, force: true});
  h = twoHouseholds({ours: {playPage: PLAY, rest: 'calendar'}});
  const ours = h.households.get('ours');
  assert.equal(ours.settings.read().rest, 'photos', 'Settings’ choices cannot be set from the config');
  assert.ok(h.logged.includes('ours: household config: ignored rest (only playPage may be set there)'), h.logged.join('\n'));
  fs.rmSync(h.data, {recursive: true, force: true});
  h = twoHouseholds({ours: {playPage: {url: 'http://example.com/'}}});
  assert.equal('playPage' in h.households.get('ours').settings.read(), false);
  assert.ok(h.logged.includes('ours: household config: playPage is not valid, so the household has none until it is fixed'), h.logged.join('\n'));
  fs.rmSync(h.data, {recursive: true, force: true});
});

test('Household config: over HTTP, the frame reads it, a POST cannot change it, and the cleanup happens at start', async () => {
  const {startServer, makeData, writeHousehold} = require('./server-harness');
  const data = makeData('frame-config-'), dir = writeHousehold(data, 'home'), config = scratch();
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{}');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({textSize: 'larger', playPage: {url: 'https://by-hand.example/'}}));
  fs.writeFileSync(path.join(config, 'home.json'), JSON.stringify({playPage: {url: 'https://example.com/play/', returnAfterMinutes: 4}}));
  const s = await startServer({data, env: {FRAME_HOUSEHOLD_CONFIG: config}});
  try {
    const get = async () => (await fetch(s.url + '/api/settings')).json();
    assert.deepEqual((await get()).playPage, {url: 'https://example.com/play/', returnAfterMinutes: 4});
    assert.deepEqual(readJson(path.join(dir, 'settings.json')), {textSize: 'larger'}, 'taken out at start, before anyone asked');
    assert.match(s.output(), /home: playPage is set in its household config now; removed it from settings\.json, where it was \{"url":"https:\/\/by-hand\.example\/"\}/);
    const post = await fetch(s.url + '/api/settings', {method: 'POST', headers: {'x-gingham': '1', 'content-type': 'application/json'}, body: JSON.stringify({textSize: 'smaller', playPage: {url: 'https://evil.example/'}})});
    assert.equal(post.status, 200);
    const after = await get();
    assert.equal(after.textSize, 'smaller');
    assert.deepEqual(after.playPage, {url: 'https://example.com/play/', returnAfterMinutes: 4}, 'Settings cannot change it');
    assert.equal('playPage' in readJson(path.join(dir, 'settings.json')), false);
  } finally { await s.stop(); fs.rmSync(config, {recursive: true, force: true}); }
});

// What a deployment commits here is checked before it merges, not found broken in a server log after the deploy.
test('Every household config committed to this repository is valid, and sets only what it may', () => {
  let files = [];
  try { files = fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const file of files) {
    assert.ok(validId(file.slice(0, -5)), file + ' is named for a household id');
    const overlay = overlayFrom(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8')));
    assert.deepEqual(overlay.ignored, [], file + ' sets only keys the config may set');
    assert.deepEqual(overlay.invalid, [], file + ' has no value the server would drop');
  }
});
