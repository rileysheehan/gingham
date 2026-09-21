const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createHomeAssistant, dueDay, shortId} = require('../homeassistant');
const integrations = require('../integrations');
const {createHouseholds} = require('../households');
const {createGrants} = require('../grants');
const {createVault} = require('../vault');
const {createSetup} = require('../setup');

const account = {url: 'http://homeassistant.local:8123', token: 'LLAT'};
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

// A Home Assistant that answers like the real one, and remembers what it was asked.
function fakeHa({oldVersion = false, wrapped = true} = {}) {
  const asked = [], items = {
    'todo.shopping_list': [{summary: 'Milk', uid: 'u1', status: 'needs_action'}, {summary: 'Eggs', uid: 'u2', status: 'needs_action', due: '2026-09-25'}, {summary: 'Done', uid: 'u3', status: 'completed'}],
    'todo.chores': [{summary: 'Recycling', uid: 'c1', status: 'needs_action', due: '2026-09-25T06:30:00+02:00'}]};
  const fetchImpl = async (url, options) => {
    const u = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    asked.push({method: options.method, path: u.pathname + u.search, body, auth: options.headers.Authorization});
    if (options.headers.Authorization !== 'Bearer LLAT') return json({message: 'Unauthorized'}, 401);
    if (u.pathname === '/api/') return json({message: 'API running.'});
    if (u.pathname === '/api/states') return json([
      {entity_id: 'light.kitchen', state: 'on', attributes: {friendly_name: 'Kitchen'}},
      {entity_id: 'todo.shopping_list', state: '2', attributes: {friendly_name: 'Shopping List', supported_features: 15}},
      {entity_id: 'todo.chores', state: '1', attributes: {}}]);
    if (u.pathname === '/api/services/todo/get_items') {
      if (oldVersion || !u.searchParams.has('return_response')) return json({message: 'Service call requires responses but caller did not ask for responses'}, 400);
      const list = {[body.entity_id]: {items: (items[body.entity_id] || []).filter(i => !body.status || body.status.includes(i.status) || i.status === 'completed')}};
      return json(wrapped ? {changed_states: [], service_response: list} : list);
    }
    if (u.pathname === '/api/services/todo/add_item') { items[body.entity_id].push({summary: body.item, uid: 'new', status: 'needs_action'}); return json([]); }
    if (u.pathname === '/api/services/todo/update_item') {
      const found = (items[body.entity_id] || []).find(i => i.uid === body.item || i.summary === body.item);
      if (!found) return json({message: 'Unable to find to-do list item'}, 400);
      found.status = body.status; return json([]);
    }
    return json({message: 'not found'}, 404);
  };
  return {fetchImpl, asked, items};
}

test('A due date from Home Assistant lands on the household\'s day', () => {
  assert.equal(dueDay('2026-09-25', 'America/Chicago'), '2026-09-25');
  assert.equal(dueDay('2026-09-25T06:30:00+02:00', 'America/Chicago'), '2026-09-24', '6:30 in the morning in Europe is still the evening before in Chicago');
  assert.equal(dueDay('', 'UTC'), '');
  assert.equal(dueDay('someday', 'UTC'), '');
});

test('Finding the lists: the token checked first, then only the to-do entities, named as Home Assistant names them', async () => {
  const ha = fakeHa(), service = createHomeAssistant({fetchImpl: ha.fetchImpl, allowPrivate: true});
  const lists = await service.discover(account);
  assert.deepEqual(lists.map(l => [l.name, l.remote, l.id]), [['Shopping List', 'todo.shopping_list', shortId('H', 'todo.shopping_list')], ['chores', 'todo.chores', shortId('H', 'todo.chores')]]);
  assert.deepEqual(ha.asked.map(a => a.path), ['/api/', '/api/states']);
  assert.equal(ha.asked[0].auth, 'Bearer LLAT');
  await assert.rejects(service.discover({...account, token: 'wrong'}), {code: 'AUTH', status: 400});
  const notHa = createHomeAssistant({fetchImpl: async () => json({hello: 'world'}), allowPrivate: true});
  await assert.rejects(notHa.discover(account), {code: 'NOT_HA'});
});

test('A home address is refused on a hosted server, and allowed where the deployment says so', async () => {
  const ha = fakeHa();
  await assert.rejects(createHomeAssistant({fetchImpl: ha.fetchImpl, lookup: async () => [{address: '192.168.1.20'}]}).discover({...account, url: 'https://homeassistant.example'}), {code: 'PRIVATE', message: /home network.*remote address/});
  await assert.rejects(createHomeAssistant({fetchImpl: ha.fetchImpl, lookup: async () => [{address: '203.0.113.9'}]}).discover(account), {code: 'BAD_ADDRESS'}, 'plain http only where private addresses are allowed');
  assert.equal((await createHomeAssistant({fetchImpl: ha.fetchImpl, lookup: async () => [{address: '203.0.113.9'}]}).discover({...account, url: 'https://abc.ui.nabu.casa'})).length, 2, 'a public https address works anywhere');
  assert.equal((await createHomeAssistant({fetchImpl: ha.fetchImpl, allowPrivate: true}).discover(account)).length, 2);
});

test('Items, adding and checking off, in both the answer shapes Home Assistant has used', async () => {
  for (const wrapped of [true, false]) {
    const ha = fakeHa({wrapped}), service = createHomeAssistant({fetchImpl: ha.fetchImpl, allowPrivate: true, credentials: () => ({homeassistant: account})});
    const got = await service.items('todo.shopping_list', 'America/Chicago');
    assert.deepEqual(got.map(i => [i.title, i.due]), [['Milk', ''], ['Eggs', '2026-09-25']], 'finished items are left out');
    const read = ha.asked.find(a => a.path.startsWith('/api/services/todo/get_items'));
    assert.deepEqual([read.path, read.body], ['/api/services/todo/get_items?return_response', {entity_id: 'todo.shopping_list', status: ['needs_action']}]);
    await service.add('todo.shopping_list', 'Bread');
    assert.deepEqual(ha.asked.at(-1).body, {entity_id: 'todo.shopping_list', item: 'Bread'});
    await service.complete(got[0].id);
    assert.deepEqual(ha.asked.at(-1).body, {entity_id: 'todo.shopping_list', item: 'u1', status: 'completed'}, 'checked off by its own id, not its name');
    await assert.rejects(service.complete(got[0].id), {code: 'UNKNOWN_TASK'}, 'once');
  }
  // An item Home Assistant no longer has, and a Home Assistant too old to share its lists.
  const ha = fakeHa(), service = createHomeAssistant({fetchImpl: ha.fetchImpl, allowPrivate: true, credentials: () => ({homeassistant: account})});
  const got = await service.items('todo.chores', 'UTC');
  ha.items['todo.chores'] = [];
  await assert.rejects(service.complete(got[0].id), {code: 'UNKNOWN_TASK'});
  const old = createHomeAssistant({fetchImpl: fakeHa({oldVersion: true}).fetchImpl, allowPrivate: true, credentials: () => ({homeassistant: account})});
  await assert.rejects(old.items('todo.chores', 'UTC'), {message: /too old/});
  await assert.rejects(createHomeAssistant({credentials: () => ({})}).items('todo.chores', 'UTC'), {code: 'SIGN_IN'});
});

test('A Home Assistant list sits beside the others, and setup keeps the token sealed and its lists to itself', async () => {
  const added = [], closed = [];
  const fake = {items: async () => [{id: 'h1111111111111111', title: 'Milk', priority: 'p4', due: '', recurring: false}], add: async (remote, title) => added.push([remote, title]), complete: async id => closed.push(id)};
  const svc = integrations.create({api: {todoistPost: async () => { throw Error('not Todoist'); }}, config: () => ({timezone: 'UTC', projects: [{id: 'Habc', name: 'Shopping', source: 'homeassistant', remote: 'todo.shopping_list'}]}), cacheDir: null, homeassistant: fake});
  assert.equal((await svc.tasks()).tasks[0].project, 'Shopping');
  await svc.addTask('Shopping', 'Eggs'); await svc.closeTask('h1111111111111111');
  assert.deepEqual([added, closed], [[['todo.shopping_list', 'Eggs']], ['h1111111111111111']]);
  // A list from a service this deployment has no connection for fails as that list, not as every list.
  const lonely = integrations.create({api: {}, config: () => ({timezone: 'UTC', projects: [{id: 'Habc', name: 'Shopping', source: 'homeassistant', remote: 'todo.x'}, {id: 'Lk', name: 'Kept', source: 'local'}]}), cacheDir: null, local: {items: () => [], has: () => false}});
  assert.deepEqual((await lonely.tasks()).problems, ['Shopping']);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-setup-'));
  fs.mkdirSync(path.join(data, 'households', 'alpha'), {recursive: true});
  fs.writeFileSync(path.join(data, 'households', 'alpha', 'sources.json'), JSON.stringify({name: 'alpha', calendars: [], people: [], projects: [{id: 'Lkept', name: 'Kept', source: 'local'}]}));
  const households = createHouseholds({root: path.join(data, 'households'), vault: createVault({masterKey: crypto.randomBytes(32).toString('base64')})});
  const grants = createGrants({file: path.join(data, 'grants.json')});
  const setup = createSetup({households, grants});
  const owner = grants.verify(grants.add({scope: 'owner', household: 'alpha', label: 'owner'}).secret);
  const call = (p, body) => setup.handle({method: body ? 'POST' : 'GET', url: new URL('http://x/api/setup' + p), grant: owner, body});
  const home = households.get('alpha'), ha = fakeHa(), file = path.join(home.dir, 'credentials.json');
  home.homeassistant = createHomeAssistant({fetchImpl: ha.fetchImpl, allowPrivate: true, credentials: () => households.vault.read(file, 'alpha')});

  assert.equal((await call('/homeassistant', {...account, token: 'wrong'})).status, 400);
  const connected = await call('/homeassistant', account);
  assert.deepEqual(connected.body.lists.map(l => l.name), ['Shopping List', 'chores']);
  assert.deepEqual((await call('')).body.homeassistant, {connected: true, server: 'homeassistant.local:8123'});
  assert.ok(!fs.readFileSync(file, 'utf8').includes('LLAT'), 'the token is sealed on disk');
  assert.ok(!JSON.stringify((await call('')).body).includes('LLAT'), 'and never sent back');
  await call('/lists', {source: 'homeassistant', lists: [{id: connected.body.lists[0].id, name: 'Shopping', icon: 'cart'}, {id: 'Hforged', name: 'Nope'}]});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home.dir, 'sources.json'), 'utf8')).projects.map(p => [p.source, p.remote || '']), [['homeassistant', 'todo.shopping_list'], ['local', '']]);
  await call('/homeassistant-disconnect', {});
  assert.deepEqual([(await call('')).body.homeassistant.connected, JSON.parse(fs.readFileSync(path.join(home.dir, 'sources.json'), 'utf8')).projects.map(p => p.source)], [false, ['local']]);
});
