// A household looked after by the people who live in it: /setup in a phone's browser, no shell, no help.
// Everything here needs an owner of that household (or an admin naming one). Secrets are accepted and never given
// back: the page learns that a calendar has a link, not what the link is.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// An action's answer can carry a value for server.js to set as a cookie rather than show the page (a Google sign-in's
// state); keyed by a symbol so no answer can carry it by accident.
const BIND = Symbol('bind');
const {mayManage} = require('./grants');
const {validZone} = require('./zone');
const {eventsBetween} = require('./ics');
const {safeFetchText} = require('./safe-fetch');
const {albumId} = require('./album');
const {dayIn} = require('./zone');
const {hashPin, checkPin} = require('./vault');

const PALETTE = ['#4793e0', '#b37dcc', '#38977b', '#e0823d', '#d05a6e', '#8a8f3c', '#5b6ee1', '#2f9bb0'];
const ICONS = ['home', 'repeat', 'cart', 'sparkles', 'suitcase', 'list'];
const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : fallback;
const fail = (status, message) => Object.assign(Error(message), {status});
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const {validDay, nextYearly, MAX: MAX_COUNTDOWNS} = require('./countdowns');

function createSetup({households, grants, feed = safeFetchText, fetchImpl = fetch}) {
  // sources.json is rewritten whole, keeping whatever this page does not know about.
  function update(home, change) {
    const file = path.join(home.dir, 'sources.json'), sources = JSON.parse(fs.readFileSync(file, 'utf8'));
    change(sources);
    fs.writeFileSync(file + '.tmp', JSON.stringify(sources, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
  }
  const credentialsFile = home => path.join(home.dir, 'credentials.json');
  const held = home => { try { return households.vault.read(credentialsFile(home), home.id); } catch (e) { return {}; } };
  const setSecret = (home, name, value) => households.vault.set(credentialsFile(home), home.id, name, value);
  // A Microsoft sign-in in progress, per household: the device code stays here and never goes to a page, since whoever
  // holds it gets the tokens once the person approves.
  const signingIn = new Map();
  // A Google sign-in in progress, by its state: which household it is for, and the PKCE verifier only this server
  // knows. Single use, ten minutes, and never more than a hundred at once.
  const googleStates = new Map();

  function describe(home) {
    const sources = home.sources(), secrets = held(home), place = home.place();
    return {
      household: {id: home.id, name: place.name, timezone: place.timezone, place: place.label},
      countdowns: (sources.countdowns || []).filter(c => c && validDay(c.date)).map(c => { const today = dayIn(home.place().timezone, Date.now()), next = c.yearly ? nextYearly(c.date, today) : c.date; return {id: c.id, name: c.name, date: next, yearly: !!c.yearly, word: c.word === 'days' ? 'days' : 'sleeps', passed: next < today}; }),
      calendars: (sources.calendars || []).map(c => ({id: c.id, name: c.name, color: c.color, private: ['show', 'hide'].includes(c.private) ? c.private : 'busy', kind: c.source === 'ics' ? 'link' : 'google', connected: c.source === 'ics' ? !!(secrets.ics || {})[c.id] : !!(secrets.google || {}).refresh_token})),
      todoist: {connected: !!(secrets.todoist || {}).token},
      caldav: (c => ({connected: !!c.password, server: c.url ? (() => { try { return new URL(c.url).host; } catch (e) { return ''; } })() : '', username: c.username || ''}))(secrets.caldav || {}),
      homeassistant: (c => ({connected: !!c.token, server: c.url ? (() => { try { return new URL(c.url).host; } catch (e) { return ''; } })() : ''}))(secrets.homeassistant || {}),
      googletasks: {available: !!(home.googletasks && home.googletasks.available), connected: !!(secrets.googletasks || {}).refresh, account: (secrets.googletasks || {}).account || '', signIn: !!(home.googletasks && home.googletasks.needsSignIn())},
      microsoft: {available: !!(home.microsoft && home.microsoft.available), connected: !!(secrets.microsoft || {}).refresh, account: (secrets.microsoft || {}).account || '', signIn: !!(home.microsoft && home.microsoft.needsSignIn())},
      lists: (sources.projects || []).map(p => ({id: p.id, name: p.name, icon: p.icon || 'list', person: !!p.person, kid: !!p.kid, color: p.color || '', kind: p.source === 'local' ? 'here' : ['microsoft', 'caldav', 'homeassistant', 'googletasks'].includes(p.source) ? p.source : 'todoist'})),
      photos: {connected: !!((secrets.album || {}).link || sources.photoAlbum), count: home.photoManifest().photos.length, folder: home.folder.status()},
      frames: grants.list().filter(g => g.household === home.id && g.scope === 'frame' && !g.revokedAt).map(g => ({id: g.id, name: g.label, lastSeen: g.lastSeen})),
      devices: grants.list().filter(g => g.household === home.id && g.scope === 'owner' && !g.revokedAt).map(g => ({id: g.id, name: g.label, lastSeen: g.lastSeen})),
      pin: {set: !!(secrets.frame || {}).pin},
      icons: ICONS, palette: PALETTE
    };
  }

  const actions = {
    async household(home, body) {
      const name = text(body.name, 40); if (!name) throw fail(400, 'Give the household a name.');
      if (!validZone(body.timezone)) throw fail(400, 'Pick a place from the list.');
      const latitude = Number(body.latitude), longitude = Number(body.longitude);
      if (!(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180)) throw fail(400, 'Pick a place from the list.');
      update(home, s => { s.name = name; s.timezone = body.timezone; s.place = {label: text(body.place, 40) || name, latitude, longitude}; });
    },
    async 'household-name'(home, body) {
      const name = text(body.name, 40); if (!name) throw fail(400, 'Give the household a name.');
      update(home, s => { s.name = name; });
    },
    // A calendar is added by its subscription link, which is tried before it is kept, so a mistyped or private link
    // is caught while the person is still looking at the page.
    async 'calendar-add'(home, body) {
      const name = text(body.name, 40), link = text(body.link, 2000); if (!name) throw fail(400, 'Give the calendar a name.');
      let found; try { found = eventsBetween((await feed(link)).text, {calendar: 'x', zone: home.place().timezone, fromDay: dayIn(home.place().timezone), toDay: dayIn(home.place().timezone, Date.now() + 60 * 86400000)}).length; }
      catch (e) { throw fail(400, 'That link could not be read as a calendar. ' + e.message + '.'); }
      const id = 'c-' + crypto.randomBytes(4).toString('hex'), used = (home.sources().calendars || []).map(c => c.color);
      setSecret(home, 'ics.' + id, link);
      update(home, s => { (s.calendars = s.calendars || []).push({id, name, color: color(body.color, PALETTE.find(p => !used.includes(p)) || PALETTE[0]), source: 'ics'}); });
      return {found};
    },
    async 'calendar-edit'(home, body) {
      update(home, s => { const c = (s.calendars || []).find(c => c.id === body.id); if (!c) throw fail(404, 'No such calendar.'); if (text(body.name, 40)) c.name = text(body.name, 40); c.color = color(body.color, c.color); if (['busy', 'show', 'hide'].includes(body.private)) c.private = body.private; });
    },
    // Something the household is counting down to. The frame shows the nearest one, as sleeps or as days.
    async 'countdown-add'(home, body) {
      const name = text(body.name, 40); if (!name) throw fail(400, 'Say what you are counting down to.');
      if (!validDay(body.date)) throw fail(400, 'Pick its date.');
      update(home, s => {
        s.countdowns = Array.isArray(s.countdowns) ? s.countdowns : [];
        if (s.countdowns.length >= MAX_COUNTDOWNS) throw fail(400, 'That is plenty to count down to. Remove one first.');
        s.countdowns.push({id: 'd-' + crypto.randomBytes(4).toString('hex'), name, date: body.date, ...(body.yearly ? {yearly: true} : {}), ...(body.word === 'days' ? {word: 'days'} : {})});
      });
    },
    async 'countdown-remove'(home, body) {
      update(home, s => { s.countdowns = (s.countdowns || []).filter(c => c.id !== body.id); });
    },
    async 'calendar-remove'(home, body) {
      update(home, s => { s.calendars = (s.calendars || []).filter(c => c.id !== body.id); });
      try { setSecret(home, 'ics.' + text(body.id, 80), null); } catch (e) {}
    },
    // The Todoist token is tried by listing projects with it; the list comes back so lists can be chosen by name.
    async todoist(home, body) {
      const token = text(body.token, 200); if (!token) throw fail(400, 'Paste your Todoist API token.');
      const projects = await todoistProjects(token);
      setSecret(home, 'todoist.token', token);
      return {projects};
    },
    async 'todoist-projects'(home) {
      const token = (held(home).todoist || {}).token; if (!token) throw fail(400, 'Connect Todoist first.');
      return {projects: await todoistProjects(token)};
    },
    // Choosing lists replaces that service's lists and keeps the others'. A Microsoft list is chosen by the short id
    // the page was shown, and its real id is looked up again here rather than taken from the page.
    async lists(home, body) {
      const source = ['microsoft', 'caldav', 'homeassistant', 'googletasks'].includes(body.source) ? body.source : 'todoist', service = {microsoft: home.microsoft, caldav: home.caldav, homeassistant: home.homeassistant, googletasks: home.googletasks}[source];
      const known = service ? new Map((await service.lists()).map(l => [l.id, l.remote])) : null;
      const chosen = (Array.isArray(body.lists) ? body.lists : []).slice(0, 12).map(l => ({id: text(l.id, 40), name: text(l.name, 40), ...(known ? {source, remote: known.get(text(l.id, 40))} : {}), ...(l.person ? {person: true, ...(l.kid ? {kid: true} : {}), ...(color(l.color, '') ? {color: color(l.color, '')} : {})} : {icon: ICONS.includes(l.icon) ? l.icon : 'list'})})).filter(l => /^[A-Za-z0-9]{1,40}$/.test(l.id) && l.name && (!known || l.remote));
      const kind = p => ['local', 'microsoft', 'caldav', 'homeassistant', 'googletasks'].includes(p.source) ? p.source : 'todoist';
      // A list's name is how the frame and the phone say which list to add to and whose task was checked off, so two
      // lists may not share one, whichever services they come from.
      const taken = new Set((home.sources().projects || []).filter(p => kind(p) !== source).map(p => p.name.toLowerCase()));
      for (const l of chosen) { if (taken.has(l.name.toLowerCase())) throw fail(400, 'There is already a list called ' + l.name + '. Rename one of them first.'); taken.add(l.name.toLowerCase()); }
      update(home, s => { const had = s.projects || []; s.projects = ['todoist', 'googletasks', 'microsoft', 'caldav', 'homeassistant', 'local'].flatMap(k => k === source ? chosen : had.filter(p => kind(p) === k)); });
    },
    // A CalDAV account (Nextcloud, Fastmail, Synology): its address, a username and an app password, tried before
    // they are kept by finding the account's task lists.
    async caldav(home, body) {
      const account = {url: text(body.url, 300), username: text(body.username, 120), password: String(body.password || '').slice(0, 300)};
      if (!account.url || !account.username || !account.password) throw fail(400, 'Fill in the server address, the username and the app password.');
      const found = await home.caldav.discover(account);
      if (!found.length) throw fail(400, 'That account has no task lists yet. Make one in your tasks app, then connect again.');
      setSecret(home, 'caldav.url', account.url); setSecret(home, 'caldav.username', account.username); setSecret(home, 'caldav.password', account.password);
      return {lists: found.map(({id, name}) => ({id, name}))};
    },
    async 'caldav-lists'(home) {
      if (!(held(home).caldav || {}).password) throw fail(400, 'Connect the CalDAV account first.');
      return {lists: (await home.caldav.lists()).map(({id, name}) => ({id, name}))};
    },
    async 'caldav-disconnect'(home) {
      for (const name of ['url', 'username', 'password']) setSecret(home, 'caldav.' + name, null);
      home.caldav.forget();
      update(home, s => { s.projects = (s.projects || []).filter(p => p.source !== 'caldav'); });
    },
    // Home Assistant: its address and a long-lived access token, tried before they are kept by finding its lists.
    async homeassistant(home, body) {
      const account = {url: text(body.url, 300), token: String(body.token || '').trim().slice(0, 1000)};
      if (!account.url || !account.token) throw fail(400, 'Fill in Home Assistant’s address and the token.');
      const found = await home.homeassistant.discover(account);
      if (!found.length) throw fail(400, 'That Home Assistant has no to-do lists yet. Add one there (the Shopping list, or Local to-do), then connect again.');
      setSecret(home, 'homeassistant.url', account.url); setSecret(home, 'homeassistant.token', account.token);
      return {lists: found.map(({id, name}) => ({id, name}))};
    },
    async 'homeassistant-lists'(home) {
      if (!(held(home).homeassistant || {}).token) throw fail(400, 'Connect Home Assistant first.');
      return {lists: (await home.homeassistant.lists()).map(({id, name}) => ({id, name}))};
    },
    async 'homeassistant-disconnect'(home) {
      setSecret(home, 'homeassistant.url', null); setSecret(home, 'homeassistant.token', null);
      home.homeassistant.forget();
      update(home, s => { s.projects = (s.projects || []).filter(p => p.source !== 'homeassistant'); });
    },
    // Google Tasks: the phone goes to Google and comes back to /oauth/google (oauthReturn, below).
    async 'googletasks-start'(home) {
      const started = home.googletasks.begin(), now = Date.now();
      for (const [key, value] of googleStates) if (value.until < now) googleStates.delete(key);
      if (googleStates.size >= 100) throw fail(429, 'Too many sign-ins at once. Try again in a few minutes.');
      googleStates.set(started.state, {household: home.id, verifier: started.verifier, until: now + 600000});
      return {url: started.url, [BIND]: started.state};
    },
    async 'googletasks-lists'(home) {
      if (!(held(home).googletasks || {}).refresh) throw fail(400, 'Connect Google Tasks first.');
      return {lists: (await home.googletasks.lists()).map(({id, name}) => ({id, name}))};
    },
    async 'googletasks-disconnect'(home) {
      await home.googletasks.revoke();   // Google is told too, so it stops trusting the token, not only this server
      setSecret(home, 'googletasks.refresh', null); setSecret(home, 'googletasks.account', null);
      update(home, s => { s.projects = (s.projects || []).filter(p => p.source !== 'googletasks'); });
    },
    // Microsoft To Do: a code on the phone, then the lists to show. microsoft.js holds the reasons.
    async 'microsoft-start'(home) {
      const started = await home.microsoft.startDevice();
      signingIn.set(home.id, {deviceCode: started.deviceCode, interval: started.interval, next: Date.now() + started.interval * 1000, until: Date.now() + started.expiresIn * 1000});
      return {code: started.code, url: started.url, interval: started.interval, expiresIn: started.expiresIn};
    },
    async 'microsoft-poll'(home) {
      const pending = signingIn.get(home.id);
      if (!pending || Date.now() > pending.until) { signingIn.delete(home.id); return {status: 'expired'}; }
      if (Date.now() < pending.next) return {status: 'pending'};   // Microsoft set the pace; the page may ask more often
      const got = await home.microsoft.pollDevice(pending.deviceCode);
      if (got.status === 'slow') pending.interval += 5;
      pending.next = Date.now() + pending.interval * 1000;
      if (got.status === 'pending' || got.status === 'slow') return {status: 'pending'};
      signingIn.delete(home.id);
      if (got.status !== 'connected') return {status: got.status};
      setSecret(home, 'microsoft.refresh', got.refresh);
      setSecret(home, 'microsoft.account', got.account || null);
      return {status: 'connected', lists: (await home.microsoft.lists()).map(({id, name, shared}) => ({id, name, shared}))};
    },
    async 'microsoft-lists'(home) {
      if (!(held(home).microsoft || {}).refresh) throw fail(400, 'Connect Microsoft To Do first.');
      return {lists: (await home.microsoft.lists()).map(({id, name, shared}) => ({id, name, shared}))};
    },
    async 'microsoft-disconnect'(home) {
      signingIn.delete(home.id);
      setSecret(home, 'microsoft.refresh', null); setSecret(home, 'microsoft.account', null);
      home.microsoft.forget();
      update(home, s => { s.projects = (s.projects || []).filter(p => p.source !== 'microsoft'); });
    },
    // A list kept here, needing no account anywhere.
    async 'list-add'(home, body) {
      const name = text(body.name, 40); if (!name) throw fail(400, 'Give the list a name.');
      if ((home.sources().projects || []).some(p => p.name.toLowerCase() === name.toLowerCase())) throw fail(400, 'There is already a list called that.');
      const entry = {id: 'L' + crypto.randomBytes(5).toString('hex'), name, source: 'local', ...(body.person ? {person: true, ...(body.kid ? {kid: true} : {}), color: color(body.color, PALETTE[(home.sources().projects || []).length % PALETTE.length])} : {icon: ICONS.includes(body.icon) ? body.icon : 'list'}), ...(text(body.description, 120) ? {description: text(body.description, 120)} : {})};
      update(home, s => { (s.projects = s.projects || []).push(entry); });
    },
    async 'list-remove'(home, body) {
      const entry = (home.sources().projects || []).find(p => p.id === body.id && p.source === 'local'); if (!entry) throw fail(404, 'No such list.');
      update(home, s => { s.projects = s.projects.filter(p => p.id !== entry.id); });
      home.lists.removeList(entry.id);
    },
    async photos(home, body) {
      const link = text(body.link, 500);
      if (!link) { setSecret(home, 'album.link', null); update(home, s => { delete s.photoAlbum; }); return; }
      try { albumId(link); } catch (e) { throw fail(400, 'That does not look like an iCloud shared album link.'); }
      setSecret(home, 'album.link', link);
      update(home, s => { delete s.photoAlbum; });
      home.syncPhotos();
    },
    async 'frame-pair'(home, body) {
      if (!grants.approvePairing(body.code, {household: home.id, label: text(body.name, 60) || 'Frame'})) throw fail(400, 'No screen is showing that code. Codes last ten minutes; read it again from the screen.');
    },
    async revoke(home, body) {
      const grant = grants.list().find(g => g.id === body.id && g.household === home.id);
      if (!grant || !grants.revoke(grant.id)) throw fail(404, 'Nothing to remove.');
    },
    // The PIN that lets someone standing at a frame add their phone. Without one, that way in stays shut.
    async pin(home, body) {
      const pin = String(body.pin == null ? '' : body.pin);
      if (pin === '') { setSecret(home, 'frame.pin', null); return; }
      if (!/^\d{4,8}$/.test(pin)) throw fail(400, 'A PIN is four to eight digits.');
      setSecret(home, 'frame.pin', hashPin(pin));
    },
    async link(home, body) { return {token: grants.mintLink({scope: 'owner', household: home.id, label: text(body.name, 60)})}; }
  };
  async function todoistProjects(token) {
    const response = await fetchImpl('https://api.todoist.com/api/v1/projects?limit=200', {headers: {Authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(12000)});
    if (response.status === 401 || response.status === 403) throw fail(400, 'Todoist did not accept that token.');
    if (!response.ok) throw fail(502, 'Todoist is not answering. Try again in a minute.');
    const all = (await response.json()).results || [], byId = Object.fromEntries(all.map(p => [p.id, p]));
    return all.filter(p => !p.is_archived && !p.inbox_project).map(p => ({id: p.id, name: p.name, under: p.parent_id && byId[p.parent_id] ? byId[p.parent_id].name : ''}));
  }
  async function places(query) {
    const q = text(query, 60); if (q.length < 2) return [];
    const response = await fetchImpl('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=' + encodeURIComponent(q), {signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw fail(502, 'Place search is not answering.');
    return ((await response.json()).results || []).filter(r => validZone(r.timezone)).map(r => ({place: r.name, detail: [r.admin1, r.country].filter(Boolean).join(', '), latitude: r.latitude, longitude: r.longitude, timezone: r.timezone}));
  }

  // Which household this request may manage: an owner's own, or the one an admin names.
  function homeFor(grant, url) {
    if (!grant) throw fail(401, 'Open your setup link first.');
    const id = grant.scope === 'admin' ? url.searchParams.get('household') : grant.household;
    const home = households.get(id);
    if (!home || !mayManage(grant, home.id)) throw fail(403, 'This device cannot manage that household.');
    return home;
  }
  // Returns an answer {status, body}, or null when the path is not this module's.
  async function handle({method, url, grant, body}) {
    if (!url.pathname.startsWith('/api/setup')) return null;
    try {
      const home = homeFor(grant, url);
      if (url.pathname === '/api/setup' && method === 'GET') return {status: 200, body: describe(home)};
      if (url.pathname === '/api/setup/places' && method === 'GET') return {status: 200, body: {places: await places(url.searchParams.get('q'))}};
      const action = url.pathname.replace('/api/setup/', '');
      if (method !== 'POST' || !Object.prototype.hasOwnProperty.call(actions, action)) return {status: 404, body: {error: 'Not found'}};
      const {[BIND]: bind, ...result} = (await actions[action](home, body || {})) || {};
      return {status: 200, body: {...result, setup: describe(home)}, ...(bind ? {bind} : {})};
    } catch (e) { return {status: e.status || 500, body: {error: e.status ? e.message : 'That did not work. Try again.'}}; }
  }
  // Where Google sends the phone back. The household's cookie does not come along (it is kept to this site's own
  // links), so the state says who this is: made by an owner, used once, within ten minutes, and carried back by the
  // same browser in a cookie of its own (server.js), so a sign-in link passed to someone else connects nothing. The
  // answer is a page that sends the phone on to setup itself, since a link followed from this site does carry the cookie.
  async function oauthReturn({code = '', state = '', error = '', browser = ''} = {}) {
    const pending = googleStates.get(String(state));
    googleStates.delete(String(state));
    const given = Buffer.from(String(browser)), expected = Buffer.from(String(state));
    const sameBrowser = !!pending && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    const page = (status, message, then) => ({status, html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex">' + (then ? '<meta http-equiv="refresh" content="0;url=' + then + '">' : '') + '<title>Google Tasks</title><link rel="stylesheet" href="/setup.css"></head>' +
      '<body><main><header class="top"><p class="eyebrow">Google Tasks</p><h1>' + escapeHtml(message) + '</h1></header>' +
      '<section class="card"><a class="button primary" href="' + (then || '/setup') + '">Back to setup</a></section></main></body></html>'});
    if (!pending || pending.until < Date.now()) return page(400, 'That sign-in ran out. Go back to setup and try again.');
    if (!sameBrowser) return page(400, 'Finish connecting Google on the phone that started it. Go back to setup and try again there.');
    const home = households.get(pending.household), back = '/setup?household=' + encodeURIComponent(pending.household);
    if (!home) return page(400, 'That household is gone.');
    if (error || !code) return page(200, 'Google Tasks wasn’t connected.', null);
    try {
      const got = await home.googletasks.finish(String(code).slice(0, 2000), pending.verifier);
      setSecret(home, 'googletasks.refresh', got.refresh);
      setSecret(home, 'googletasks.account', got.account || null);
      return page(200, 'Google Tasks is connected.', back + '#google-connected');
    } catch (e) { return page(e.status && e.status < 500 ? e.status : 502, e.status ? e.message : 'Google didn’t finish signing in. Try again.'); }
  }
  // Asked by a paired frame: a code that lets a phone in, if the household has a PIN and this is it.
  function ownerCode(home, pin) {
    const stored = (held(home).frame || {}).pin;
    if (!stored) throw fail(409, 'Set a frame PIN on the setup page first.');
    if (!checkPin(pin, stored)) throw fail(403, 'That is not the PIN.');
    return grants.startClaim(home.id);
  }
  return {handle, describe, ownerCode, oauthReturn};
}
module.exports = {createSetup};
