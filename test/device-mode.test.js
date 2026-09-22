// The tablet is the server: started with no households inside the kiosk app (FRAME_LOCAL_FRAME=1), its own screen is
// the frame, and the first person to read the code off that screen becomes the household's owner. Once.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {startServer, makeData} = require('./server-harness');

test('First run on a tablet: the screen vouches for the first owner, and only the first', async () => {
  const s = await startServer({data: makeData('frame-device-'), env: {FRAME_AUTH: 'required', FRAME_LOCAL_FRAME: '1', FRAME_URL: 'http://192.168.1.23:4173'}});
  try {
    const base = s.url;
    const post = (url, body, headers = {}) => fetch(base + url, {method: 'POST', headers: {'x-gingham': '1', 'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
    const screen = await (await fetch(base + '/api/household')).json();
    assert.deepEqual(screen, {name: 'home', timezone: 'UTC', place: '', needsSetup: true, address: 'http://192.168.1.23:4173'}, 'the tablet\'s own screen is its frame, and is told nobody looks after it yet');
    assert.equal((await fetch(base + '/api/settings')).status, 200, 'and it can already show the (empty) frame');
    assert.equal((await fetch(base + '/api/household', {headers: {cookie: 'frame=' + 'x'.repeat(43)}})).status, 401, 'a wrong secret is not excused for coming from the same machine');
    assert.equal((await fetch(base + '/api/setup')).status, 401, 'being the screen is not being an owner');
    const shown = await (await post('/api/owner-code', {})).json();
    assert.match(shown.code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/, 'no PIN is asked for: nobody exists who could have set one');
    const claimed = await post('/api/setup/claim', {code: shown.code});
    assert.equal(claimed.status, 200);
    const phone = claimed.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(base + '/api/setup', {headers: {cookie: phone}})).json()).household.id, 'home');
    assert.equal((await (await fetch(base + '/api/household')).json()).needsSetup, undefined, 'the welcome is over');
    assert.equal((await post('/api/owner-code', {})).status, 409, 'and that door is shut: from now on it takes the household PIN');
    // With no account anywhere: the phone makes a list, the wall adds to it and checks it off.
    assert.equal((await post('/api/setup/list-add', {name: 'Groceries', icon: 'cart'}, {cookie: phone})).status, 200);
    assert.equal((await fetch(base + '/api/tasks', {method: 'POST', body: '{}'})).status, 403, 'adding needs the header a foreign page cannot send');
    assert.equal((await post('/api/tasks', {list: 'Groceries', title: 'Milk'})).status, 200);
    assert.equal((await post('/api/tasks', {list: 'Nope', title: 'Milk'})).status, 404);
    const wall = await (await fetch(base + '/api/tasks')).json();
    assert.deepEqual(wall.tasks.map(t => [t.project, t.title]), [['Groceries', 'Milk']]);
    assert.equal((await post('/api/tasks/' + wall.tasks[0].id + '/close', {})).status, 200);
    assert.deepEqual((await (await fetch(base + '/api/tasks')).json()).tasks, []);
  } finally { await s.stop(); }
});
