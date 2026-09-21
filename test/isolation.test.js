// Two households on one server: a frame paired to one must never read or change the other. Runs the real server
// in a child process against a scratch data folder, using only routes that need no outside service.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createGrants} = require('../grants');

test('A frame sees its own household and nobody else\'s', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-iso-')), port = 4300 + Math.floor(Math.random() * 500);
  for (const [id, name, zone] of [['alpha', 'Alpha', 'America/Chicago'], ['beta', 'Beta', 'Europe/London']]) {
    fs.mkdirSync(path.join(data, 'households', id), {recursive: true});
    fs.writeFileSync(path.join(data, 'households', id, 'sources.json'), JSON.stringify({name, timezone: zone, calendars: [], projects: []}));
    fs.writeFileSync(path.join(data, 'households', id, 'credentials.json'), '{}');
  }
  const grants = createGrants({file: path.join(data, 'grants.json')});
  const a = grants.add({scope: 'frame', household: 'alpha', label: 'A wall'}).secret, b = grants.add({scope: 'frame', household: 'beta', label: 'B wall'}).secret;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {env: {...process.env, FRAME_DATA: data, FRAME_AUTH: 'required', PORT: String(port), HOST: '127.0.0.1'}, stdio: 'ignore'});
  try {
    const base = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    const as = secret => ({headers: {cookie: 'frame=' + secret, 'x-gingham': '1'}});
    assert.equal((await (await fetch(base + '/api/household', as(a))).json()).name, 'Alpha');
    assert.equal((await (await fetch(base + '/api/household', as(b))).json()).timezone, 'Europe/London');
    await fetch(base + '/api/settings', {...as(a), method: 'POST', body: JSON.stringify({mornings: 10, rest: 'calendar'})});
    assert.equal((await (await fetch(base + '/api/settings', as(a))).json()).mornings, 10);
    assert.equal((await (await fetch(base + '/api/settings', as(b))).json()).mornings, 0, 'beta is untouched by alpha\'s change');
    assert.ok(!fs.existsSync(path.join(data, 'households', 'beta', 'settings.json')), 'nothing was written into beta');
    for (const forged of ['', 'x'.repeat(43), a.slice(0, -2) + 'zz']) assert.equal((await fetch(base + '/api/household', as(forged))).status, 401);
    assert.equal((await fetch(base + '/api/household?household=beta', as(a))).status, 200);
    assert.equal((await (await fetch(base + '/api/household?household=beta', as(a))).json()).name, 'Alpha', 'a frame cannot name the household it wants');
    // A new screen pairs by code: nothing until approved, then its own cookie, then beta's data and only beta's.
    // The phone pages are only pages: anyone may load them, and they show nothing until the tasks answer.
    for (const page of ['/lists', '/setup']) assert.equal((await fetch(base + page)).status, 200);
    // Google's way back in answers with a page, never caches, and gets nothing done without a state it issued.
    const oauth = await fetch(base + '/oauth/google?state=made-up&code=stolen');
    assert.deepEqual([oauth.status, oauth.headers.get('cache-control'), oauth.headers.get('referrer-policy')], [400, 'no-store', 'no-referrer']);
    assert.match(await (await fetch(base + '/lists')).text(), /lists-page\.js/);
    assert.equal((await fetch(base + '/api/tasks')).status, 401, 'the lists page gets nothing for a stranger');
    const post = (url, body, headers = {}) => fetch(base + url, {method: 'POST', headers: {'x-gingham': '1', 'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
    assert.equal((await fetch(base + '/api/pair/start', {method: 'POST'})).status, 405, 'not without the header a browser form cannot send');
    assert.notEqual((await fetch(base + '/api/pair/start', {method: 'POST', headers: {'x-family-frame': '1', 'content-type': 'application/json'}, body: '{}'})).status, 405, 'a page kept from before the rename still works');
    const screen = await (await post('/api/pair/start', {})).json();
    assert.equal((await post('/api/pair/poll', {device: screen.device})).status, 202);
    assert.equal(grants.approvePairing(screen.code, {household: 'beta', label: 'New wall'}), true);
    const approved = await post('/api/pair/poll', {device: screen.device});
    assert.equal(approved.status, 200);
    const cookie = approved.headers.get('set-cookie');
    assert.match(cookie, /^frame=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict/);
    assert.ok(!JSON.stringify(await approved.json()).includes(cookie.slice(6, 30)), 'the secret travels only in the cookie');
    assert.equal((await (await fetch(base + '/api/household', {headers: {cookie: cookie.split(';')[0]}})).json()).name, 'Beta');
    assert.equal((await post('/api/pair/poll', {device: screen.device})).status, 410, 'a second poll gets nothing');
    // The way back in: beta's owner sets a PIN; beta's frame, given that PIN, shows a code; a phone with nothing
    // at all types the code and becomes an owner of beta, once.
    const owner = grants.add({scope: 'owner', household: 'beta', label: 'Phone'}).secret, frameB = {cookie: cookie.split(';')[0]};
    // Photos from a phone: an owner may add to the household's pictures; its frame may look but not add, and the
    // other household sees none of it.
    const picture = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 3, 0x20, 4, 0xb0, 1, 1, 0x11, 0]), Buffer.from([0xff, 0xd9])]);
    const sendPhoto = (who, body = picture) => fetch(base + '/api/photos/add', {method: 'POST', headers: {'x-gingham': '1', 'content-type': 'image/jpeg', 'x-taken': '2025-12-25', ...who}, body});
    assert.equal((await sendPhoto(frameB)).status, 403, 'a frame cannot put pictures on the wall');
    assert.equal((await sendPhoto({})).status, 401);
    assert.equal((await sendPhoto({cookie: 'frame=' + owner}, Buffer.from('not a picture'))).status, 400);
    const kept = await (await sendPhoto({cookie: 'frame=' + owner})).json();
    assert.match(kept.file, /^up-/);
    const shownB = (await (await fetch(base + '/api/photos', frameB.cookie ? {headers: frameB} : {})).json()).photos;
    assert.deepEqual(shownB.map(p => [p.width, p.height, p.taken, p.uploaded]), [[1200, 800, '2025-12-25', true]]);
    assert.equal((await fetch(base + shownB[0].url, {headers: frameB})).status, 200);
    assert.equal((await fetch(base + shownB[0].url, as(a))).status, 404, 'alpha cannot fetch beta\'s picture by its name');
    assert.equal((await (await fetch(base + '/api/photos', as(a))).json()).photos.length, 0);
    assert.equal((await post('/api/photos/remove', {file: kept.file}, frameB)).status, 403);
    assert.equal((await post('/api/photos/remove', {file: kept.file}, {cookie: 'frame=' + owner})).status, 200);
    assert.equal((await fetch(base + shownB[0].url, {headers: frameB})).status, 404);
    assert.equal((await post('/api/owner-code', {pin: '2468'}, frameB)).status, 409, 'with no PIN set, that door stays shut');
    assert.equal((await post('/api/setup/pin', {pin: '12'}, {cookie: 'frame=' + owner})).status, 400);
    assert.equal((await post('/api/setup/pin', {pin: '2468'}, {cookie: 'frame=' + owner})).status, 200);
    assert.equal((await post('/api/owner-code', {pin: '0000'}, frameB)).status, 403);
    assert.equal((await post('/api/owner-code', {pin: '2468'})).status, 401, 'only a paired frame may ask');
    const shown = await (await post('/api/owner-code', {pin: '2468'}, frameB)).json();
    assert.match(shown.code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    assert.equal((await post('/api/setup/claim', {code: 'AAA-AAA'})).status, 400);
    const claimed = await post('/api/setup/claim', {code: shown.code.toLowerCase()});
    assert.equal(claimed.status, 200);
    const phone = claimed.headers.get('set-cookie').split(';')[0];
    const managed = await (await fetch(base + '/api/setup', {headers: {cookie: phone}})).json();
    assert.deepEqual([managed.household.id, managed.pin.set, managed.devices.length], ['beta', true, 2]);
    assert.ok(!JSON.stringify(managed).includes('2468') && !JSON.stringify(managed).includes('scrypt'), 'neither the PIN nor its hash is ever sent');
    assert.equal((await post('/api/setup/claim', {code: shown.code})).status, 400, 'the code works once');
    for (let i = 0; i < 5; i++) await post('/api/owner-code', {pin: '9999'}, frameB);
    assert.equal((await post('/api/owner-code', {pin: '2468'}, frameB)).status, 429, 'five wrong PINs shut the door for a while, even to the right one');
  } finally { server.kill(); fs.rmSync(data, {recursive: true, force: true}); }
});
