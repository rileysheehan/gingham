// Dates in a household's own time zone, without depending on the zone the server happens to run in. A container
// runs in UTC and serves families in several zones, so "today" and "midnight" are always asked of a named zone.
const parts = (tz, ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'}).formatToParts(new Date(ms)).map(p => [p.type, Number(p.value)]));
// How far the zone's wall clock is ahead of UTC at that instant, in milliseconds.
function offset(tz, ms) { const p = parts(tz, ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; }
// The calendar day it is in the zone at that instant, as YYYY-MM-DD.
function dayIn(tz, ms = Date.now()) { const p = parts(tz, ms); return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0'); }
// The instant a calendar day begins in the zone. Two passes, so a day that starts just after a clock change is right.
function midnightIn(tz, day) { const utc = Date.parse(day + 'T00:00:00Z'); let at = utc - offset(tz, utc); at = utc - offset(tz, at); return new Date(at).toISOString(); }
// The instant at which a zone's wall clock reads the given time. `wall` is that reading written as if it were UTC
// (Date.UTC(y, m, d, h, mi, s)). A time that does not exist, in the hour clocks skip, lands just after the gap.
function instantOf(tz, wall) { let at = wall - offset(tz, wall); at = wall - offset(tz, at); return at; }
function validZone(tz) { try { new Intl.DateTimeFormat('en-US', {timeZone: tz}); return typeof tz === 'string' && tz.length > 0; } catch (e) { return false; } }
module.exports = {dayIn, midnightIn, validZone, instantOf, offset};
