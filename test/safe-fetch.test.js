const {test} = require('node:test');
const assert = require('node:assert/strict');
const {safeFetchText, isPrivate} = require('../safe-fetch');

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
