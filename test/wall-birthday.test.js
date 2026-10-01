// A birthday gets a candle (D-11, DESIGN.md → "Moments of the day"), run headless against the fixtures like test/wall.test.js, with the
// device in London while the household is in Austin, as a Frameo resets itself to.
process.env.TZ = 'Europe/London';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./wall-harness');

test('An all-day birthday gets a candle before its title in Today, the week, Later and the agenda; the match is a whole word (D-11)', () => {
  const lit = el => !!el.querySelector('.candle');
  const titled = (box, text) => box.querySelectorAll('.item').find(el => (el.querySelector('.item-title') || el).textContent === text);
  // In the week (Thursday's column), with the candle first in the title, in the calendar's colour from its rail.
  let w = load({fixture: 'evening', now: '2026-09-23T20:40:00'});
  const thursday = w.$('strip').children[0], birthday = titled(thursday, 'Priya’s birthday');
  assert.ok(lit(birthday));
  assert.equal(birthday.querySelector('.item-title').firstChild.classes[0], 'candle', 'before the title');
  assert.equal(birthday.style.getPropertyValue('--rail'), '#4793e0');
  assert.equal(birthday.querySelector('.candle').getAttribute('aria-hidden'), 'true', 'the title already says it');
  assert.ok(!lit(titled(thursday, 'June to school')));
  // In Tomorrow on the sky, and in Later, where it takes the calendar's colour itself.
  assert.ok(lit(titled(w.$('tomorrow-list'), 'Priya’s birthday')));
  const rosa = w.$('later-rows').children.find(r => r.textContent.includes('Grandma Rosa’s birthday'));
  assert.equal(rosa.querySelector('.candle').style.color, '#b37dcc');
  // In Today, and in the agenda.
  w = load({fixture: 'quiet', now: '2026-09-24T09:00:00'});
  assert.ok(lit(titled(w.$('today-list'), 'Priya’s birthday')));
  w = load({fixture: 'quiet', now: '2026-09-23T09:00:00', overrides: {'/api/settings': {rest: 'calendar', restAfter: 5, mornings: 0, photoEvery: 60, appearance: 'auto', screen: 'auto', calendarView: 'agenda'}}});
  assert.ok(lit(titled(w.$('agenda'), 'Priya’s birthday')));
  // Which titles: the word, in either number and any case, on an all-day event only.
  const calendars = [{id: 'mara', name: 'Mara', color: '#4793e0'}];
  const day = (title, extra = {}) => ({id: title, uid: title, title, calendar: 'mara', start: '2026-09-24', end: '2026-09-25', allDay: true, location: '', ...extra});
  const events = [day('Priya’s birthday'), day("Sam's Birthday"), day('Twins’ birthdays'), day('BIRTHDAY'), day('birthdayparty'), day('Unbirthday tea'), day('Busy', {busy: true, private: true}),
    {id: 'p', uid: 'p', title: 'June’s birthday party', calendar: 'mara', start: '2026-09-24T16:00:00-05:00', end: '2026-09-24T18:00:00-05:00', allDay: false, location: ''}];
  w = load({fixture: 'quiet', now: '2026-09-23T09:00:00', overrides: {'/api/calendar': {mode: 'live', calendars, events, from: '2026-09-23', to: '2026-10-21', updatedAt: '2026-09-23T22:39:00.000Z'}}});
  const candles = w.$('strip').children[0].querySelectorAll('.item').filter(lit).map(el => w.row(el).title);
  assert.deepEqual(candles, ['Priya’s birthday', 'Sam’s Birthday', 'Twins’ birthdays', 'BIRTHDAY'], 'not "birthdayparty", "Unbirthday", busy time, or a party at 4 PM');
});
