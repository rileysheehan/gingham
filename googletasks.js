// Google Tasks. Google allows no sign-in by code for Tasks, so it is the ordinary "Sign in with Google": the phone is
// sent to Google, and Google sends it back to this server's own public address with a one-time code, which this
// server trades for a token using its Google app's secret and the PKCE verifier it kept. That needs a Google app
// registered for the deployment (GINGHAM_GOOGLE_CLIENT_ID and _SECRET) and a public https address (FRAME_URL); without
// them Google Tasks is simply not offered. Why this way, and Google's limits: docs/SIGN-IN.md.
const crypto = require('node:crypto');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const TASKS = 'https://tasks.googleapis.com/tasks/v1/';
// Tasks and nothing else of the account; the email only so setup can say which account is connected.
const SCOPE = 'https://www.googleapis.com/auth/tasks openid email';

const fail = (code, message, status) => Object.assign(Error(message), {code, status});
const shortId = (prefix, remote) => prefix + crypto.createHash('sha256').update(String(remote)).digest('hex').slice(0, 16);
const base64url = bytes => Buffer.from(bytes).toString('base64url');

// The return address Google must be told about in advance, or nothing when this deployment has no public https one.
function redirectFrom(frameUrl) {
  try { const u = new URL(String(frameUrl || '')); return u.protocol === 'https:' ? u.origin + '/oauth/google' : ''; } catch (e) { return ''; }
}
function accountOf(idToken) {
  try { const p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); return String(p.email || '').slice(0, 120); } catch (e) { return ''; }
}

function createGoogleTasks({clientId = process.env.GINGHAM_GOOGLE_CLIENT_ID || '', clientSecret = process.env.GINGHAM_GOOGLE_CLIENT_SECRET || '', redirectUri = redirectFrom(process.env.FRAME_URL),
  fetchImpl = fetch, credentials = () => ({})} = {}) {
  let access = null, expires = 0, refreshing = null, signIn = false;
  const index = new Map();   // short task id -> where it lives: only what a read has shown can be checked off

  async function post(url, form) {
    let response;
    try { response = await fetchImpl(url, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(form), redirect: 'error', signal: AbortSignal.timeout(12000)}); }
    catch (e) { throw fail('UPSTREAM', 'Can’t reach Google. Try again.', 503); }
    let data = {}; try { data = await response.json(); } catch (e) {}
    return {status: response.status, data};
  }
  function keep(data) { access = data.access_token; expires = Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000; }

  // ---- signing in
  // A fresh state and PKCE pair for one sign-in. The caller keeps them, bound to the household, and hands out the URL.
  function begin() {
    if (!clientId || !clientSecret || !redirectUri) throw fail('UNAVAILABLE', 'Google Tasks isn’t set up on this server yet.', 409);
    const state = base64url(crypto.randomBytes(32)), verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const url = AUTH + '?' + new URLSearchParams({client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline',
      prompt: 'consent', include_granted_scopes: 'false', state, code_challenge: challenge, code_challenge_method: 'S256'});
    return {state, verifier, url};
  }
  async function finish(code, verifier) {
    const {status, data} = await post(TOKEN, {grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri});
    if (status !== 200 || !data.access_token) throw fail('UPSTREAM', 'Google didn’t finish signing in. Try again.', 502);
    if (!data.refresh_token) throw fail('UPSTREAM', 'Google gave no lasting access. Remove Gingham at myaccount.google.com, then connect again.', 502);
    if (!/auth\/tasks(\s|$)/.test(data.scope || '')) throw fail('SCOPE', 'Google Tasks wasn’t allowed. Connect again and allow it.', 400);
    keep(data); signIn = false;
    return {refresh: data.refresh_token, account: accountOf(data.id_token)};
  }
  async function revoke() {
    const held = (credentials().googletasks || {}).refresh;
    if (held) try { await post(REVOKE, {token: held}); } catch (e) {}   // best effort: the token is forgotten here either way
    access = null; expires = 0; index.clear(); signIn = false;
  }

  // ---- talking to Tasks
  async function token() {
    if (access && Date.now() < expires) return access;
    if (!refreshing) refreshing = (async () => {
      const held = (credentials().googletasks || {}).refresh;
      if (!held) { signIn = true; throw fail('SIGN_IN', 'Google needs you to sign in again.', 401); }
      const {status, data} = await post(TOKEN, {grant_type: 'refresh_token', refresh_token: held, client_id: clientId, client_secret: clientSecret});
      if (status !== 200 || !data.access_token) {
        // A Google app left in "Testing" expires this after seven days; a removed app or changed password does too.
        if (data.error === 'invalid_grant') { signIn = true; throw fail('SIGN_IN', 'Google needs you to sign in again.', 401); }
        throw fail('UPSTREAM', 'Google isn’t answering.', 503);
      }
      keep(data); signIn = false;
      return access;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function api(route, {method = 'GET', body} = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try { response = await fetchImpl(TASKS + route, {method, headers: {Authorization: 'Bearer ' + await token(), ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'error', signal: AbortSignal.timeout(12000)}); }
      catch (e) { if (e.code) throw e; throw fail('UPSTREAM', 'Can’t reach Google Tasks.', 503); }
      if (response.status === 401 && attempt === 0) { access = null; expires = 0; continue; }
      if (response.status === 404) throw fail('GONE', 'That is no longer in Google Tasks.', 404);
      if (!response.ok) throw fail('UPSTREAM', 'Google Tasks isn’t answering.', 503);
      return response.status === 204 ? null : response.json();
    }
  }
  async function every(route, join) {
    const out = []; let pageToken = '';
    for (let page = 0; page < 50; page++) {
      const got = await api(route + join + 'maxResults=100' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
      out.push(...((got && got.items) || []));
      pageToken = got && got.nextPageToken; if (!pageToken) break;
    }
    return out;
  }

  async function lists() {
    return (await every('users/@me/lists', '?')).map(l => ({id: shortId('G', l.id), remote: l.id, name: String(l.title || 'Tasks').slice(0, 40)}));
  }
  // Google keeps a due date as midnight UTC of the day meant, and says the time is to be ignored.
  async function items(remote) {
    const open = await every('lists/' + encodeURIComponent(remote) + '/tasks', '?showCompleted=false&showHidden=false&');
    return open.filter(t => t.status !== 'completed' && !t.deleted && t.title).map(t => {
      const id = shortId('g', remote + '|' + t.id);
      index.set(id, {list: remote, task: t.id});
      return {id, title: String(t.title).slice(0, 300), priority: 'p4', due: /^\d{4}-\d{2}-\d{2}/.test(t.due || '') ? t.due.slice(0, 10) : '', recurring: false};
    });
  }
  async function add(remote, title) { await api('lists/' + encodeURIComponent(remote) + '/tasks', {method: 'POST', body: {title}}); }
  async function complete(id) {
    const at = index.get(id);
    if (!at) throw fail('UNKNOWN_TASK', 'That task is no longer on the list.', 404);
    try { await api('lists/' + encodeURIComponent(at.list) + '/tasks/' + encodeURIComponent(at.task), {method: 'PATCH', body: {status: 'completed'}}); }
    catch (e) { if (e.code === 'GONE') { index.delete(id); throw fail('UNKNOWN_TASK', 'That task is no longer on the list.', 404); } throw e; }
    index.delete(id);
  }
  function forget() { access = null; expires = 0; index.clear(); signIn = false; }

  return {available: !!(clientId && clientSecret && redirectUri), begin, finish, revoke, lists, items, add, complete, has: id => index.has(id), forget, needsSignIn: () => signIn};
}
module.exports = {createGoogleTasks, redirectFrom, accountOf, shortId};
