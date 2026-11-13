// Screen time (rewards.js and its routes in server.js): the arithmetic of a day, where a day ends, a timer that outlives
// a reload, a restart or midnight, and the PIN guard at the server. The PIN in these tests is made up for each run.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {createRewards, createManageTokens, UNDO_MS} = require('../rewards');
const {createGrants} = require('../grants');
const {startServer, makeData, writeHousehold} = require('./server-harness');

const CHICAGO = 'America/Chicago';
const at = text => Date.parse(text);
// A household's rewards on a clock the test moves.
function clocked(start, options = {}) {
  const clock = {t: at(start)};
  const rewards = createRewards({persist: false, now: () => clock.t, zone: () => CHICAGO, ...options});
  return {rewards, clock, advance: minutes => { clock.t += minutes * 60000; }};
}
const made = view => view.changed.id;
const june = view => view.people[0];
const madePin = () => String(crypto.randomInt(10000000, 100000000));

test('A day is its allowance, plus what was earned and added, less what was taken and used', () => {
  const {rewards, advance} = clocked('2026-09-23T15:00:00-05:00');
  const id = made(rewards.person({name: 'June', allowance: 30}));
  let day = june(rewards.read());
  assert.deepEqual([day.allowance, day.earned, day.adjusted, day.used, day.left], [30, 0, 0, 0, 1800]);
  rewards.adjust(id, 10, 'chores', 'g');
  rewards.adjust(id, 5, null, 'g');
  rewards.adjust(id, -5, null, 'g');
  rewards.start(id, 'g'); advance(12); rewards.stop(id, 'g');
  day = june(rewards.read());
  assert.deepEqual([day.earned, day.adjusted, day.used, day.left], [10, 0, 720, (30 + 10) * 60 - 720]);
  assert.deepEqual(day.entries.map(e => e.kind), ['timer', 'adjust', 'adjust', 'earn'], 'newest first');
  assert.equal(day.entries[0].seconds, 720);
  // What a change may be.
  for (const [minutes, reason] of [[0, null], [241, null], [1.5, null], [-5, 'chores'], [5, 'bribery'], ['5', null]])
    assert.throws(() => rewards.adjust(id, minutes, reason, 'g'), e => e.status === 400, JSON.stringify([minutes, reason]));
  assert.throws(() => rewards.adjust('nobody', 5, null, 'g'), e => e.status === 404);
  assert.throws(() => rewards.person({name: '  '}), e => e.status === 400);
  assert.throws(() => rewards.person({id, allowance: 33}), e => e.status === 400, 'allowances go in fives');
});

test('The timer charges by the second, starts only with time left, and starts once', () => {
  const {rewards, clock, advance} = clocked('2026-09-23T16:00:00-05:00');
  const id = made(rewards.person({name: 'June', allowance: 5}));
  rewards.start(id, 'g');
  const since = june(rewards.read()).timer.since;
  advance(2);
  assert.equal(rewards.start(id, 'g').changed, undefined, 'a second start while one runs changes nothing');
  assert.equal(june(rewards.read()).timer.since, since);
  advance(2); clock.t += 30000;
  rewards.stop(id, 'g');
  let day = june(rewards.read());
  assert.deepEqual([day.timer, day.used, day.left], [null, 270, 30]);
  rewards.start(id, 'g'); clock.t += 30000;
  rewards.stop(id, 'g');
  day = june(rewards.read());
  assert.deepEqual([day.used, day.left], [300, 0]);
  assert.throws(() => rewards.start(id, 'g'), e => e.status === 409 && /No time left/.test(e.message));
  assert.equal(rewards.stop(id, 'g').changed, undefined, 'stopping a stopped timer changes nothing');
});

// Time's up (MER-2089): once the time runs out the timer stops, and more time is added behind the PIN. The server stops
// it, charged exactly to zero, whoever is or is not looking.
const timeUps = day => day.entries.filter(e => e.timeUp);
test('A timer stops by itself when time runs out, charged exactly to zero, even with every frame away', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-')), 'rewards.json');
  const clock = {t: at('2026-09-23T17:00:00-05:00')}, open = () => createRewards({file, now: () => clock.t, zone: () => CHICAGO});
  const id = made(open().person({name: 'June', allowance: 30}));
  open().start(id, 'g');
  clock.t += 20 * 60000;
  assert.deepEqual([june(open().read()).left, june(open().read()).used], [600, 1200], 'still running with ten minutes left');
  clock.t += 20 * 60000;                       // nobody looked between 17:20 and 17:40
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).people[0].days['2026-09-23'].timer, 'on file it still runs until someone reads it');
  const day = june(open().read());
  assert.deepEqual([day.timer, day.used, day.left], [null, 1800, 0], 'no minute past zero is counted');
  assert.deepEqual(timeUps(day).map(e => [e.seconds, e.at, e.from]), [[1800, at('2026-09-23T17:30:00-05:00'), at('2026-09-23T17:00:00-05:00')]]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).people[0].days['2026-09-23'];
  assert.deepEqual([saved.timer, saved.entries.length, saved.entries[0].by], [null, 1, 'time-up'], 'one entry, written once');
  clock.t += 60000; open().read();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).people[0].days['2026-09-23'].entries.length, 1, 'a later read adds nothing');
  // Mid-timer, the moment before anything is written, the day still never goes below zero.
  const {rewards, clock: c2} = clocked('2026-09-23T17:00:00-05:00');
  const pid = made(rewards.person({name: 'Theo', allowance: 5}));
  rewards.start(pid, 'g'); c2.t += 9 * 60000;
  assert.equal(june(rewards.read()).left, 0);
});

test('Stop just before zero charges what ran; just after, time’s up already stopped it, and two stops make one entry', () => {
  let {rewards, clock} = clocked('2026-09-23T17:00:00-05:00');
  let id = made(rewards.person({name: 'June', allowance: 5}));
  rewards.start(id, 'g'); clock.t += 299000;
  rewards.stop(id, 'g');
  let day = june(rewards.read());
  assert.deepEqual([day.used, day.left, timeUps(day).length], [299, 1, 0], 'a second before zero: a stop like any other');
  ({rewards, clock} = clocked('2026-09-23T17:00:00-05:00'));
  id = made(rewards.person({name: 'June', allowance: 5}));
  rewards.start(id, 'g'); clock.t += 301000;
  const first = rewards.stop(id, 'g'), second = rewards.stop(id, 'g');
  assert.deepEqual([first.changed, second.changed], [undefined, undefined], 'a second after zero, Stop finds it stopped');
  day = june(rewards.read());
  assert.deepEqual([day.used, day.left, day.entries.length, timeUps(day)[0].seconds], [300, 0, 1, 300]);
  // Two frames stopping together, before zero: one entry.
  ({rewards, clock} = clocked('2026-09-23T17:00:00-05:00'));
  id = made(rewards.person({name: 'June', allowance: 5}));
  rewards.start(id, 'g'); clock.t += 120000;
  assert.equal(rewards.stop(id, 'a').changed.kind, 'stop');
  assert.equal(rewards.stop(id, 'b').changed, undefined);
  assert.equal(june(rewards.read()).entries.length, 1);
});

test('Time added while it runs moves its end later; time taken away brings it earlier, or stops it now', () => {
  let {rewards, clock} = clocked('2026-09-23T17:00:00-05:00');
  let id = made(rewards.person({name: 'June', allowance: 10}));
  rewards.start(id, 'g'); clock.t += 5 * 60000;
  rewards.adjust(id, 10, 'chores', 'g');
  clock.t += 10 * 60000;
  assert.deepEqual([june(rewards.read()).timer !== null, june(rewards.read()).left], [true, 300], 'it runs on into the added time');
  clock.t += 10 * 60000;
  let day = june(rewards.read());
  assert.deepEqual([day.timer, day.used, timeUps(day)[0].at], [null, 1200, at('2026-09-23T17:20:00-05:00')]);
  // Taken away, still with time left: it stops at the new, earlier end.
  ({rewards, clock} = clocked('2026-09-23T17:00:00-05:00'));
  id = made(rewards.person({name: 'June', allowance: 30}));
  rewards.start(id, 'g'); clock.t += 5 * 60000;
  rewards.adjust(id, -15, null, 'g');
  clock.t += 20 * 60000;
  day = june(rewards.read());
  assert.deepEqual([day.used, day.left, timeUps(day)[0].at], [900, 0, at('2026-09-23T17:15:00-05:00')]);
  // Taken away past what is left: it stops at once, charged every second it ran, and the day is short by the rest.
  ({rewards, clock} = clocked('2026-09-23T17:00:00-05:00'));
  id = made(rewards.person({name: 'June', allowance: 10}));
  rewards.start(id, 'g'); clock.t += 5 * 60000;
  const view = rewards.adjust(id, -10, null, 'g');
  day = june(view);
  assert.deepEqual([day.timer, day.used, day.left, timeUps(day)[0].at], [null, 300, -300, at('2026-09-23T17:05:00-05:00')]);
  assert.throws(() => rewards.start(id, 'g'), e => e.status === 409);
});

test('Midnight before zero stops it at midnight; an undone stop never resumes past zero; old days stay as they are', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-')), 'rewards.json');
    const clock = {t: at('2026-09-23T23:50:00-05:00')}, kept = createRewards({file, now: () => clock.t, zone: () => CHICAGO});
    const id = made(kept.person({name: 'June', allowance: 30}));
    kept.start(id, 'g'); clock.t += 60 * 60000;
    const view = kept.read();
    assert.equal(view.day, '2026-09-24');
    assert.deepEqual([june(view).timer, june(view).left], [null, 1800]);
    const before = JSON.parse(fs.readFileSync(file, 'utf8')).people[0].days['2026-09-23'].entries;
    assert.deepEqual(before.map(e => [e.seconds, e.by]), [[600, 'midnight']], 'ten minutes, to midnight, with twenty still left');
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
  // A stop five seconds before zero, undone ten seconds later, would run past zero: it stays stopped.
  let {rewards, clock} = clocked('2026-09-23T17:00:00-05:00');
  let id = made(rewards.person({name: 'June', allowance: 5}));
  rewards.start(id, 'g'); clock.t += 295000;
  const stopped = rewards.stop(id, 'g').changed.entry;
  clock.t += 10000;
  assert.throws(() => rewards.resume(id, stopped), e => e.status === 409 && /Time’s up/.test(e.message));
  assert.deepEqual([june(rewards.read()).timer, june(rewards.read()).used], [null, 295], 'and nothing is charged past the stop');
  // The entry time's up made cannot be undone into a running timer.
  ({rewards, clock} = clocked('2026-09-23T17:00:00-05:00'));
  id = made(rewards.person({name: 'June', allowance: 5}));
  rewards.start(id, 'g'); clock.t += 302000;
  const up = timeUps(june(rewards.read()))[0];
  assert.throws(() => rewards.resume(id, up.id), e => e.status === 409 && /A grown-up can add time/.test(e.message));
  // A day the old build let run past its total keeps its record: nothing rewrites it.
  const over = {people: [{id: 'june', name: 'June', on: true, allowance: 30, days: {'2026-09-23': {allowance: 30, timer: null,
    entries: [{id: 'old1', at: '2026-09-23T23:11:51.000Z', kind: 'timer', seconds: 3054, from: '2026-09-23T22:20:57.000Z', by: 'f'}]}}}]};
  const kept = createRewards({persist: false, initial: over, now: () => at('2026-09-23T19:00:00-05:00'), zone: () => CHICAGO});
  const day = june(kept.read());
  assert.deepEqual([day.used, day.left, day.entries.map(e => [e.id, e.seconds, !!e.timeUp])], [3054, 1800 - 3054, [['old1', 3054, false]]]);
});

test('A day starts again at house midnight, and a timer running across it is charged to the day it ran in', () => {
  // The process runs in London (as a container in UTC would), the household in Chicago.
  const tz = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    const {rewards, advance} = clocked('2026-09-23T23:00:00-05:00');
    const id = made(rewards.person({name: 'June', allowance: 30}));
    rewards.adjust(id, 15, 'reading', 'g');
    advance(40); rewards.start(id, 'g');
    let view = rewards.read();
    assert.equal(view.day, '2026-09-23', 'London is already on Thursday; the household is not');
    advance(30);   // 12:10 AM in Chicago
    view = rewards.read();
    assert.equal(view.day, '2026-09-24');
    assert.deepEqual([june(view).allowance, june(view).earned, june(view).used, june(view).left, june(view).timer], [30, 0, 0, 1800, null], 'nothing carries over, and no timer runs into the new day');
    // Yesterday's record, on file: the timer stopped at midnight, twenty minutes after it started.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-')), 'rewards.json');
    const clock = {t: at('2026-09-23T23:40:00-05:00')};
    const kept = createRewards({file, now: () => clock.t, zone: () => CHICAGO});
    const pid = made(kept.person({name: 'Theo'}));
    kept.start(pid, 'g');
    clock.t = at('2026-09-24T00:10:00-05:00');
    kept.read();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).people[0].days;
    assert.equal(saved['2026-09-23'].timer, null);
    assert.deepEqual(saved['2026-09-23'].entries.map(e => [e.kind, e.seconds, e.at]), [['timer', 1200, '2026-09-24T05:00:00.000Z']]);
    assert.ok(!saved['2026-09-24'], 'a plain read starts no day on file');
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});

test('A running timer survives a reload or a restart, since its start is on file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-')), 'rewards.json');
  const clock = {t: at('2026-09-23T17:00:00-05:00')}, open = () => createRewards({file, now: () => clock.t, zone: () => CHICAGO});
  const id = made(open().person({name: 'June'}));
  open().start(id, 'g');
  clock.t += 25 * 60000;
  const day = june(open().read());
  assert.equal(day.timer.since, at('2026-09-23T17:00:00-05:00'));
  assert.equal(day.left, 300);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('Undo: a start or a stop is taken back for a few seconds, and an entry is removed and put back, all on the record', () => {
  const {rewards, clock, advance} = clocked('2026-09-23T15:00:00-05:00');
  const id = made(rewards.person({name: 'June'}));
  rewards.start(id, 'g'); clock.t += 5000;
  rewards.cancelStart(id);
  assert.deepEqual([june(rewards.read()).timer, june(rewards.read()).entries.length], [null, 0], 'a start undone at once leaves nothing');
  rewards.start(id, 'g'); clock.t += UNDO_MS + 1000;
  assert.throws(() => rewards.cancelStart(id), e => e.status === 409, 'later, it is a stop like any other');
  advance(10);
  const stop = rewards.stop(id, 'g').changed.entry;
  clock.t += 3000;
  rewards.resume(id, stop);
  let day = june(rewards.read());
  assert.ok(day.timer, 'the timer carries on');
  assert.equal(day.used, UNDO_MS / 1000 + 1 + 600 + 3, 'every second since it started is still charged');
  rewards.stop(id, 'g');
  const earned = rewards.adjust(id, 10, 'chores', 'g').changed.entry;
  rewards.remove(id, earned, 'g');
  day = june(rewards.read());
  assert.equal(day.earned, 0);
  assert.ok(day.entries.find(e => e.id === earned).removed, 'the removed entry stays in the record, marked');
  assert.throws(() => rewards.remove(id, earned, 'g'), e => e.status === 409);
  rewards.restore(id, earned, 'g');
  day = june(rewards.read());
  assert.equal(day.earned, 10);
  assert.ok(!day.entries.find(e => e.id === earned).removed);
  assert.throws(() => rewards.remove(id, 'nothing', 'g'), e => e.status === 404);
});

test('A new allowance starts tomorrow; turning someone off stops their timer and keeps their record', () => {
  const {rewards, advance} = clocked('2026-09-23T15:00:00-05:00');
  const id = made(rewards.person({name: 'June', allowance: 30}));
  rewards.person({id, allowance: 45});
  let day = june(rewards.read());
  assert.deepEqual([day.allowance, day.nextAllowance], [30, 45]);
  rewards.start(id, 'g'); advance(5);
  rewards.person({id, on: false});
  day = june(rewards.read());
  assert.deepEqual([day.on, day.timer, day.used], [false, null, 300]);
  assert.throws(() => rewards.start(id, 'g'), e => e.status === 404, 'off is off');
  advance(24 * 60);
  rewards.person({id, on: true});
  assert.equal(june(rewards.read()).allowance, 45);
});

test('A manage token is good for two idle minutes, for one frame of one household, until it is locked', () => {
  const clock = {t: 0}, tokens = createManageTokens({now: () => clock.t});
  const token = tokens.issue('alpha', 'frame-a');
  assert.ok(tokens.check(token, 'alpha', 'frame-a'));
  assert.ok(!tokens.check(token, 'alpha', 'frame-b'), 'another frame');
  assert.ok(!tokens.check(token, 'beta', 'frame-a'), 'another household');
  clock.t += 110000; assert.ok(tokens.check(token, 'alpha', 'frame-a'), 'a use renews it');
  clock.t += 110000; assert.ok(tokens.check(token, 'alpha', 'frame-a'));
  clock.t += 121000; assert.ok(!tokens.check(token, 'alpha', 'frame-a'), 'two quiet minutes and it is gone');
  const second = tokens.issue('alpha', 'frame-a');
  tokens.revoke(second);
  assert.ok(!tokens.check(second, 'alpha', 'frame-a'), 'Lock');
  for (const forged of ['', 'x', 'x'.repeat(43), null, 42]) assert.ok(!tokens.check(forged, 'alpha', 'frame-a'));
});

// The server: what a frame may do without the PIN, what it may do with it, and what nobody may do.
test('The server guards every change of time behind the household PIN, shares its lockout, and never repeats the PIN', async () => {
  const data = makeData('frame-rewards-');
  for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(writeHousehold(data, id, {name: id}), 'credentials.json'), '{}');
  fs.writeFileSync(path.join(data, 'households', 'alpha', 'settings.json'), JSON.stringify({rest: 'calendar'}));
  const grants = createGrants({file: path.join(data, 'grants.json')});
  const frameA = grants.add({scope: 'frame', household: 'alpha', label: 'Kitchen'}).secret, frameA2 = grants.add({scope: 'frame', household: 'alpha', label: 'Hall'}).secret;
  const frameB = grants.add({scope: 'frame', household: 'beta', label: 'Beta'}).secret, owner = grants.add({scope: 'owner', household: 'alpha', label: 'Phone'}).secret;
  const pin = madePin();
  const s = await startServer({data, env: {FRAME_AUTH: 'required', TZ: 'Europe/London'}});
  const seen = [];
  const call = async (pathname, {as = frameA, body, token, method = body === undefined && !token ? 'GET' : 'POST', header = true} = {}) => {
    const response = await fetch(s.url + pathname, {method, headers: {cookie: 'frame=' + as, ...(header ? {'x-gingham': '1'} : {}), ...(token ? {'x-gingham-manage': token} : {})}, ...(method === 'POST' ? {body: JSON.stringify(body || {})} : {})});
    const text = await response.text();
    // Every answer but the one that hands the token over, which is the token's only way out.
    if (pathname !== '/api/rewards/unlock' || response.status !== 200) seen.push(text);
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return {status: response.status, json};
  };
  try {
    const home = path.join(data, 'households', 'alpha');
    // An older household: nothing about it changes, and no file appears for reading it.
    const before = fs.readdirSync(home).sort();
    let got = await call('/api/rewards');
    assert.deepEqual([got.status, got.json.people, got.json.pinSet, got.json.unit], [200, [], false, 'min']);
    assert.equal(got.json.day, new Intl.DateTimeFormat('en-CA', {timeZone: CHICAGO}).format(new Date()), 'the household\'s day, not the server\'s zone');
    assert.deepEqual(fs.readdirSync(home).sort(), before);
    assert.equal((await call('/api/settings')).json.rest, 'calendar');

    // No PIN yet: the wall says where to set one, and no PIN opens anything.
    got = await call('/api/rewards/unlock', {body: {pin: '1234'}});
    assert.deepEqual([got.status, got.json.error], [409, 'Set a household PIN on the setup page to manage screen time here.']);
    assert.equal((await call('/api/setup/pin', {as: owner, body: {pin}})).status, 200);
    const files = () => Object.fromEntries(fs.readdirSync(home).filter(f => f !== 'rewards.json' && f !== 'cache').map(f => [f, fs.readFileSync(path.join(home, f))]));
    const untouched = files();

    // Without a token, nothing that changes time or who has it.
    for (const action of ['adjust', 'remove', 'restore', 'person']) {
      got = await call('/api/rewards/' + action, {body: {name: 'June', person: 'x', minutes: 10}});
      assert.deepEqual([got.status, got.json.locked], [403, true], action);
    }
    assert.equal((await call('/api/rewards/person', {body: {name: 'June'}, token: 'x'.repeat(43)})).status, 403, 'a made-up token');
    assert.equal((await call('/api/rewards/unlock', {body: {pin}, header: false})).status, 405, 'only from our pages');
    assert.equal((await call('/api/rewards/unlock', {body: {pin}, as: 'nobody'.repeat(5)})).status, 401, 'only a paired frame');

    // The PIN opens it for this frame.
    got = await call('/api/rewards/unlock', {body: {pin}});
    assert.equal(got.status, 200);
    const token = got.json.token;
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(got.json.expiresIn, 120);
    got = await call('/api/rewards/person', {body: {name: 'June', allowance: 30}, token});
    assert.equal(got.status, 200);
    const june = got.json.people[0].id;
    got = await call('/api/rewards/adjust', {body: {person: june, minutes: 10, reason: 'chores'}, token});
    assert.equal(got.json.people[0].left, 2400);
    const earned = got.json.changed.entry;
    assert.equal((await call('/api/rewards/adjust', {body: {person: june, minutes: 10}, token, as: frameA2})).status, 403, 'another frame cannot use this one\'s token');
    assert.equal((await call('/api/rewards/adjust', {body: {person: june, minutes: 10}, token, as: frameB})).status, 403, 'nor another household');
    assert.equal((await call('/api/rewards', {as: frameB})).json.people.length, 0, 'beta sees none of alpha\'s');

    // The timer needs a paired frame of the household and nothing more.
    got = await call('/api/rewards/start', {body: {person: june}, as: frameA2});
    assert.ok(got.json.people[0].timer);
    assert.equal((await call('/api/rewards/stop', {body: {person: june}, as: frameB})).status, 404, 'beta has no such person');
    got = await call('/api/rewards/stop', {body: {person: june}, as: frameA2});
    assert.equal(got.json.people[0].entries[0].kind, 'timer');
    got = await call('/api/rewards/remove', {body: {person: june, entry: earned}, token});
    assert.equal(got.json.people[0].earned, 0);

    // Lock: the token is gone.
    assert.equal((await call('/api/rewards/lock', {body: {}, token})).status, 200);
    assert.equal((await call('/api/rewards/restore', {body: {person: june, entry: earned}, token})).status, 403);

    // Only rewards.json changed in the household's folder.
    assert.deepEqual(files(), untouched, 'every other household file is byte for byte as it was');
    assert.ok(!fs.existsSync(path.join(data, 'households', 'beta', 'rewards.json')));

    // Wrong PINs are one count with the phone's way in: three here and two there, and both doors are shut, even to the PIN.
    for (let i = 0; i < 3; i++) assert.equal((await call('/api/rewards/unlock', {body: {pin: '0000'}})).status, 403);
    for (let i = 0; i < 2; i++) assert.equal((await call('/api/owner-code', {body: {pin: '0000'}})).status, 403);
    assert.equal((await call('/api/rewards/unlock', {body: {pin}})).status, 429);
    assert.equal((await call('/api/owner-code', {body: {pin}})).status, 429);
    assert.equal((await call('/api/rewards/unlock', {body: {pin}, as: frameB})).status, 409, 'another household keeps its own count');

    // The PIN and the token appear in no answer, no file and no log.
    const everything = [...seen, s.output()];
    (function walk(dir) { for (const e of fs.readdirSync(dir, {withFileTypes: true})) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else everything.push(fs.readFileSync(f, 'utf8')); } })(data);
    for (const secret of [pin, token]) assert.ok(!everything.some(text => text.includes(secret)), 'never written or sent back');
  } finally { await s.stop(); }
});

test('A restart keeps a running timer, and forgets every manage token', async () => {
  const data = makeData('frame-rewards-restart-');
  fs.writeFileSync(path.join(writeHousehold(data, 'home'), 'credentials.json'), '{}');
  const grants = createGrants({file: path.join(data, 'grants.json')});
  const frame = grants.add({scope: 'frame', household: 'home', label: 'Kitchen'}).secret, owner = grants.add({scope: 'owner', household: 'home', label: 'Phone'}).secret;
  const pin = madePin();
  const post = (s, pathname, body, extra = {}) => fetch(s.url + pathname, {method: 'POST', headers: {cookie: 'frame=' + (extra.as || frame), 'x-gingham': '1', ...(extra.token ? {'x-gingham-manage': extra.token} : {})}, body: JSON.stringify(body)}).then(async r => ({status: r.status, json: await r.json()}));
  let s = await startServer({data, env: {FRAME_AUTH: 'required'}});
  let token, june, since;
  try {
    await post(s, '/api/setup/pin', {pin}, {as: owner});
    token = (await post(s, '/api/rewards/unlock', {pin})).json.token;
    june = (await post(s, '/api/rewards/person', {name: 'June'}, {token})).json.people[0].id;
    since = (await post(s, '/api/rewards/start', {person: june})).json.people[0].timer.since;
  } catch (e) { await s.stop(); throw e; }
  s.server.kill(); await once(s.server, 'exit');
  s = await startServer({data, env: {FRAME_AUTH: 'required'}});
  try {
    const view = await (await fetch(s.url + '/api/rewards', {headers: {cookie: 'frame=' + frame}})).json();
    assert.equal(view.people[0].timer.since, since);
    assert.equal((await post(s, '/api/rewards/adjust', {person: june, minutes: 5}, {token})).status, 403, 'the old token died with the old process');
  } finally { await s.stop(); }
});
