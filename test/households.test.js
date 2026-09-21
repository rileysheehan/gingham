const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHouseholds, validId} = require('../households');
const {createGrants, mayManage} = require('../grants');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frame-'));

test('A household is a folder of its own, and ids cannot climb out of the root', () => {
  const root = temp();
  fs.mkdirSync(path.join(root, 'ashby'));
  fs.writeFileSync(path.join(root, 'ashby', 'sources.json'), JSON.stringify({photoAlbum: ''}));
  fs.mkdirSync(path.join(root, 'empty'));
  const households = createHouseholds({root});
  assert.deepEqual(households.list(), ['ashby', 'empty']);
  assert.equal(households.get('ashby').id, 'ashby');
  assert.equal(households.get('empty'), null, 'no sources.json, no household');
  for (const bad of ['../ashby', 'ashby/..', '', 'A', '.', 'a'.repeat(41)]) { assert.equal(validId(bad), false); assert.equal(households.get(bad), null); }
  assert.deepEqual(households.get('ashby').photoManifest(), {photos: []});
  assert.equal(households.get('ashby').settings.read().rest, 'photos');
});

test('A secret is shown once, stored only as a hash, scoped, and stops working when revoked', () => {
  const file = path.join(temp(), 'grants.json');
  const grants = createGrants({file});
  const {grant, secret} = grants.add({scope: 'frame', household: 'ashby', label: 'Kitchen'});
  assert.ok(secret.length >= 40);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(secret), 'the secret itself is never written');
  assert.equal(grants.verify(secret).household, 'ashby');
  for (const wrong of [secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A'), '', 'short', undefined, 'x'.repeat(300)]) assert.equal(grants.verify(wrong), null);
  assert.equal(grants.list()[0].hash, undefined, 'listings leave the hash out');
  assert.throws(() => grants.add({scope: 'frame'}), 'a frame must belong to a household');
  assert.throws(() => grants.add({scope: 'root', household: 'x'}));
  assert.equal(grants.revoke(grant.id), true);
  assert.equal(grants.verify(secret), null);
  assert.equal(mayManage({scope: 'owner', household: 'a'}, 'a'), true);
  assert.equal(mayManage({scope: 'owner', household: 'a'}, 'b'), false);
  assert.equal(mayManage({scope: 'frame', household: 'a'}, 'a'), false);
  assert.equal(mayManage({scope: 'admin', household: null}, 'b'), true);
});

test('A link works once, only when pressed, and not after it expires', () => {
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const grants = createGrants({file: path.join(temp(), 'grants.json'), now: () => clock});
  const token = grants.mintLink({scope: 'owner', household: 'ashby', label: 'Mara'});
  assert.deepEqual(grants.peekLink(token), {scope: 'owner', household: 'ashby'});
  assert.deepEqual(grants.peekLink(token), {scope: 'owner', household: 'ashby'}, 'a preview does not spend it');
  const first = grants.redeemLink(token, 'Mara’s iPhone');
  assert.equal(first.grant.scope, 'owner');
  assert.equal(grants.verify(first.secret).label, 'Mara’s iPhone');
  assert.equal(grants.redeemLink(token), null, 'a second use gets nothing');
  assert.equal(grants.verify(token), null, 'the link is never itself a session');
  const stale = grants.mintLink({scope: 'admin'});
  clock += 73 * 3600000;
  assert.equal(grants.redeemLink(stale), null);
  assert.throws(() => grants.mintLink({scope: 'frame', household: 'ashby'}), 'screens pair by code, not by link');
});

test('A screen pairs by a code that someone approves, and is answered exactly once', () => {
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const grants = createGrants({file: path.join(temp(), 'grants.json'), now: () => clock});
  const screen = grants.startPairing();
  assert.match(screen.code, /^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/, 'no 0/O/1/I/L to misread');
  assert.equal(grants.pollPairing(screen.device).status, 'pending');
  assert.equal(grants.pollPairing('someone-elses-device-token-000000000000').status, 'expired');
  assert.equal(grants.approvePairing('ZZZ-ZZZ', {household: 'ashby'}), false);
  assert.equal(grants.approvePairing(screen.code.toLowerCase().replace('-', ' '), {household: 'ashby', label: 'Kitchen'}), true, 'typed however a person types it');
  assert.equal(grants.approvePairing(screen.code, {household: 'other'}), false, 'an approved code cannot be re-pointed');
  const answer = grants.pollPairing(screen.device);
  assert.equal(answer.status, 'approved');
  assert.deepEqual([grants.verify(answer.secret).scope, grants.verify(answer.secret).household, answer.grant.label], ['frame', 'ashby', 'Kitchen']);
  assert.equal(grants.pollPairing(screen.device).status, 'expired', 'the secret is handed over once');
  const late = grants.startPairing();
  clock += 11 * 60000;
  assert.equal(grants.approvePairing(late.code, {household: 'ashby'}), false, 'codes last ten minutes');
});
