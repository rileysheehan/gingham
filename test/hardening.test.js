// From the pre-launch review, against the real server in a child process: a request it cannot read is answered, not
// fatal; a header anyone can send does not choose whose ration a request comes out of; and a Google sign-in is
// finished only by the browser that started it.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createGrants} = require('../grants');

async function start(env = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-hard-')), port = 4800 + Math.floor(Math.random() * 500);
  fs.mkdirSync(path.join(data, 'households', 'alpha'), {recursive: true});
  fs.writeFileSync(path.join(data, 'households', 'alpha', 'sources.json'), JSON.stringify({name: 'Alpha', timezone: 'America/Chicago', calendars: [], projects: []}));
  const base = {...process.env}; delete base.FLY_APP_NAME; delete base.FRAME_TRUST_PROXY;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {env: {...base, FRAME_DATA: data, FRAME_AUTH: 'required', PORT: String(port), HOST: '127.0.0.1', ...env}, stdio: 'ignore'});
  const url = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url + '/healthz')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
  return {url, port, data, server, stop: () => server.kill()};
}
const raw = (port, text) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => socket.end(text)); let got = '';
  socket.on('data', d => { got += d; }); socket.on('end', () => resolve(got)); socket.on('error', reject);
});
const pairStart = (url, headers = {}) => fetch(url + '/api/pair/start', {method: 'POST', headers: {'x-gingham': '1', 'content-type': 'application/json', ...headers}, body: '{}'});

test('A request the server cannot read gets a 400, and the server carries on for everyone else', async () => {
  const s = await start();
  try {
    assert.match(await raw(s.port, 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
    assert.equal(s.server.exitCode, null, 'still running');
    assert.equal((await fetch(s.url + '/healthz')).status, 200);
  } finally { s.stop(); }
});

test('Rations are by the address that connected; Fly-Client-IP counts only on Fly, where Fly sets it', async () => {
  const plain = await start();
  try {
    const answers = [];
    for (let i = 0; i < 13; i++) answers.push((await pairStart(plain.url, {'fly-client-ip': '203.0.113.' + i, 'x-forwarded-for': '198.51.100.' + i})).status);
    assert.deepEqual([answers.slice(0, 12).every(s => s === 200), answers[12]], [true, 429], 'changing a header buys nothing');
  } finally { plain.stop(); }
  const fly = await start({FLY_APP_NAME: 'gingham-test'});
  try {
    for (let i = 0; i < 12; i++) await pairStart(fly.url, {'fly-client-ip': '203.0.113.7'});
    assert.equal((await pairStart(fly.url, {'fly-client-ip': '203.0.113.7'})).status, 429);
    assert.equal((await pairStart(fly.url, {'fly-client-ip': '203.0.113.8'})).status, 200, 'on Fly, the header is who is asking');
  } finally { fly.stop(); }
});

test('A Google sign-in carries a cookie for the browser that started it, and a return without it connects nothing', async () => {
  const s = await start({GINGHAM_GOOGLE_CLIENT_ID: 'CID.apps.googleusercontent.com', GINGHAM_GOOGLE_CLIENT_SECRET: 'SECRET', FRAME_URL: 'https://frame.example.com'});
  try {
    const owner = createGrants({file: path.join(s.data, 'grants.json')}).add({scope: 'owner', household: 'alpha', label: 'Phone'}).secret;
    const started = await fetch(s.url + '/api/setup/googletasks-start', {method: 'POST', headers: {cookie: 'frame=' + owner, 'x-gingham': '1', 'content-type': 'application/json'}, body: '{}'});
    assert.equal(started.status, 200);
    const state = new URL((await started.json()).url).searchParams.get('state');
    assert.equal(started.headers.get('set-cookie'), 'gingham_oauth=' + state + '; Path=/oauth/google; HttpOnly; SameSite=Lax; Max-Age=600');
    const elsewhere = await fetch(s.url + '/oauth/google?code=GOOD&state=' + state);
    assert.equal(elsewhere.status, 400);
    assert.match(await elsewhere.text(), /phone that started it/);
    assert.match(elsewhere.headers.get('set-cookie'), /^gingham_oauth=; Path=\/oauth\/google; .*Max-Age=0/, 'and the cookie is cleared');
  } finally { s.stop(); }
});

test('A ration keeps only what it needs, counts an IPv6 /64 as one household, and a full table never forgets who is held back', async () => {
  const s = await start({FRAME_TRUST_PROXY: '1'});
  try {
    const from = address => fetch(s.url + '/oauth/google?state=x', {headers: {'x-forwarded-for': '198.51.100.250, ' + address}}).then(r => r.status);
    // The last X-Forwarded-For entry is the one the proxy added; the first is whatever the client claimed.
    for (let i = 0; i < 30; i++) await from('2001:db8:1:2::' + (i + 1).toString(16));
    assert.equal(await from('2001:db8:1:2:ffff::9'), 429, 'a new address in the same /64 is the same household');
    assert.equal(await from('2001:db8:1:3::1'), 400, 'the next /64 is someone else (400: no such sign-in)');
    // 5,000 other addresses, all still inside their window, fill the table. The held-back /64 stays held back, and a
    // newcomer waits rather than anyone's limit being thrown away to make room.
    for (let i = 0; i < 5000; i += 100) await Promise.all(Array.from({length: 100}, (_, j) => from('203.0.' + Math.floor((i + j) / 250) + '.' + ((i + j) % 250 + 1))));
    assert.equal(await from('2001:db8:1:2::1'), 429, 'still held back');
    assert.equal(await from('192.0.2.77'), 429, 'a newcomer to a full table waits');
    assert.equal(s.server.exitCode, null);
  } finally { s.stop(); }
});
