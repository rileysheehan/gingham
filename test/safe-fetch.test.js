const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const {safeFetchText, safeRequest, isPrivate, sameService, pinnedFetch} = require('../safe-fetch');

const publicLookup = async () => [{address: '142.250.1.1'}];
const reply = (body, status = 200, headers = {}) => new Response(body, {status, headers});

test('Private, loopback, link-local and internal addresses are recognised, in both families', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.20', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fdaa:0:1::3', 'fc00::1', '::ffff:10.0.0.1', '224.0.0.1']) assert.equal(isPrivate(a), true, a);
  for (const a of ['142.250.1.1', '17.253.144.10', '172.32.0.1', '100.128.0.1', '2607:f8b0:4000::1']) assert.equal(isPrivate(a), false, a);
});

test('Only public https addresses are fetched, and a calendar:// style link is understood', async () => {
  const seen = [];
  const fetchImpl = async url => { seen.push(String(url)); return reply('BEGIN:VCALENDAR'); };
  assert.equal((await safeFetchText('webcal://p01-caldav.icloud.com/published/2/abc', {fetchImpl, lookup: publicLookup})).text, 'BEGIN:VCALENDAR');
  assert.equal(seen[0], 'https://p01-caldav.icloud.com/published/2/abc');
  for (const bad of ['http://calendar.google.com/x.ics', 'ftp://example.com/x', 'file:///etc/passwd', 'not a link', '', 'https://user:pw@example.com/x.ics'])
    await assert.rejects(safeFetchText(bad, {fetchImpl, lookup: publicLookup}), undefined, bad);
  for (const inside of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x'])
    await assert.rejects(safeFetchText(inside, {fetchImpl, lookup: publicLookup}), /public internet/, inside);
  await assert.rejects(safeFetchText('https://innocent.example/x', {fetchImpl, lookup: async () => [{address: '142.250.1.1'}, {address: '10.0.0.5'}]}), /public internet/, 'a name that also resolves inside is refused');
  assert.equal(seen.length, 1, 'nothing refused was ever requested');
});

test('A redirect is checked like any other address, and cannot lead inside', async () => {
  const hops = {'https://a.example/cal': reply('', 302, {location: 'https://b.example/real.ics'}), 'https://b.example/real.ics': reply('OK')};
  assert.equal((await safeFetchText('https://a.example/cal', {fetchImpl: async u => hops[String(u)], lookup: publicLookup})).text, 'OK');
  const inward = async () => reply('', 302, {location: 'https://internal.example/secret'});
  const lookup = async host => host === 'internal.example' ? [{address: '10.0.0.9'}] : [{address: '142.250.1.1'}];
  await assert.rejects(safeFetchText('https://a.example/cal', {fetchImpl: inward, lookup}), /public internet/);
  await assert.rejects(safeFetchText('https://a.example/cal', {fetchImpl: async u => reply('', 302, {location: String(u) + 'x'}), lookup: publicLookup}), /Too many redirects/);
  await assert.rejects(safeFetchText('https://a.example/cal', {fetchImpl: async () => reply('', 302, {location: 'http://b.example/plain'}), lookup: publicLookup}), /https/);
});

test('An oversized body is dropped at the cap, errors are errors, and a home server can be allowed on purpose', async () => {
  await assert.rejects(safeFetchText('https://a.example/big', {fetchImpl: async () => reply('x'.repeat(5000)), lookup: publicLookup, maxBytes: 1000}), /too large/);
  await assert.rejects(safeFetchText('https://a.example/gone', {fetchImpl: async () => reply('no', 404), lookup: publicLookup}), /404/);
  assert.equal((await safeFetchText('http://192.168.1.20:5232/cal.ics', {fetchImpl: async () => reply('HOME'), allowPrivate: true})).text, 'HOME');
});

// From the pre-launch review: the same private address has many spellings, and the URL parser writes
// ::ffff:127.0.0.1 as ::ffff:7f00:1, which a check that only knew the dotted form let through.
test('Every spelling of an inside address is recognised, including the ones the URL parser produces', async () => {
  for (const a of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:0:7f00:1', '::7f00:1', '2002:7f00:1::', '2002:a9fe:a9fe::1',
    '64:ff9b::a00:1', '2001::1', 'fec0::1', 'ff02::1', 'FE80::1%en0', 'zz::1', '1::2::3', '']) assert.equal(isPrivate(a), true, a);
  for (const a of ['::ffff:8.8.8.8', '::ffff:808:808', '2002:808:808::1', '2606:4700::1111']) assert.equal(isPrivate(a), false, a);
  const fetchImpl = async () => reply('should not be asked');
  for (const inside of ['https://[::ffff:127.0.0.1]/x', 'https://[::ffff:169.254.169.254]/latest', 'https://[0:0:0:0:0:ffff:a00:1]/x', 'https://2130706433/x', 'https://0x7f.1/x']) {
    await assert.rejects(safeFetchText(inside, {fetchImpl, lookup: publicLookup}), /public internet/, inside);
    await assert.rejects(safeRequest(inside, {fetchImpl, lookup: publicLookup}), {code: 'PRIVATE'}, inside);
  }
});

test('The connection goes only to the addresses that were checked, so a name cannot change its answer in between', async () => {
  const told = [];
  await safeRequest('https://cal.example/dav', {fetchImpl: async (url, options) => { told.push(options.pinned); return reply('ok'); }, lookup: async () => [{address: '142.250.1.1'}, {address: '2607:f8b0:4000::1'}]});
  assert.deepEqual(told[0].map(f => f.address), ['142.250.1.1', '2607:f8b0:4000::1']);
  // The real one: a name that resolves nowhere is still reached at the address it was pinned to, and a compressed
  // answer is unpacked as fetch would.
  const server = http.createServer((req, res) => {
    if (req.url === '/zipped') { res.writeHead(200, {'Content-Encoding': 'gzip'}); return res.end(zlib.gzipSync('BEGIN:VCALENDAR zipped')); }
    res.writeHead(200, {ETag: '"v1"'}); res.end('BEGIN:VCALENDAR ' + req.headers.host);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const plain = await pinnedFetch('http://nowhere.invalid:' + port + '/', {pinned: [{address: '127.0.0.1'}]});
    assert.deepEqual([plain.status, await plain.text(), plain.headers.get('etag')], [200, 'BEGIN:VCALENDAR nowhere.invalid:' + port, '"v1"']);
    assert.equal(await (await pinnedFetch('http://nowhere.invalid:' + port + '/zipped', {pinned: [{address: '127.0.0.1'}]})).text(), 'BEGIN:VCALENDAR zipped');
  } finally { server.close(); }
});

test('A redirect to another site leaves the password or token behind; one within the same service keeps it', async () => {
  const asked = [];
  const run = async (from, to, status = 302, method = 'GET') => {
    asked.length = 0;
    const fetchImpl = async (url, options) => { asked.push({url: String(url), method: options.method, auth: options.headers.Authorization, body: options.body}); return asked.length === 1 ? reply('', status, {location: to}) : reply('done'); };
    await safeRequest(from, {method, body: method === 'GET' ? undefined : 'x', headers: {Authorization: 'Bearer SECRET', 'Content-Type': 'text/plain'}, fetchImpl, lookup: publicLookup});
    return asked[1];
  };
  assert.equal((await run('https://ha.example.com/api/', 'https://attacker.example/steal')).auth, undefined, 'another site');
  assert.equal((await run('https://caldav.icloud.com/', 'https://p42-caldav.icloud.com/1234/')).auth, 'Bearer SECRET', 'another host of the same service');
  const seeOther = await run('https://cal.example.com/a', 'https://cal.example.com/b', 303, 'PROPFIND');
  assert.deepEqual([seeOther.method, seeOther.body], ['GET', undefined], 'a 303 continues as a plain GET');
  assert.equal((await run('https://cal.example.com/a', 'https://cal.example.com/b', 307, 'REPORT')).method, 'REPORT', 'a 307 keeps the method');
  assert.equal((await run('https://victim.co.uk/dav/', 'https://attacker.co.uk/steal')).auth, undefined, 'two tenants of one public suffix are two sites');
  // Second pass: "the same service" is the same origin, or two hosts of a provider known to shard accounts.
  for (const [a, b, same] of [
    ['https://a.example.com/', 'http://a.example.com/', false], ['https://a.example.com:8443/', 'https://a.example.com/', false],
    ['https://victim.com./', 'https://attacker.com./', false], ['https://Cal.Example.com./x', 'https://cal.example.com/y', true],
    ['https://victim.co.uk/', 'https://attacker.co.uk/', false], ['https://dav.example.com/', 'https://www.example.com/', false],
    ['https://caldav.icloud.com/', 'https://p42-caldav.icloud.com:443/1/', true], ['https://caldav.icloud.com/', 'https://evilicloud.com/', false],
    ['https://[2001:db8::1]/', 'https://[2001:db8::1]:443/', true]]) assert.equal(sameService(a, b), same, a + ' / ' + b);
});
