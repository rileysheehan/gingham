// Dinner, from a chore (D-07, DESIGN.md → "Moments of the day"), run headless against the fixtures like test/wall.test.js, with the
// device in London while the household is in Austin, as a Frameo resets itself to.
process.env.TZ = 'Europe/London';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./wall-harness');

test('A chore called "Dinner: …" due today leaves Today\'s rows for one line above the countdown, and a tap checks it off (D-07)', () => {
  // The packed day with "Dinner: tacos al pastor" due today, and the fixtures' countdown.
  const counting = {'/api/household': {name: 'Household', timezone: 'America/Chicago', place: 'Austin', countdowns: [{name: 'the pumpkin patch', date: '2026-09-26', word: 'sleeps'}]}};
  let w = load({fixture: 'dinner', now: '2026-09-23T12:30:00', overrides: counting});
  const line = w.$('dinner');
  assert.equal(line.hidden, false);
  assert.deepEqual(line.children.map(el => el.textContent), ['Dinner', 'tacos al pastor']);
  assert.equal(w.$('countdown').hidden, false, 'the countdown stays, under it');
  assert.equal(w.$('countdown').textContent, '3 sleeps until the pumpkin patch');
  assert.ok(!w.today().some(r => /Dinner/.test(r.title)), 'not a row');
  w.more().click();
  assert.ok(w.sheet().some(r => r.title === 'Dinner: tacos al pastor'), 'the day sheet still has everything on the day');
  w.$('close-day').click();
  // A tap checks it off with the usual undo; a second tap is the undo.
  line.click();
  assert.ok(line.classes.includes('done'));
  assert.equal(line.getAttribute('aria-checked'), 'true');
  assert.match(w.$('toast-text').textContent, /Checked off “Dinner: tacos al pastor”/);
  assert.equal(w.$('toast-undo').hidden, false);
  line.click();
  assert.ok(!line.classes.includes('done'));
  assert.equal(w.$('toast').hidden, true);
  // Only "Dinner:" at the start, in any case, with something after it, and due today. The first is the line; any other
  // dinner due today stays a row; yesterday's is an overdue chore like any other, and tomorrow's is tomorrow's row.
  const tasks = titles => ({projects: ['Chores'], people: {}, lists: [{name: 'Chores', icon: 'repeat', person: false, kid: false, color: '', description: ''}],
    tasks: titles.map(([title, due], i) => ({id: 'd' + i, title, priority: 'p4', due, project: 'Chores', section: '', labels: '', recurring: false, assignee: ''})), updatedAt: '2026-09-23T22:39:00.000Z'});
  w = load({fixture: 'quiet', now: '2026-09-23T09:00:00', overrides: {'/api/tasks': tasks([['dinner:  Soup and bread', '2026-09-23'], ['Dinner: leftovers', '2026-09-23'], ['Dinnerware: donate the old plates', '2026-09-23'], ['Dinner:', '2026-09-23'], ['Dinner: lasagna', '2026-09-22'], ['Dinner: pizza night', '2026-09-24']])}});
  assert.deepEqual(w.$('dinner').children.map(el => el.textContent), ['Dinner', 'Soup and bread']);
  assert.deepEqual(w.today().map(r => r.title).sort(), ['Dinner:', 'Dinner: lasagna', 'Dinner: leftovers', 'Dinnerware: donate the old plates']);
  assert.equal(w.today().find(r => r.title === 'Dinner: lasagna').meta, 'Overdue');
  assert.ok(w.$('tomorrow-list').children.some(el => w.row(el).title === 'Dinner: pizza night'));
  // Without one, there is no line.
  assert.equal(load({now: '2026-09-23T12:30:00'}).$('dinner').hidden, true);
});
