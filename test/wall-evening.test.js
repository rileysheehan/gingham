// The evening hands over to tomorrow (D-01, DESIGN.md → "Moments of the day"), run headless against the fixtures like test/wall.test.js, with the
// device in London while the household is in Austin, as a Frameo resets itself to.
process.env.TZ = 'Europe/London';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./wall-harness');

test('From sunset, once nothing timed is left today, Tomorrow carries its forecast and its first timed thing leads (D-01)', () => {
  const tomorrow = w => w.$('tomorrow-list').children.filter(el => !el.classes.includes('more')).map(w.row);
  // 6:50 PM: soccer is over and the trash is late, but the sun is up (7 PM, the day a review clock gets), so nothing changes.
  let w = load({fixture: 'evening', now: '2026-09-23T18:50:00'});
  assert.equal(w.$('tomorrow').hidden, false);
  assert.equal(w.$('tomorrow-wx').hidden, true);
  assert.deepEqual(tomorrow(w).map(r => r.title).slice(0, 2), ['Priya’s birthday', 'June to school'], 'all-day first, as on any day');
  assert.ok(!tomorrow(w).some(r => r.classes.includes('next')));
  // 8:40 PM: the evening. The forecast says rain, and school at 7:45 leads with the next row's time.
  w = load({fixture: 'evening', now: '2026-09-23T20:40:00'});
  const wx = w.$('tomorrow-wx');
  assert.equal(wx.hidden, false);
  assert.deepEqual(wx.children.filter(el => el.tagName !== 'SVG').map(el => el.textContent), ['95°', '71° · 70% rain']);
  assert.equal(wx.getAttribute('aria-label'), 'Rain, high 95, low 71, 70 percent chance of rain');
  const rows = tomorrow(w);
  assert.equal(rows[0].title, 'June to school');
  assert.equal(rows[0].meta, '7:45 AM');
  assert.ok(rows[0].classes.includes('next'), 'the first timed row takes the next treatment');
  assert.deepEqual(rows.slice(1).map(r => r.title), ['Priya’s birthday', 'Design review', 'Pack: soccer bag'], 'the rest keep their order and their size');
  assert.ok(!rows.slice(1).some(r => r.classes.includes('next')));
  // A tomorrow with nothing timed still gets its forecast, and nothing leads.
  w = load({fixture: 'quiet', now: '2026-09-23T20:40:00'});
  assert.equal(w.$('tomorrow-wx').hidden, false);
  assert.deepEqual(tomorrow(w).map(r => r.title), ['Priya’s birthday']);
  assert.ok(!tomorrow(w).some(r => r.classes.includes('next')));
  // While today still has a next thing (the 9 PM fridge, the 11 PM trash), the evening waits.
  w = load({now: '2026-09-23T20:40:00'});
  assert.equal(w.$('tomorrow-wx').hidden, true);
  // The real sunset, on the device's own clock: 7:29 PM in the fixture's forecast. At 7:20 PM it is still today's panel;
  // at 7:35 PM it is tomorrow's.
  assert.equal(load({fixture: 'evening', clock: '2026-09-24T00:20:00Z'}).$('tomorrow-wx').hidden, true);
  assert.equal(load({fixture: 'evening', clock: '2026-09-24T00:35:00Z'}).$('tomorrow-wx').hidden, false);
});
