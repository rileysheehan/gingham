// The real moon (D-06, DESIGN.md → "Moments of the day"), run headless against the fixtures like test/wall.test.js, with the
// device in London while the household is in Austin, as a Frameo resets itself to.
process.env.TZ = 'Europe/London';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./wall-harness');

test('At night on a clear or partly cloudy sky, the weather icon is tonight\'s moon, from the date alone (D-06)', () => {
  // Read back from the drawing: which side is lit, and how much of the disc (the terminator's half-width over the radius).
  const moon = (now, opts = {}) => {
    const html = load({fixture: 'sparse', now, ...opts}).$('now-icon').innerHTML;
    if (!/moon-dark/.test(html)) return null;
    const lit = /class="moon" d="M32 10A22 22 0 0 (\d) 32 54A([\d.]+) 22 0 0 (\d) 32 10Z"/.exec(html);
    if (!lit) return {side: 'none', lit: 0};
    const right = lit[1] === '1', k = Number(lit[2]) / 22 * ((lit[3] === '0') === right ? 1 : -1);
    return {side: right ? 'right' : 'left', lit: (1 - k) / 2};
  };
  // Against the almanac's 2026 phases (UTC): new moon Sep 11 03:27, first quarter Sep 18 20:44, full Sep 26 16:49, last
  // quarter Oct 3 13:25, each looked at on the night nearest it (the device is in London, an hour ahead of UTC). The
  // arithmetic is the mean month, so it may be most of a day out; these hold it to that.
  assert.deepEqual(moon('2026-09-11T04:27:00'), {side: 'none', lit: 0}, 'new: only the faint disc');
  const quarter = moon('2026-09-18T21:44:00');
  assert.equal(quarter.side, 'right', 'waxing is lit on the right');
  assert.ok(Math.abs(quarter.lit - 0.5) < 0.1, 'first quarter: half lit (' + quarter.lit.toFixed(2) + ')');
  assert.ok(moon('2026-09-26T21:00:00').lit > 0.98, 'full');
  const last = moon('2026-10-03T20:00:00');
  assert.equal(last.side, 'left', 'waning is lit on the left');
  assert.ok(Math.abs(last.lit - 0.5) < 0.1, 'last quarter: half lit (' + last.lit.toFixed(2) + ')');
  const crescent = moon('2026-09-15T21:00:00');
  assert.ok(crescent.side === 'right' && crescent.lit > 0.05 && crescent.lit < 0.25, 'a waxing crescent four days after new');
  // South of the equator the same crescent is lit on the left.
  assert.equal(moon('2026-09-15T21:00:00', {overrides: {'/api/household': {name: 'Household', timezone: 'America/Chicago', place: 'Austin', south: true}}}).side, 'left');
  // By day, the sun; on a partly cloudy night the cloud takes its shape out of the moon.
  assert.equal(moon('2026-09-15T12:00:00'), null);
  const cloudy = load({fixture: 'quiet', now: '2026-09-19T21:00:00'}).$('now-icon').innerHTML;
  assert.match(cloudy, /<mask id="behind-cloud">.*<g mask="url\(#behind-cloud\)"><g transform="translate\(14,-6\) scale\(\.62\)"><circle class="moon-dark"/);
});
