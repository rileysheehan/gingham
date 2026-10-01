// The day line (D-02, DESIGN.md → "Moments of the day"), run headless against the fixtures like test/wall.test.js, with the
// device in London while the household is in Austin, as a Frameo resets itself to.
process.env.TZ = 'Europe/London';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./wall-harness');

test('The day line draws today from 6 AM to midnight in the hairline over TODAY: bars, rings, now, and no words (D-02)', () => {
  const marks = (w, cls) => w.$('dayline').children.filter(el => el.classes.includes(cls));
  const left = el => parseFloat(el.style.left);
  let w = load({now: '2026-09-23T17:40:00'});
  const line = w.$('dayline');
  assert.equal(line.hidden, false);
  assert.equal(line.getAttribute('aria-hidden'), 'true', 'the rows say it in words; the line is for the eye');
  assert.equal(line.textContent, '', 'no labels');
  // Six timed events, the busy one broken; four chores with a time (the 11 PM trash and recycling share a place).
  const bars = marks(w, 'dl-event');
  assert.equal(bars.length, 6);
  assert.deepEqual(bars.filter(b => b.classes.includes('busy')).map(b => Math.round(left(b) * 10) / 10), [22.2], 'Busy, 10 to 11 AM');
  const lunch = bars.find(b => Math.abs(left(b) - 100 / 3) < 0.01);
  assert.ok(lunch, 'noon is a third of the way along');
  assert.equal(lunch.style.getPropertyValue('--rail'), '#b37dcc', 'in its calendar’s colour');
  assert.ok(Math.abs(parseFloat(lunch.style.width) - 100 / 18) < 0.01, 'as long as it lasts: an hour of eighteen');
  const pickup = bars.find(b => Math.abs(left(b) - 17.5 / 18 * 100) < 0.01);
  assert.ok(Math.abs(left(pickup) + parseFloat(pickup.style.width) - 100) < 0.01, 'the 11:30 PM pickup stops at midnight');
  assert.deepEqual(marks(w, 'dl-chore').map(left).map(Math.round), [56, 83, 94, 94], '4 PM piano, 9 PM fridge, 11 PM trash and recycling');
  assert.deepEqual(marks(w, 'dl-tick').map(left).map(Math.round), [33, 67], 'ticks at noon and 6 PM');
  const [dot] = marks(w, 'dl-now');
  assert.ok(Math.abs(left(dot) - 11 / 18 * 100 - 40 / 60 / 18 * 100) < 0.01, '5:40 PM');
  // The rule is heavier behind now, and stops short of the dot and every ring rather than run through them.
  const rules = marks(w, 'dl-rule');
  assert.ok(rules.some(r => r.classes.includes('past')) && rules.some(r => !r.classes.includes('past')));
  rules.forEach(r => {
    const a = left(r), b = a + parseFloat(r.style.width);
    assert.ok(r.classes.includes('past') ? b < left(dot) : a > left(dot), 'past pieces end before now, the rest start after it');
    marks(w, 'dl-chore').concat(dot).forEach(m => assert.ok(!(a < left(m) && left(m) < b), 'no piece runs through a ring or the dot'));
  });
  // A chore checked off fills its ring.
  w = load({now: '2026-09-23T15:40:00'});
  w.$('today-list').children.find(el => w.row(el).title === 'Practice: piano').click();
  assert.ok(marks(w, 'dl-chore')[0].classes.includes('done'));
  // A day with nothing timed keeps the plain hairline, and so does a frame with no calendar yet.
  assert.equal(load({fixture: 'quiet', now: '2026-09-23T09:00:00'}).$('dayline').hidden, true);
  assert.equal(load({fixture: 'offline', now: '2026-09-23T09:00:00'}).$('dayline').hidden, true);
  // Before 6 AM, now sits at the start of the line; the line is drawn again with the clock, never in between.
  assert.equal(left(marks(load({now: '2026-09-23T05:10:00'}), 'dl-now')[0]), 0);
});
