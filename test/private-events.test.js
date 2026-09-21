const {test} = require('node:test');
const assert = require('node:assert/strict');
const {eventsBetween} = require('../ics');
const {normalize, discreet} = require('../integrations');

const feed = ['BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Dentist', 'LOCATION:12 Main St', 'CLASS:PRIVATE', 'DTSTART:20260922T150000Z', 'DTEND:20260922T160000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Soccer', 'CLASS:PUBLIC', 'DTSTART:20260922T220000Z', 'DTEND:20260922T230000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Surprise party planning', 'CLASS:CONFIDENTIAL', 'DTSTART;VALUE=DATE:20260923', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n');

test('A feed says which events their author marked private, and only those', () => {
  const events = eventsBetween(feed, {calendar: 'cal', zone: 'UTC', fromDay: '2026-09-20', toDay: '2026-09-27'});
  assert.deepEqual(events.map(e => [e.title, !!e.private]).sort(), [['Dentist', true], ['Soccer', false], ['Surprise party planning', true]]);
});

test('Google says it with visibility; the default visibility is not private', () => {
  const when = {start: {dateTime: '2026-09-22T15:00:00Z'}, end: {dateTime: '2026-09-22T16:00:00Z'}};
  const events = normalize([{id: '1', summary: 'Dentist', visibility: 'private', ...when}, {id: '2', summary: 'Soccer', visibility: 'default', ...when}, {id: '3', summary: 'Lunch', ...when}], 'cal');
  assert.deepEqual(events.map(e => !!e.private), [true, false, false]);
});

test('On the wall a private event is Busy with nowhere and nothing else, unless the household chose otherwise', () => {
  const events = eventsBetween(feed, {calendar: 'cal', zone: 'UTC', fromDay: '2026-09-20', toDay: '2026-09-27'});
  for (const policy of [undefined, 'busy', 'nonsense']) {
    const shown = discreet(events, policy);
    assert.equal(shown.length, 3);
    assert.ok(!JSON.stringify(shown).match(/Dentist|Main St|Surprise/), 'nothing of a private event leaves the server');
    assert.deepEqual(shown.filter(e => e.private).map(e => [e.title, e.location, e.busy]), [['Busy', '', true], ['Busy', '', true]]);
    assert.ok(shown.some(e => e.title === 'Soccer'));
  }
  assert.deepEqual(discreet(events, 'hide').map(e => e.title), ['Soccer']);
  assert.ok(discreet(events, 'show').some(e => e.title === 'Dentist'));
  assert.ok(!discreet(events, 'show').some(e => e.busy), 'shown in full is not drawn as Busy');
});
