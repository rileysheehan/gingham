const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createCalDav, parseXml, parseTodo, completeText, newTodo, foldLine, shortId} = require('../caldav');
const integrations = require('../integrations');
const {createHouseholds} = require('../households');
const {createGrants} = require('../grants');
const {createVault} = require('../vault');
const {createSetup} = require('../setup');

const account = {url: 'https://cloud.example.com', username: 'sam', password: 'app-pass'};
const publicDns = async () => [{address: '203.0.113.7'}];
const ms = (xml, status = 207) => new Response(xml, {status, headers: {'Content-Type': 'application/xml'}});
const multistatus = responses => '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:oc="http://owncloud.org/ns">' + responses + '</d:multistatus>';
const ok = (href, props) => '<d:response><d:href>' + href + '</d:href><d:propstat><d:prop>' + props + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>' +
  '<d:propstat><d:prop><oc:missing/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>';
const vtodo = (lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nextcloud Tasks', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';

const MILK = vtodo(['BEGIN:VTODO', 'UID:milk', 'DTSTAMP:20260901T000000Z', 'SUMMARY:Milk\\, eggs and a very long line that goes on well past seventy-five', '  characters so it is folded', 'STATUS:NEEDS-ACTION',
  'DUE;VALUE=DATE:20260925', 'X-APPLE-SORT-ORDER:12', 'SEQUENCE:3', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'STATUS:ALARMING', 'END:VALARM', 'END:VTODO']);
const TRASH = vtodo(['BEGIN:VTODO', 'UID:trash', 'SUMMARY:Trash to the curb', 'DTSTART;VALUE=DATE:20260921', 'DUE;VALUE=DATE:20260922', 'RRULE:FREQ=WEEKLY', 'PRIORITY:1', 'END:VTODO',
  'BEGIN:VTODO', 'UID:trash', 'RECURRENCE-ID;VALUE=DATE:20260914', 'SUMMARY:An old edit of one week', 'END:VTODO']);
const DONE = vtodo(['BEGIN:VTODO', 'UID:done', 'SUMMARY:Already done', 'STATUS:COMPLETED', 'COMPLETED:20260910T100000Z', 'END:VTODO']);
const BERLIN = vtodo(['BEGIN:VTODO', 'UID:call', 'SUMMARY:Call Oma', 'DUE;TZID=Europe/Berlin:20260925T010000', 'END:VTODO']);

// A CalDAV server in Nextcloud's manner, remembering what it was asked.
function fakeServer({resources = {}} = {}) {
  const asked = [], store = {...resources}, etags = {};
  let conflicts = 0;
  const fetchImpl = async (url, options) => {
    const u = new URL(url), method = options.method, body = options.body ? String(options.body) : '';
    asked.push({method, path: u.pathname, depth: options.headers.Depth, auth: options.headers.Authorization, headers: options.headers, body});
    if (options.headers.Authorization !== 'Basic ' + Buffer.from('sam:app-pass').toString('base64')) return new Response('', {status: 401});
    if (method === 'PROPFIND' && u.pathname === '/.well-known/caldav') return new Response('', {status: 301, headers: {Location: '/remote.php/dav/'}});
    if (method === 'PROPFIND' && u.pathname === '/remote.php/dav/') return ms(multistatus(ok('/remote.php/dav/', '<d:current-user-principal><d:href>/remote.php/dav/principals/users/sam/</d:href></d:current-user-principal>')));
    if (method === 'PROPFIND' && u.pathname === '/remote.php/dav/principals/users/sam/') return ms(multistatus(ok('/remote.php/dav/principals/users/sam/', '<cal:calendar-home-set><d:href>/remote.php/dav/calendars/sam/</d:href></cal:calendar-home-set>')));
    if (method === 'PROPFIND' && u.pathname === '/remote.php/dav/calendars/sam/') return ms(multistatus(
      ok('/remote.php/dav/calendars/sam/', '<d:resourcetype><d:collection/></d:resourcetype>') +
      ok('/remote.php/dav/calendars/sam/tasks/', '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Groceries &amp; errands</d:displayname><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>') +
      ok('/remote.php/dav/calendars/sam/personal/', '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Personal</d:displayname><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>') +
      ok('/remote.php/dav/calendars/sam/inbox/', '<d:resourcetype><d:collection/><cal:schedule-inbox/></d:resourcetype>') +
      ok('/remote.php/dav/calendars/sam/chores', '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>')));
    if (method === 'REPORT' && u.pathname === '/remote.php/dav/calendars/sam/tasks/') return ms(multistatus(Object.entries(store).filter(([p]) => p.startsWith(u.pathname)).map(([p, text]) =>
      ok(p, '<d:getetag>"' + (etags[p] || 'e1') + '"</d:getetag><cal:calendar-data><![CDATA[' + text + ']]></cal:calendar-data>')).join('')));
    if (method === 'GET' && store[u.pathname]) return new Response(store[u.pathname], {status: 200, headers: {ETag: '"' + (etags[u.pathname] || 'e1') + '"'}});
    if (method === 'GET') return new Response('', {status: 404});
    if (method === 'PUT') {
      if (options.headers['If-None-Match'] === '*' && store[u.pathname]) return new Response('', {status: 412});
      if (options.headers['If-Match'] && conflicts > 0) { conflicts--; etags[u.pathname] = 'e2'; return new Response('', {status: 412}); }
      store[u.pathname] = body; etags[u.pathname] = 'e' + (Number((etags[u.pathname] || 'e1').slice(1)) + 1);
      return new Response(null, {status: 204});
    }
    return new Response('', {status: 500});
  };
  return {fetchImpl, asked, store, conflictOnce: () => { conflicts = 1; }};
}

test('The little XML reader: prefixes of any kind, a default namespace, entities, CDATA and attributes', () => {
  const tree = parseXml('<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/a%20b/</href><propstat><prop><x:comp xmlns:x="urn:x" name="VTODO"/><displayname>Tom &amp; Jerry &#233;</displayname><data><![CDATA[BEGIN:<VTODO>]]></data></prop></propstat></response></multistatus>');
  const prop = tree.children[0].children[0].children[1].children[0];
  assert.deepEqual(prop.children.map(c => [c.name, c.attrs.name || '', c.text]), [['comp', 'VTODO', ''], ['displayname', '', 'Tom & Jerry é'], ['data', '', 'BEGIN:<VTODO>']]);
});

test('Tasks read from their text: folded, escaped, dated in the household\'s zone, done ones known, alarms and edits not mistaken for the task', () => {
  assert.deepEqual(parseTodo(MILK, 'America/Chicago'), {title: 'Milk, eggs and a very long line that goes on well past seventy-five characters so it is folded', done: false, priority: 'p4', due: '2026-09-25', recurring: false});
  assert.deepEqual(parseTodo(TRASH, 'America/Chicago'), {title: 'Trash to the curb', done: false, priority: 'p1', due: '2026-09-22', recurring: true});
  assert.equal(parseTodo(DONE, 'UTC').done, true);
  assert.equal(parseTodo(BERLIN, 'America/Chicago').due, '2026-09-24', '1 a.m. in Berlin is still the evening before in Chicago');
  assert.equal(parseTodo('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR', 'UTC'), null);
});

test('Finding the lists: the well-known address, who the account is, where its calendars live, and only the ones that hold tasks', async () => {
  const server = fakeServer(), caldav = createCalDav({fetchImpl: server.fetchImpl, lookup: publicDns});
  const lists = await caldav.discover(account);
  assert.deepEqual(lists.map(l => [l.name, l.remote]), [['Groceries & errands', 'https://cloud.example.com/remote.php/dav/calendars/sam/tasks/'], ['chores', 'https://cloud.example.com/remote.php/dav/calendars/sam/chores/']],
    'events-only calendars and the scheduling inbox are left out; a calendar that does not say what it holds is kept');
  assert.equal(lists[0].id, shortId('C', lists[0].remote));
  assert.deepEqual(server.asked.map(a => [a.method, a.path, a.depth]).slice(0, 5), [['PROPFIND', '/.well-known/caldav', '0'], ['PROPFIND', '/remote.php/dav/', '0'], ['PROPFIND', '/remote.php/dav/principals/users/sam/', '0'], ['PROPFIND', '/remote.php/dav/calendars/sam/', '1']].slice(0, 5));
  await assert.rejects(caldav.discover({...account, password: 'wrong'}), {code: 'AUTH', status: 400});
});

test('A server that names a host on another site for the account is not sent the password', async () => {
  const server = fakeServer(), caldav = createCalDav({fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/remote.php/dav/') return ms(multistatus(ok('/remote.php/dav/', '<d:current-user-principal><d:href>https://collector.example/principal/</d:href></d:current-user-principal>')));
    return server.fetchImpl(url, options);
  }, lookup: publicDns});
  await assert.rejects(caldav.discover({url: 'https://cloud.example.com/', username: 'sam', password: 'app-pass'}), {code: 'BAD_ADDRESS', message: /different site/});
  assert.ok(!server.asked.some(a => a.path === '/principal/'), 'the other site was never asked');
  // Redirected to another host at the start: the password stays behind, and the message says which address to type.
  const moved = createCalDav({fetchImpl: async (url, options) => new URL(url).host === 'cloud.example.com' ? new Response('', {status: 301, headers: {Location: 'https://dav.example.net/remote.php/dav/'}}) : new Response('', {status: options.headers.Authorization ? 207 : 401}), lookup: publicDns});
  await assert.rejects(moved.discover({url: 'https://cloud.example.com/', username: 'sam', password: 'app-pass'}), {code: 'BAD_ADDRESS', message: /on to dav\.example\.net .*Type that address instead/});
});

test('A typed address gets a calendar link\'s care: https, public, no password in it, every redirect checked', async () => {
  const server = fakeServer();
  const privateDns = async () => [{address: '10.0.0.5'}];
  await assert.rejects(createCalDav({fetchImpl: server.fetchImpl, lookup: privateDns}).discover(account), {code: 'PRIVATE'});
  await assert.rejects(createCalDav({fetchImpl: server.fetchImpl, lookup: publicDns}).discover({...account, url: 'http://cloud.example.com'}), {code: 'BAD_ADDRESS'});
  await assert.rejects(createCalDav({fetchImpl: server.fetchImpl, lookup: publicDns}).discover({...account, url: 'https://sam:pw@cloud.example.com'}), {code: 'BAD_ADDRESS'});
  await assert.rejects(createCalDav({fetchImpl: server.fetchImpl, lookup: publicDns}).discover({...account, url: 'not an address'}), {code: 'BAD_ADDRESS'});
  // A public server that redirects to a private one is stopped at the redirect.
  const sneaky = async (url, options) => new URL(url).hostname === 'cloud.example.com' ? new Response('', {status: 307, headers: {Location: 'https://internal.example/'}}) : server.fetchImpl(url, options);
  const splitDns = async host => host === 'internal.example' ? [{address: '192.168.1.2'}] : [{address: '203.0.113.7'}];
  await assert.rejects(createCalDav({fetchImpl: sneaky, lookup: splitDns}).discover({...account, url: 'https://cloud.example.com/dav/'}), {code: 'PRIVATE'});
  // Someone running it for one household at home can opt out, for a server on their own network.
  const home = createCalDav({fetchImpl: async (url, o) => server.fetchImpl(String(url).replace('http://nas.local:5000', 'https://cloud.example.com'), o), lookup: privateDns, allowPrivate: true});
  assert.equal((await home.discover({...account, url: 'http://nas.local:5000'})).length, 2);
});

test('Items, adding, and checking off: a one-off is completed, a repeating one moves on, and nothing else in it changes', async () => {
  const base = '/remote.php/dav/calendars/sam/tasks/';
  const server = fakeServer({resources: {[base + 'milk.ics']: MILK, [base + 'trash.ics']: TRASH, [base + 'done.ics']: DONE}});
  let held = {caldav: account};
  const caldav = createCalDav({fetchImpl: server.fetchImpl, lookup: publicDns, credentials: () => held, now: () => Date.UTC(2026, 8, 21, 15, 0, 0)});
  const list = 'https://cloud.example.com' + base;
  const items = await caldav.items(list, 'America/Chicago');
  assert.deepEqual(items.map(t => [t.title.slice(0, 18), t.due, t.recurring]), [['Milk, eggs and a v', '2026-09-25', false], ['Trash to the curb', '2026-09-22', true]], 'a server that ignores the filter still shows no finished task');
  const report = server.asked.find(a => a.method === 'REPORT');
  assert.equal(report.depth, '1'); assert.match(report.body, /<c:prop-filter name="COMPLETED"><c:is-not-defined\/>/);

  await caldav.add(list, 'Bread; jam, and butter');
  const put = server.asked.at(-1);
  assert.equal(put.headers['If-None-Match'], '*');
  assert.match(put.path, /^\/remote\.php\/dav\/calendars\/sam\/tasks\/[0-9a-f-]{36}\.ics$/);
  assert.match(put.body, /\r\nSUMMARY:Bread\\; jam\\, and butter\r\n/);
  assert.match(put.body, /\r\nSTATUS:NEEDS-ACTION\r\n/);

  // The one-off.
  await caldav.complete(items[0].id);
  const milk = server.store[base + 'milk.ics'];
  assert.equal(server.asked.at(-1).headers['If-Match'], '"e1"', 'written back only if unchanged since it was read');
  assert.match(milk, /\r\nSTATUS:COMPLETED\r\n/); assert.match(milk, /\r\nCOMPLETED:20260921T150000Z\r\n/); assert.match(milk, /\r\nPERCENT-COMPLETE:100\r\n/);
  assert.match(milk, /\r\nSEQUENCE:4\r\n/); assert.match(milk, /\r\nX-APPLE-SORT-ORDER:12\r\n/);
  assert.match(milk, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nSTATUS:ALARMING\r\nEND:VALARM/, 'the alarm is left exactly as it was');
  assert.equal((milk.match(/^STATUS:/gm) || []).length, 2, 'one STATUS for the task, one for its alarm');
  assert.ok(milk.split('\r\n').every(line => Buffer.byteLength(line) <= 75), 'every line folded to 75 bytes');
  await assert.rejects(caldav.complete(items[0].id), {code: 'UNKNOWN_TASK'}, 'once');

  // The repeating one, which somebody else changed a moment before: read again, then moved on a week.
  server.conflictOnce();
  await caldav.complete(items[1].id);
  const trash = server.store[base + 'trash.ics'];
  assert.match(trash, /\r\nDTSTART;VALUE=DATE:20260928\r\n/); assert.match(trash, /\r\nDUE;VALUE=DATE:20260929\r\n/);
  assert.match(trash, /\r\nRRULE:FREQ=WEEKLY\r\n/); assert.match(trash, /\r\nSTATUS:NEEDS-ACTION\r\n/);
  assert.doesNotMatch(trash, /COMPLETED:/);
  assert.match(trash, /RECURRENCE-ID;VALUE=DATE:20260914\r\nSUMMARY:An old edit of one week/, 'the edit of one occurrence is left alone');
});

test('Repeating tasks: local times survive daylight saving, a count counts down, an ended series completes, a rule it cannot follow is refused', () => {
  const at = Date.UTC(2026, 9, 29, 12);
  const weekly = completeText(vtodo(['BEGIN:VTODO', 'UID:a', 'SUMMARY:Piano', 'DTSTART;TZID=America/Chicago:20261029T090000', 'DUE;TZID=America/Chicago:20261029T093000', 'RRULE:FREQ=WEEKLY', 'END:VTODO']), at);
  assert.match(weekly, /DTSTART;TZID=America\/Chicago:20261105T090000/, 'still 9 a.m. after the clocks change');
  assert.match(weekly, /DUE;TZID=America\/Chicago:20261105T093000/);
  const counted = completeText(vtodo(['BEGIN:VTODO', 'UID:b', 'DUE:20261029T150000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VTODO']), at);
  assert.match(counted, /DUE:20261030T150000Z/); assert.match(counted, /RRULE:FREQ=DAILY;COUNT=2/);
  const last = completeText(vtodo(['BEGIN:VTODO', 'UID:c', 'DUE:20261029T150000Z', 'RRULE:FREQ=DAILY;COUNT=1', 'END:VTODO']), at);
  assert.match(last, /STATUS:COMPLETED/); assert.match(last, /DUE:20261029T150000Z/);
  const ended = completeText(vtodo(['BEGIN:VTODO', 'UID:d', 'DUE;VALUE=DATE:20261029', 'RRULE:FREQ=WEEKLY;UNTIL=20261101', 'END:VTODO']), at);
  assert.match(ended, /STATUS:COMPLETED/);
  assert.throws(() => completeText(vtodo(['BEGIN:VTODO', 'UID:e', 'DUE:20261029T150000Z', 'RRULE:FREQ=HOURLY', 'END:VTODO']), at), {code: 'REPEAT', status: 409});
  // From the pre-launch review: a series is over only when it says so, never because the search stopped looking.
  assert.match(completeText(vtodo(['BEGIN:VTODO', 'UID:f', 'DUE;VALUE=DATE:20260101', 'RRULE:FREQ=YEARLY;INTERVAL=3', 'END:VTODO']), at), /DUE;VALUE=DATE:20290101[\s\S]*STATUS:NEEDS-ACTION|STATUS:NEEDS-ACTION[\s\S]*DUE;VALUE=DATE:20290101/, 'every three years moves on three years');
  assert.match(completeText(vtodo(['BEGIN:VTODO', 'UID:g', 'DUE;VALUE=DATE:20240229', 'RRULE:FREQ=YEARLY', 'END:VTODO']), at), /DUE;VALUE=DATE:20280229/, 'a leap day waits for the next one');
  assert.throws(() => completeText(vtodo(['BEGIN:VTODO', 'UID:h', 'DUE;VALUE=DATE:20260101', 'RRULE:FREQ=YEARLY;INTERVAL=20', 'END:VTODO']), at), {code: 'REPEAT', status: 409}, 'too far ahead to find: refused, not ended');
  // Second pass: UNTIL is an instant, and 09:00 in Chicago is 15:00Z.
  const zoned = until => completeText(vtodo(['BEGIN:VTODO', 'UID:i', 'DTSTART;TZID=America/Chicago:20261029T090000', 'RRULE:FREQ=DAILY;UNTIL=' + until, 'END:VTODO']), at);
  assert.match(zoned('20261030T120000Z'), /STATUS:COMPLETED/, 'the next one, at 14:00Z, is after UNTIL');
  assert.match(zoned('20261030T150000Z'), /DTSTART;TZID=America\/Chicago:20261030T090000/, 'the next one is exactly UNTIL, so it still happens');
  assert.match(zoned('20261030'), /DTSTART;TZID=America\/Chicago:20261030T090000/, 'a date UNTIL covers the whole day');
  assert.match(newTodo('x', 'u', at), /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.equal(foldLine('é'.repeat(50)).split('\r\n ').every(part => Buffer.byteLength(part) <= 75), true, 'never splits a character');
});

test('A CalDAV list sits beside the others, and setup keeps its password sealed and its lists to itself', async () => {
  const closed = [], added = [];
  const fake = {has: () => true, items: async () => [{id: 'c1111111111111111', title: 'Milk', priority: 'p4', due: '', recurring: false}], add: async (remote, title) => added.push([remote, title]), complete: async id => closed.push(id)};
  const service = integrations.create({api: {todoistPost: async () => { throw Error('not Todoist'); }}, config: () => ({timezone: 'UTC', projects: [{id: 'Cabc', name: 'Groceries', source: 'caldav', remote: 'https://x/tasks/'}]}), cacheDir: null, caldav: fake});
  assert.equal((await service.tasks()).tasks[0].project, 'Groceries');
  await service.addTask('Groceries', 'Eggs'); await service.closeTask('c1111111111111111');
  assert.deepEqual([added, closed], [[['https://x/tasks/', 'Eggs']], ['c1111111111111111']]);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'caldav-setup-'));
  fs.mkdirSync(path.join(data, 'households', 'alpha'), {recursive: true});
  fs.writeFileSync(path.join(data, 'households', 'alpha', 'sources.json'), JSON.stringify({name: 'alpha', calendars: [], people: [], projects: [{id: 'Lkept', name: 'Kept', source: 'local'}]}));
  const households = createHouseholds({root: path.join(data, 'households'), vault: createVault({masterKey: crypto.randomBytes(32).toString('base64')})});
  const grants = createGrants({file: path.join(data, 'grants.json')});
  const setup = createSetup({households, grants});
  const owner = grants.verify(grants.add({scope: 'owner', household: 'alpha', label: 'owner'}).secret);
  const call = (p, body) => setup.handle({method: body ? 'POST' : 'GET', url: new URL('http://x/api/setup' + p), grant: owner, body});
  const home = households.get('alpha'), server = fakeServer(), file = path.join(home.dir, 'credentials.json');
  home.caldav = createCalDav({fetchImpl: server.fetchImpl, lookup: publicDns, credentials: () => households.vault.read(file, 'alpha')});

  assert.equal((await call('/caldav', {url: account.url, username: 'sam', password: 'wrong'})).status, 400);
  assert.equal((await call('')).body.caldav.connected, false, 'a wrong password is not kept');
  const connected = await call('/caldav', account);
  assert.deepEqual(connected.body.lists.map(l => l.name), ['Groceries & errands', 'chores']);
  assert.deepEqual((await call('')).body.caldav, {connected: true, server: 'cloud.example.com', username: 'sam'});
  assert.ok(!fs.readFileSync(file, 'utf8').includes('app-pass'), 'the password is sealed on disk');
  assert.ok(!JSON.stringify((await call('')).body).includes('app-pass'), 'and never sent back');

  const groceries = connected.body.lists[0].id;
  await call('/lists', {source: 'caldav', lists: [{id: groceries, name: 'Groceries', icon: 'cart'}, {id: 'Cforged', name: 'Nope'}]});
  const projects = JSON.parse(fs.readFileSync(path.join(home.dir, 'sources.json'), 'utf8')).projects;
  assert.deepEqual(projects.map(p => [p.source, p.remote || '']), [['caldav', 'https://cloud.example.com/remote.php/dav/calendars/sam/tasks/'], ['local', '']]);
  await call('/caldav-disconnect', {});
  assert.deepEqual([(await call('')).body.caldav.connected, JSON.parse(fs.readFileSync(path.join(home.dir, 'sources.json'), 'utf8')).projects.map(p => p.source)], [false, ['local']]);
});
