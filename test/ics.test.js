const {test} = require('node:test');
const assert = require('node:assert/strict');
const {eventsBetween, parseEvents} = require('../ics');

const cal = (...events) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + events.map(e => 'BEGIN:VEVENT\r\n' + e.trim().split('\n').map(l => l.trim()).join('\r\n') + '\r\nEND:VEVENT\r\n').join('') + 'END:VCALENDAR\r\n';
const between = (text, fromDay, toDay, zone = 'America/Chicago') => eventsBetween(text, {calendar: 'c', zone, fromDay, toDay});
const starts = list => list.map(e => e.start);

test('A timed event: escaped text, a named zone, and the frame\'s own event shape', () => {
  const [e] = between(cal(`UID:a1
    SUMMARY:Soccer\\, practice
    LOCATION:Brentwood Park\\nAustin
    DTSTART;TZID=America/Chicago:20260923T173000
    DTEND;TZID=America/Chicago:20260923T183000`), '2026-09-23', '2026-10-21');
  assert.deepEqual(e, {id: 'c:a1:' + Date.parse('2026-09-23T22:30:00Z'), uid: 'a1', title: 'Soccer, practice', calendar: 'c', start: '2026-09-23T22:30:00.000Z', end: '2026-09-23T23:30:00.000Z', allDay: false, location: 'Brentwood Park\nAustin'});
});

test('Long lines arrive folded, and an alarm inside an event is not the event', () => {
  const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f1\r\nSUMMARY:Pediatric dentist appointment for June with\r\n  Dr. Patel\r\nDTSTART:20260923T220000Z\r\nDTEND:20260923T230000Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDURATION:PT15M\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT30M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [e] = between(text, '2026-09-23', '2026-09-24');
  assert.equal(e.title, 'Pediatric dentist appointment for June with Dr. Patel');
  assert.equal(e.end, '2026-09-23T23:00:00.000Z', 'the alarm\'s DURATION did not become the event\'s');
});

test('All-day events keep their exclusive end, and one with no end lasts a day', () => {
  const list = between(cal(`UID:t1
    SUMMARY:Theo in Chicago
    DTSTART;VALUE=DATE:20260922
    DTEND;VALUE=DATE:20260926`, `UID:t2
    SUMMARY:Picture day
    DTSTART;VALUE=DATE:20260923`), '2026-09-23', '2026-10-21');
  assert.deepEqual(list.map(e => [e.title, e.start, e.end, e.allDay]), [['Theo in Chicago', '2026-09-22', '2026-09-26', true], ['Picture day', '2026-09-23', '2026-09-24', true]]);
  assert.equal(between(cal(`UID:t3
    DTSTART;VALUE=DATE:20260920
    DTEND;VALUE=DATE:20260923`), '2026-09-23', '2026-10-21').length, 0, 'an all-day event ending the day before is not shown');
});

test('UTC, floating, Windows-named and path-named zones all land on the same instant', () => {
  const want = '2026-09-23T22:00:00.000Z';
  for (const line of ['DTSTART:20260923T220000Z', 'DTSTART:20260923T170000', 'DTSTART;TZID=Central Standard Time:20260923T170000', 'DTSTART;TZID="/mozilla.org/20050126_1/America/Chicago":20260923T170000', 'DTSTART;TZID=Nowhere/Invented:20260923T170000'])
    assert.equal(between(cal('UID:z\n' + line), '2026-09-23', '2026-09-24')[0].start, want, line);
  assert.equal(between(cal('UID:z\nDTSTART:20260923T170000'), '2026-09-23', '2026-09-24', 'Europe/London')[0].start, '2026-09-23T16:00:00.000Z', 'a floating time is the household\'s clock');
});

test('A weekly event keeps its wall-clock time across the end of daylight saving, and skips its EXDATE', () => {
  const list = between(cal(`UID:w1
    SUMMARY:Piano
    DTSTART;TZID=America/Chicago:20261020T170000
    DTEND;TZID=America/Chicago:20261020T174500
    RRULE:FREQ=WEEKLY;BYDAY=TU
    EXDATE;TZID=America/Chicago:20261027T170000`), '2026-10-19', '2026-11-16');
  assert.deepEqual(starts(list), ['2026-10-20T22:00:00.000Z', '2026-11-03T23:00:00.000Z', '2026-11-10T23:00:00.000Z'], '5 PM Central before and after November 1');
  assert.equal(list[1].end, '2026-11-03T23:45:00.000Z');
});

test('COUNT is counted from the first occurrence, not from the window; UNTIL includes its own day', () => {
  const counted = cal(`UID:c1
    DTSTART;TZID=America/Chicago:20260923T170000
    RRULE:FREQ=DAILY;COUNT=3`);
  assert.equal(between(counted, '2026-09-23', '2026-10-21').length, 3);
  assert.deepEqual(starts(between(counted, '2026-09-25', '2026-10-21')), ['2026-09-25T22:00:00.000Z'], 'the third and last');
  assert.equal(between(counted, '2026-09-26', '2026-10-21').length, 0);
  assert.equal(between(cal(`UID:u1
    DTSTART;TZID=America/Chicago:20260923T170000
    RRULE:FREQ=DAILY;UNTIL=20260925T220000Z`), '2026-09-23', '2026-10-21').length, 3);
});

test('Monthly rules: second Tuesday, last Friday, the 31st, the last day, the last weekday', () => {
  const monthly = (start, rule) => starts(between(cal('UID:m\nDTSTART;VALUE=DATE:' + start + '\nRRULE:' + rule), '2026-09-01', '2027-01-01'));
  assert.deepEqual(monthly('20260908', 'FREQ=MONTHLY;BYDAY=2TU'), ['2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08']);
  assert.deepEqual(monthly('20260925', 'FREQ=MONTHLY;BYDAY=-1FR'), ['2026-09-25', '2026-10-30', '2026-11-27', '2026-12-25']);
  assert.deepEqual(monthly('20260831', 'FREQ=MONTHLY;BYMONTHDAY=31'), ['2026-08-31', '2026-10-31', '2026-12-31'].slice(1), 'months without a 31st are skipped');
  assert.deepEqual(monthly('20260930', 'FREQ=MONTHLY;BYMONTHDAY=-1'), ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
  assert.deepEqual(monthly('20260930', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'), ['2026-09-30', '2026-10-30', '2026-11-30', '2026-12-31']);
  assert.deepEqual(monthly('20260915', 'FREQ=MONTHLY;INTERVAL=2'), ['2026-09-15', '2026-11-15']);
});

test('Yearly rules: a birthday from years ago, Thanksgiving, and a leap-day birthday', () => {
  assert.deepEqual(starts(between(cal(`UID:y1
    SUMMARY:June’s birthday
    DTSTART;VALUE=DATE:20210923
    RRULE:FREQ=YEARLY`), '2026-09-01', '2026-10-01')), ['2026-09-23']);
  assert.deepEqual(starts(between(cal(`UID:y2
    DTSTART;VALUE=DATE:20201126
    RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH`), '2026-11-01', '2026-12-01')), ['2026-11-26']);
  const leap = cal('UID:y3\nDTSTART;VALUE=DATE:20240229\nRRULE:FREQ=YEARLY');
  assert.deepEqual(starts(between(leap, '2026-02-01', '2026-03-31')), []);
  assert.deepEqual(starts(between(leap, '2028-02-01', '2028-03-31')), ['2028-02-29']);
});

test('The standard\'s own example: every other week on Tuesday and Sunday depends on the week\'s first day', () => {
  const rfc = wkst => starts(between(cal('UID:r\nDTSTART;TZID=America/New_York:19970805T090000\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=' + wkst), '1997-08-01', '1997-09-15', 'America/New_York')).map(s => s.slice(5, 10));
  assert.deepEqual(rfc('MO'), ['08-05', '08-10', '08-19', '08-24']);
  assert.deepEqual(rfc('SU'), ['08-05', '08-17', '08-19', '08-31']);
});

test('One occurrence moved and renamed, another cancelled, the rest untouched', () => {
  const list = between(cal(`UID:s1
    SUMMARY:Swim
    DTSTART;TZID=America/Chicago:20260922T170000
    DTEND;TZID=America/Chicago:20260922T180000
    RRULE:FREQ=WEEKLY;BYDAY=TU`, `UID:s1
    RECURRENCE-ID;TZID=America/Chicago:20260929T170000
    SUMMARY:Swim (moved)
    DTSTART;TZID=America/Chicago:20260930T180000
    DTEND;TZID=America/Chicago:20260930T190000`, `UID:s1
    RECURRENCE-ID;TZID=America/Chicago:20261006T170000
    STATUS:CANCELLED
    DTSTART;TZID=America/Chicago:20261006T170000`), '2026-09-22', '2026-10-14');
  assert.deepEqual(list.map(e => [e.title, e.start]), [['Swim', '2026-09-22T22:00:00.000Z'], ['Swim (moved)', '2026-09-30T23:00:00.000Z'], ['Swim', '2026-10-13T22:00:00.000Z']]);
});

test('DURATION, events that started before the window, and a daily event from twenty years ago', () => {
  assert.equal(between(cal('UID:d1\nDTSTART:20260923T220000Z\nDURATION:PT1H30M'), '2026-09-23', '2026-09-24')[0].end, '2026-09-23T23:30:00.000Z');
  assert.equal(between(cal('UID:d2\nDTSTART;TZID=America/Chicago:20260922T220000\nDTEND;TZID=America/Chicago:20260923T020000'), '2026-09-23', '2026-09-24').length, 1, 'still running after midnight');
  const began = Date.now(), old = between(cal('UID:d3\nDTSTART;TZID=America/Chicago:20060101T070000\nRRULE:FREQ=DAILY'), '2026-09-23', '2026-10-21');
  assert.equal(old.length, 28);
  assert.equal(old[0].start, '2026-09-23T12:00:00.000Z');
  assert.ok(Date.now() - began < 500, 'it jumps to the window rather than walking two decades');
});

test('Rules this does not understand show once; nonsense shows nothing and never throws', () => {
  assert.deepEqual(starts(between(cal('UID:x1\nDTSTART;VALUE=DATE:20260923\nRRULE:FREQ=YEARLY;BYWEEKNO=20'), '2026-09-01', '2027-12-31')), ['2026-09-23']);
  for (const junk of ['', 'hello', 'BEGIN:VEVENT\nUID:q\n', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:notadate\nEND:VEVENT', null, undefined, 'BEGIN:VEVENT\nDTSTART:20260923T220000Z\nRRULE:FREQ=SECONDLY\nEND:VEVENT'])
    assert.doesNotThrow(() => between(junk, '2026-09-23', '2026-10-21'));
  assert.equal(parseEvents('BEGIN:VEVENT\nUID:q\nEND:VEVENT', 'UTC').length, 0, 'an event with no start is not an event');
});
