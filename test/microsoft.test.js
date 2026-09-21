const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createMicrosoft, dueDay, accountOf, shortId} = require('../microsoft');
const integrations = require('../integrations');
const {createHouseholds} = require('../households');
const {createGrants} = require('../grants');
const {createVault} = require('../vault');
const {createSetup} = require('../setup');

const idToken = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

// A Microsoft that answers like the real one, and remembers what it was asked.
function fakeMicrosoft({refresh = 'r1'} = {}) {
  const asked = [], state = {refresh, polls: 0, graph401: false};
  const fetchImpl = async (url, options = {}) => {
    const body = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : null;
    asked.push({url: String(url), method: options.method || 'GET', body, auth: (options.headers || {}).Authorization});
    const u = new URL(url);
    if (u.pathname.endsWith('/devicecode')) return json({device_code: 'DEVICE-SECRET', user_code: 'K7WPX4R2', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5});
    if (u.pathname.endsWith('/token') && body.grant_type.endsWith('device_code')) {
      state.polls++;
      if (state.polls === 1) return json({error: 'authorization_pending'}, 400);
      if (state.polls === 2) return json({error: 'slow_down'}, 400);
      return json({access_token: 'a0', refresh_token: 'r1', expires_in: 3600, id_token: idToken({preferred_username: 'sam@outlook.com'})});
    }
    if (u.pathname.endsWith('/token') && body.grant_type === 'refresh_token') {
      if (body.refresh_token !== state.refresh) return json({error: 'invalid_grant'}, 400);
      state.refresh = body.refresh_token === 'r1' ? 'r2' : 'r3';
      return json({access_token: 'a-' + state.refresh, refresh_token: state.refresh, expires_in: 3600});
    }
    if (u.host === 'graph.microsoft.com') {
      if (state.graph401) { state.graph401 = false; return json({error: {code: 'InvalidAuthenticationToken'}}, 401); }
      if (u.pathname === '/v1.0/me/todo/lists' && !u.search) return json({value: [{id: 'LIST-A==', displayName: 'Groceries', isShared: true}], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists?$skip=1'});
      if (u.pathname === '/v1.0/me/todo/lists') return json({value: [{id: 'LIST-B==', displayName: 'Sam'}]});
      if (/\/tasks$/.test(u.pathname) && options.method === 'POST') return json({id: 'NEW'}, 201);
      if (/\/tasks$/.test(u.pathname)) return json({value: [
        {id: 'T1', title: 'Milk', status: 'notStarted', importance: 'normal'},
        {id: 'T2', title: 'Birthday cake', status: 'inProgress', importance: 'high', dueDateTime: {dateTime: '2026-09-25T05:00:00.0000000', timeZone: 'UTC'}, recurrence: {pattern: {type: 'weekly'}}},
        {id: 'T3', title: 'Done already', status: 'completed'}]});
      if (/\/tasks\/[^/]+$/.test(u.pathname) && options.method === 'PATCH') return json({id: 'T1', status: 'completed'});
    }
    return json({error: 'unexpected'}, 500);
  };
  return {fetchImpl, asked, state};
}

test('A due date means the calendar day where the household lives, and who signed in comes from the ID token', () => {
  // Midnight in Chicago, as To Do writes it in UTC, is still the 25th in Chicago.
  assert.equal(dueDay({dateTime: '2026-09-25T05:00:00.0000000', timeZone: 'UTC'}, 'America/Chicago'), '2026-09-25');
  assert.equal(dueDay({dateTime: '2026-09-24T22:00:00.0000000', timeZone: 'UTC'}, 'Europe/Berlin'), '2026-09-25', 'east of UTC too');
  assert.equal(dueDay({dateTime: '2026-09-25T00:00:00.0000000', timeZone: 'America/New_York'}, 'America/New_York'), '2026-09-25');
  assert.equal(dueDay({dateTime: '2026-09-25T00:00:00.0000000', timeZone: 'Some Windows Zone'}, 'America/Chicago'), '2026-09-25', 'an unknown zone keeps the day it was written');
  assert.equal(dueDay(null, 'UTC'), '');
  assert.equal(accountOf(idToken({preferred_username: 'sam@outlook.com'})), 'sam@outlook.com');
  assert.equal(accountOf('not a token'), '');
});

test('With no app registered, Microsoft is simply not offered', async () => {
  const ms = createMicrosoft({clientId: ''});
  assert.equal(ms.available, false);
  await assert.rejects(ms.startDevice(), {code: 'UNAVAILABLE', status: 409});
});

test('Signing in by code: pending, slow down, then connected with the account named', async () => {
  const fake = fakeMicrosoft(), ms = createMicrosoft({clientId: 'CLIENT', fetchImpl: fake.fetchImpl});
  const started = await ms.startDevice();
  assert.deepEqual([started.code, started.url, started.interval], ['K7WPX4R2', 'https://microsoft.com/devicelogin', 5]);
  assert.equal(fake.asked[0].body.scope, 'openid profile offline_access Tasks.ReadWrite', 'asks for no more than it needs');
  assert.deepEqual(await ms.pollDevice(started.deviceCode), {status: 'pending'});
  assert.deepEqual(await ms.pollDevice(started.deviceCode), {status: 'slow'});
  assert.deepEqual(await ms.pollDevice(started.deviceCode), {status: 'connected', refresh: 'r1', account: 'sam@outlook.com'});
  assert.ok(fake.asked.every(a => !a.body || !('client_secret' in a.body)), 'a public client sends no secret');
});

test('Lists and items: pages followed on Graph only, completed items left out, rotated refresh tokens kept', async () => {
  const fake = fakeMicrosoft(), saved = {};
  let held = {microsoft: {refresh: 'r1'}};
  const ms = createMicrosoft({clientId: 'CLIENT', fetchImpl: fake.fetchImpl, credentials: () => held, saveSecret: (name, value) => { saved[name] = value; held = {microsoft: {refresh: value}}; }});
  const lists = await ms.lists();
  assert.deepEqual(lists.map(l => [l.name, l.remote, l.id]), [['Groceries', 'LIST-A==', shortId('M', 'LIST-A==')], ['Sam', 'LIST-B==', shortId('M', 'LIST-B==')]]);
  assert.match(lists[0].id, /^M[0-9a-f]{16}$/);
  assert.equal(saved['microsoft.refresh'], 'r2', 'the replacement refresh token is saved as soon as it arrives');

  const items = await ms.items('LIST-A==', 'America/Chicago');
  assert.deepEqual(items.map(t => [t.title, t.priority, t.due, t.recurring]), [['Milk', 'p4', '', false], ['Birthday cake', 'p1', '2026-09-25', true]]);
  const tasksUrl = new URL(fake.asked.find(a => /\/tasks\?/.test(a.url)).url);
  assert.equal(tasksUrl.searchParams.get('$filter'), "status ne 'completed'");

  await ms.complete(items[0].id);
  const patch = fake.asked.at(-1);
  assert.deepEqual([patch.method, new URL(patch.url).pathname, patch.body], ['PATCH', '/v1.0/me/todo/lists/LIST-A%3D%3D/tasks/T1', {status: 'completed'}]);
  await assert.rejects(ms.complete(items[0].id), {code: 'UNKNOWN_TASK'}, 'checked off once');
  await assert.rejects(ms.complete('m0000000000000000'), {code: 'UNKNOWN_TASK'}, 'nothing it was not shown');

  await ms.add('LIST-B==', 'Brush teeth');
  assert.deepEqual([fake.asked.at(-1).method, fake.asked.at(-1).body], ['POST', {title: 'Brush teeth'}]);

  // An access token that dies early is renewed once, quietly.
  fake.state.graph401 = true;
  assert.equal((await ms.lists()).length, 2);
  assert.equal(saved['microsoft.refresh'], 'r3');
});

test('A next page that leaves Graph is refused, and a revoked sign-in says so', async () => {
  const leaky = createMicrosoft({clientId: 'CLIENT', credentials: () => ({microsoft: {refresh: 'r1'}}), fetchImpl: async url => /token/.test(url)
    ? json({access_token: 'a', refresh_token: 'r1', expires_in: 3600})
    : json({value: [], '@odata.nextLink': 'https://evil.example/steal'})});
  await assert.rejects(leaky.lists(), {code: 'UPSTREAM'});

  const revoked = createMicrosoft({clientId: 'CLIENT', fetchImpl: fakeMicrosoft({refresh: 'someone-else'}).fetchImpl, credentials: () => ({microsoft: {refresh: 'r1'}})});
  await assert.rejects(revoked.lists(), {code: 'SIGN_IN'});
  assert.equal(revoked.needsSignIn(), true);
  const never = createMicrosoft({clientId: 'CLIENT', credentials: () => ({})});
  await assert.rejects(never.lists(), {code: 'SIGN_IN'});
});

test('A Microsoft list sits beside the others: read, added to, and checked off through Microsoft', async () => {
  const closed = [], added = [], todoist = [];
  const microsoft = {has: () => true, items: async (remote, zone) => { assert.deepEqual([remote, zone], ['LIST-A==', 'America/Chicago']); return [{id: 'm1111111111111111', title: 'Milk', priority: 'p4', due: '', recurring: false}]; }, add: async (remote, title) => added.push([remote, title]), complete: async id => closed.push(id)};
  const api = {todoistPost: async (...args) => todoist.push(args), pages: async () => [], todoist: async () => ({results: []})};
  const cfg = {timezone: 'America/Chicago', projects: [{id: 'Mabc', name: 'Groceries', source: 'microsoft', remote: 'LIST-A=='}]};
  const service = integrations.create({api, config: () => cfg, cacheDir: null, microsoft});
  const got = await service.tasks();
  assert.deepEqual(got.tasks.map(t => [t.id, t.title, t.project]), [['m1111111111111111', 'Milk', 'Groceries']]);
  await service.addTask('Groceries', 'Eggs');
  assert.deepEqual(added, [['LIST-A==', 'Eggs']]);
  await service.closeTask('m1111111111111111');
  assert.deepEqual(closed, ['m1111111111111111']);
  assert.deepEqual(todoist, [], 'nothing went to Todoist');
});

test('Setup: the device code stays on the server, the pace is Microsoft\'s, and choosing lists keeps the other services\' lists', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-setup-'));
  fs.mkdirSync(path.join(data, 'households', 'alpha'), {recursive: true});
  fs.writeFileSync(path.join(data, 'households', 'alpha', 'sources.json'), JSON.stringify({name: 'alpha', calendars: [], people: [], projects: [{id: 'P1', name: 'Home'}, {id: 'Lkept', name: 'Kept', source: 'local'}]}));
  const households = createHouseholds({root: path.join(data, 'households'), vault: createVault({masterKey: crypto.randomBytes(32).toString('base64')})});
  const grants = createGrants({file: path.join(data, 'grants.json')});
  const setup = createSetup({households, grants});
  const owner = grants.verify(grants.add({scope: 'owner', household: 'alpha', label: 'owner'}).secret);
  const call = (p, body) => setup.handle({method: body ? 'POST' : 'GET', url: new URL('http://x/api/setup' + p), grant: owner, body});

  const home = households.get('alpha'), fake = fakeMicrosoft();
  home.microsoft = createMicrosoft({clientId: 'CLIENT', fetchImpl: fake.fetchImpl, credentials: () => households.vault.read(path.join(home.dir, 'credentials.json'), 'alpha'), saveSecret: (n, v) => households.vault.set(path.join(home.dir, 'credentials.json'), 'alpha', n, v)});
  assert.deepEqual((await call('')).body.microsoft, {available: true, connected: false, account: '', signIn: false});

  const started = await call('/microsoft-start', {});
  assert.equal(started.body.code, 'K7WPX4R2');
  assert.ok(!JSON.stringify(started.body).includes('DEVICE-SECRET'), 'the device code never reaches a page');
  assert.equal((await call('/microsoft-poll', {})).body.status, 'pending');
  assert.equal(fake.state.polls, 0, 'asked before Microsoft\'s interval, the server does not ask Microsoft');

  // Let the pace pass three times: pending, slow down, connected.
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    for (const wait of [6000, 12000, 25000]) { skew += wait; await call('/microsoft-poll', {}); }
  } finally { Date.now = realNow; }
  const described = (await call('')).body;
  assert.deepEqual([described.microsoft.connected, described.microsoft.account], [true, 'sam@outlook.com']);
  assert.ok(!fs.readFileSync(path.join(home.dir, 'credentials.json'), 'utf8').includes('"r1"'), 'the refresh token is sealed on disk');

  // A forged id is dropped; the real one is looked up again on the server.
  const groceries = shortId('M', 'LIST-A==');
  await call('/lists', {source: 'microsoft', lists: [{id: groceries, name: 'Groceries', icon: 'cart'}, {id: 'Mforged', name: 'Nope'}]});
  const projects = JSON.parse(fs.readFileSync(path.join(home.dir, 'sources.json'), 'utf8')).projects;
  assert.deepEqual(projects.map(p => [p.id, p.source || 'todoist', p.remote || '']), [['P1', 'todoist', ''], [groceries, 'microsoft', 'LIST-A=='], ['Lkept', 'local', '']]);
  assert.deepEqual((await call('')).body.lists.map(l => l.kind), ['todoist', 'microsoft', 'here']);
  // Choosing Todoist lists again leaves the Microsoft one where it is.
  await call('/lists', {lists: [{id: 'P1', name: 'Home'}]});
  assert.equal(JSON.parse(fs.readFileSync(path.join(home.dir, 'sources.json'), 'utf8')).projects.filter(p => p.source === 'microsoft').length, 1);

  await call('/microsoft-disconnect', {});
  const after = (await call('')).body;
  assert.deepEqual([after.microsoft.connected, after.lists.map(l => l.kind)], [false, ['todoist', 'here']]);
});
