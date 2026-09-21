// Does a calendar read from its subscription link match what Google's API says? Run before trusting a link in place
// of a sign-in:   node scripts/compare-calendar.js <household> <google calendar id> <secret ics address> [days]
// It prints counts and every difference, and nothing from the link itself.
const path = require('node:path');
const fs = require('node:fs');
const {createClient} = require('../api-client');
const {eventsBetween} = require('../ics');
const {safeFetchText} = require('../safe-fetch');
const {normalize, boundary} = require('../integrations');
const {dayIn} = require('../zone');

const [household, calendarId, link, days = '60'] = process.argv.slice(2);
if (!household || !calendarId || !link) { console.error('usage: node scripts/compare-calendar.js <household> <google calendar id> <ics address> [days]'); process.exit(1); }
const dir = path.join(process.env.FRAME_DATA || path.join(__dirname, '..', 'data'), 'households', household);
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const zone = read('sources.json').timezone || 'America/Chicago';
const from = dayIn(zone), to = dayIn(zone, Date.now() + Number(days) * 86400000);
(async () => {
  const api = createClient({credentials: () => read('credentials.json')});
  const mine = eventsBetween((await safeFetchText(link)).text, {calendar: 'c', zone, fromDay: from, toDay: to});
  const theirs = normalize(await api.pages(c => api.google('calendars/' + encodeURIComponent(calendarId) + '/events', {timeMin: boundary(from, zone), timeMax: boundary(to, zone), timeZone: zone, singleEvents: 'true', maxResults: '2500', ...(c ? {pageToken: c} : {})}), 'items', 'nextPageToken'), 'c');
  // Google writes a timed start with the zone's offset and the link's reader writes UTC; compare the instants.
  const key = e => (e.allDay ? e.start + '→' + e.end : new Date(e.start).toISOString() + '→' + new Date(e.end).toISOString()) + '  ' + e.title;
  const a = new Set(mine.map(key)), b = new Set(theirs.map(key));
  console.log(from + ' to ' + to + ': ' + mine.length + ' from the link, ' + theirs.length + ' from Google');
  [...a].filter(k => !b.has(k)).forEach(k => console.log('  only from the link:  ' + k));
  [...b].filter(k => !a.has(k)).forEach(k => console.log('  only from Google:    ' + k));
  console.log(a.size === b.size && [...a].every(k => b.has(k)) ? 'They agree.' : 'They differ. Do not switch this calendar over until that is explained.');
})().catch(e => { console.error(e.message); process.exit(1); });
