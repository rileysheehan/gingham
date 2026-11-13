// Screen time on the wall's own page (wall-harness.js), answered by the real rewards.js on the fixtures' clock: off until
// someone has it, the ring and its words, a running timer holding the wall, the PIN pad, and the token kept out of storage.
// The device is in London while the household is in Austin, as a Frameo resets itself to.
process.env.TZ = 'Europe/London';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures');
const {createRewards} = require('../rewards');
const {load} = require('./wall-harness');

// What GET /api/rewards answers for a fixture: the real module, in memory, at the fixture's own instant.
function rewardsOf(name, extra = {}) {
  const r = fixtures[name].rewards;
  return {...createRewards({persist: false, initial: r.data, now: () => Date.parse(r.clock || '2026-09-23T17:40:00-05:00'), zone: () => 'America/Chicago'}).read(), pinSet: true, ...extra};
}
const tab = w => w.$('tabs').children.find(b => b.textContent === 'Screen time');
const open = w => { tab(w).click(); w.server.flush(); };
const ring = w => w.$('screen-card').querySelector('.ring-text').textContent;

test('Screen time is nowhere until someone has it, and then a tab with no count', () => {
  let w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': {unit: 'min', day: '2026-09-23', now: Date.now(), people: [], pinSet: false}}});
  assert.equal(tab(w), undefined, 'off: no tab');
  assert.equal(w.$('screen-who').textContent, 'Nobody yet');
  w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen')}});
  assert.ok(tab(w));
  assert.equal(tab(w).querySelector('b'), null, 'minutes left are not work to be done');
  assert.equal(w.$('screen-who').textContent, 'June');
});

test('The ring says what is left in Bricolage and in words, beside the day and its record', () => {
  const w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen')}});
  open(w);
  assert.equal(w.$('view-screen').hidden, false);
  assert.equal(ring(w), '30min left');
  assert.equal(w.$('screen-card').querySelector('.ring').getAttribute('aria-label'), '30 minutes left of 40 today');
  assert.deepEqual(w.$('screen-card').querySelectorAll('.screen-sum div').map(d => d.textContent), ['Daily30 min', 'Earned+15 min', 'Added or taken−5 min', 'Used10 min']);
  assert.deepEqual(w.$('screen-card').querySelectorAll('.screen-row').map(r => r.textContent),
    ['4:10 PMTimer−10 min', '4 PMTaken away−5 min', '3:30 PMEarned for reading+5 min', '3 PMEarned for chores+10 min']);
  assert.equal(w.$('screen-card').querySelector('.screen-go').textContent, 'Start');
  assert.equal(w.$('screen-note').textContent, 'Counts only while the timer is on');
});

test('A day with no time left says so, and Start waits for a grown-up', () => {
  const used = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen-none')}});
  open(used);
  assert.equal(ring(used), '0min left');
  assert.equal(used.$('screen-card').querySelector('.screen-line').textContent, 'No time left today');
  const start = used.$('screen-card').querySelector('.screen-go');
  assert.deepEqual([start.textContent, start.disabled, used.$('screen-card').querySelector('.screen-hint').textContent], ['Start', true, 'A grown-up can add time']);
});

test('A running timer counts down on the frame and holds the wall instead of resting', () => {
  const w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen-running'), '/api/settings': {rest: 'calendar', restAfter: 2}}});
  open(w);
  assert.equal(ring(w), '15:00left');
  w.$('tab-calendar').click();
  assert.equal(w.$('view-screen').hidden, true);
  w.advance(6 * 60000);
  w.every('');
  assert.equal(w.$('view-screen').hidden, false, 'quiet, the wall goes back to the timer, not to the week');
  assert.equal(ring(w), '9:00left', 'counted from the server\'s answer, not the frame\'s clock');
});

test('The PIN unlocks the grown-up’s controls; the token stays in the page and goes only in its header', () => {
  const token = 'T'.repeat(43), sent = [];
  const w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen'), 'POST /api/rewards/unlock': {token, expiresIn: 120}, 'POST /api/rewards/adjust': () => rewardsOf('screen')}});
  const XHR = w.server.XMLHttpRequest.prototype, setHeader = XHR.setRequestHeader;
  XHR.setRequestHeader = function (name, value) { sent.push([this.url, name, value]); return setHeader.call(this, name, value); };
  open(w);
  assert.equal(w.$('screen-card').querySelectorAll('.screen-row .quiet').length, 0, 'locked: nothing to remove');
  w.$('screen-manage').click();
  assert.equal(w.$('manage-eyebrow').textContent, 'Screen time');
  const key = k => w.$('keypad').children.find(b => b.textContent === k);
  for (const d of '2580') key(d).click();
  key('OK').click(); w.server.flush();
  assert.equal(w.$('manage-dialog').hidden, true);
  assert.equal(w.$('screen-manage').textContent, 'Lock');
  assert.ok(w.$('screen-card').querySelector('.screen-manage-panel'));
  assert.equal(w.$('screen-card').querySelectorAll('.screen-row .quiet').length, 4, 'every entry can be removed');
  w.$('screen-card').querySelector('.screen-manage-panel .screen-go').click(); w.server.flush();
  assert.ok(sent.some(([url, name, value]) => url === '/api/rewards/adjust' && name === 'X-Gingham-Manage' && value === token));
  assert.ok(!sent.some(([url]) => url.includes(token)), 'never in an address');
  assert.ok(!JSON.stringify(w.window.localStorage).includes(token) && !w.document.cookie, 'never in storage');
  w.$('tab-calendar').click();
  assert.ok(sent.some(([url, name]) => url === '/api/rewards/lock' && name === 'X-Gingham-Manage'), 'leaving locks it');
  open(w);
  assert.equal(w.$('screen-manage').textContent, 'Manage');
});

test('With no household PIN, the wall says where to set one and offers no keypad', () => {
  const w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen', {pinSet: false})}});
  open(w);
  w.$('screen-manage').click();
  assert.equal(w.$('manage-title').textContent, 'No household PIN yet');
  assert.equal(w.$('manage-note').textContent, 'Set a household PIN on the setup page to manage screen time here.');
  assert.equal(w.$('keypad').hidden, true);
});

test('Out of reach, it shows the balance it had, says from when, and turns its controls off', () => {
  const w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen')}});
  open(w);
  w.server.answers['/api/rewards'] = undefined;
  w.every('loadRewards');
  assert.equal(w.$('screen-note').textContent, 'Can’t reach the frame’s server. Showing the balance from 5:40 PM.');
  assert.equal(ring(w), '30min left');
  assert.equal(w.$('screen-card').querySelector('.screen-go').disabled, true);
});

// The seconds on the ring (MER-2089). The frame's clock is fixed and moved by the test, and so is the server's: a rewards
// module answering as server.js does, so a stop, a start and an undo are the real ones.
const CLOCK = '2026-09-23T17:40:00-05:00';
function serverFor(name) {
  let t = Date.parse(CLOCK);
  const r = createRewards({persist: false, initial: fixtures[name].rewards.data, now: () => t, zone: () => 'America/Chicago'});
  const answer = out => ({...out, pinSet: true});
  let stopped = null;
  return {move: ms => { t += ms; }, answers: {
    '/api/rewards': () => answer(r.read()),
    'POST /api/rewards/start': () => answer(r.start('june', 'test')), 'POST /api/rewards/stop': () => { const out = r.stop('june', 'test'); stopped = out.changed.entry; return answer(out); },
    'POST /api/rewards/resume': () => answer(r.resume('june', stopped))
  }};
}
const card = (w, sel) => w.$('screen-card').querySelector(sel);
const label = w => card(w, '.ring').getAttribute('aria-label');
// The clock's once-a-second timer, a second later on both clocks.
const second = (w, srv, n = 1) => { for (let i = 0; i < n; i++) { w.advance(1000); if (srv) srv.move(1000); w.every(''); } };

test('A running timer reads in minutes and seconds, from 1:04:37 down to 0:42, sized by its length', () => {
  for (const [fixture, text, size] of [['screen-s3000', '30:00', 'n5'], ['screen-s2437', '24:37', 'n5'], ['screen-s0042', '0:42', 'n4'], ['screen-s10437', '1:04:37', 'n7']]) {
    const w = load({now: '2026-09-23T17:40:00', clock: CLOCK, overrides: {'/api/rewards': rewardsOf(fixture)}});
    open(w);
    assert.equal(ring(w), text + 'left', fixture);
    assert.equal(card(w, '.ring-number').className, 'ring-number ' + size, fixture);
  }
  const w = load({now: '2026-09-23T17:40:00', clock: CLOCK, overrides: {'/api/rewards': rewardsOf('screen-s2437')}});
  open(w);
  assert.equal(label(w), '24 minutes left of 40 today', 'the label is the minute, never the second');
});

// Time's up (MER-2089): the server stops the timer at zero, and the page says so, once, with a chime when it can play one.
// Web Audio is a stand-in that records each tone it is asked to play: six tones are one chime.
function audioStub({state = 'running', resume} = {}) {
  const tones = [];
  class Context {
    constructor() { this.state = state; this.currentTime = 0; this.destination = {}; Context.made++; }
    resume() { return resume ? resume(this) : Promise.resolve(); }
    createOscillator() { const o = {type: '', frequency: {value: 0}, connect() {}, start(at) { tones.push([o.frequency.value, at]); }, stop() {}}; return o; }
    createGain() { return {gain: {setValueAtTime() {}, exponentialRampToValueAtTime() {}}, connect() {}}; }
  }
  Context.made = 0; Context.tones = tones; Context.chimes = () => tones.length / 6;
  return Context;
}
const toastText = w => w.$('toast').hidden ? '' : w.$('toast-text').textContent;
const settle = () => new Promise(resolve => setImmediate(resolve));

test('At zero the timer is stopped: time’s up, when it stopped, nothing counted past it, and Start waits for a grown-up', () => {
  const w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen-over')}});
  open(w);
  assert.equal(ring(w), 'Time’s up');
  assert.equal(label(w), 'Time’s up. No time left of 40 today');
  assert.equal(card(w, '.screen-line').textContent, 'Timer stopped at 5:30 PM', 'where the time ran out, not when someone looked');
  const start = card(w, '.screen-go');
  assert.deepEqual([start.textContent, start.disabled, card(w, '.screen-hint').textContent], ['Start', true, 'A grown-up can add time']);
  assert.equal(card(w, '.ring-arc').getAttribute('visibility'), 'hidden', 'the ring is empty, with no dot of a round end');
  assert.deepEqual(w.$('screen-card').querySelectorAll('.screen-sum div').map(d => d.textContent).slice(-1), ['Used40 min'], 'used is the day, not a minute more');
  assert.ok(!/over/.test(w.$('screen-card').textContent), 'no overtime anywhere');
  assert.equal(toastText(w), '', 'ten minutes ago: no chime and no toast');
});

test('Crossing zero here: time’s up at once, one ask of the server, one chime, and nothing counts on', () => {
  const srv = serverFor('screen-s0042'), audio = audioStub();
  let asked = 0;
  const read = srv.answers['/api/rewards'];
  srv.answers['/api/rewards'] = () => { asked++; return read(); };
  const w = load({now: '2026-09-23T17:40:00', clock: CLOCK, audio, overrides: srv.answers});
  open(w);
  const before = asked;
  second(w, srv, 41);
  assert.equal(ring(w), '0:01left');
  assert.equal(audio.chimes(), 0);
  second(w, srv);
  assert.equal(ring(w), 'Time’s up');
  assert.equal(asked - before, 1, 'one ask, for the server’s stop');
  assert.equal(audio.chimes(), 1, 'one chime');
  assert.deepEqual(audio.tones.slice(0, 3).map(t => t[0]), [523.25, 659.25, 783.99], 'three rising tones');
  assert.equal(toastText(w), 'Time’s up for June');
  assert.equal(card(w, '.screen-line').textContent, 'Timer stopped at 5:40 PM');
  assert.equal(card(w, '.screen-go').disabled, true);
  second(w, srv, 90);
  assert.deepEqual([ring(w), asked - before, audio.chimes()], ['Time’s up', 1, 1], 'and stays: no ask, no chime, no count');
  assert.ok(!/over/.test(w.$('screen-card').textContent));
  w.every('loadRewards');
  assert.equal(audio.chimes(), 1, 'the minute’s read of the same stop chimes nothing');
});

test('Loaded within two minutes of time’s up it chimes once; later, never', () => {
  const audio = audioStub();
  const w = load({now: '2026-09-23T17:40:00', clock: CLOCK, audio, overrides: {'/api/rewards': rewardsOf('screen-sover')}});
  assert.equal(audio.chimes(), 1, 'stopped at 5:38:48, read at 5:40');
  open(w);
  assert.equal(ring(w), 'Time’s up');
  w.every('loadRewards'); second(w, null, 5);
  assert.equal(audio.chimes(), 1, 'once');
  const late = audioStub();
  load({now: '2026-09-23T17:40:00', audio: late, overrides: {'/api/rewards': rewardsOf('screen-over')}});
  assert.equal(late.chimes(), 0, 'stopped at 5:30: too long ago to ring for');
});

test('Without sound the timer still stops, and the toast says the frame couldn’t play its chime', async () => {
  // No Web Audio at all.
  let w = load({now: '2026-09-23T17:40:00', clock: CLOCK, overrides: {'/api/rewards': rewardsOf('screen-sover')}});
  open(w);
  assert.equal(toastText(w), 'Time’s up. This frame couldn’t play its chime.');
  assert.equal(ring(w), 'Time’s up');
  // A context the browser keeps suspended, and one whose resume() fails.
  for (const resume of [ctx => Promise.resolve(), () => Promise.reject(Error('not allowed'))]) {
    const audio = audioStub({state: 'suspended', resume});
    w = load({now: '2026-09-23T17:40:00', clock: CLOCK, audio, overrides: {'/api/rewards': rewardsOf('screen-sover')}});
    await settle();
    open(w);
    assert.equal(audio.chimes(), 0);
    assert.equal(toastText(w), 'Time’s up. This frame couldn’t play its chime.');
    assert.equal(card(w, '.screen-go').disabled, true, 'stopped all the same');
  }
  // A context that comes up when resumed plays.
  const audio = audioStub({state: 'suspended', resume: ctx => { ctx.state = 'running'; return Promise.resolve(); }});
  w = load({now: '2026-09-23T17:40:00', clock: CLOCK, audio, overrides: {'/api/rewards': rewardsOf('screen-sover')}});
  await settle();
  assert.equal(audio.chimes(), 1);
  assert.equal(toastText(w), 'Time’s up for June');
});

test('Settings plays the chime on request, once someone has screen time', () => {
  let w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': {unit: 'min', day: '2026-09-23', now: Date.now(), people: [], pinSet: true}}});
  assert.equal(w.$('screen-chime-row').hidden, true, 'nobody has it: nothing to hear');
  const audio = audioStub();
  w = load({now: '2026-09-23T17:40:00', audio, overrides: {'/api/rewards': rewardsOf('screen')}});
  assert.equal(w.$('screen-chime-row').hidden, false);
  assert.equal(w.$('screen-chime').textContent, 'Play the chime');
  w.$('screen-chime').click();
  assert.equal(audio.chimes(), 1);
  assert.equal(toastText(w), '', 'the sound is the answer');
  w = load({now: '2026-09-23T17:40:00', overrides: {'/api/rewards': rewardsOf('screen')}});
  w.$('screen-chime').click();
  assert.equal(toastText(w), 'This frame couldn’t play its chime. Check that its sound is on.');
});

test('A tick changes the ring and its number in place: the same Stop keeps focus, and nothing is announced', () => {
  const w = load({now: '2026-09-23T17:40:00', clock: CLOCK, overrides: {'/api/rewards': rewardsOf('screen-s2437')}});
  open(w);
  const stop = card(w, '.screen-go'), arc = card(w, '.ring-arc'), number = card(w, '.ring-number'), offsets = [arc.getAttribute('stroke-dashoffset')];
  stop.focus();
  for (const text of ['24:36', '24:35', '24:34']) {
    second(w);
    assert.equal(ring(w), text + 'left');
    assert.equal(card(w, '.screen-go'), stop, 'the same button');
    assert.equal(card(w, '.ring-number'), number, 'the same number');
    assert.equal(w.document.activeElement, stop, 'focus stays on Stop');
    offsets.push(arc.getAttribute('stroke-dashoffset'));
  }
  assert.equal(new Set(offsets).size, 4, 'the arc moves every second');
  assert.ok(Number(offsets[1]) > Number(offsets[0]), 'and shrinks');
  assert.equal(label(w), '24 minutes left of 40 today', 'its label waits for the minute');
  assert.equal(w.$('screen-card').querySelectorAll('[aria-live]').length, 0, 'no live region reads seconds');
  second(w, null, 35);
  assert.equal(ring(w), '23:59left');
  assert.equal(label(w), '23 minutes left of 40 today', 'the minute moved: one redraw, one new label');
});

test('Stopped between minutes it keeps the seconds, never rounded up; on a whole minute it is the big minutes', () => {
  let w = load({now: '2026-09-23T17:40:00', clock: CLOCK, overrides: {'/api/rewards': rewardsOf('screen-stop2437')}});
  open(w);
  assert.equal(ring(w), '24:37left');
  assert.equal(label(w), '24 minutes 37 seconds left of 40 today');
  w = load({now: '2026-09-23T17:40:00', clock: CLOCK, overrides: {'/api/rewards': rewardsOf('screen-stop25')}});
  open(w);
  assert.equal(ring(w), '25min left');
  assert.equal(card(w, '.ring-number').className, 'ring-number');
});

test('Stop and start again keep the seconds, and so does undoing a stop', () => {
  const srv = serverFor('screen-s2437'), w = load({now: '2026-09-23T17:40:00', clock: CLOCK, overrides: srv.answers});
  open(w);
  second(w, srv, 3);
  assert.equal(ring(w), '24:34left');
  card(w, '.screen-go').click(); w.server.flush();
  assert.equal(ring(w), '24:34left', 'stopped where it was');
  assert.equal(card(w, '.screen-go').textContent, 'Start');
  second(w, srv, 20);
  assert.equal(ring(w), '24:34left', 'and stays there');
  card(w, '.screen-go').click(); w.server.flush();
  second(w, srv, 2);
  assert.equal(ring(w), '24:32left', 'on again from the same second');
  card(w, '.screen-go').click(); w.server.flush();
  second(w, srv, 5);
  w.$('toast-undo').click(); w.server.flush();
  assert.equal(ring(w), '24:27left', 'an undone stop charges every second since it started');
  second(w, srv);
  assert.equal(ring(w), '24:26left');
});

test('A reload in the middle of a minute shows the same second as the wall that was already on', () => {
  const srv = serverFor('screen-s2437'), before = load({now: '2026-09-23T17:40:00', clock: CLOCK, overrides: srv.answers});
  open(before);
  second(before, srv, 30);
  assert.equal(ring(before), '24:07left');
  const after = load({now: '2026-09-23T17:40:30', clock: '2026-09-23T17:40:30-05:00', overrides: srv.answers});
  open(after);
  assert.equal(ring(after), ring(before));
  second(before, srv); second(after);
  assert.equal(ring(after), '24:06left');
  assert.equal(ring(before), '24:06left');
});
