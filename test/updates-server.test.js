// The update check as the server serves it (/api/updates): the real version in each form it runs in, the switch in
// Settings, who may flip it, and data from 0.1.0 read by this version.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {startServer, makeData, writeHousehold} = require('./server-harness');
const {createHouseholds} = require('../households');
const {createSettings, DEFAULTS} = require('../settings');

const VERSION = require('../package.json').version;
const ours = {'X-Gingham': '1', 'Content-Type': 'application/json'};

test('The server reports package.json’s version, and the form it runs in', async () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, 'package.json carries a plain release version');
  for (const [form, expected] of [[undefined, 'node'], ['container', 'container'], ['app', 'app'], ['nonsense', 'node']]) {
    const data = makeData(); writeHousehold(data, 'home');
    const s = await startServer({data, env: form ? {GINGHAM_FORM: form} : {}});
    try {
      const body = await (await fetch(s.url + '/api/updates')).json();
      assert.equal(body.version, VERSION);
      assert.equal(body.form, expected);
      assert.equal(body.check, true, 'on by default');
      assert.equal(body.mayChange, true, 'one household: its frame may turn it off');
      assert.equal(body.latest, null, 'nothing known before the first check');
    } finally { await s.stop(); }
  }
});

test('The switch in Settings is kept on the server, needs our header, and a shared server leaves it to its operator', async () => {
  const data = makeData(); writeHousehold(data, 'home');
  let s = await startServer({data: data, env: {}});
  const keep = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'updates-keep-'));
  try {
    assert.equal((await fetch(s.url + '/api/updates', {method: 'POST', body: '{"check":false}', headers: {'Content-Type': 'application/json'}})).status, 403, 'no header, no change');
    assert.equal((await fetch(s.url + '/api/updates', {method: 'POST', body: '{"check":"no"}', headers: ours})).status, 400);
    const off = await (await fetch(s.url + '/api/updates', {method: 'POST', body: '{"check":false}', headers: ours})).json();
    assert.equal(off.check, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'updates.json'), 'utf8')).check, false);
    fs.cpSync(data, keep, {recursive: true});
  } finally { await s.stop(); }
  // Restarted on the same data: still off.
  s = await startServer({data: keep});
  try { assert.equal((await (await fetch(s.url + '/api/updates')).json()).check, false); } finally { await s.stop(); }

  const shared = makeData(); writeHousehold(shared, 'one'); writeHousehold(shared, 'two');
  s = await startServer({data: shared});
  try {
    assert.equal((await (await fetch(s.url + '/api/updates')).json()).mayChange, false);
    assert.equal((await fetch(s.url + '/api/updates', {method: 'POST', body: '{"check":false}', headers: ours})).status, 403);
  } finally { await s.stop(); }

  const locked = makeData(); writeHousehold(locked, 'home');
  s = await startServer({data: locked, env: {GINGHAM_UPDATE_CHECK: 'off'}});
  try {
    const body = await (await fetch(s.url + '/api/updates')).json();
    assert.equal(body.check, false); assert.equal(body.locked, true); assert.equal(body.mayChange, false);
    assert.equal((await fetch(s.url + '/api/updates', {method: 'POST', body: '{"check":true}', headers: ours})).status, 403);
  } finally { await s.stop(); }
});

test('Check now: one press asks GitHub at once, with the switch’s authority, at most once a minute for the server', async () => {
  const http = require('node:http');
  const releases = require('./release-fixture');
  let asked = 0;
  const github = http.createServer((req, res) => { asked++; res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(releases.newer)); });
  await new Promise(resolve => github.listen(0, '127.0.0.1', resolve));
  const env = {GINGHAM_UPDATE_URL: 'http://127.0.0.1:' + github.address().port + '/repos/rileysheehan/gingham/releases/latest'};
  const data = makeData(); writeHousehold(data, 'home');
  let s = await startServer({data, env});
  try {
    assert.equal((await fetch(s.url + '/api/updates/check', {method: 'POST', headers: {'Content-Type': 'application/json'}})).status, 403, 'no header, no check');
    assert.equal((await fetch(s.url + '/api/updates/check')).status, 405);
    const first = await fetch(s.url + '/api/updates/check?app=0.1.0', {method: 'POST', headers: ours, body: '{}'});
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.latest.version, releases.newer.tag_name.slice(1));
    assert.equal(body.appAvailable, true, 'the app’s own version is compared, as in GET');
    assert.equal(body.mayChange, true);
    assert.ok(body.checkedAt);
    assert.equal(asked, 1);
    const again = await fetch(s.url + '/api/updates/check', {method: 'POST', headers: ours, body: '{}'});
    assert.equal(again.status, 429);
    const refused = await again.json();
    assert.equal(refused.error, 'Checked a moment ago. Try again in a minute.');
    assert.ok(refused.retryAt > Date.now());
    assert.equal(refused.latest.version, body.latest.version, 'and still says what it knows');
    assert.equal(asked, 1, 'GitHub is not asked twice in a minute');
    assert.equal((await (await fetch(s.url + '/api/updates')).json()).latest.version, body.latest.version, 'Settings’ next look sees it too');
    await fetch(s.url + '/api/updates', {method: 'POST', headers: ours, body: '{"check":false}'});
    assert.equal((await fetch(s.url + '/api/updates/check', {method: 'POST', headers: ours, body: '{}'})).status, 409, 'off means off');
  } finally { await s.stop(); }
  // Where the frame may not flip the switch, it may not press this either.
  const shared = makeData(); writeHousehold(shared, 'one'); writeHousehold(shared, 'two');
  s = await startServer({data: shared, env});
  try { assert.equal((await fetch(s.url + '/api/updates/check', {method: 'POST', headers: ours, body: '{}'})).status, 403); } finally { await s.stop(); }
  const locked = makeData(); writeHousehold(locked, 'home');
  s = await startServer({data: locked, env: {...env, GINGHAM_UPDATE_CHECK: 'off'}});
  try { assert.equal((await fetch(s.url + '/api/updates/check', {method: 'POST', headers: ours, body: '{}'})).status, 403); } finally { await s.stop(); }
  assert.equal(asked, 1);
  github.closeAllConnections(); github.close();
});

test('Design review never asks GitHub, and shows a newer release when told to', async () => {
  const s = await startServer({env: {FRAME_FIXTURE: 'stress', FRAME_FIXTURE_UPDATE: 'available'}});
  try {
    let body;
    for (let i = 0; i < 20 && !(body && body.latest); i++) { body = await (await fetch(s.url + '/api/updates')).json(); if (!body.latest) await new Promise(r => setTimeout(r, 50)); }
    assert.equal(body.latest.version, require('./release-fixture').newer.tag_name.slice(1));
    assert.equal(body.available, true);
    assert.equal((await (await fetch(s.url + '/api/updates?app=0.1.0')).json()).appAvailable, true);
  } finally { await s.stop(); }
});

// Forward only: whatever 0.1.0 wrote, this version reads as it was meant, and writes nothing an older version cannot
// read. Checked against the formats as they were at the 0.1.0 release: a household's sources.json without a country,
// settings.json without the clock, and no updates.json at all.
test('A household’s data from 0.1.0 reads cleanly in this version', () => {
  const data = makeData();
  const dir = writeHousehold(data, 'home', {name: 'Home', place: {label: 'Austin', latitude: 30.27, longitude: -97.74}});
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({rest: 'calendar', restAfter: 10, mornings: 8, photoEvery: 120, appearance: 'dark', screen: 'dim'}));
  const home = createHouseholds({root: path.join(data, 'households')}).get('home');
  const place = home.place();
  assert.equal(place.country, '', 'no country yet: the clock stays 12-hour until the place is picked again');
  assert.equal(place.latitude, 30.27);
  const settings = home.settings.read();
  assert.equal(settings.clock, DEFAULTS.clock, 'the new setting takes its default');
  assert.equal(settings.calendarView, 'week', 'and so does 0.1.2’s calendar view: the columns it always had');
  assert.equal(settings.textSize, 'standard', 'and 0.1.3’s text size: the size it always had');
  assert.equal(settings.rest, 'calendar'); assert.equal(settings.screen, 'dim'); assert.equal(settings.mornings, 8);
  // An older version reading what this one writes: it drops what it does not know and keeps the rest.
  const written = home.settings.update({clock: '24'});
  const olderClean = input => Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'clock' && k !== 'calendarView' && k !== 'textSize'));
  assert.deepEqual(olderClean(written), {rest: 'calendar', restAfter: 10, mornings: 8, photoEvery: 120, appearance: 'dark', screen: 'dim'});
  assert.equal(createSettings({file: path.join(dir, 'settings.json')}).read().clock, '24');
  fs.rmSync(data, {recursive: true, force: true});
});
