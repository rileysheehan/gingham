// Looking after the whole deployment from a page: who the households are, making a new one, and sending the first
// link to whoever will look after it. Everything here needs an admin; an owner of one household gets nothing.
// The same things can be done from a shell with admin.js, which is how the first admin is made.
const {validId} = require('./households');

const fail = (status, message) => Object.assign(Error(message), {status});
const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const slug = name => text(name, 60).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

function createAdmin({households, grants}) {
  function describe() {
    const all = grants.list().filter(g => !g.revokedAt);
    return {households: households.list().map(id => {
      const home = households.get(id), place = home.place(), mine = all.filter(g => g.household === id);
      const seen = mine.map(g => g.lastSeen).filter(Boolean).sort().pop() || null;
      return {id, name: place.name, place: place.label, frames: mine.filter(g => g.scope === 'frame').length, owners: mine.filter(g => g.scope === 'owner').length, lastSeen: seen};
    })};
  }
  const link = (base, household, label) => base + '/s/' + grants.mintLink({scope: 'owner', household, label: text(label, 60) || 'First setup'});
  const actions = {
    // A household is made from its name; the id in its address and on disk is derived, and never typed.
    'household-add'(body, base) {
      const name = text(body.name, 40); if (!name) throw fail(400, 'Give the household a name.');
      const stem = slug(name); if (!validId(stem)) throw fail(400, 'Use some letters or numbers in the name.');
      let id = stem; for (let n = 2; households.get(id); n++) id = stem.slice(0, 27) + '-' + n;
      households.create(id, {name});
      return {made: {id, name, link: link(base, id, body.whose)}};
    },
    // Another way in for a household that has lost its owner, or has a second person to look after it.
    'owner-link'(body, base) {
      const home = households.get(text(body.household, 40)); if (!home) throw fail(404, 'No such household.');
      return {made: {id: home.id, name: home.place().name, link: link(base, home.id, body.whose)}};
    },
  };
  // Returns an answer {status, body}, or null when the path is not this module's.
  function handle({method, url, grant, body, base}) {
    if (!url.pathname.startsWith('/api/admin')) return null;
    try {
      if (!grant) throw fail(401, 'Open your admin link first.');
      if (grant.scope !== 'admin') throw fail(403, 'This device looks after one household, not the whole deployment.');
      if (url.pathname === '/api/admin' && method === 'GET') return {status: 200, body: describe()};
      const action = url.pathname.replace('/api/admin/', '');
      if (method !== 'POST' || !Object.prototype.hasOwnProperty.call(actions, action)) return {status: 404, body: {error: 'Not found'}};
      return {status: 200, body: {...actions[action](body || {}, base), ...describe()}};
    } catch (e) { return {status: e.status || 500, body: {error: e.status ? e.message : 'That did not work. Try again.'}}; }
  }
  return {handle, describe};
}
module.exports = {createAdmin, slug};
