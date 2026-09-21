// Calendars by subscription link. Google's "secret address", iCloud's public calendar and Outlook's published
// calendar all serve the same text format (iCalendar, RFC 5545), with no sign-in, which is what lets a household
// other than the first one have a calendar at all. This file only reads that text; fetching it is safe-fetch.js.
//
// What is handled, because real family calendars use it: folded lines and escaped text; all-day, zoned, UTC and
// floating times; Windows zone names from Outlook; DURATION; repeating events by day, week, month and year with
// INTERVAL, COUNT, UNTIL, BYDAY (with "2nd Tuesday" and "last Friday"), BYMONTHDAY, BYMONTH, BYSETPOS and WKST;
// EXDATE; and a single occurrence that was moved, renamed or cancelled (RECURRENCE-ID). A repeating event keeps its
// wall-clock time across daylight saving, as a person expects. Not handled: RDATE, hourly and faster rules,
// BYWEEKNO, BYYEARDAY and "this and all following" edits; events using them show their first occurrence only.
const {instantOf, validZone} = require('./zone');

const DAY = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WINDOWS_ZONES = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland', 'UTC': 'UTC'
};

// ---------------------------------------------------------------- reading the text

const unfold = text => String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
const unescape = text => String(text || '').replace(/\\([nN,;\\])/g, (m, c) => c === 'n' || c === 'N' ? '\n' : c);
function parseLine(line) {
  let quoted = false, colon = -1;
  for (let i = 0; i < line.length; i++) { if (line[i] === '"') quoted = !quoted; else if (line[i] === ':' && !quoted) { colon = i; break; } }
  if (colon < 1) return null;
  const [name, ...rest] = line.slice(0, colon).split(';'), params = {};
  for (const part of rest) { const eq = part.indexOf('='); if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, ''); }
  return {name: name.toUpperCase(), params, value: line.slice(colon + 1)};
}
function zoneFor(tzid, fallback) {
  if (!tzid) return fallback;
  if (validZone(tzid)) return tzid;
  if (WINDOWS_ZONES[tzid]) return WINDOWS_ZONES[tzid];
  const tail = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_]+)?)$/.exec(tzid);   // "/mozilla.org/20050126_1/Europe/London"
  return tail && validZone(tail[1]) ? tail[1] : fallback;
}
// A date or date-time as written: `wall` is the reading as if it were UTC. allDay values have no time and no zone.
function parseWhen(value, params, fallbackZone) {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/.exec(String(value || '').trim());
  if (!m) return null;
  if (!m[4]) return {allDay: true, wall: Date.UTC(+m[1], m[2] - 1, +m[3])};
  const wall = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)), zone = m[7] ? 'UTC' : zoneFor(params.TZID, fallbackZone);
  return {allDay: false, wall, zone, at: m[7] ? wall : instantOf(zone, wall)};
}
function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value || '').trim());
  if (!m) return 0;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000;
  return m[1] === '-' ? 0 : ms;
}
function parseRule(value) {
  const rule = {interval: 1, byday: [], bymonthday: [], bymonth: [], bysetpos: [], wkst: 1};
  for (const part of String(value || '').split(';')) {
    const [key, v] = part.split('='); if (!v) continue;
    const list = v.split(',');
    if (key === 'FREQ') rule.freq = v.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (key === 'COUNT') rule.count = parseInt(v, 10);
    else if (key === 'UNTIL') rule.until = v;
    else if (key === 'WKST') rule.wkst = Math.max(0, WEEKDAYS.indexOf(v.toUpperCase()));
    else if (key === 'BYDAY') rule.byday = list.map(d => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d.toUpperCase())).filter(Boolean).map(m => ({n: m[1] ? parseInt(m[1], 10) : 0, day: WEEKDAYS.indexOf(m[2])}));
    else if (key === 'BYMONTHDAY') rule.bymonthday = list.map(Number).filter(n => n && Math.abs(n) <= 31);
    else if (key === 'BYMONTH') rule.bymonth = list.map(Number).filter(n => n >= 1 && n <= 12);
    else if (key === 'BYSETPOS') rule.bysetpos = list.map(Number).filter(Boolean);
    else if (['BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'].includes(key)) rule.unsupported = true;
  }
  return ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) && !rule.unsupported ? rule : null;
}

function parseEvents(text, fallbackZone) {
  const events = [];
  let current = null, skipping = 0;
  for (const raw of unfold(text).split('\n')) {
    const line = parseLine(raw); if (!line) continue;
    if (line.name === 'BEGIN') { if (line.value.toUpperCase() === 'VEVENT' && !current) current = {exdates: []}; else if (current) skipping++; continue; }
    if (line.name === 'END') { if (skipping) skipping--; else if (line.value.toUpperCase() === 'VEVENT' && current) { if (current.start) events.push(current); current = null; } continue; }
    if (!current || skipping) continue;
    const v = line.value;
    if (line.name === 'UID') current.uid = v.trim();
    else if (line.name === 'SUMMARY') current.title = unescape(v).trim();
    else if (line.name === 'LOCATION') current.location = unescape(v).trim();
    else if (line.name === 'CLASS') current.private = /^(PRIVATE|CONFIDENTIAL)$/i.test(v.trim());
    else if (line.name === 'STATUS') current.cancelled = v.trim().toUpperCase() === 'CANCELLED';
    else if (line.name === 'DTSTART') current.start = parseWhen(v, line.params, fallbackZone);
    else if (line.name === 'DTEND') current.end = parseWhen(v, line.params, fallbackZone);
    else if (line.name === 'DURATION') current.duration = parseDuration(v);
    else if (line.name === 'RRULE') current.rule = parseRule(v);
    else if (line.name === 'EXDATE') v.split(',').forEach(x => { const w = parseWhen(x, line.params, fallbackZone); if (w) current.exdates.push(w); });
    else if (line.name === 'RECURRENCE-ID') current.recurrenceId = parseWhen(v, line.params, fallbackZone);
  }
  return events;
}

// ---------------------------------------------------------------- repeating

// All of this works on wall-clock readings, so "every Tuesday at 5" stays at 5 whatever daylight saving does.
const ymd = wall => { const d = new Date(wall); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
function monthDays(y, m, rule, startDay) {
  const total = daysIn(y, m);
  let days = [];
  if (rule.byday.length) {
    for (let d = 1; d <= total; d++) {
      const weekday = new Date(Date.UTC(y, m, d)).getUTCDay(), nth = Math.ceil(d / 7), fromEnd = -Math.ceil((total - d + 1) / 7);
      if (rule.byday.some(b => b.day === weekday && (b.n === 0 || b.n === nth || b.n === fromEnd))) days.push(d);
    }
    if (rule.bymonthday.length) days = days.filter(d => rule.bymonthday.some(n => (n > 0 ? n : total + n + 1) === d));
  } else if (rule.bymonthday.length) days = rule.bymonthday.map(n => n > 0 ? n : total + n + 1).filter(d => d >= 1 && d <= total);
  else if (startDay <= total) days = [startDay];
  return [...new Set(days)].sort((a, b) => a - b);
}
const pick = (set, positions) => positions.length ? positions.map(p => p > 0 ? set[p - 1] : set[set.length + p]).filter(x => x !== undefined) : set;

// Occurrence readings of a rule, in order: stops at `stopAfter` (a reading), the rule's own end, or a generous cap,
// whichever comes first. A rule with no COUNT jumps straight to just before `notBefore`, so a daily event begun
// twenty years ago costs no more than one begun last week; a COUNT has to be counted from the beginning.
function* occurrences(startWall, rule, stopAfter, notBefore = startWall) {
  const [y0, m0, d0] = ymd(startWall), timeOfDay = startWall - Date.UTC(y0, m0, d0), startWeekday = new Date(startWall).getUTCDay();
  const span = {DAILY: DAY, WEEKLY: 7 * DAY, MONTHLY: 31 * DAY, YEARLY: 366 * DAY}[rule.freq] * rule.interval;
  const first = rule.count ? 0 : Math.max(0, Math.floor((notBefore - startWall) / span) - 2);
  let produced = 0;
  for (let period = first; period < first + 6000; period++) {
    let walls = [];
    if (rule.freq === 'DAILY') {
      const day = Date.UTC(y0, m0, d0) + period * rule.interval * DAY, [y, m, d] = ymd(day), weekday = new Date(day).getUTCDay(), total = daysIn(y, m);
      if ((!rule.bymonth.length || rule.bymonth.includes(m + 1)) && (!rule.byday.length || rule.byday.some(b => b.day === weekday)) &&
          (!rule.bymonthday.length || rule.bymonthday.some(n => (n > 0 ? n : total + n + 1) === d))) walls = [day];
    } else if (rule.freq === 'WEEKLY') {
      const weekStart = Date.UTC(y0, m0, d0) - ((startWeekday - rule.wkst + 7) % 7) * DAY + period * rule.interval * 7 * DAY;
      const wanted = rule.byday.length ? rule.byday.map(b => b.day) : [startWeekday];
      walls = wanted.map(day => weekStart + ((day - rule.wkst + 7) % 7) * DAY).filter(day => !rule.bymonth.length || rule.bymonth.includes(ymd(day)[1] + 1));
    } else if (rule.freq === 'MONTHLY') {
      const index = m0 + period * rule.interval, y = y0 + Math.floor(index / 12), m = ((index % 12) + 12) % 12;
      if (!rule.bymonth.length || rule.bymonth.includes(m + 1)) walls = pick(monthDays(y, m, rule, d0), rule.bysetpos).map(d => Date.UTC(y, m, d));
    } else {
      const y = y0 + period * rule.interval, months = rule.bymonth.length ? rule.bymonth.map(n => n - 1) : [m0];
      let all = [];
      for (const m of [...months].sort((a, b) => a - b)) all = all.concat(monthDays(y, m, rule, d0).map(d => Date.UTC(y, m, d)));
      walls = pick(all, rule.bysetpos);
    }
    walls = [...new Set(walls)].sort((a, b) => a - b).map(day => day + timeOfDay).filter(w => w >= startWall);
    // The first occurrence is always DTSTART itself, even when it does not match its own rule.
    if (period === 0 && !walls.includes(startWall)) walls.unshift(startWall);
    for (const wall of walls) {
      if (wall > stopAfter || (rule.count && produced >= rule.count)) return;
      produced++;
      yield wall;
    }
    if (rule.count && produced >= rule.count) return;
  }
}

// ---------------------------------------------------------------- the window

const day = wall => new Date(wall).toISOString().slice(0, 10);
const key = when => when.allDay ? 'd' + when.wall : 't' + when.at;

// Everything in the feed that touches [fromDay, toDay), as the frame's events. Days are the household's.
function eventsBetween(text, {calendar, zone, fromDay, toDay}) {
  const from = instantOf(zone, Date.parse(fromDay + 'T00:00:00Z')), to = instantOf(zone, Date.parse(toDay + 'T00:00:00Z'));
  const fromWall = Date.parse(fromDay + 'T00:00:00Z'), toWall = Date.parse(toDay + 'T00:00:00Z');
  const parsed = parseEvents(text, zone), overrides = new Map(), out = [];
  for (const e of parsed) if (e.recurrenceId && e.uid) { if (!overrides.has(e.uid)) overrides.set(e.uid, new Map()); overrides.get(e.uid).set(key(e.recurrenceId), e); }

  function emit(e, start, source) {
    const length = e.end ? (e.start.allDay ? e.end.wall - e.start.wall : e.end.at - e.start.at) : (e.duration || (e.start.allDay ? DAY : 0));
    const shown = source || e;
    if (shown.cancelled) return;
    if (start.allDay) {
      const endWall = start.wall + Math.max(DAY, length);
      if (start.wall < toWall && endWall > fromWall) out.push({id: calendar + ':' + (e.uid || '') + ':' + day(start.wall), uid: e.uid || '', title: shown.title || 'Busy', calendar, start: day(start.wall), end: day(endWall), allDay: true, location: shown.location || '', ...(shown.private ? {private: true} : {})});
    } else {
      const end = start.at + Math.max(0, length);
      if (start.at < to && (end > from || (end === start.at && start.at >= from))) out.push({id: calendar + ':' + (e.uid || '') + ':' + start.at, uid: e.uid || '', title: shown.title || 'Busy', calendar, start: new Date(start.at).toISOString(), end: new Date(end).toISOString(), allDay: false, location: shown.location || '', ...(shown.private ? {private: true} : {})});
    }
  }

  for (const e of parsed) {
    if (e.recurrenceId) { emit(e, e.start); continue; }           // a moved or edited occurrence stands on its own
    if (!e.rule) { emit(e, e.start); continue; }
    const moved = overrides.get(e.uid) || new Map(), skipped = new Set(e.exdates.map(key));
    const until = e.rule.until ? parseWhen(e.rule.until, {}, e.start.zone || zone) : null;
    const length = e.end ? (e.start.allDay ? e.end.wall - e.start.wall : e.end.at - e.start.at) : (e.duration || 0);
    for (const wall of occurrences(e.start.wall, e.rule, toWall + 2 * DAY, fromWall - Math.max(DAY, length) - 2 * DAY)) {
      const start = e.start.allDay ? {allDay: true, wall} : {allDay: false, wall, zone: e.start.zone, at: instantOf(e.start.zone, wall)};
      if (until && (e.start.allDay ? wall > (until.allDay ? until.wall : Date.UTC(...ymd(until.wall))) : start.at > (until.allDay ? until.wall + DAY - 1 : until.at))) break;
      if (skipped.has(key(start)) || moved.has(key(start))) continue;
      if ((e.start.allDay ? wall + Math.max(DAY, length) : start.at + length) < (e.start.allDay ? fromWall : from) - DAY) continue;
      emit(e, start);
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
// The pieces caldav.js needs to read and edit tasks in the same text format.
module.exports = {eventsBetween, parseEvents, parseRule, unfold, parseLine, parseWhen, occurrences, unescape};
