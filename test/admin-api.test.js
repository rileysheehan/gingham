const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHouseholds} = require('../households');
const {createGrants} = require('../grants');
const {createAdmin, slug} = require('../admin-api');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frame-'));
const at = p => new URL('http://frame.test' + p);

test('A household gets its id from its name', () => {
  assert.equal(slug('The Garcías'), 'the-garcias');
  assert.equal(slug('  O’Neill & Sons!  '), 'o-neill-sons');
  assert.equal(slug('家'), '');
});

test('Only an admin sees the deployment; an admin makes a household and the one-time link that goes with it', () => {
  const root = temp(), households = createHouseholds({root: path.join(root, 'households')}), grants = createGrants({file: path.join(root, 'grants.json')});
  const admin = createAdmin({households, grants}), base = 'https://frame.test';
  households.create('alpha', {name: 'Alpha'});
  const boss = grants.add({scope: 'admin', label: 'Laptop'}).grant, owner = grants.add({scope: 'owner', household: 'alpha', label: 'Phone'}).grant;

  assert.equal(admin.handle({method: 'GET', url: at('/api/setup'), grant: boss}), null, 'other paths are not its business');
  assert.equal(admin.handle({method: 'GET', url: at('/api/admin'), grant: null}).status, 401);
  assert.equal(admin.handle({method: 'GET', url: at('/api/admin'), grant: owner}).status, 403, 'an owner of one household is not an admin');
  assert.equal(admin.handle({method: 'POST', url: at('/api/admin/household-add'), grant: owner, body: {name: 'Mine'}, base}).status, 403);
  assert.deepEqual(households.list(), ['alpha']);

  const seen = admin.handle({method: 'GET', url: at('/api/admin'), grant: boss});
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body.households.map(h => [h.id, h.name, h.owners, h.frames]), [['alpha', 'Alpha', 1, 0]]);
  assert.ok(!JSON.stringify(seen.body).includes('hash'), 'nothing a reader could pose with');

  const made = admin.handle({method: 'POST', url: at('/api/admin/household-add'), grant: boss, body: {name: 'The Garcias', whose: 'Maria'}, base});
  assert.equal(made.status, 200);
  assert.equal(made.body.made.id, 'the-garcias');
  assert.equal(households.get('the-garcias').place().name, 'The Garcias');
  const token = made.body.made.link.replace(base + '/s/', '');
  assert.deepEqual(grants.peekLink(token), {scope: 'owner', household: 'the-garcias'});
  assert.equal(made.body.households.length, 2);

  // The same name again is a second household, not an error and not the first one's.
  assert.equal(admin.handle({method: 'POST', url: at('/api/admin/household-add'), grant: boss, body: {name: 'The Garcias'}, base}).body.made.id, 'the-garcias-2');
  assert.equal(admin.handle({method: 'POST', url: at('/api/admin/household-add'), grant: boss, body: {name: '!!!'}, base}).status, 400);
  assert.equal(admin.handle({method: 'POST', url: at('/api/admin/owner-link'), grant: boss, body: {household: 'nobody'}, base}).status, 404);
  const again = admin.handle({method: 'POST', url: at('/api/admin/owner-link'), grant: boss, body: {household: 'alpha'}, base});
  assert.equal(grants.peekLink(again.body.made.link.replace(base + '/s/', '')).household, 'alpha');
  assert.equal(admin.handle({method: 'POST', url: at('/api/admin/constructor'), grant: boss, body: {}, base}).status, 404);
});
