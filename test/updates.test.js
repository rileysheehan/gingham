// The update check (updates.js): version order, when it asks, what it sends, and that every way GitHub can fail leaves
// the frame exactly as it was. GitHub is played by a local server, so the requests are real HTTP with real headers.
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createUpdates, parseVersion, compareVersions, isNewer, summarizeNotes, nextCheckAt, DAY, FIRST_AFTER, START_GAP, NOW_GAP} = require('../updates');
const releases = require('./release-fixture');
const NEXT = releases.newer.tag_name.slice(1);   // the fixture's newer release, one patch past package.json

const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'updates-test-')), 'updates.json');

const open = new Set();
after(() => { for (const server of open) { server.closeAllConnections(); server.close(); } });
// A stand-in for api.github.com: `answer(req)` returns {status, headers, body}, or 'hang' to never answer.
async function fakeGitHub(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({url: req.url, headers: req.headers});
    const a = answer(req, seen.length);
    if (a === 'hang') return;
    res.writeHead(a.status, a.headers || {});
    res.end(a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  open.add(server);   // closed at the end even when a test fails before closing it
  const url = 'http://127.0.0.1:' + server.address().port + '/repos/rileysheehan/gingham/releases/latest';
  return {url, seen, close: () => new Promise(resolve => { open.delete(server); server.closeAllConnections(); server.close(resolve); })};
}
const checker = (github, options = {}) => createUpdates({current: '0.1.1', file: scratch(), env: {GINGHAM_UPDATE_URL: github.url}, timeoutMs: 500, ...options});

test('Versions compare as semver: numbers, not text, and a pre-release before its release', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('v0.2.0', '0.1.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1, 'numeric identifiers compare as numbers');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('0.1.1-dev.57', '0.1.1'), -1, 'a dev build sorts before its release');
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0, 'build metadata is ignored');
  assert.equal(parseVersion('0.1'), null);
  assert.equal(parseVersion('01.2.3'), null, 'no leading zeros');
  assert.equal(parseVersion('latest'), null);
});

test('Only a stable release that is strictly newer is ever offered', () => {
  assert.ok(isNewer('v0.1.2', '0.1.1'));
  assert.ok(isNewer('0.2.0', '0.1.10'));
  assert.ok(!isNewer('0.1.1', '0.1.1'), 'the same version is not an update');
  assert.ok(!isNewer('0.1.0', '0.1.1'), 'never backward');
  assert.ok(!isNewer('0.2.0-beta.1', '0.1.1'), 'pre-releases are ignored');
  assert.ok(isNewer('0.1.1', '0.1.1-dev.3'), 'a dev build is offered its release');
  assert.ok(!isNewer('garbage', '0.1.1'));
});

test('What’s new is the first run of bullets, tidied, at most four lines', () => {
  const notes = summarizeNotes(releases.newer.body);
  assert.equal(notes.lines.length, 4);
  assert.equal(notes.lines[0], 'Lists can be reordered from the wall: hold an item, then drag it.');
  assert.equal(notes.more, true, 'a fifth bullet is left for the release page');
  // GitHub's generated notes come down to their titles.
  const generated = summarizeNotes("## What's Changed\n* Settings shows the version by @someone in https://github.com/rileysheehan/gingham/pull/3\n* **Bold** and [a link](https://x.test) by @a-b in https://github.com/x/y/pull/4\n\n**Full Changelog**: https://github.com/x/compare/v0.1.0...v0.1.1");
  assert.deepEqual(generated, {lines: ['Settings shows the version', 'Bold and a link'], more: false});
  assert.deepEqual(summarizeNotes(''), {lines: [], more: false});
  assert.ok(summarizeNotes('- ' + 'word '.repeat(60)).lines[0].length <= 140);
});

test('It asks shortly after start, then once a day, and a restart loop is not a request loop', () => {
  const start = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(nextCheckAt({}, start), start + FIRST_AFTER, 'never checked: shortly after start');
  assert.equal(nextCheckAt({attemptedAt: start - 5 * 3600000}, start), start + FIRST_AFTER, 'checked hours ago: shortly after start');
  assert.equal(nextCheckAt({attemptedAt: start - 10 * 60000}, start), start - 10 * 60000 + DAY, 'checked ten minutes ago: a day after that');
  assert.equal(nextCheckAt({attemptedAt: start + 60000}, start), start + 60000 + DAY, 'after the first check: daily');
  assert.equal(nextCheckAt({attemptedAt: start + 60000, retryAfter: start + 3 * DAY}, start), start + 3 * DAY, 'a rate limit pushes it later');
  assert.ok(nextCheckAt({attemptedAt: start - START_GAP}, start) >= start - START_GAP + START_GAP);
});

test('The timer runs the check when it is due, and never keeps the process alive', async () => {
  const github = await fakeGitHub(() => ({status: 200, body: releases.newer, headers: {'ETag': '"a"'}}));
  let clock = Date.parse('2026-10-01T12:00:00Z');
  const timers = [];
  const u = checker(github, {now: () => clock, setTimer: (fn, ms) => { const t = {fn, ms, unref() { t.unrefd = true; }}; timers.push(t); return t; }, clearTimer: t => { t.cleared = true; }});
  u.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, FIRST_AFTER, 'first check two minutes after start');
  assert.ok(timers[0].unrefd);
  assert.equal(github.seen.length, 0, 'nothing is asked at start itself');
  clock += FIRST_AFTER;
  timers[0].fn();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(github.seen.length, 1);
  assert.equal(timers.length, 2, 'the next one is scheduled');
  assert.equal(timers[1].ms, DAY, 'a day later');
  assert.equal(u.status().latest.version, NEXT);
  await github.close();
});

test('What is sent: no cookie, no household, a fixed User-Agent, and the ETag once there is one; a 304 keeps what it knew', async () => {
  const github = await fakeGitHub((req, n) => n === 1 ? {status: 200, headers: {'ETag': 'W/"abc"'}, body: releases.newer} : {status: 304, headers: {'ETag': 'W/"abc"'}});
  const u = checker(github);
  assert.deepEqual(await u.check(), {ok: true, changed: true});
  assert.deepEqual(await u.check(), {ok: true, changed: false});
  const [first, second] = github.seen;
  assert.equal(first.headers['user-agent'], 'Gingham');
  assert.equal(first.headers['if-none-match'], undefined);
  assert.equal(second.headers['if-none-match'], 'W/"abc"', 'the second request is conditional');
  for (const {headers} of github.seen) {
    assert.equal(headers.cookie, undefined); assert.equal(headers.authorization, undefined);
    // Only what fetch itself adds, and ours: nothing that could say which household, frame or person this is.
    const allowed = ['accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection', 'host', 'if-none-match', 'pragma', 'sec-fetch-mode', 'user-agent', 'x-github-api-version'];
    assert.deepEqual(Object.keys(headers).filter(h => !allowed.includes(h)), []);
  }
  assert.equal(first.url, '/repos/rileysheehan/gingham/releases/latest', 'nothing in the address but the repository');
  const s = u.status();
  assert.equal(s.available, true);
  assert.equal(s.latest.version, NEXT);
  assert.equal(s.latest.url, 'https://github.com/rileysheehan/gingham/releases/tag/v' + NEXT);
  assert.ok(s.howTo.includes('download Gingham ' + NEXT + ' from github.com/rileysheehan/gingham/releases'), s.howTo);
  await github.close();
});

test('What it learned survives a restart, including the ETag', async () => {
  const github = await fakeGitHub(() => ({status: 200, headers: {'ETag': '"v2"'}, body: releases.newer}));
  const file = scratch();
  await checker(github, {file}).check();
  const again = checker(github, {file});
  assert.equal(again.status().latest.version, NEXT);
  await again.check();
  assert.equal(github.seen[1].headers['if-none-match'], '"v2"');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  await github.close();
});

test('Offline, GitHub down, a timeout, a bad answer: silent, harmless, and what it knew stays', async () => {
  const good = await fakeGitHub(() => ({status: 200, headers: {'ETag': '"x"'}, body: releases.newer}));
  const file = scratch(), logged = [];
  await checker(good, {file}).check();
  await good.close();
  // Nothing listening at all.
  const offline = createUpdates({current: '0.1.1', file, env: {GINGHAM_UPDATE_URL: good.url}, timeoutMs: 500, log: m => logged.push(m)});
  assert.deepEqual(await offline.check(), {ok: false, reason: 'offline'});
  assert.equal(offline.status().latest.version, NEXT, 'the last answer is kept');
  for (const answer of [{status: 500, body: 'oops'}, {status: 502}, {status: 200, body: '{not json'}, {status: 200, body: {tag_name: 'nightly'}}, {status: 200, body: {...releases.newer, tag_name: 'v0.3.0-rc.1'}}, 'hang']) {
    const github = await fakeGitHub(() => answer);
    const u = createUpdates({current: '0.1.1', file, env: {GINGHAM_UPDATE_URL: github.url}, timeoutMs: 300, log: m => logged.push(m)});
    const started = Date.now();
    const result = await u.check();
    assert.equal(result.ok, false, JSON.stringify(answer).slice(0, 60));
    assert.ok(Date.now() - started < 2000, 'never waits past its timeout');
    assert.equal(u.status().latest.version, NEXT);
    await github.close();
  }
  assert.ok(logged.every(m => /^update check: /.test(m)), 'a line in the server log, and nothing anywhere else');
});

test('Rate-limited: it waits until GitHub says it may ask again', async () => {
  const at = Date.parse('2026-10-01T12:00:00Z'), reset = at / 1000 + 3 * 3600;
  const github = await fakeGitHub(() => ({status: 403, headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset)}, body: {message: 'API rate limit exceeded'}}));
  const u = checker(github, {now: () => at});
  assert.deepEqual(await u.check(), {ok: false, reason: 'rate-limited'});
  assert.equal(u.state().retryAfter, reset * 1000);
  assert.equal(nextCheckAt(u.state(), at - DAY), at + DAY, 'the daily check is later than the reset anyway');
  const retry = await fakeGitHub(() => ({status: 429, headers: {'retry-after': String(3 * DAY / 1000)}}));
  const v = checker(retry, {now: () => at});
  await v.check();
  assert.equal(nextCheckAt(v.state(), at - DAY), at + 3 * DAY, 'a longer Retry-After is respected');
  await github.close(); await retry.close();
});

test('No release yet is not an error, and nothing is offered', async () => {
  const github = await fakeGitHub(() => ({status: 404, body: {message: 'Not Found'}}));
  const u = checker(github);
  assert.equal((await u.check()).ok, true);
  assert.equal(u.status().latest, null);
  assert.equal(u.status().available, false);
  await github.close();
});

test('Up to date: the same version is known and not offered', async () => {
  const github = await fakeGitHub(() => ({status: 200, body: releases.same('0.1.1')}));
  const u = checker(github);
  await u.check();
  const s = u.status();
  assert.equal(s.latest.version, '0.1.1');
  assert.equal(s.available, false);
  assert.ok(s.checkedAt);
  await github.close();
});

test('Turned off: nothing is asked, nothing is shown, and the choice is kept', async () => {
  const github = await fakeGitHub(() => ({status: 200, body: releases.newer}));
  const file = scratch();
  const u = checker(github, {file});
  await u.check();
  assert.equal(u.status().available, true);
  const off = u.setEnabled(false);
  assert.equal(off.check, false);
  assert.equal(off.latest, null, 'the notice goes with the choice');
  assert.equal(off.available, false);
  assert.deepEqual(await u.check(), {ok: false, reason: 'off'});
  assert.equal(github.seen.length, 1, 'nothing asked after turning it off');
  const timers = [];
  const restarted = checker(github, {file, setTimer: (fn, ms) => { timers.push(ms); return {}; }});
  restarted.start();
  assert.equal(restarted.status().check, false, 'survives a restart');
  assert.equal(timers.length, 0, 'no timer at all while off');
  assert.equal(restarted.setEnabled(true).check, true);
  assert.equal(timers.length, 1, 'turning it on schedules a check');
  await github.close();
});

test('GINGHAM_UPDATE_CHECK=off turns it off for a whole server, and a frame cannot turn it back on', async () => {
  const github = await fakeGitHub(() => ({status: 200, body: releases.newer}));
  const u = createUpdates({current: '0.1.1', file: scratch(), env: {GINGHAM_UPDATE_CHECK: 'off', GINGHAM_UPDATE_URL: github.url}});
  assert.equal(u.status().locked, true);
  assert.equal(u.setEnabled(true).check, false);
  assert.deepEqual(await u.check(), {ok: false, reason: 'off'});
  assert.equal(github.seen.length, 0);
  await github.close();
});

test('The app’s own version is compared too, and each form says how it is updated', async () => {
  const github = await fakeGitHub(() => ({status: 200, body: releases.newer}));
  const u = checker(github, {form: 'container'});
  await u.check();
  assert.equal(u.status('0.1.0').appAvailable, true);
  assert.equal(u.status(NEXT).appAvailable, false);
  assert.equal(u.status('not a version').app, undefined);
  assert.match(u.status().howTo, /docker pull ghcr\.io\/rileysheehan\/gingham:latest/);
  const app = checker(github, {form: 'app'});
  await app.check();
  assert.match(app.status().howTo, /gingham-either\.apk/);
  await github.close();
});

test('A release page elsewhere is not linked; the releases page is', async () => {
  const github = await fakeGitHub(() => ({status: 200, body: {...releases.newer, html_url: 'https://evil.example/phish'}}));
  const u = checker(github);
  await u.check();
  assert.equal(u.status().latest.url, 'https://github.com/rileysheehan/gingham/releases');
  await github.close();
});

// 2026-09-25: the day's check ran at 01:27Z, 0.1.4 was published minutes later, and Settings said "up to date" to a frame
// on 0.1.3 until the next day. Check now asks at once, and still spends GitHub's allowance like the timer does.
test('Check now: asks at once and replaces what Settings knew, then waits a minute; the daily timer counts from it', async () => {
  let answer = releases.same('0.1.1');
  const github = await fakeGitHub(() => ({status: 200, body: answer}));
  let clock = Date.parse('2026-09-25T01:27:00Z');
  const timers = [];
  const u = checker(github, {now: () => clock, setTimer: (fn, ms) => { const t = {fn, ms, unref() {}}; timers.push(t); return t; }, clearTimer: () => {}});
  await u.check();
  assert.equal(u.status().available, false, 'the day’s check: up to date');
  answer = releases.newer;                                   // published just after it
  clock += 2 * 3600000;
  assert.deepEqual(await u.checkNow(), {ok: true, changed: true});
  assert.equal(u.status().available, true, 'seen now, not tomorrow');
  assert.equal(u.status().latest.version, NEXT);
  assert.equal(u.status().checkedAt, clock);
  assert.equal(timers[timers.length - 1].ms, DAY, 'the next daily check is a day after this one');
  // Pressed again, by this frame or another: refused for a minute, saying until when, and GitHub is not asked.
  clock += 20000;
  assert.deepEqual(await u.checkNow(), {ok: false, reason: 'too-soon', retryAt: clock - 20000 + NOW_GAP});
  assert.equal(github.seen.length, 2);
  clock += NOW_GAP;
  assert.equal((await u.checkNow()).ok, true, 'a minute later it asks again');
  assert.equal(github.seen.length, 3);
  await github.close();
});

test('Check now: a rate limit GitHub named is respected, and a check turned off asks nothing', async () => {
  const at = Date.parse('2026-10-01T12:00:00Z');
  let clock = at;
  const github = await fakeGitHub(() => ({status: 429, headers: {'retry-after': '1800'}}));
  const u = checker(github, {now: () => clock});
  assert.deepEqual(await u.checkNow(), {ok: false, reason: 'rate-limited', retryAt: at + 1800000});
  clock += 10 * 60000;
  assert.deepEqual(await u.checkNow(), {ok: false, reason: 'rate-limited', retryAt: at + 1800000}, 'still inside the pause: not asked');
  assert.equal(github.seen.length, 1);
  clock = at + 1800000;
  await u.checkNow();
  assert.equal(github.seen.length, 2, 'asked again once the pause is over');
  u.setEnabled(false);
  clock += 2 * NOW_GAP;
  assert.deepEqual(await u.checkNow(), {ok: false, reason: 'off'});
  assert.equal(github.seen.length, 2);
  const locked = createUpdates({current: '0.1.1', file: scratch(), env: {GINGHAM_UPDATE_CHECK: 'off', GINGHAM_UPDATE_URL: github.url}});
  assert.deepEqual(await locked.checkNow(), {ok: false, reason: 'off'});
  assert.equal(github.seen.length, 2);
  await github.close();
});
