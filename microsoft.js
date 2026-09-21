// Microsoft To Do, through Microsoft Graph. Signing in is by device code: the setup page shows a short code, the person
// enters it at microsoft.com on their own phone, and this server asks until Microsoft answers. Nothing is redirected
// anywhere, so it works the same on a tablet with no address of its own as on a hosted server.
//
// The app registration is a public client: its ID is not a secret, ships here, and serves every copy. Whoever runs a
// copy can use their own instead with GINGHAM_MS_CLIENT_ID. Why this and not the other ways in: docs/SIGN-IN.md.
const crypto = require('node:crypto');
const {dayIn, instantOf, validZone} = require('./zone');

const SHIPPED_CLIENT_ID = '';   // Gingham's own registration, filled in once it exists
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0/';
const GRAPH = 'https://graph.microsoft.com/v1.0/';
// The profile part only lets the setup page say which account is connected.
const SCOPE = 'openid profile offline_access Tasks.ReadWrite';

const fail = (code, message, status) => Object.assign(Error(message), {code, status});
// Microsoft's ids are long; the frame and its routes use short ones, made from them and looked up here.
const shortId = (prefix, remote) => prefix + crypto.createHash('sha256').update(String(remote)).digest('hex').slice(0, 16);

// To Do keeps a due date as midnight somewhere; the household wants the calendar day it means where they live.
function dueDay(due, zone) {
  const m = due && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(due.dateTime || '');
  if (!m) return '';
  const wall = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const from = !due.timeZone || /^(utc|gmt)$/i.test(due.timeZone) ? 'UTC' : validZone(due.timeZone) ? due.timeZone : '';
  if (!from || !validZone(zone)) return m[1] + '-' + m[2] + '-' + m[3];
  return dayIn(zone, from === 'UTC' ? wall : instantOf(from, wall));
}
// Who signed in, from the ID token Microsoft sent straight to this server. Shown to the household, trusted for nothing.
function accountOf(idToken) {
  try { const p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); return String(p.preferred_username || p.email || p.name || '').slice(0, 80); }
  catch (e) { return ''; }
}

function createMicrosoft({clientId = process.env.GINGHAM_MS_CLIENT_ID || SHIPPED_CLIENT_ID, fetchImpl = fetch, credentials = () => ({}), saveSecret = () => {}} = {}) {
  let access = null, expires = 0, refreshing = null, signIn = false;
  const index = new Map();   // short task id -> where it lives: only what a fetch has shown can be checked off

  async function post(url, form) {
    let response;
    try { response = await fetchImpl(url, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(form), redirect: 'error', signal: AbortSignal.timeout(12000)}); }
    catch (e) { throw fail('UPSTREAM', 'Can’t reach Microsoft. Try again.', 503); }
    let data = {}; try { data = await response.json(); } catch (e) {}
    return {status: response.status, data};
  }
  function keep(data) { access = data.access_token; expires = Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000; }

  // ---- signing in
  async function startDevice() {
    if (!clientId) throw fail('UNAVAILABLE', 'Microsoft To Do isn’t set up on this server yet.', 409);
    const {status, data} = await post(AUTHORITY + 'devicecode', {client_id: clientId, scope: SCOPE});
    if (status !== 200 || !data.device_code || !data.user_code) throw fail('UPSTREAM', 'Microsoft didn’t give a code. Try again.', 502);
    return {deviceCode: data.device_code, code: data.user_code, url: data.verification_uri || 'https://microsoft.com/devicelogin', expiresIn: Number(data.expires_in) || 900, interval: Number(data.interval) || 5};
  }
  // One question to Microsoft; the caller keeps the pace Microsoft asked for.
  async function pollDevice(deviceCode) {
    const {status, data} = await post(AUTHORITY + 'token', {grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: deviceCode});
    if (status === 200 && data.refresh_token && data.access_token) { keep(data); signIn = false; return {status: 'connected', refresh: data.refresh_token, account: accountOf(data.id_token)}; }
    switch (data.error) {
      case 'authorization_pending': return {status: 'pending'};
      case 'slow_down': return {status: 'slow'};
      case 'expired_token': case 'code_expired': return {status: 'expired'};
      case 'authorization_declined': case 'access_denied': return {status: 'declined'};
      default: throw fail('UPSTREAM', 'Microsoft couldn’t finish signing in. Try again.', 502);
    }
  }

  // ---- talking to Graph
  async function token() {
    if (access && Date.now() < expires) return access;
    if (!refreshing) refreshing = (async () => {
      const held = (credentials().microsoft || {}).refresh;
      if (!held) { signIn = true; throw fail('SIGN_IN', 'Microsoft needs you to sign in again.', 401); }
      const {status, data} = await post(AUTHORITY + 'token', {grant_type: 'refresh_token', client_id: clientId, refresh_token: held, scope: SCOPE});
      if (status !== 200 || !data.access_token) {
        if (data.error === 'invalid_grant' || data.error === 'interaction_required') { signIn = true; throw fail('SIGN_IN', 'Microsoft needs you to sign in again.', 401); }
        throw fail('UPSTREAM', 'Microsoft isn’t answering.', 503);
      }
      // Microsoft replaces the refresh token every time it is used. The new one is kept before the old is forgotten.
      if (data.refresh_token && data.refresh_token !== held) saveSecret('microsoft.refresh', data.refresh_token);
      keep(data); signIn = false;
      return access;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function graph(route, {method = 'GET', body} = {}) {
    const url = route.startsWith('https://') ? route : GRAPH + route;
    if (!url.startsWith(GRAPH)) throw fail('UPSTREAM', 'Microsoft sent an unexpected address.', 502);   // a next page must stay on Graph
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try { response = await fetchImpl(url, {method, headers: {Authorization: 'Bearer ' + await token(), ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'error', signal: AbortSignal.timeout(12000)}); }
      catch (e) { if (e.code) throw e; throw fail('UPSTREAM', 'Can’t reach Microsoft To Do.', 503); }
      if (response.status === 401 && attempt === 0) { access = null; expires = 0; continue; }   // an access token can die early
      if (response.status === 404) throw fail('GONE', 'That is no longer in Microsoft To Do.', 404);
      if (!response.ok) throw fail('UPSTREAM', 'Microsoft To Do isn’t answering.', 503);
      return response.status === 204 ? null : response.json();
    }
  }
  async function every(route) {
    const out = []; let next = route;
    for (let page = 0; next && page < 50; page++) { const got = await graph(next); out.push(...(got.value || [])); next = got['@odata.nextLink']; }
    return out;
  }

  // ---- lists and what is on them
  async function lists() {
    return (await every('me/todo/lists')).map(l => ({id: shortId('M', l.id), remote: l.id, name: String(l.displayName || 'List').slice(0, 40), shared: !!l.isShared}));
  }
  async function items(remote, zone) {
    const open = await every('me/todo/lists/' + encodeURIComponent(remote) + '/tasks?$top=100&$filter=' + encodeURIComponent("status ne 'completed'"));
    return open.filter(t => t.status !== 'completed').map(t => {
      const id = shortId('m', remote + '|' + t.id);
      index.set(id, {list: remote, task: t.id});
      return {id, title: String(t.title || '').slice(0, 300), priority: t.importance === 'high' ? 'p1' : 'p4', due: dueDay(t.dueDateTime, zone), recurring: !!t.recurrence};
    });
  }
  async function add(remote, title) { await graph('me/todo/lists/' + encodeURIComponent(remote) + '/tasks', {method: 'POST', body: {title}}); }
  async function complete(id) {
    const at = index.get(id);
    if (!at) throw fail('UNKNOWN_TASK', 'That task is no longer on the list.', 404);
    await graph('me/todo/lists/' + encodeURIComponent(at.list) + '/tasks/' + encodeURIComponent(at.task), {method: 'PATCH', body: {status: 'completed'}});
    index.delete(id);
  }
  function forget() { access = null; expires = 0; index.clear(); signIn = false; }

  return {available: !!clientId, startDevice, pollDevice, lists, items, add, complete, has: id => index.has(id), forget, needsSignIn: () => signIn};
}
module.exports = {createMicrosoft, dueDay, accountOf, shortId};
