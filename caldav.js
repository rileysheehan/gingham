// Task lists on a CalDAV server: Nextcloud, Fastmail, Synology, mailbox.org and others. Signing in is a server address,
// a username and an app password, pasted on the setup page and kept in the household's vault. No one has to register
// anything anywhere. Why this way: docs/SIGN-IN.md.
//
// CalDAV is WebDAV plus iCalendar: lists are found by asking the server where the account's calendars live
// (PROPFIND), tasks are read with one query (REPORT) and are VTODO entries in the same text format as a calendar feed,
// written back whole (PUT) with a check that nobody changed them in between. The address is typed by a person, so
// every request gets the same care as a calendar link: https only, public addresses only unless the deployment opts
// out (FRAME_ALLOW_PRIVATE_FEEDS=1), each redirect checked, the answer capped.
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const {safeRequest} = require('./safe-fetch');
const {dayIn} = require('./zone');
const ics = require('./ics');

const DAY = 86400000;
const fail = (code, message, status) => Object.assign(Error(message), {code, status});
const shortId = (prefix, remote) => prefix + crypto.createHash('sha256').update(String(remote)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- a little XML, enough for a WebDAV answer

const decode = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({lt: '<', gt: '>', amp: '&', quot: '"', apos: "'"})[e.toLowerCase()] ??
  String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const localName = name => name.slice(name.indexOf(':') + 1).toLowerCase();   // namespaces differ by server; names do not
function parseXml(text) {
  const root = {name: '#root', attrs: {}, children: [], text: ''}, stack = [root];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s>\/]+)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = token.exec(String(text || '')))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {}; (m[4] || '').replace(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (x, k, a, b) => { attrs[localName(k)] = decode(a ?? b); });
      const node = {name: localName(m[3]), attrs, children: [], text: ''};
      top.children.push(node); if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root;
}
const child = (node, name) => node && node.children.find(c => c.name === name) || null;
function find(node, name) { if (!node) return null; for (const c of node.children) { if (c.name === name) return c; const deep = find(c, name); if (deep) return deep; } return null; }
function findAll(node, name, out = []) { if (node) for (const c of node.children) { if (c.name === name) out.push(c); findAll(c, name, out); } return out; }
const textOf = node => node ? (node.text + node.children.map(textOf).join('')).trim() : '';

// A multistatus answer as [{href, props}], each href absolute, props only from the parts the server said were found.
function responses(xml, base) {
  return findAll(parseXml(xml), 'response').map(r => {
    let href; try { href = new URL(textOf(child(r, 'href')), base).toString(); } catch (e) { return null; }
    const props = findAll(r, 'propstat').filter(p => /\s2\d\d\s/.test(' ' + textOf(child(p, 'status')) + ' ')).map(p => child(p, 'prop')).filter(Boolean);
    return {href, props};
  }).filter(Boolean);
}
const prop = (res, name) => { for (const p of (res && res.props) || []) { const n = find(p, name); if (n) return n; } return null; };
const hrefIn = (res, name) => { const n = prop(res, name), h = n && find(n, 'href'); try { return h ? new URL(textOf(h), res.href).toString() : ''; } catch (e) { return ''; } };

// ---------------------------------------------------------------- tasks in iCalendar text

const utcStamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escapeText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 bytes are folded, never in the middle of a character.
function foldLine(line) {
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) { const b = Buffer.byteLength(ch); if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; } cur += ch; bytes += b; }
  out.push(cur); return out.join('\r\n ');
}
const writeLines = lines => lines.map(foldLine).join('\r\n') + '\r\n';

// The task itself: the first VTODO that is not an edit of one occurrence. Alarms inside it are not it.
function parseTodo(text, zone) {
  const path = []; let current = null, master = null;
  for (const raw of ics.unfold(text).split('\n')) {
    const line = ics.parseLine(raw); if (!line) continue;
    if (line.name === 'BEGIN') { path.push(line.value.toUpperCase()); if (path.length === 2 && path[1] === 'VTODO') current = {}; continue; }
    if (line.name === 'END') { const was = path.pop(); if (was === 'VTODO' && path.length === 1 && current) { if (!current.recurrenceId && !master) master = current; current = null; } continue; }
    if (!current || path.length !== 2) continue;
    const v = line.value.trim();
    if (line.name === 'SUMMARY') current.title = ics.unescape(line.value).trim();
    else if (line.name === 'STATUS') current.status = v.toUpperCase();
    else if (line.name === 'COMPLETED') current.completed = true;
    else if (line.name === 'DUE') current.due = ics.parseWhen(v, line.params, zone);
    else if (line.name === 'RRULE') current.rrule = v;
    else if (line.name === 'PRIORITY') current.priority = parseInt(v, 10) || 0;
    else if (line.name === 'RECURRENCE-ID') current.recurrenceId = v;
  }
  if (!master) return null;
  const due = master.due ? (master.due.allDay ? new Date(master.due.wall).toISOString().slice(0, 10) : dayIn(zone, master.due.at)) : '';
  return {title: (master.title || '').slice(0, 300), done: master.completed || master.status === 'COMPLETED' || master.status === 'CANCELLED',
    priority: master.priority >= 1 && master.priority <= 4 ? 'p1' : 'p4', due, recurring: !!master.rrule};
}

// A reading written back in the form it came in: a date, a UTC time, or a local time under its own TZID.
function formatWall(original, wall) {
  const d = new Date(wall), p = n => String(n).padStart(2, '0');
  const date = d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
  if (/^\d{8}$/.test(original.trim())) return date;
  return date + 'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + (/Z$/i.test(original.trim()) ? 'Z' : '');
}

// Checking a task off. A one-off is marked completed. A repeating one moves on to its next occurrence and stays on
// the list, which is what the apps that share these lists do; one whose series has run out is completed like a
// one-off. A rule this file cannot follow is refused rather than guessed at, since guessing wrong ends the series.
function completeText(text, nowMs) {
  const lines = ics.unfold(text).split('\n').filter(l => l.length);
  const path = []; let start = -1, end = -1, isEdit = false;
  for (let i = 0; i < lines.length && end < 0; i++) {
    const line = ics.parseLine(lines[i]); if (!line) continue;
    if (line.name === 'BEGIN') { path.push(line.value.toUpperCase()); if (path.length === 2 && path[1] === 'VTODO') { start = i; isEdit = false; } continue; }
    if (line.name === 'END') { const was = path.pop(); if (was === 'VTODO' && path.length === 1 && start >= 0) { if (isEdit) start = -1; else end = i; } continue; }
    if (start >= 0 && path.length === 2 && line.name === 'RECURRENCE-ID') isEdit = true;
  }
  if (start < 0 || end < 0) throw fail('UPSTREAM', 'That item isn’t a task.', 502);
  const own = []; let depth = 0;   // the task's own lines, not an alarm's
  for (let i = start + 1; i < end; i++) {
    const line = ics.parseLine(lines[i]); if (!line) continue;
    if (line.name === 'BEGIN') { depth++; continue; } if (line.name === 'END') { depth--; continue; }
    if (depth === 0) own.push({i, line, prefix: lines[i].slice(0, lines[i].length - line.value.length - 1)});
  }
  const get = name => own.find(o => o.line.name === name);
  const drop = new Set(), replace = new Map(), add = [];
  const rewrite = (name, value) => { const o = get(name); if (o) replace.set(o.i, o.prefix + ':' + value); else add.push(name + ':' + value); };
  const stamp = utcStamp(nowMs);

  let finished = true;
  const rrule = get('RRULE');
  if (rrule) {
    const rule = ics.parseRule(rrule.line.value), anchorO = get('DTSTART') || get('DUE');
    const anchor = anchorO && ics.parseWhen(anchorO.line.value.trim(), anchorO.line.params, 'UTC');
    if (!rule || !anchor) throw fail('REPEAT', 'Check off this repeating item in its own app.', 409);
    let next = null;
    for (const wall of ics.occurrences(anchor.wall, {...rule, count: undefined}, anchor.wall + 800 * DAY, anchor.wall)) if (wall > anchor.wall) { next = wall; break; }
    const until = rule.until ? ics.parseWhen(rule.until, {}, 'UTC') : null;
    if (next !== null && until && next > (until.allDay ? until.wall + DAY - 1 : until.wall)) next = null;
    if (next !== null && rule.count === 1) next = null;
    if (next !== null) {
      finished = false;
      const shift = next - anchor.wall;
      for (const name of ['DTSTART', 'DUE']) {
        const o = get(name), when = o && ics.parseWhen(o.line.value.trim(), o.line.params, 'UTC');
        if (when) replace.set(o.i, o.prefix + ':' + formatWall(o.line.value, when.wall + shift));
      }
      // A counted series counts down, so it still ends when it should.
      if (rule.count > 1) replace.set(rrule.i, rrule.prefix + ':' + rrule.line.value.replace(/COUNT=\d+/i, 'COUNT=' + (rule.count - 1)));
      for (const name of ['COMPLETED', 'PERCENT-COMPLETE']) { const o = get(name); if (o) drop.add(o.i); }
      rewrite('STATUS', 'NEEDS-ACTION');
    }
  }
  if (finished) {
    rewrite('STATUS', 'COMPLETED');
    rewrite('COMPLETED', stamp);
    rewrite('PERCENT-COMPLETE', '100');
  }
  rewrite('DTSTAMP', stamp);
  rewrite('LAST-MODIFIED', stamp);
  const seq = get('SEQUENCE'); if (seq) replace.set(seq.i, seq.prefix + ':' + ((parseInt(seq.line.value, 10) || 0) + 1));

  const out = [];
  lines.forEach((line, i) => { if (i === end) out.push(...add); if (!drop.has(i)) out.push(replace.has(i) ? replace.get(i) : line); });
  return writeLines(out);
}

function newTodo(title, uid, nowMs) {
  const stamp = utcStamp(nowMs);
  return writeLines(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gingham//Gingham//EN', 'BEGIN:VTODO', 'UID:' + uid, 'DTSTAMP:' + stamp, 'CREATED:' + stamp,
    'LAST-MODIFIED:' + stamp, 'SUMMARY:' + escapeText(title), 'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR']);
}

// ---------------------------------------------------------------- the account

const QUERY = '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>' +
  '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"><c:prop-filter name="COMPLETED"><c:is-not-defined/></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
const PROPFIND = props => '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>' + props + '</d:prop></d:propfind>';

function createCalDav({credentials = () => ({}), fetchImpl = fetch, lookup = dns.lookup, allowPrivate = process.env.FRAME_ALLOW_PRIVATE_FEEDS === '1', now = () => Date.now()} = {}) {
  const index = new Map();   // short task id -> its address: only what a query has shown can be checked off

  async function request(address, {method = 'GET', depth, body, headers = {}, account}) {
    const r = await safeRequest(address, {method, body, fetchImpl, lookup, allowPrivate, headers: {
      ...(body && !headers['Content-Type'] ? {'Content-Type': 'application/xml; charset=utf-8'} : {}), ...headers,
      ...(depth !== undefined ? {Depth: String(depth)} : {}),
      ...(account ? {Authorization: 'Basic ' + Buffer.from(account.username + ':' + account.password).toString('base64')} : {})}});
    if (r.status === 401 || r.status === 403) throw fail('AUTH', 'The server didn’t accept that username and password.', 400);
    return r;
  }
  async function propfind(address, depth, props, account) {
    const r = await request(address, {method: 'PROPFIND', depth, body: PROPFIND(props), account});
    if (r.status !== 207) throw fail('NOT_CALDAV', 'That address doesn’t answer like a CalDAV server. Check it, or try the one your app’s help page gives.', 400);
    return responses(r.text, r.url);
  }
  function account() {
    const c = credentials().caldav || {};
    if (!c.url || !c.password) throw fail('SIGN_IN', 'Connect the CalDAV account again.', 401);
    return {url: c.url, username: c.username || '', password: c.password};
  }

  // Where the account's task lists are: the address typed (or its well-known one), then who the account is, then
  // where its calendars live. An address that already is the calendar home, or a single list, works too.
  async function discover(acct) {
    let typed; try { typed = new URL(String(acct.url || '').trim()); } catch (e) { throw fail('BAD_ADDRESS', 'That isn’t a web address.', 400); }
    const startAt = typed.pathname === '/' ? new URL('/.well-known/caldav', typed).toString() : typed.toString();
    const first = await propfind(startAt, 0, '<d:current-user-principal/><c:calendar-home-set/><d:resourcetype/>', acct);
    let home = hrefIn(first[0], 'calendar-home-set');
    const principal = hrefIn(first[0], 'current-user-principal');
    if (!home && principal) home = hrefIn((await propfind(principal, 0, '<c:calendar-home-set/>', acct))[0], 'calendar-home-set');
    const found = await propfind(home || (first[0] && first[0].href) || startAt, 1, '<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>', acct);
    const seen = new Set();
    return found.filter(r => {
      const type = prop(r, 'resourcetype'); if (!type || !find(type, 'calendar')) return false;
      const comps = prop(r, 'supported-calendar-component-set');
      return !comps || findAll(comps, 'comp').some(c => /^vtodo$/i.test(c.attrs.name || ''));
    }).map(r => {
      const remote = r.href.endsWith('/') ? r.href : r.href + '/';
      const name = textOf(prop(r, 'displayname')) || decodeURIComponent(remote.split('/').filter(Boolean).pop() || 'Tasks');
      return {id: shortId('C', remote), remote, name: name.slice(0, 40)};
    }).filter(l => !seen.has(l.id) && seen.add(l.id));
  }
  const lists = () => discover(account());

  async function items(remote, zone) {
    const r = await request(remote, {method: 'REPORT', depth: 1, body: QUERY, account: account()});
    if (r.status !== 207) throw fail('UPSTREAM', 'The CalDAV server isn’t answering.', 503);
    const out = [];
    for (const res of responses(r.text, r.url)) {
      const data = prop(res, 'calendar-data'); if (!data) continue;
      const todo = parseTodo(textOf(data), zone); if (!todo || todo.done) continue;   // a server that ignores the filter still gets none
      const id = shortId('c', res.href); index.set(id, res.href);
      out.push({id, title: todo.title, priority: todo.priority, due: todo.due, recurring: todo.recurring});
    }
    return out;
  }
  async function add(remote, title) {
    const uid = crypto.randomUUID(), base = remote.endsWith('/') ? remote : remote + '/';
    const r = await request(new URL(uid + '.ics', base).toString(), {method: 'PUT', body: newTodo(title, uid, now()), headers: {'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*'}, account: account()});
    if (![200, 201, 204].includes(r.status)) throw fail('UPSTREAM', 'The CalDAV server didn’t take the new item.', 503);
  }
  // Read fresh, change, write back only if nobody changed it meanwhile; once more if somebody did.
  async function complete(id) {
    const href = index.get(id);
    if (!href) throw fail('UNKNOWN_TASK', 'That task is no longer on the list.', 404);
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await request(href, {method: 'GET', account: account()});
      if (got.status === 404) { index.delete(id); throw fail('UNKNOWN_TASK', 'That task is no longer on the list.', 404); }
      if (got.status !== 200) throw fail('UPSTREAM', 'The CalDAV server isn’t answering.', 503);
      const put = await request(href, {method: 'PUT', body: completeText(got.text, now()), headers: {'Content-Type': 'text/calendar; charset=utf-8', ...(got.etag ? {'If-Match': got.etag} : {})}, account: account()});
      if (put.status === 412 && attempt === 0) continue;
      if (![200, 201, 204].includes(put.status)) throw fail('UPSTREAM', 'The CalDAV server didn’t take the change.', 503);
      index.delete(id); return;
    }
    throw fail('UPSTREAM', 'That item kept changing. Try again.', 409);
  }
  return {discover, lists, items, add, complete, has: id => index.has(id), forget: () => index.clear()};
}
module.exports = {createCalDav, parseXml, parseTodo, completeText, newTodo, foldLine, shortId};
