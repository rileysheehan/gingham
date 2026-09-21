const {test} = require('node:test');
const assert = require('node:assert/strict');
const {upcoming, nextYearly, validDay} = require('../countdowns');

test('A yearly day comes round again, and a leap day falls on the 28th when there is no 29th', () => {
  assert.equal(nextYearly('2021-09-23', '2026-09-20'), '2026-09-23');
  assert.equal(nextYearly('2021-09-23', '2026-09-23'), '2026-09-23', 'the day itself still counts');
  assert.equal(nextYearly('2021-09-23', '2026-09-24'), '2027-09-23');
  assert.equal(nextYearly('2020-02-29', '2026-12-01'), '2027-02-28');
  assert.equal(nextYearly('2020-02-29', '2027-12-01'), '2028-02-29');
});

test('The frame hears only what is still ahead and near, soonest first', () => {
  const list = [{name: 'The beach', date: '2026-12-20'}, {name: 'Sam turns 5', date: '2021-09-23', yearly: true}, {name: 'Last summer', date: '2025-07-01'},
    {name: 'A long way off', date: '2027-06-01'}, {name: '', date: '2026-10-01'}, {name: 'Nonsense', date: '2026-02-30'}, null, {name: 'Grandma visits', date: '2026-10-02', word: 'days'}];
  assert.deepEqual(upcoming(list, '2026-09-20'), [{name: 'Sam turns 5', date: '2026-09-23', word: 'sleeps'}, {name: 'Grandma visits', date: '2026-10-02', word: 'days'}, {name: 'The beach', date: '2026-12-20', word: 'sleeps'}]);
  assert.deepEqual(upcoming(undefined, '2026-09-20'), []);
  assert.equal(validDay('2026-02-30'), false);
});
