const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createHouseholds} = require('../households');
const {createGrants} = require('../grants');
const {createVault} = require('../vault');
const {createSetup} = require('../setup');

const ICS = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Standing lunch\r\nDTSTART;TZID=America/Chicago:20200106T120000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR';
function world() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  for (const id of ['alpha', 'beta']) { fs.mkdirSync(path.join(data, 'households', id), {recursive: true}); fs.writeFileSync(path.join(data, 'households', id, 'sources.json'), JSON.stringify({name: id, calendars: [], projects: [], people: [{id: '7', name: 'Kept'}]})); }
  const households = createHouseholds({root: path.join(data, 'households'), vault: createVault({masterKey: crypto.randomBytes(32).toString('base64')})});
  const grants = createGrants({file: path.join(data, 'grants.json')});
  const asked = [];
  const setup = createSetup({households, grants,
    feed: async link => { asked.push(link); if (/broken/.test(link)) throw Error('The calendar link answered 404'); return {status: 200, text: ICS}; },
    fetchImpl: async (url, options) => /todoist/.test(url)
      ? (options.headers.Authorization === 'Bearer good-token' ? new Response(JSON.stringify({results: [{id: 'P1', name: 'Home'}, {id: 'P2', name: 'Chores', parent_id: 'P1'}, {id: 'P3', name: 'Inbox', inbox_project: true}]})) : new Response('', {status: 401}))
      : new Response(JSON.stringify({results: [{name: 'Austin', admin1: 'Texas', country: 'United States', latitude: 30.27, longitude: -97.74, timezone: 'America/Chicago'}, {name: 'Nowhere', timezone: 'Not/AZone', latitude: 0, longitude: 0}]}))});
  const grant = (scope, household) => grants.verify(grants.add({scope, household, label: scope}).secret);
  const call = (g, method, p, body) => setup.handle({method, url: new URL('http://x' + p), grant: g, body});
  return {data, households, grants, setup, asked, grant, call};
}

test('Only an owner of that household, or an admin naming it, gets in', async () => {
  const w = world(), ownerA = w.grant('owner', 'alpha'), frameA = w.grant('frame', 'alpha'), admin = w.grant('admin');
  assert.equal((await w.call(ownerA, 'GET', '/api/setup')).body.household.id, 'alpha');
  assert.equal((await w.call(ownerA, 'GET', '/api/setup?household=beta')).body.household.id, 'alpha', 'an owner cannot name another household');
  assert.equal((await w.call(frameA, 'GET', '/api/setup')).status, 403, 'a frame may show a household, not manage it');
  assert.equal((await w.call(null, 'GET', '/api/setup')).status, 401);
  assert.equal((await w.call(admin, 'GET', '/api/setup?household=beta')).body.household.id, 'beta');
  assert.equal((await w.call(admin, 'GET', '/api/setup')).status, 403, 'an admin must say which');
  assert.equal(await w.call(ownerA, 'GET', '/api/tasks'), null, 'other paths are not this module\'s');
  assert.equal((await w.call(ownerA, 'POST', '/api/setup/constructor', {})).status, 404);
});

test('A calendar link is tried before it is kept, sealed when kept, and never given back', async () => {
  const w = world(), owner = w.grant('owner', 'alpha'), link = 'https://p01-caldav.icloud.com/published/2/VERYSECRET';
  const bad = await w.call(owner, 'POST', '/api/setup/calendar-add', {name: 'Mara', link: 'https://example.com/broken.ics'});
  assert.equal(bad.status, 400); assert.match(bad.body.error, /could not be read/);
  const added = await w.call(owner, 'POST', '/api/setup/calendar-add', {name: '  Mara  ', link});
  assert.equal(added.status, 200); assert.ok(added.body.found >= 8, 'a weekly event over two months');
  const [calendar] = added.body.setup.calendars;
  assert.deepEqual([calendar.name, calendar.kind, calendar.connected, /^#[0-9a-f]{6}$/.test(calendar.color)], ['Mara', 'link', true, true]);
  assert.ok(!JSON.stringify(added.body).includes('VERYSECRET'), 'the page learns that there is a link, not what it is');
  const home = path.join(w.data, 'households', 'alpha');
  assert.ok(!fs.readFileSync(path.join(home, 'credentials.json'), 'utf8').includes('VERYSECRET'), 'sealed on disk');
  assert.ok(!fs.readFileSync(path.join(home, 'sources.json'), 'utf8').includes('VERYSECRET'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'sources.json'), 'utf8')).people, [{id: '7', name: 'Kept'}], 'what the page does not know about is left alone');
  assert.equal(w.households.vault.read(path.join(home, 'credentials.json'), 'alpha').ics[calendar.id], link);
  assert.equal((await w.call(w.grant('owner', 'beta'), 'GET', '/api/setup')).body.calendars.length, 0, 'beta has no such calendar');
  // Private events are Busy on the wall unless the household says otherwise, and only the three choices are kept.
  assert.equal(calendar.private, 'busy');
  assert.equal((await w.call(owner, 'POST', '/api/setup/calendar-edit', {id: calendar.id, private: 'hide'})).body.setup.calendars[0].private, 'hide');
  assert.equal((await w.call(owner, 'POST', '/api/setup/calendar-edit', {id: calendar.id, private: 'everything'})).body.setup.calendars[0].private, 'hide');
  const removed = await w.call(owner, 'POST', '/api/setup/calendar-remove', {id: calendar.id});
  assert.equal(removed.body.setup.calendars.length, 0);
  assert.deepEqual(w.households.vault.names(w.households.vault.read(path.join(home, 'credentials.json'), 'alpha')), [], 'and its link goes with it');
});

test('Place, lists, photos, frames and devices', async () => {
  const w = world(), owner = w.grant('owner', 'alpha');
  assert.deepEqual((await w.call(owner, 'GET', '/api/setup/places?q=Aus')).body.places.map(p => p.place), ['Austin'], 'a place with a zone this server does not know is left out');
  assert.equal((await w.call(owner, 'POST', '/api/setup/household', {name: 'The Alphas', place: 'Austin', latitude: 30.27, longitude: -97.74, timezone: 'Mars/Base'})).status, 400);
  const saved = await w.call(owner, 'POST', '/api/setup/household', {name: 'The Alphas', place: 'Austin', latitude: 30.27, longitude: -97.74, timezone: 'America/Chicago'});
  assert.deepEqual(saved.body.setup.household, {id: 'alpha', name: 'The Alphas', timezone: 'America/Chicago', place: 'Austin'});
  assert.equal((await w.call(owner, 'POST', '/api/setup/todoist', {token: 'wrong'})).status, 400);
  const todoist = await w.call(owner, 'POST', '/api/setup/todoist', {token: 'good-token'});
  assert.deepEqual(todoist.body.projects, [{id: 'P1', name: 'Home', under: ''}, {id: 'P2', name: 'Chores', under: 'Home'}], 'the inbox is not offered');
  assert.ok(!JSON.stringify(todoist.body).includes('good-token'));
  const lists = await w.call(owner, 'POST', '/api/setup/lists', {lists: [{id: 'P2', name: 'Chores', icon: 'repeat'}, {id: 'P1', name: 'Sam', person: true, kid: true, color: '#E0823D'}, {id: '../etc', name: 'x'}, {id: 'P9', name: '', icon: 'evil"><script>'}]});
  assert.deepEqual(lists.body.setup.lists, [{id: 'P2', name: 'Chores', icon: 'repeat', person: false, kid: false, color: '', kind: 'todoist'}, {id: 'P1', name: 'Sam', icon: 'list', person: true, kid: true, color: '#e0823d', kind: 'todoist'}]);
  // A list kept here needs no account. Choosing Todoist lists again must not throw it away, and removing it takes its items.
  const own = await w.call(owner, 'POST', '/api/setup/list-add', {name: 'Groceries', icon: 'cart', description: 'By aisle'});
  const made = own.body.setup.lists.find(l => l.kind === 'here');
  assert.deepEqual([made.name, made.icon, /^L[0-9a-f]{10}$/.test(made.id)], ['Groceries', 'cart', true]);
  assert.equal((await w.call(owner, 'POST', '/api/setup/list-add', {name: 'groceries'})).status, 400, 'two lists cannot share a name: the page tells them apart by it');
  await w.households.get('alpha').addTask('Groceries', '  Milk  ');
  assert.deepEqual(w.households.get('alpha').lists.items(made.id).map(i => i.title), ['Milk']);
  const again = await w.call(owner, 'POST', '/api/setup/lists', {lists: [{id: 'P2', name: 'Chores', icon: 'repeat'}]});
  assert.deepEqual(again.body.setup.lists.map(l => l.name), ['Chores', 'Groceries']);
  assert.equal((await w.call(w.grant('owner', 'beta'), 'POST', '/api/setup/list-remove', {id: made.id})).status, 404, 'not from another household');
  assert.equal((await w.call(owner, 'POST', '/api/setup/list-remove', {id: made.id})).status, 200);
  assert.deepEqual(w.households.get('alpha').lists.items(made.id), [], 'its items went with it');
  let synced = 0; w.households.get('alpha').syncPhotos = async () => { synced++; };   // no iCloud in a test
  for (const junk of ['https://example.com/not-an-album', 'nope']) assert.equal((await w.call(owner, 'POST', '/api/setup/photos', {link: junk})).status, 400, junk);
  const album = await w.call(owner, 'POST', '/api/setup/photos', {link: 'https://www.icloud.com/sharedalbum/#B0exampleSharedAlbum1234'});
  assert.deepEqual([album.status, album.body.setup.photos.connected, synced], [200, true, 1], 'saved, and the mirror starts at once');
  assert.ok(!JSON.stringify(album.body).includes('B0example'), 'the album link lets people add photos, so it is a secret too');
  const screen = w.grants.startPairing();
  assert.equal((await w.call(owner, 'POST', '/api/setup/frame-pair', {code: 'ZZZ-ZZZ', name: 'Kitchen'})).status, 400);
  assert.equal((await w.call(owner, 'POST', '/api/setup/frame-pair', {code: screen.code, name: 'Kitchen'})).status, 200);
  const frame = w.grants.pollPairing(screen.device);
  assert.deepEqual([frame.grant.household, frame.grant.label], ['alpha', 'Kitchen']);
  const other = w.grants.add({scope: 'frame', household: 'beta', label: 'Beta wall'});
  assert.equal((await w.call(owner, 'POST', '/api/setup/revoke', {id: other.grant.id})).status, 404, 'cannot remove another household\'s frame');
  assert.ok(w.grants.verify(other.secret));
  assert.equal((await w.call(owner, 'POST', '/api/setup/revoke', {id: frame.grant.id})).status, 200);
  assert.equal(w.grants.verify(frame.secret), null);
  const invite = await w.call(owner, 'POST', '/api/setup/link', {name: 'Partner'});
  assert.deepEqual(w.grants.peekLink(invite.body.token), {scope: 'owner', household: 'alpha'});
});
