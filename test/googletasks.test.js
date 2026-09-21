const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createGoogleTasks, redirectFrom, accountOf} = require('../googletasks');
const {createHouseholds} = require('../households');
const {createGrants} = require('../grants');
const {createVault} = require('../vault');
const {createSetup} = require('../setup');

const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const idToken = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
const config = {clientId: 'CID.apps.googleusercontent.com', clientSecret: 'SECRET', redirectUri: 'https://frame.example.com/oauth/google'};

// A Google that answers like the real one, and remembers what it was asked.
function fakeGoogle({grantScope = 'https://www.googleapis.com/auth/tasks openid https://www.googleapis.com/auth/userinfo.email', giveRefresh = true} = {}) {
  const asked = [], state = {refresh: 'R1', revoked: []};
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url), body = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : null;
    asked.push({method: options.method || 'GET', url: u.toString(), path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: (options.headers || {}).Authorization});
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      if (body.grant_type === 'authorization_code') return body.code === 'GOOD' ? json({access_token: 'A0', expires_in: 3599, scope: grantScope, ...(giveRefresh ? {refresh_token: 'R1'} : {}), id_token: idToken({email: 'sam@example.com'})}) : json({error: 'invalid_grant'}, 400);
      if (body.grant_type === 'refresh_token') return body.refresh_token === state.refresh && !state.revoked.includes(body.refresh_token) ? json({access_token: 'A1', expires_in: 3599}) : json({error: 'invalid_grant', error_description: 'Token has been expired or revoked.'}, 400);
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') { state.revoked.push(body.token); return json({}); }
    if (u.host === 'tasks.googleapis.com') {
      if (u.pathname === '/tasks/v1/users/@me/lists' && !u.searchParams.get('pageToken')) return json({items: [{id: 'LIST1', title: 'Groceries'}], nextPageToken: 'P2'});
      if (u.pathname === '/tasks/v1/users/@me/lists') return json({items: [{id: 'LIST2', title: 'Chores'}]});
      if (u.pathname === '/tasks/v1/lists/LIST1/tasks' && (options.method || 'GET') === 'GET') return json({items: [
        {id: 'T1', title: 'Milk', status: 'needsAction'}, {id: 'T2', title: 'Birthday cake', status: 'needsAction', due: '2026-09-25T00:00:00.000Z'},
        {id: 'T3', title: 'Done', status: 'completed'}, {id: 'T4', title: '', status: 'needsAction'}]});
      if (u.pathname === '/tasks/v1/lists/LIST1/tasks' && options.method === 'POST') return json({id: 'NEW', title: body.title});
      if (u.pathname === '/tasks/v1/lists/LIST1/tasks/T1' && options.method === 'PATCH') return json({id: 'T1', status: 'completed'});
      if (options.method === 'PATCH') return json({error: {code: 404}}, 404);
    }
    return json({error: 'unexpected'}, 500);
  };
  return {fetchImpl, asked, state};
}

test('Google is offered only with an app of its own and a public https address to come back to', () => {
  assert.equal(redirectFrom('https://frame.example.com/'), 'https://frame.example.com/oauth/google');
  assert.equal(redirectFrom('http://192.168.1.40:4173'), '', 'a tablet on its own has no address Google will return to');
  assert.equal(redirectFrom(''), '');
  assert.equal(createGoogleTasks({clientId: '', clientSecret: '', redirectUri: ''}).available, false);
  assert.throws(() => createGoogleTasks({...config, clientSecret: ''}).begin(), {code: 'UNAVAILABLE', status: 409});
  assert.equal(accountOf(idToken({email: 'sam@example.com'})), 'sam@example.com');
});

test('Sending the phone to Google: its own state, a PKCE challenge, Tasks only, and lasting access asked for', () => {
  const google = createGoogleTasks(config), a = google.begin(), b = google.begin();
  const url = new URL(a.url), q = Object.fromEntries(url.searchParams);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual([q.client_id, q.redirect_uri, q.response_type, q.scope, q.access_type, q.prompt, q.code_challenge_method], [config.clientId, config.redirectUri, 'code', 'https://www.googleapis.com/auth/tasks openid email', 'offline', 'consent', 'S256']);
  assert.equal(q.state, a.state);
  assert.equal(q.code_challenge, crypto.createHash('sha256').update(a.verifier).digest('base64url'));
  assert.notEqual(a.state, b.state); assert.notEqual(a.verifier, b.verifier);
  assert.ok(!a.url.includes(config.clientSecret) && !a.url.includes(a.verifier), 'neither the secret nor the verifier travels with the phone');
});

test('Coming back: the code traded with the secret and the verifier, and refused without Tasks or without lasting access', async () => {
  const fake = fakeGoogle(), google = createGoogleTasks({...config, fetchImpl: fake.fetchImpl});
  const {verifier} = google.begin();
  assert.deepEqual(await google.finish('GOOD', verifier), {refresh: 'R1', account: 'sam@example.com'});
  assert.deepEqual(fake.asked[0].body, {grant_type: 'authorization_code', code: 'GOOD', code_verifier: verifier, client_id: config.clientId, client_secret: 'SECRET', redirect_uri: config.redirectUri});
  await assert.rejects(google.finish('BAD', verifier), {code: 'UPSTREAM'});
  await assert.rejects(createGoogleTasks({...config, fetchImpl: fakeGoogle({grantScope: 'openid email'}).fetchImpl}).finish('GOOD', verifier), {code: 'SCOPE'}, 'Tasks unticked on Google\'s screen');
  await assert.rejects(createGoogleTasks({...config, fetchImpl: fakeGoogle({giveRefresh: false}).fetchImpl}).finish('GOOD', verifier), {message: /no lasting access/});
});

test('Lists and items: pages followed, finished and untitled tasks left out, due dates as the day meant, check-offs to Google', async () => {
  const fake = fakeGoogle(), google = createGoogleTasks({...config, fetchImpl: fake.fetchImpl, credentials: () => ({googletasks: {refresh: 'R1'}})});
  assert.deepEqual((await google.lists()).map(l => [l.name, l.remote]), [['Groceries', 'LIST1'], ['Chores', 'LIST2']]);
  const items = await google.items('LIST1');
  assert.deepEqual(items.map(t => [t.title, t.due]), [['Milk', ''], ['Birthday cake', '2026-09-25']]);
  const read = fake.asked.find(a => a.path === '/tasks/v1/lists/LIST1/tasks');
  assert.deepEqual([read.query.showCompleted, read.query.maxResults, read.auth], ['false', '100', 'Bearer A1']);
  await google.add('LIST1', 'Bread');
  assert.deepEqual([fake.asked.at(-1).method, fake.asked.at(-1).body], ['POST', {title: 'Bread'}]);
  await google.complete(items[0].id);
  assert.deepEqual([fake.asked.at(-1).method, fake.asked.at(-1).path, fake.asked.at(-1).body], ['PATCH', '/tasks/v1/lists/LIST1/tasks/T1', {status: 'completed'}]);
  await assert.rejects(google.complete(items[0].id), {code: 'UNKNOWN_TASK'});
  await assert.rejects(google.complete(items[1].id), {code: 'UNKNOWN_TASK'}, 'a task Google no longer has');
  // Revoked at Google, or expired after a week in Testing: said plainly.
  const expired = createGoogleTasks({...config, fetchImpl: fakeGoogle().fetchImpl, credentials: () => ({googletasks: {refresh: 'OLD'}})});
  await assert.rejects(expired.lists(), {code: 'SIGN_IN'});
  assert.equal(expired.needsSignIn(), true);
});

test('Setup: a sign-in is bound to its household, used once, and its token sealed; disconnecting tells Google too', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'google-setup-'));
  fs.mkdirSync(path.join(data, 'households', 'alpha'), {recursive: true});
  fs.writeFileSync(path.join(data, 'households', 'alpha', 'sources.json'), JSON.stringify({name: 'alpha', calendars: [], people: [], projects: [{id: 'Lkept', name: 'Kept', source: 'local'}]}));
  const households = createHouseholds({root: path.join(data, 'households'), vault: createVault({masterKey: crypto.randomBytes(32).toString('base64')})});
  const grants = createGrants({file: path.join(data, 'grants.json')});
  const setup = createSetup({households, grants});
  const owner = grants.verify(grants.add({scope: 'owner', household: 'alpha', label: 'owner'}).secret);
  const call = (p, body) => setup.handle({method: body ? 'POST' : 'GET', url: new URL('http://x/api/setup' + p), grant: owner, body});
  const home = households.get('alpha'), fake = fakeGoogle(), file = path.join(home.dir, 'credentials.json');
  home.googletasks = createGoogleTasks({...config, fetchImpl: fake.fetchImpl, credentials: () => households.vault.read(file, 'alpha')});

  assert.deepEqual((await call('')).body.googletasks, {available: true, connected: false, account: '', signIn: false});
  const started = await call('/googletasks-start', {});
  const state = new URL(started.body.url).searchParams.get('state');

  assert.equal((await setup.oauthReturn({code: 'GOOD', state: 'made-up'})).status, 400, 'a state nobody started gets nothing');
  const denied = await setup.oauthReturn({error: 'access_denied', state: (new URL((await call('/googletasks-start', {})).body.url)).searchParams.get('state')});
  assert.match(denied.html, /wasn’t connected/);

  const back = await setup.oauthReturn({code: 'GOOD', state});
  assert.equal(back.status, 200);
  assert.match(back.html, /<meta http-equiv="refresh" content="0;url=\/setup\?household=alpha#google-connected">/, 'the phone goes on to setup from this site, so its cookie comes too');
  assert.ok(!back.html.includes('GOOD') && !back.html.includes('R1'), 'neither the code nor the token is on the page');
  assert.equal((await setup.oauthReturn({code: 'GOOD', state})).status, 400, 'used once');
  assert.deepEqual((await call('')).body.googletasks, {available: true, connected: true, account: 'sam@example.com', signIn: false});
  assert.ok(!fs.readFileSync(file, 'utf8').includes('R1'), 'sealed on disk');

  const lists = (await call('/googletasks-lists', {})).body.lists;
  await call('/lists', {source: 'googletasks', lists: [{id: lists[0].id, name: 'Groceries', icon: 'cart'}, {id: 'Gforged', name: 'Nope'}]});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home.dir, 'sources.json'), 'utf8')).projects.map(p => [p.source, p.remote || '']), [['googletasks', 'LIST1'], ['local', '']]);

  await call('/googletasks-disconnect', {});
  assert.deepEqual(fake.state.revoked, ['R1'], 'Google is told to forget the token');
  assert.deepEqual([(await call('')).body.googletasks.connected, JSON.parse(fs.readFileSync(path.join(home.dir, 'sources.json'), 'utf8')).projects.map(p => p.source)], [false, ['local']]);
});
