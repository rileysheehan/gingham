const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createVault, hashPin, checkPin} = require('../vault');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'credentials.json');
const key = () => crypto.randomBytes(32).toString('base64');

test('With a key, credentials are unreadable on disk and open only for their own household', () => {
  const f = file(), k = key(), vault = createVault({masterKey: k});
  vault.write(f, 'ashby', {todoist: {token: 'tok-1234567890'}, ics: {theo: 'https://p01-caldav.icloud.com/published/2/abcdef'}});
  const onDisk = fs.readFileSync(f, 'utf8');
  for (const leak of ['tok-1234567890', 'icloud', 'theo', 'todoist']) assert.ok(!onDisk.includes(leak), leak + ' is not visible in the file');
  assert.equal(vault.read(f, 'ashby').todoist.token, 'tok-1234567890');
  assert.throws(() => vault.read(f, 'someone-else'), 'dropped into another household\'s folder, it does not open');
  assert.throws(() => createVault({masterKey: key()}).read(f, 'ashby'), 'nor with another key');
  assert.throws(() => createVault({masterKey: ''}).read(f, 'ashby'), /FRAME_MASTER_KEY is not set/);
  const tampered = JSON.parse(onDisk), bytes = Buffer.from(tampered.data, 'base64'); bytes[0] ^= 1; tampered.data = bytes.toString('base64');   // one bit, so it always differs
  fs.writeFileSync(f, JSON.stringify(tampered));
  assert.throws(() => vault.read(f, 'ashby'), 'a changed file is refused, not half-read');
  assert.throws(() => createVault({masterKey: 'too-short'}), /32 bytes/);
});

test('Without a key it is the plain file it always was; with one, a plain file is sealed where it lies', () => {
  const f = file(), plain = createVault({masterKey: ''});
  plain.write(f, 'ashby', {todoist: {token: 't'}});
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), {todoist: {token: 't'}});
  assert.equal(plain.seal(f, 'ashby'), false);
  const vault = createVault({masterKey: key()});
  assert.deepEqual(vault.read(f, 'ashby'), {todoist: {token: 't'}}, 'a plain file still reads while a key is set');
  assert.equal(vault.seal(f, 'ashby'), true);
  assert.equal(vault.seal(f, 'ashby'), false, 'once');
  assert.ok(!fs.readFileSync(f, 'utf8').includes('todoist'));
  assert.equal((fs.statSync(f).mode & 0o777), 0o600);
});

test('Secrets are set by name and listed by name, and never listed by value', () => {
  const f = file(), vault = createVault({masterKey: key()});
  vault.set(f, 'h', 'ics.theo', 'https://example.com/secret.ics');
  vault.set(f, 'h', 'todoist.token', 'abc');
  vault.set(f, 'h', 'ics.empty', '');
  assert.deepEqual(vault.names(vault.read(f, 'h')).sort(), ['ics.theo', 'todoist.token']);
  assert.ok(!JSON.stringify(vault.names(vault.read(f, 'h'))).includes('example.com'));
  vault.set(f, 'h', 'ics.theo', null);
  assert.deepEqual(vault.names(vault.read(f, 'h')), ['todoist.token']);
  for (const bad of ['__proto__.polluted', 'a..b', 'constructor.x', 'a b', '']) assert.throws(() => vault.set(f, 'h', bad, 'x'), undefined, bad);
  assert.equal({}.polluted, undefined);
});

test('A PIN is stored stretched and salted, and only the right digits open it', () => {
  const stored = hashPin('2468');
  assert.match(stored, /^scrypt\$/); assert.ok(!stored.includes('2468'));
  assert.notEqual(hashPin('2468'), stored, 'salted: the same PIN never stores the same way twice');
  assert.equal(checkPin('2468', stored), true);
  for (const wrong of ['2469', '', '24680', undefined]) assert.equal(checkPin(wrong, stored), false);
  for (const junk of ['', 'plain$x$y', 'scrypt$only', undefined]) assert.equal(checkPin('2468', junk), false);
});
