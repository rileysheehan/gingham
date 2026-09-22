// To-do lists in Home Assistant. One connection reaches every list Home Assistant already has: its own shopping list
// and local lists, and whatever it is connected to (Google Tasks, Todoist, CalDAV, and others through its community
// integrations). Signing in is Home Assistant's address and a long-lived access token, made in its profile page and
// pasted on the setup page. Why this way: docs/SIGN-IN.md.
//
// Lists are Home Assistant's `todo.*` entities; items are read, added and checked off through its `todo` services
// over the REST API. The address is typed by a person, so every request gets a calendar link's care (safe-fetch.js).
// Home Assistant usually lives on the home network: a tablet that is its own server allows that (the app sets
// FRAME_ALLOW_PRIVATE_FEEDS=1), and a hosted server needs Home Assistant's remote address.
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const {safeRequest, pinnedFetch} = require('./safe-fetch');
const {dayIn, validZone} = require('./zone');

const fail = (code, message, status) => Object.assign(Error(message), {code, status});
const shortId = (prefix, remote) => prefix + crypto.createHash('sha256').update(String(remote)).digest('hex').slice(0, 16);

// A due date as Home Assistant gives it: a day, or a moment with its offset, which lands on the household's day.
function dueDay(due, zone) {
  if (!due) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const at = Date.parse(due);
  return Number.isNaN(at) ? '' : dayIn(validZone(zone) ? zone : 'UTC', at);
}

function createHomeAssistant({credentials = () => ({}), fetchImpl = pinnedFetch, lookup = dns.lookup, allowPrivate = process.env.FRAME_ALLOW_PRIVATE_FEEDS === '1'} = {}) {
  const index = new Map();   // short item id -> which list and which item: only what a read has shown can be checked off

  function account() {
    const c = credentials().homeassistant || {};
    if (!c.url || !c.token) throw fail('SIGN_IN', 'Connect Home Assistant again.', 401);
    return c;
  }
  async function call(acct, route, body) {
    let base; try { base = new URL(String(acct.url || '').trim()); } catch (e) { throw fail('BAD_ADDRESS', 'That isn’t a web address.', 400); }
    let r;
    try {
      r = await safeRequest(new URL(route, base.origin + base.pathname.replace(/\/+$/, '') + '/').toString(), {fetchImpl, lookup, allowPrivate,
        method: body === undefined ? 'GET' : 'POST', headers: {Authorization: 'Bearer ' + acct.token, ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    } catch (e) {
      // The usual reason, said plainly: a hosted server cannot see into a home network.
      if (!allowPrivate && (e.code === 'PRIVATE' || (e.code === 'BAD_ADDRESS' && base.protocol === 'http:'))) throw fail(e.code, 'This server can’t reach a Home Assistant on your home network. Use its remote address, starting https:// (a Nabu Casa address works).', 400);
      throw e;
    }
    if (r.status === 401 || r.status === 403) throw fail('AUTH', 'Home Assistant didn’t accept that token.', 400);
    let data = null; try { data = r.text ? JSON.parse(r.text) : null; } catch (e) {}
    return {status: r.status, data, text: r.text};
  }

  // The to-do lists Home Assistant has, found through its states. Trying this is also how a token is checked.
  async function discover(acct) {
    const ping = await call(acct, 'api/');
    if (ping.status !== 200 || !ping.data || !/api running/i.test(ping.data.message || '')) throw fail('NOT_HA', 'That address doesn’t answer like Home Assistant. Use the one you open it at, such as http://homeassistant.local:8123.', 400);
    const states = await call(acct, 'api/states');
    if (states.status !== 200 || !Array.isArray(states.data)) throw fail('UPSTREAM', 'Home Assistant didn’t list its entities.', 502);
    return states.data.filter(s => /^todo\.[a-z0-9_]+$/.test(s.entity_id || '')).map(s => ({
      id: shortId('H', s.entity_id), remote: s.entity_id, name: String((s.attributes && s.attributes.friendly_name) || s.entity_id.slice(5).replace(/_/g, ' ')).slice(0, 40)}));
  }
  const lists = () => discover(account());

  async function items(entity, zone) {
    const r = await call(account(), 'api/services/todo/get_items?return_response', {entity_id: entity, status: ['needs_action']});
    if (r.status === 400) throw fail('UPSTREAM', 'This Home Assistant is too old to share its lists. Update it, then connect again.', 502);
    if (r.status !== 200 || !r.data) throw fail('UPSTREAM', 'Home Assistant isn’t answering.', 503);
    // Newer versions answer {service_response: {entity: …}}; the answer is otherwise keyed by entity directly.
    const found = ((r.data.service_response || r.data)[entity] || {}).items || [];
    return found.filter(i => i && i.status !== 'completed' && i.summary).map(i => {
      const handle = i.uid || i.summary, id = shortId('h', entity + '|' + handle);
      index.set(id, {entity, item: handle});
      return {id, title: String(i.summary).slice(0, 300), priority: 'p4', due: dueDay(i.due, zone), recurring: false};
    });
  }
  async function add(entity, title) {
    const r = await call(account(), 'api/services/todo/add_item', {entity_id: entity, item: title});
    if (r.status !== 200) throw fail('UPSTREAM', 'Home Assistant didn’t take the new item.', 503);
  }
  async function complete(id) {
    const at = index.get(id);
    if (!at) throw fail('UNKNOWN_TASK', 'That task is no longer on the list.', 404);
    const r = await call(account(), 'api/services/todo/update_item', {entity_id: at.entity, item: at.item, status: 'completed'});
    if (r.status === 400) { index.delete(id); throw fail('UNKNOWN_TASK', 'That task is no longer on the list.', 404); }   // gone, or a list that cannot be changed
    if (r.status !== 200) throw fail('UPSTREAM', 'Home Assistant isn’t answering.', 503);
    index.delete(id);
  }
  return {discover, lists, items, add, complete, has: id => index.has(id), forget: () => index.clear()};
}
module.exports = {createHomeAssistant, dueDay, shortId};
