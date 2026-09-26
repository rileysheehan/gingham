// Whether a newer Gingham exists. Gingham is sideloaded, not installed from a store, so without this nothing would
// ever tell a family there is one.
//
// Once shortly after the server starts and then once a day, the server asks GitHub's public API for the latest
// release of rileysheehan/gingham. The request carries no account, no cookie and nothing about any household: a fixed
// User-Agent (GitHub refuses requests without one) and, after the first answer, the ETag GitHub gave, so an unchanged
// answer comes back as an empty 304. Offline, rate-limited or with GitHub down, the check fails quietly and tries again
// the next day; it never blocks a request, and the wall never waits on it. Settings can also ask for one at once (Check
// now, checkNow below), at most once a minute. It can be turned off in the frame's Settings, or for a whole server
// with GINGHAM_UPDATE_CHECK=off. Nothing is ever downloaded or installed here: the server only learns that a release
// exists and what its notes say. Installing is always a person's choice (see UpdateInstaller.java for the Android app).
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'rileysheehan/gingham';
const LATEST_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const RELEASES_URL = 'https://github.com/' + REPO + '/releases';
const IMAGE = 'ghcr.io/' + REPO;
const DAY = 24 * 3600000;
const FIRST_AFTER = 2 * 60000;     // shortly after start, once the frame has what it needs
const START_GAP = 3600000;         // ...unless a check was made within the hour, so a restart loop is not a request loop
const TIMEOUT = 10000;
const MAX_BODY = 512 * 1024;       // a release's JSON; its notes are capped by GitHub well below this
const NOW_GAP = 60000;             // Check now: at most once a minute for the whole server, however many frames press it

// Versions are semantic (MAJOR.MINOR.PATCH, a leading "v" allowed). A pre-release ("0.2.0-beta.1") parses but is never
// offered, and a dev build ("0.1.1-dev.57") sorts before its release.
function parseVersion(text) {
  const m = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/.exec(String(text || '').trim());
  return m ? {major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : []} : null;
}
// -1, 0 or 1, as semver orders them; an unreadable version sorts before any readable one.
function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a, y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
// Whether `candidate` is a release worth offering to something running `current`: a stable version, strictly newer.
function isNewer(candidate, current) {
  const c = parseVersion(candidate);
  return !!c && !c.pre.length && compareVersions(c, parseVersion(current)) > 0;
}
const plain = version => { const v = parseVersion(version); return v ? v.major + '.' + v.minor + '.' + v.patch + (v.pre.length ? '-' + v.pre.join('.') : '') : ''; };

// "What's new", from the release's notes: the first run of bullet points, as plain text, at most four lines. A release
// written for families (RELEASING.md) opens with them; GitHub's generated notes ("* Fix it by @someone in https://…")
// are tidied to their titles.
function summarizeNotes(body, max = 4) {
  const lines = String(body || '').replace(/\r/g, '').split('\n'), out = [];
  let started = false, more = false;
  for (const raw of lines) {
    const bullet = /^\s{0,3}[-*•]\s+(.*)$/.exec(raw);
    if (!bullet) { if (started && raw.trim()) break; continue; }
    started = true;
    const text = bullet[1]
      .replace(/\s+by @[\w-]+ in https?:\/\/\S+$/, '')     // GitHub's generated "by @x in <link>"
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')             // links keep their words
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_`]+/g, '')
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (out.length === max) { more = true; break; }
    out.push(text.length > 140 ? text.slice(0, 139).replace(/\s+\S*$/, '') + '…' : text);
  }
  return {lines: out, more};
}

// When the next check is due. `state.attemptedAt` is the last time GitHub was asked, successfully or not; a check is
// made shortly after start unless one was made within the hour, then a day after the last one, and never before a
// rate limit GitHub named has passed.
function nextCheckAt(state, startedAt) {
  const last = state.attemptedAt || 0;
  let due = startedAt - last >= START_GAP ? startedAt + FIRST_AFTER : last + DAY;
  if (due < last + START_GAP) due = last + START_GAP;
  if (state.retryAfter && state.retryAfter > due) due = state.retryAfter;
  return due;
}

// The form this server runs in decides what "update" means: the app updates itself with a tap, a container is pulled
// again, a plain Node server is downloaded again. GINGHAM_FORM is set by the app (NodeServer.java) and the Dockerfile.
function howToUpdate(form, version) {
  if (form === 'container') return 'Whoever runs this frame’s server updates it: docker pull ' + IMAGE + ':latest, then start the container again.';
  if (form === 'app') return 'On this tablet, download gingham-either.apk from github.com/' + REPO + '/releases and open it.';
  return 'Whoever runs this frame’s server updates it: download Gingham ' + version + ' from github.com/' + REPO + '/releases and start the server again.';
}

function createUpdates({current, form = 'node', file, fetchImpl = globalThis.fetch, now = Date.now, env = process.env, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = TIMEOUT} = {}) {
  const locked = String(env.GINGHAM_UPDATE_CHECK || '').toLowerCase() === 'off';
  const url = env.GINGHAM_UPDATE_URL || LATEST_URL;   // tests point this at a server of their own
  let state = read(), timer = null, running = null, startedAt = now();

  function read() {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return s && typeof s === 'object' ? s : {};
    } catch (e) { return {}; }
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), {mode: 0o600});
      fs.renameSync(file + '.tmp', file);
    } catch (e) { log('update check: could not save its state: ' + e.message); }
  }
  const enabled = () => !locked && state.check !== false;

  // One request to GitHub. Every way it can go wrong ends the same way: nothing changes but the time of the attempt.
  async function check() {
    if (!enabled()) return {ok: false, reason: 'off'};
    if (running) return running;
    running = (async () => {
      const at = now();
      state.attemptedAt = at;
      try {
        const headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'Gingham', 'X-GitHub-Api-Version': '2022-11-28'};
        if (state.etag && state.latest) headers['If-None-Match'] = state.etag;
        const response = await fetchImpl(url, {headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs)});
        if (response.status === 304) { state.checkedAt = at; delete state.retryAfter; return {ok: true, changed: false}; }
        if (response.status === 403 || response.status === 429) {
          // Unauthenticated, GitHub allows 60 requests an hour per address, shared with anything else in the house.
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000, wait = Number(response.headers.get('retry-after')) * 1000;
          const until = wait > 0 ? at + wait : reset > at ? reset : at + DAY;
          state.retryAfter = Math.min(until, at + 7 * DAY);
          return {ok: false, reason: 'rate-limited'};
        }
        if (response.status === 404) { state.checkedAt = at; state.latest = null; delete state.etag; return {ok: true, changed: true}; }   // no release yet
        if (!response.ok) return {ok: false, reason: 'status ' + response.status};
        const text = await response.text();
        if (text.length > MAX_BODY) return {ok: false, reason: 'too large'};
        const release = JSON.parse(text);
        const version = release && !release.draft && !release.prerelease && plain(release.tag_name);
        if (!version || parseVersion(version).pre.length) return {ok: false, reason: 'no stable release'};
        const html = typeof release.html_url === 'string' && release.html_url.indexOf('https://github.com/' + REPO + '/') === 0 ? release.html_url : RELEASES_URL;
        state.latest = {version, notes: summarizeNotes(release.body), url: html, publishedAt: typeof release.published_at === 'string' ? release.published_at : null};
        state.etag = response.headers.get('etag') || undefined;
        state.checkedAt = at;
        delete state.retryAfter;
        return {ok: true, changed: true};
      } catch (e) {
        return {ok: false, reason: e && e.name === 'TimeoutError' ? 'timed out' : 'offline'};
      } finally {
        save();
        running = null;
      }
    })();
    const result = await running;
    if (!result.ok && result.reason !== 'off') log('update check: ' + result.reason + '; trying again tomorrow');
    return result;
  }

  // The timer never keeps the process alive and never runs on the request path.
  function schedule() {
    if (timer) clearTimer(timer);
    timer = null;
    if (!enabled()) return;
    const wait = Math.max(1000, nextCheckAt(state, startedAt) - now());
    timer = setTimer(() => { timer = null; check().catch(() => {}).then(schedule); }, Math.min(wait, 2 ** 31 - 1));
    if (timer && timer.unref) timer.unref();
  }
  // Check now, from Settings: the same request, asked for by a person rather than the timer, so a release published just
  // after the day's check is not invisible until tomorrow's. It is the server's one budget with GitHub (60 requests an
  // hour per address, shared with everything else in the house), so it is refused, saying until when, inside a minute
  // of the last request (by anyone, the timer included) and while a rate limit GitHub named is still running. The next
  // daily check counts from this one.
  async function checkNow() {
    if (!enabled()) return {ok: false, reason: 'off'};
    const at = now();
    if (state.retryAfter && state.retryAfter > at) return {ok: false, reason: 'rate-limited', retryAt: state.retryAfter};
    if (!running && state.attemptedAt && at - state.attemptedAt < NOW_GAP && at >= state.attemptedAt) return {ok: false, reason: 'too-soon', retryAt: state.attemptedAt + NOW_GAP};
    const result = await check();
    schedule();
    return result.ok || result.reason !== 'rate-limited' ? result : {...result, retryAt: state.retryAfter};
  }
  function start() { startedAt = now(); schedule(); }
  function stop() { if (timer) clearTimer(timer); timer = null; }

  // Turning the check off also forgets what it last heard, so no notice outlives the choice.
  function setEnabled(on) {
    if (locked) return status();
    state.check = !!on;
    if (!on) { delete state.latest; delete state.etag; delete state.retryAfter; }
    save();
    schedule();
    return status();
  }

  // What Settings shows. `app` is the version of the Android app showing the page, when the page runs in it; it may
  // differ from the server's when the app shows a server elsewhere.
  function status(app) {
    const latest = enabled() && state.latest && parseVersion(state.latest.version) ? state.latest : null;
    const appVersion = parseVersion(app) ? plain(app) : null;
    return {
      version: current, form, check: enabled(), locked,
      checkedAt: enabled() ? state.checkedAt || null : null,
      latest: latest ? {version: latest.version, notes: latest.notes && Array.isArray(latest.notes.lines) ? latest.notes : {lines: [], more: false}, url: latest.url || RELEASES_URL} : null,
      available: !!latest && isNewer(latest.version, current),
      ...(appVersion ? {app: appVersion, appAvailable: !!latest && isNewer(latest.version, appVersion)} : {}),
      howTo: latest ? howToUpdate(form, latest.version) : ''
    };
  }

  return {check, checkNow, start, stop, schedule, setEnabled, status, enabled, state: () => state};
}

module.exports = {createUpdates, parseVersion, compareVersions, isNewer, summarizeNotes, nextCheckAt, howToUpdate, REPO, LATEST_URL, RELEASES_URL, DAY, FIRST_AFTER, START_GAP, NOW_GAP};
