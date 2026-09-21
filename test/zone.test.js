const {test} = require('node:test');
const assert = require('node:assert/strict');
const {dayIn, midnightIn, validZone} = require('../zone');
const {boundary} = require('../integrations');

test('A day begins at midnight in the household zone, through daylight saving and wherever the server runs', () => {
  assert.equal(midnightIn('America/Chicago', '2026-09-20'), '2026-09-20T05:00:00.000Z');
  assert.equal(midnightIn('America/Chicago', '2026-12-20'), '2026-12-20T06:00:00.000Z');
  assert.equal(midnightIn('America/Chicago', '2027-03-14'), '2027-03-14T06:00:00.000Z', 'the morning clocks go forward');
  assert.equal(midnightIn('America/Chicago', '2027-03-15'), '2027-03-15T05:00:00.000Z');
  assert.equal(midnightIn('Asia/Tokyo', '2026-09-20'), '2026-09-19T15:00:00.000Z');
  assert.equal(midnightIn('Pacific/Honolulu', '2026-09-20'), '2026-09-20T10:00:00.000Z');
  assert.equal(boundary('2026-09-20'), '2026-09-20T00:00:00.000Z', 'with no zone given, UTC: no household is the default');
  assert.equal(boundary('2026-09-20', 'Europe/London'), '2026-09-19T23:00:00.000Z');
});
test('The calendar day depends on the zone asked, not the clock of the machine', () => {
  const at = Date.parse('2026-09-21T03:30:00Z');
  assert.equal(dayIn('America/Chicago', at), '2026-09-20');
  assert.equal(dayIn('Asia/Tokyo', at), '2026-09-21');
  assert.equal(validZone('America/Chicago'), true);
  for (const bad of ['Mars/Olympus', '', undefined, 5]) assert.equal(validZone(bad), false);
});
