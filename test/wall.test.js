// The wall's own page, run headless against the fixtures (see wall-harness.js). These are the behaviours the 2026-09-22
// app audit found broken: what Today keeps when it is full, an event that runs past midnight, and checking off a chore
// in a day sheet. Run with the device set to London while the household is in Austin, as a Frameo resets itself to.
process.env.TZ = 'Europe/London';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./wall-harness');

test('A chore whose time has passed is overdue, and Today keeps what is next ahead of it (GA-01)', () => {
  // 10:58 PM: the 11 PM trash is two minutes away and the 11:30 PM airport pickup half an hour; the 4 PM piano practice
  // is seven hours late.
  let w = load({now: '2026-09-23T22:58:00'});
  let rows = w.today();
  assert.deepEqual(rows.map(r => r.title), ['Take: trash to street', 'Return: library books', 'Pay: water bill', 'Take: recycling to street', 'Late flight pickup at the airport'],
    'next, the two oldest overdue chores, then the next three hours: all on screen');
  assert.equal(rows[0].meta, '11 PM · in 2 min', 'the next row carries the countdown');
  assert.ok(rows[0].classes.includes('next'));
  assert.match(w.more().textContent, /^\d+ more$/);
  w.more().click();
  const piano = w.sheet().find(r => r.title.includes('Practice: piano'));
  assert.equal(piano.meta, 'Overdue', 'a 4 PM chore at 10:58 PM is overdue, not "4 PM"');
  assert.ok(piano.classes.includes('overdue'));

  // 7:05 PM: the 7:15 PM dentist is the next thing, and nothing all-day or overdue stands in front of it.
  rows = load({now: '2026-09-23T19:05:00'}).today();
  assert.match(rows[0].title, /^Pediatric dentist/);
  assert.match(rows[0].meta, /^7:15 PM · in 10 min/);

  // 11:40 PM: the pickup is happening, and happening comes first.
  rows = load({now: '2026-09-23T23:40:00'}).today();
  assert.equal(rows[0].title, 'Late flight pickup at the airport');
  assert.match(rows[0].meta, /^Now, until 12:30 AM/);
  assert.ok(rows[0].classes.includes('happening'));
});

test('An event that runs past midnight stays in Today until it ends, and only in Today (GA-02)', () => {
  // The device's own clock, in London, at 12:10 AM in Austin.
  const w = load({clock: '2026-09-24T05:10:00Z'});
  assert.equal(w.$('today-weekday').textContent, 'Thursday', 'house time, not the device\'s');
  const [first] = w.today();
  assert.equal(first.title, 'Late flight pickup at the airport');
  assert.match(first.meta, /^Now, until 12:30 AM/);
  // After it ends, it is gone.
  assert.ok(!load({clock: '2026-09-24T05:31:00Z'}).today().some(r => r.title.includes('flight pickup')));
  // The week keeps the rule that a timed event belongs to the day it starts: Thursday's column never shows it.
  const day = load({now: '2026-09-23T15:40:00'});
  const thursday = day.$('strip').children[0];
  assert.match(thursday.textContent, /^Tomorrow24/);
  assert.ok(!thursday.textContent.includes('flight pickup'));
});

test('A chore checked off in a day sheet shows its check there, and a second tap is a visible undo (GA-04)', () => {
  const w = load({now: '2026-09-23T15:40:00'});
  w.more().click();
  assert.equal(w.$('day-dialog').hidden, false);
  w.sheetRow('Clean: out fridge').click();
  const checked = w.sheetRow('Clean: out fridge');
  assert.ok(checked.classes.includes('done'), 'the sheet shows the check');
  assert.equal(checked.getAttribute('aria-checked'), 'true');
  assert.equal(w.$('toast').hidden, false);
  checked.click();
  const undone = w.sheetRow('Clean: out fridge');
  assert.ok(!undone.classes.includes('done'), 'the second tap undoes it, and the sheet says so');
  assert.equal(undone.getAttribute('aria-checked'), 'false');
  assert.equal(w.$('toast').hidden, true);
});

test('First run says it is not set up, not that nothing is planned (GA-20)', () => {
  const w = load({fixture: 'empty', now: '2026-09-23T10:00:00', overrides: {'/api/household': {name: '', timezone: 'America/Chicago', needsSetup: true, address: 'http://10.0.0.9:4173'}}});
  assert.equal(w.$('today-list').textContent, 'Not set up yet');
  assert.equal(load({fixture: 'empty', now: '2026-09-23T10:00:00'}).$('today-list').textContent, 'Nothing planned');
});

test('An old calendar says so in the panel every view shares, with the day when it is not today (GA-06)', () => {
  const stale = fixture => ({...require('./fixtures').stress[fixture], stale: true});
  const w = load({now: '2026-09-24T10:00:00', overrides: {'/api/calendar': stale('calendar')}});
  assert.equal(w.$('stale-line').hidden, false);
  assert.equal(w.$('stale-line').textContent, 'Calendar not updated since yesterday 5:39 PM');
  assert.match(w.$('notice').textContent, /Showing it from yesterday 5:39 PM/);
  const both = load({now: '2026-09-26T10:00:00', overrides: {'/api/calendar': stale('calendar'), '/api/tasks': stale('tasks')}});
  assert.equal(both.$('stale-line').textContent, 'Calendar and lists not updated since Wed, Sep 23, 5:39 PM');
  assert.equal(load({now: '2026-09-23T18:00:00', overrides: {'/api/calendar': stale('calendar')}}).$('stale-line').textContent, 'Calendar not updated since 5:39 PM');
  assert.equal(load({now: '2026-09-24T10:00:00'}).$('stale-line').hidden, true);
});

test('Later puts whose a chore is after its title, as a monogram (GA-21)', () => {
  const w = load({now: '2026-09-23T15:40:00'});
  const row = w.$('later-rows').children.find(el => el.textContent.includes('Return: library book'));
  assert.ok(row, 'June\'s library book is in Later');
  const what = row.querySelector('.what');
  assert.equal(what.children[0].textContent, '📚 Return: library book');
  assert.ok(what.children[1].classes.includes('avatar'));
  assert.equal(what.children[1].textContent, 'J');
  assert.ok(!row.textContent.includes('June ·'));
});

test('An update never reloads the page out from under an open dialog (GA-39)', () => {
  for (const dialog of ['add-dialog', 'manage-dialog', 'day-dialog', 'event-dialog']) {
    const w = load({now: '2026-09-23T15:40:00'});
    w.$(dialog).hidden = false;
    w.server.version = 'v2';        // the server was updated
    w.advance(60000);               // and nobody has touched the frame for a minute
    w.every('loadTasks');
    assert.equal(w.window.reloaded, undefined, 'reloaded with ' + dialog + ' open');
  }
  // With nothing open it does reload, so the guard is not simply never reloading.
  const w = load({now: '2026-09-23T15:40:00'});
  w.server.version = 'v2'; w.advance(60000); w.every('loadTasks');
  assert.equal(w.window.reloaded, true);
});

test('A countdown\'s name is tidied like any title (GA-35)', () => {
  const w = load({now: '2026-09-23T15:40:00', overrides: {'/api/household': {name: '', timezone: 'America/Chicago', countdowns: [{name: "June's birthday", date: '2026-09-26', word: 'sleeps'}]}}});
  assert.equal(w.$('countdown').textContent, '3 sleeps until June’s birthday');
});

test('Past the now and next rows, Today is one line a row, so it holds about twice as many (GA-03)', () => {
  // 7:10 AM on the stress day: the fold held three rows; now the next row keeps two lines and the rest are one.
  let w = load({now: '2026-09-23T07:10:00'});
  let rows = w.today();
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.classes.includes('compact')), [false, true, true, true, true]);
  assert.equal(rows[0].meta, '7:30 AM · in 20 min');
  assert.deepEqual(rows.slice(1).map(r => r.meta), ['Overdue', 'Overdue', '10 AM', 'Until Fri'], 'the time column: a state, a time or a span');
  // A compact row's monogram follows the title outside it, so the title is cut before the mark is.
  w = load({now: '2026-09-23T23:40:00'});
  rows = w.today();
  assert.ok(rows[0].classes.includes('happening') && !rows[0].classes.includes('compact'), 'the row happening now keeps two lines');
  const bill = w.$('today-list').children.find(el => el.textContent.includes('Pay: water bill'));
  assert.ok(bill, 'the overdue water bill is on screen');
  assert.ok(bill.classes.includes('compact'));
  assert.equal(bill.querySelector('.item-meta').textContent, 'Overdue');
  assert.ok(bill.querySelector('.item-body').children.some(el => el.classes.includes('avatar')));
});

test('Today keeps an empty time column only while another one-line row has a time to line up with', () => {
  const base = require('./fixtures').stress;
  const event = (id, title, start, end) => ({id, uid: id, title, calendar: 'family', start, end, allDay: false, location: ''});
  const chore = (id, title) => ({id, title, priority: 'p4', due: '2026-09-23', project: 'Chores', section: '', labels: '', recurring: false, assignee: ''});
  const tasks = {...base.tasks, tasks: [chore('c1', 'Trash to the curb'), chore('c2', 'Feed the fish')]};
  const day = extra => ({...base.calendar, events: [event('e1', 'Soccer practice', '2026-09-23T17:00:00', '2026-09-23T19:30:00'), ...extra]});
  const metaSpans = w => w.$('today-list').children.filter(el => el.classes.includes('compact')).map(el => !!el.querySelector('.item-meta'));
  // Soccer is happening, the chores have no time: nothing to line up with, so no gap between the circle and the title.
  let w = load({now: '2026-09-23T17:42:00', overrides: {'/api/calendar': day([]), '/api/tasks': tasks}});
  assert.deepEqual(metaSpans(w), [false, false]);
  // Two timed events later (one is the next row, the other one line): the chores keep the column, so the titles align.
  w = load({now: '2026-09-23T17:42:00', overrides: {'/api/calendar': day([event('e2', 'Dinner', '2026-09-23T19:45:00', '2026-09-23T20:30:00'), event('e3', 'Book club', '2026-09-23T21:00:00', '2026-09-23T22:00:00')]), '/api/tasks': tasks}});
  const compact = metaSpans(w);
  assert.ok(compact.length >= 2 && compact.every(Boolean), 'every one-line row keeps its time column: ' + JSON.stringify(compact));
});

test('An all-day event in a one-line row says "All day" when there is a time column to say it in (0.1.3)', () => {
  const base = require('./fixtures').stress;
  const event = (id, title, start, end, allDay = false) => ({id, uid: id, title, calendar: 'family', start, end, allDay, location: ''});
  const chore = {id: 'c1', title: 'Feed the fish', priority: 'p4', due: '2026-09-23', project: 'Chores', section: '', labels: '', recurring: false, assignee: ''};
  const tasks = {...base.tasks, tasks: [chore]};
  const soccer = event('e1', 'Soccer practice', '2026-09-23T17:00:00', '2026-09-23T19:30:00'), pictures = event('e0', 'June’s school picture day', '2026-09-23', '2026-09-24', true);
  const day = events => ({...base.calendar, events: [pictures, ...events]});
  const compact = w => w.$('today-list').children.filter(el => el.classes.includes('compact')).map(el => [w.row(el).title, el.querySelector('.item-meta') ? el.querySelector('.item-meta').textContent : null]);
  // Nothing timed among the one-line rows: no column at all, so the rail sits beside its title, as the circle does.
  let w = load({now: '2026-09-23T17:42:00', overrides: {'/api/calendar': day([soccer]), '/api/tasks': tasks}});
  assert.deepEqual(compact(w), [['June’s school picture day', null], ['Feed the fish', null]]);
  // With a time to line up with, the column stays and the all-day row fills it; an untimed chore leaves it empty.
  w = load({now: '2026-09-23T17:42:00', overrides: {'/api/calendar': day([event('e2', 'Dinner', '2026-09-23T19:45:00', '2026-09-23T20:30:00'), event('e3', 'Book club', '2026-09-23T21:00:00', '2026-09-23T22:00:00')]), '/api/tasks': tasks}});
  assert.deepEqual(compact(w), [['June’s school picture day', 'All day'], ['Book club', '9 PM'], ['Feed the fish', '']]);
  // "All day" alone is not a time to line up with, but a trip's span is.
  w = load({now: '2026-09-23T17:42:00', overrides: {'/api/calendar': day([soccer, event('e4', 'Theo in Chicago', '2026-09-22', '2026-09-26', true)]), '/api/tasks': tasks}});
  assert.deepEqual(compact(w).map(r => r[1]), ['All day', 'Until Fri', '']);
});

test('The clock is 12- or 24-hour as the household\'s country writes it, or as Settings says (GA-24)', () => {
  const house = country => ({'/api/household': {name: '', timezone: 'America/Chicago', place: 'Somewhere', ...(country ? {country} : {})}});
  const settings = clock => ({'/api/settings': {rest: 'calendar', restAfter: 5, mornings: 0, photoEvery: 60, appearance: 'auto', screen: 'auto', clock}});
  // A British household, on Automatic: every time on the wall is 24-hour.
  const stale = {...require('./fixtures').stress.calendar, stale: true};
  let w = load({now: '2026-09-24T22:58:00', overrides: {...house('GB'), '/api/calendar': stale}});
  assert.equal(w.$('clock').textContent, '22:58');
  assert.equal(w.$('ampm').hidden, true);
  assert.equal(w.$('stale-line').textContent, 'Calendar not updated since yesterday 17:39');
  w = load({now: '2026-09-23T22:58:00', overrides: house('GB')});
  const rows = w.today();
  assert.equal(rows[0].meta, '23:00 · in 2 min');
  assert.equal(rows[4].meta, '23:30');
  assert.ok(w.$('later-rows').textContent.includes('11:30'));
  assert.ok(!/AM|PM/.test(w.$('later-rows').textContent));
  const mornings = w.document.querySelectorAll('[data-setting]').find(el => el.getAttribute('data-setting') === 'mornings');
  assert.deepEqual(mornings.children.map(b => b.textContent), ['Off', 'Until 08:00', 'Until 09:00', 'Until 10:00']);
  assert.equal(w.$('mornings-note').textContent, 'Shows the calendar instead of photos from 04:00 until the time you\u00a0pick.');
  // An American household, and one whose country is not known yet, keep the 12-hour clock.
  for (const country of ['US', '']) {
    w = load({now: '2026-09-23T22:58:00', overrides: house(country)});
    assert.equal(w.$('clock').textContent, '10:58'); assert.equal(w.$('ampm').textContent, 'PM');
    assert.equal(w.today()[0].meta, '11 PM · in 2 min');
  }
  // Settings overrides the country either way.
  assert.equal(load({now: '2026-09-23T22:58:00', overrides: {...house('US'), ...settings('24')}}).$('clock').textContent, '22:58');
  assert.equal(load({now: '2026-09-23T22:58:00', overrides: {...house('DE'), ...settings('12')}}).$('clock').textContent, '10:58');
});

test('The wall\'s setup screens carry a QR code of the whole link, code and all, and the typed address beside it (D7)', () => {
  const qrOf = el => el && el.querySelector('svg') ? el.querySelector('svg').getAttribute('data-text') : null;
  // First run on a tablet that is its own server.
  const first = {'/api/household': {name: '', timezone: 'America/Chicago', needsSetup: true, address: 'http://192.168.4.23:4173', named: 'http://gingham.local:4173'},
    'POST /api/owner-code': {code: '3TW-9B8', expiresIn: 600}};
  let w = load({fixture: 'empty', now: '2026-09-23T10:00:00', overrides: first});
  w.every('firstRunStep');
  const strip = w.$('strip');
  assert.equal(qrOf(strip), 'http://192.168.4.23:4173/setup#code=3TW9B8', 'the numbers, which every phone reaches');
  assert.match(strip.textContent, /point your phone’s camera at this code/);
  assert.match(strip.textContent, /gingham\.local:4173\/setup/);
  assert.match(strip.textContent, /or 192\.168\.4\.23:4173\/setup/);
  assert.match(strip.textContent, /3TW-9B8/);
  // "Manage from a phone" at the wall, on that same tablet once someone looks after it: the phone-reachable address,
  // never the tablet's own 127.0.0.1.
  w = load({fixture: 'empty', now: '2026-09-23T10:00:00', overrides: {'/api/household': {name: '', timezone: 'America/Chicago', address: 'http://192.168.4.23:4173', named: 'http://gingham.local:4173'}, 'POST /api/owner-code': {code: 'KMN-234', expiresIn: 600}}});
  w.$('manage-button').click();
  for (const key of ['1', '2', '3', '4', 'OK']) w.$('keypad').children.find(b => b.textContent === key).click();
  w.server.flush();
  assert.equal(qrOf(w.$('manage-qr')), 'http://192.168.4.23:4173/setup#code=KMN234');
  assert.equal(w.$('manage-title').textContent, 'Point your phone’s camera at this code');
  assert.equal(w.$('manage-typed').textContent, 'No camera? Open gingham.local:4173/setup and enter the code.');
  assert.equal(w.$('manage-code').textContent, 'KMN-234');
});

test('Overdue chores come straight after the next thing, the two oldest of them; a longer backlog waits at the end (Riley, 2026-09-22)', () => {
  const titles = w => w.today().map(r => r.title);
  // 7:10 and 10:20 AM on the stress day: both overdue chores are on screen, right after the next row.
  let rows = load({now: '2026-09-23T07:10:00'}).today();
  assert.deepEqual(rows.slice(0, 3).map(r => r.title), ['Drop-off', 'Return: library books', 'Pay: water bill']);
  assert.deepEqual(rows.slice(1, 3).map(r => [r.meta, r.classes.includes('compact'), r.classes.includes('overdue')]), [['Overdue', true, true], ['Overdue', true, true]]);
  const busy = load({now: '2026-09-23T10:20:00'});
  assert.deepEqual(titles(busy).slice(2), ['Return: library books', 'Pay: water bill'], 'after now and next');
  // 8:00 AM on the 28th: nine chores are overdue. The two oldest move up; the other seven keep their place at the end,
  // so the next three hours still reach the screen.
  const monday = load({now: '2026-09-28T08:00:00'});
  assert.deepEqual(titles(monday), ['Standup', 'Return: library books', 'Pay: water bill', 'Dentist', 'Haircut']);
  monday.more().click();
  const sheet = monday.sheet().map(r => r.title);
  assert.equal(sheet.filter((t, i) => monday.sheet()[i].meta === 'Overdue').length, 9);
  assert.ok(sheet.indexOf('Clean: out fridge') > sheet.indexOf('Book club'), 'the rest of the backlog comes after the day');
});

// Updates (2026-09-22): a newer Gingham is said in Settings and nowhere else — at most a dot on the Settings button,
// and only when this frame can install it with a tap.
const release = {version: '0.1.2', notes: {lines: ['Lists can be reordered from the wall: hold an item, then drag it.', 'Countdowns name the day of the week once they are a week away.'], more: true}, url: 'https://github.com/rileysheehan/gingham/releases/tag/v0.1.2'};
const updates = (extra = {}) => ({version: '0.1.1', form: 'node', check: true, mayChange: true, locked: false, checkedAt: Date.parse('2026-09-23T14:05:00Z'), latest: release, available: true, howTo: 'Whoever runs this frame’s server updates it: download Gingham 0.1.2 from github.com/rileysheehan/gingham/releases and start the server again.', ...extra});
// Every piece of text on the page outside the Settings view, and Settings' own.
const outside = w => { const settings = w.$('view-settings'); const walk = el => el === settings ? '' : el.nodeType === 3 ? el.textContent : el.childNodes.map(walk).join(' '); return walk(w.document.body); };
// A fake of the app's bridge, whose install state a test moves along.
function appBridge(version = '0.1.1') {
  const b = {installed: [], state: {state: 'idle'}, opened: 0, cancelled: 0,
    ginghamApp: () => JSON.stringify({version, variant: '32bit', installs: true}),
    installUpdate(v) { b.installed.push(v); b.state = {state: 'permission', version: v}; },
    updateStatus: () => JSON.stringify(b.state),
    openInstallPermission() { b.opened++; }, cancelUpdate() { b.cancelled++; b.state = {state: 'idle'}; }};
  return b;
}
const text = el => el.textContent.replace(/\s+/g, ' ').trim();

test('A newer release shows in Settings and nowhere else on the wall', () => {
  for (const now of ['2026-09-23T07:10:00', '2026-09-23T22:58:00']) {
    const w = load({now, overrides: {'/api/updates': updates()}});
    assert.equal(w.$('update-card').hidden, false);
    assert.equal(w.$('update-title').textContent, 'Gingham 0.1.2 is available');
    assert.equal(w.$('update-version').textContent, 'Gingham 0.1.1');
    assert.equal(w.$('update-label').textContent, 'What’s new');
    assert.match(text(w.$('update-lines')), /Lists can be reordered from the wall/);
    assert.match(w.$('update-sub').textContent, /download Gingham 0\.1\.2 from github\.com\/rileysheehan\/gingham\/releases/, 'a plain server says how it is updated');
    assert.equal(w.$('update-actions').children.length, 0, 'no Install button where nothing can install');
    assert.equal(w.$('update-foot').textContent, 'The full notes are on github.com/rileysheehan/gingham/releases/tag/v0.1.2');
    assert.equal(w.$('update-dot').hidden, true, 'nothing this frame can do: not even a dot');
    // Nothing of it anywhere but Settings: not Today, not the week, not the notice line, not a toast.
    assert.doesNotMatch(outside(w), /0\.1\.2|is available|Gingham 0\.1|update/i);
    assert.equal(w.$('view-settings').hidden, true, 'and Settings is not opened for it');
    assert.equal(w.$('toast').hidden, true);
  }
});

test('Up to date, and turned off, say so in one line', () => {
  let w = load({now: '2026-09-23T15:40:00', overrides: {'/api/updates': updates({latest: {...release, version: '0.1.1'}, available: false})}});
  assert.equal(w.$('update-card').hidden, true);
  assert.equal(w.$('update-state').textContent, 'Up to date, checked 9:05 AM');
  assert.deepEqual(w.$('update-check').children.map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['On', 'true'], ['Off', 'false']]);
  const note = w.$('update-check').parentNode.parentNode.querySelector('.setting-note');
  assert.equal(note.textContent, 'Once a day this frame asks GitHub whether a newer Gingham exists. It sends nothing about your household.');
  // Off, by a tap: the server is told, and what it answers is shown.
  w = load({now: '2026-09-23T15:40:00', overrides: {'/api/updates': updates(), 'POST /api/updates': updates({check: false, latest: null, available: false, checkedAt: null, howTo: ''})}});
  w.$('update-check').children[1].click();
  w.server.flush();
  assert.equal(w.$('update-state').textContent, 'Not checking');
  assert.equal(w.$('update-card').hidden, true);
  assert.equal(w.$('update-check').children[1].getAttribute('aria-pressed'), 'true');
  // A shared server: the choice is its operator's, shown and not offered.
  w = load({now: '2026-09-23T15:40:00', overrides: {'/api/updates': updates({mayChange: false})}});
  assert.equal(w.$('update-check').hidden, true);
  assert.equal(w.$('update-locked').textContent, 'On, set by whoever runs this frame’s server');
});

test('In Gingham’s app: a dot on Settings, Install, the permission walk-through, progress, and failures in plain words', () => {
  const bridge = appBridge();
  const w = load({now: '2026-09-23T15:40:00', bridge, overrides: {'/api/updates': updates({form: 'app', app: '0.1.1', appAvailable: true, howTo: 'On this tablet, download gingham-either.apk from github.com/rileysheehan/gingham/releases and open it.'})}});
  assert.equal(w.$('update-dot').hidden, false, 'the one mark outside Settings');
  assert.equal(w.$('update-sub').textContent, 'Installs over this one. Your calendars, lists, photos and settings stay as they are.');
  const install = w.$('update-actions').children[0];
  assert.equal(install.textContent, 'Install');
  install.click();
  assert.deepEqual(bridge.installed, ['0.1.2'], 'the page names the version and nothing else');
  // Android's one-time permission, walked through.
  assert.equal(w.$('update-title').textContent, 'Let Gingham install its update');
  assert.deepEqual(w.$('update-lines').children.map(el => el.textContent), ['1Tap Open Android settings.', '2Turn on “Allow from this source”.', '3Come back with the back arrow. The update carries on by itself.']);
  w.$('update-actions').children[0].click();
  assert.equal(bridge.opened, 1);
  // Downloading, with how far.
  const reopen = () => { w.$('settings-button').click(); w.$('settings-button').click(); w.server.flush(); };
  bridge.state = {state: 'downloading', version: '0.1.2', done: 36 * 1048576, total: 88 * 1048576};
  reopen();
  assert.equal(w.$('update-title').textContent, 'Downloading Gingham 0.1.2');
  assert.equal(w.$('update-sub').textContent, '36 of 88 MB');
  assert.equal(w.$('update-progress').hidden, false);
  assert.equal(w.$('update-bar').style.width, '41%');
  assert.equal(w.$('update-actions').children[0].textContent, 'Cancel');
  // Every failure in plain words, each with a way to try again, and each saying nothing changed.
  const said = {
    checksum: 'The download didn’t match the checksum published with the release, so it was thrown away. Nothing on this frame changed.',
    network: 'The download stopped before it finished. Check the Wi-Fi, then try again. Nothing on this frame changed.',
    space: 'This tablet needs about 326 MB free for it. Free up some space, then try again. Nothing on this frame changed.',
    cancelled: 'The update was cancelled. Nothing on this frame changed.',
    install: 'Android didn’t install it. Android said: INSTALL_FAILED_UPDATE_INCOMPATIBLE Nothing on this frame changed.'
  };
  for (const [reason, sentence] of Object.entries(said)) {
    bridge.state = {state: 'failed', version: '0.1.2', reason, needMb: 326, detail: reason === 'install' ? 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' : ''};
    reopen();
    assert.equal(w.$('update-sub').textContent, sentence, reason);
    assert.equal(w.$('update-actions').children[0].textContent, reason === 'cancelled' ? 'Install' : 'Try again');
  }
  // Nothing of it outside Settings, even mid-install.
  w.$('settings-button').click();
  assert.doesNotMatch(outside(w), /0\.1\.2|download|install/i);
});

test('The calendar side turns dark or light at the same moment as the sky, never on a clock of its own', () => {
  // Riley, 2026-09-23: "the left side weather frame of gingham got bright in the morning before the right side calendar
  // did." The sky blends for an hour around sunrise and sunset; the theme used to flip at sunrise less ten minutes.
  const cream = 'rgb(253,246,238)';
  let flips = 0;
  for (const [from, to] of [[5 * 60, 8 * 60], [17 * 60, 21 * 60]]) {
    let last = null;
    for (let m = from; m <= to; m += 5) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0');
      const w = load({fixture: 'quiet', now: `2026-09-23T${hh}:${mm}:00`});
      const inkIsCream = w.document.documentElement.style.getPropertyValue('--sky-ink') === cream;
      const dark = w.document.body.className === 'theme-dark';
      assert.equal(dark, inkIsCream, `at ${hh}:${mm} the sky's ink and the calendar's theme disagree`);
      if (last !== null && last !== dark) flips++;
      last = dark;
    }
  }
  assert.equal(flips, 2, 'one change at dawn and one at dusk');
});

// 0.1.2: the days ahead as an agenda (a household setting), and this calendar week crossed off in the header.
const settingsWith = extra => ({'/api/settings': {rest: 'calendar', restAfter: 5, mornings: 0, photoEvery: 60, appearance: 'auto', screen: 'auto', clock: 'auto', ...extra}});
const agendaAt = (now, fixture = 'stress', overrides = {}) => load({fixture, now, overrides: {...settingsWith({calendarView: 'agenda'}), ...overrides}});
// The agenda as read from the wall: a day as its date and its rows' titles, a quiet line as its words, a month heading as
// "# October".
const agendaOf = w => w.$('agenda').children.map(el => el.classes.includes('agenda-day')
  ? {day: el.getAttribute('aria-label'), date: el.querySelector('.agenda-date').textContent, rows: el.querySelectorAll('.item').map(w.row)}
  : el.classes.includes('agenda-month') ? '# ' + el.textContent : el.textContent);

test('The agenda is one list from tomorrow, grouped by day, and Later folds into it', () => {
  const w = agendaAt('2026-09-23T15:40:00');
  assert.equal(w.$('agenda').hidden, false);
  assert.equal(w.$('strip').hidden, true, 'the columns give way to the list');
  assert.equal(w.$('later').hidden, true, 'one list, not two');
  const blocks = agendaOf(w);
  assert.equal(blocks[0].day, 'Thursday, September 24', 'Today is the left panel; the list starts tomorrow');
  assert.equal(blocks[0].date, '24Tomorrow');
  assert.deepEqual(blocks[0].rows.map(r => r.title), ['Theo in Chicago for work', 'Priya’s birthday', 'Gym', 'June to school', 'Design review', 'Lunch with Dana', 'Pickup', 'Dinner at the noodle place', 'Water: plants', '⚽️ Pack: soccer bag']);
  // Today's one-line rows: a time column that says when (how long a trip runs, or that it is all day), the title, whose it
  // is after it.
  const rows = blocks[0].rows;
  assert.ok(rows.every(r => r.classes.includes('compact')));
  assert.deepEqual(rows.slice(0, 4).map(r => r.meta), ['Until Fri', 'All day', '6 AM', '7:45 AM']);
  assert.ok(rows[0].classes.includes('continues'), 'a trip already under way reads as still going');
  const bag = w.$('agenda').querySelectorAll('.item').find(el => w.row(el).title.includes('soccer bag'));
  assert.ok(bag.querySelector('.item-body').children.some(el => el.classes.includes('avatar')), 'the monogram follows the title');
  assert.ok(!w.$('agenda').textContent.includes('flight pickup'), 'a timed event belongs to the day it starts');
  // What Later used to hold is in the list, on its day, under its month.
  assert.ok(blocks.includes('# October'));
  const october = blocks.indexOf('# October');
  assert.equal(blocks[october + 1].day, 'Thursday, October 1');
  assert.ok(blocks.some(b => b.day === 'Sunday, October 18' && b.rows[0].title === 'Halloween costume shopping'));
  assert.equal(blocks[blocks.length - 1], 'Nothing else planned through Oct 20', 'as far as the frame has the calendar, and it says so');
  // A private event keeps its broken rail in the list too.
  const monday = load({now: '2026-09-22T12:00:00', overrides: settingsWith({calendarView: 'agenda'})});
  assert.ok(agendaOf(monday)[0].rows.some(r => r.title === 'Busy' && r.classes.includes('busy')));
});

test('Empty days fold into one quiet line, by weekday this week and by date after it', () => {
  // Stress: a single empty Saturday.
  assert.ok(agendaOf(agendaAt('2026-09-23T15:40:00')).includes('Nothing planned Saturday'));
  // Sparse: nothing until Sunday, then nothing until October.
  let blocks = agendaOf(agendaAt('2026-09-23T15:40:00', 'sparse'));
  assert.deepEqual(blocks.map(b => typeof b === 'string' ? b : b.day), ['Nothing planned Thu–Sat', 'Sunday, September 27', 'Nothing planned Sep 28 – Oct 1', '# October', 'Friday, October 2', 'Nothing else planned through Oct 20']);
  // A run inside one month, past the coming week.
  assert.ok(agendaOf(agendaAt('2026-09-28T09:30:00')).includes('Nothing planned Oct 4–8'));
  // One empty day that is tomorrow.
  assert.equal(agendaOf(agendaAt('2026-09-25T09:30:00', 'sparse'))[0], 'Nothing planned tomorrow');
  // Nothing at all: one line, never a wall of empty days.
  assert.deepEqual(agendaOf(agendaAt('2026-09-23T15:40:00', 'empty')), ['Nothing planned through Oct 20']);
  assert.deepEqual(agendaOf(agendaAt('2026-10-02T16:00:00', 'quiet')), ['Nothing planned through Oct 20']);
});

test('The agenda reaches exactly as far as the calendar the frame has, and no further', () => {
  const extra = {...require('./fixtures').stress.calendar};
  extra.events = extra.events.concat([{id: 'x1', uid: 'x1', title: 'Past the window', calendar: 'mara', start: '2026-10-21T10:00:00-05:00', end: '2026-10-21T11:00:00-05:00', allDay: false, location: ''}]);
  const w = agendaAt('2026-09-23T15:40:00', 'stress', {'/api/calendar': extra});
  assert.ok(!w.$('agenda').textContent.includes('Past the window'));
  const days = agendaOf(w).filter(b => b.day).map(b => b.day);
  assert.equal(days[days.length - 1], 'Sunday, October 18');
  assert.equal(w.$('month').textContent, 'Sep – Oct', 'the title names what the list spans, short so the rail stays put');
  // Everything fits on one page when nothing is measured, so there is nowhere to page to.
  assert.equal(w.$('next').disabled, true);
});

test('The agenda is a household setting: chosen in Settings, saved on the server, never changed by itself', () => {
  const saved = [];
  const w = load({now: '2026-09-23T15:40:00', overrides: {'POST /api/settings': () => { saved.push('post'); return {rest: 'calendar', restAfter: 5, mornings: 0, photoEvery: 60, appearance: 'auto', screen: 'auto', clock: 'auto', calendarView: 'agenda'}; }}});
  assert.equal(w.$('agenda').hidden, true, 'Week is the default');
  const choice = w.document.querySelectorAll('[data-setting]').find(el => el.getAttribute('data-setting') === 'calendarView');
  assert.deepEqual(choice.children.map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['Week', 'true'], ['Agenda', 'false']]);
  assert.equal(choice.parentNode.firstChild.textContent, 'Calendar');
  choice.children[1].click();
  assert.equal(w.$('agenda').hidden, false, 'applies at once');
  w.server.flush();
  assert.deepEqual(saved, ['post'], 'and is saved');
  assert.equal(w.$('agenda').hidden, false);
  // A frame whose household chose it opens on it, and the resting view is named for the calendar, not the week.
  const again = agendaAt('2026-09-23T15:40:00');
  assert.equal(again.$('agenda').hidden, false);
  const rest = again.document.querySelectorAll('[data-setting]').find(el => el.getAttribute('data-setting') === 'rest');
  assert.deepEqual(rest.children.map(b => b.textContent), ['Photos', 'Calendar']);
});

// The rail as read from the wall: each mark's number and state ('x' crossed off, 'o' today, '.' ahead), '*' for a star.
const railOf = w => w.$('week-rail').children.map(el => el.textContent + (el.classes.includes('mark-over') ? 'x' : el.classes.includes('mark-now') ? 'o' : '.') + (el.classes.includes('starred') ? '*' : '')).join(' ');
const house = (country, extra = {}) => ({'/api/household': {name: '', timezone: 'America/Chicago', place: 'Somewhere', ...(country ? {country} : {}), ...extra}});

test('The week rail crosses off the days that are over, rings today, and starts the week as the household\'s country does', () => {
  const at = (country, now = '2026-09-23T15:40:00') => railOf(load({now, overrides: house(country)}));
  assert.equal(at('US'), '20x 21x 22x 23o 24. 25. 26.', 'Sunday to Saturday in the US');
  assert.equal(at(''), '20x 21x 22x 23o 24. 25. 26.', 'and where the country is not known yet');
  assert.equal(at('GB'), '21x 22x 23o 24. 25. 26. 27.', 'Monday to Sunday in Britain');
  assert.equal(at('DE'), '21x 22x 23o 24. 25. 26. 27.');
  assert.equal(at('EG'), '19x 20x 21x 22x 23o 24. 25.', 'Saturday to Friday in Egypt');
  // Sunday starts a fresh week in the US, and ends one in Britain.
  assert.equal(at('US', '2026-09-27T09:00:00'), '27o 28. 29. 30. 1. 2. 3.');
  assert.equal(at('GB', '2026-09-27T09:00:00'), '21x 22x 23x 24x 25x 26x 27o');
  // In both views, and with the same seven days whichever days the calendar is showing.
  const w = load({now: '2026-09-23T15:40:00', overrides: {...house('US'), ...settingsWith({calendarView: 'agenda'})}});
  assert.equal(w.$('week-rail').hidden, false);
  assert.equal(railOf(w), '20x 21x 22x 23o 24. 25. 26.');
  w.$('next').onclick();
  assert.equal(railOf(w), '20x 21x 22x 23o 24. 25. 26.');
  assert.match(w.$('week-rail').getAttribute('aria-label'), /^This week: Sunday 20, crossed off; .*Wednesday 23, today; Thursday 24; /);
  // Not on the first-run screen, where there is no household's week yet.
  const first = load({fixture: 'empty', now: '2026-09-23T10:00:00', overrides: {'/api/household': {name: '', timezone: 'America/Chicago', needsSetup: true, address: 'http://10.0.0.9:4173'}}});
  assert.equal(first.$('week-rail').hidden, true);
});

test('A day is crossed off when it ends at midnight house time, whatever the device\'s own clock says', () => {
  // The device is in London. 23:30 UTC is already Thursday there, and still Wednesday 6:30 PM in Austin.
  assert.equal(railOf(load({clock: '2026-09-23T23:30:00Z', overrides: house('US')})), '20x 21x 22x 23o 24. 25. 26.');
  // A minute to midnight in Austin, then midnight.
  assert.equal(railOf(load({clock: '2026-09-24T04:59:00Z', overrides: house('US')})), '20x 21x 22x 23o 24. 25. 26.');
  assert.equal(railOf(load({clock: '2026-09-24T05:00:00Z', overrides: house('US')})), '20x 21x 22x 23x 24o 25. 26.');
  // Saturday night crosses off six; the new week starts clean at midnight.
  assert.equal(railOf(load({clock: '2026-09-27T04:59:00Z', overrides: house('US')})), '20x 21x 22x 23x 24x 25x 26o');
  assert.equal(railOf(load({clock: '2026-09-27T05:00:00Z', overrides: house('US')})), '27o 28. 29. 30. 1. 2. 3.');
});

test('A countdown that lands this week puts a star on its day; one further off does not', () => {
  const counting = list => house('US', {countdowns: list});
  let w = load({now: '2026-09-23T15:40:00', overrides: counting([{name: "June's birthday", date: '2026-09-26', word: 'sleeps'}, {name: 'the zoo', date: '2026-10-03', word: 'sleeps'}])});
  assert.equal(railOf(w), '20x 21x 22x 23o 24. 25. 26.*');
  assert.equal(w.$('countdown').textContent, '3 sleeps until June’s birthday', 'the rail and the line under Today agree');
  assert.match(w.$('week-rail').getAttribute('aria-label'), /Saturday 26, June’s birthday$/);
  const mark = w.$('week-rail').children[6];
  assert.ok(mark.querySelector('svg'), 'a star, drawn');
  // On the day itself, today is ringed and starred.
  w = load({now: '2026-09-26T21:30:00', overrides: counting([{name: 'the pumpkin patch', date: '2026-09-26', word: 'sleeps'}])});
  assert.equal(railOf(w), '20x 21x 22x 23x 24x 25x 26o*');
  // Next week's is not this week's.
  w = load({now: '2026-09-23T15:40:00', overrides: counting([{name: 'the zoo', date: '2026-10-03', word: 'sleeps'}])});
  assert.ok(!railOf(w).includes('*'));
});

// 0.1.3: text size, a household setting, and a legend that holds any number of calendars.
test('Text size is a household setting: Standard unless chosen, applied at once, saved, and kept by the frame', () => {
  const saved = [];
  const w = load({now: '2026-09-23T15:40:00', overrides: {'POST /api/settings': () => { saved.push('post'); return {...settingsWith({textSize: 'larger'})['/api/settings'], calendarView: 'week'}; }}});
  assert.equal(w.document.documentElement.getAttribute('data-text'), 'standard', 'Standard is the default');
  const choice = w.document.querySelectorAll('[data-setting]').find(el => el.getAttribute('data-setting') === 'textSize');
  assert.deepEqual(choice.children.map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['Smaller', 'false'], ['Standard', 'true'], ['Larger', 'false']]);
  assert.equal(choice.parentNode.firstChild.textContent, 'Text size');
  assert.equal(choice.parentNode.parentNode.firstChild.textContent, 'Appearance');
  choice.children[2].click();
  assert.equal(w.document.documentElement.getAttribute('data-text'), 'larger', 'applies at once');
  w.server.flush();
  assert.deepEqual(saved, ['post'], 'and is saved on the server');
  assert.equal(w.document.documentElement.getAttribute('data-text'), 'larger');
  // A frame whose household chose it opens with it.
  const smaller = load({now: '2026-09-23T15:40:00', overrides: settingsWith({textSize: 'smaller'})});
  assert.equal(smaller.document.documentElement.getAttribute('data-text'), 'smaller');
  // The agenda's pages were laid out at the old size, so a new size starts it again from tomorrow.
  const agenda = agendaAt('2026-09-23T15:40:00');
  const sizes = agenda.document.querySelectorAll('[data-setting]').find(el => el.getAttribute('data-setting') === 'textSize');
  sizes.children[0].click();
  assert.equal(agenda.$('previous').disabled, true);
});

test('Text size reaches what is read and leaves the glance layer and the layout as they are', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../dist/style.css'), 'utf8');
  assert.match(css, /html\[data-text=smaller\]\{--ts:\.88\}/);
  assert.match(css, /html\[data-text=larger\]\{--ts:1\.12\}/);
  const rule = selector => { const at = css.indexOf('\n' + selector + '{'); assert.ok(at >= 0, selector); return css.slice(at, css.indexOf('}', at)); };
  // What is read follows it, and so do the rows and the time columns that hold it.
  for (const selector of ['.today .item.compact .item-meta', '.agenda .item-title', '.list-body .item-title', '.later-row', '.setting p', '.dialog p', '.item-meta', '.eyebrow'])
    assert.match(rule(selector), /var\(--ts\)/, selector + ' scales');
  // The glance layer and the frame's structure do not.
  for (const selector of ['.clock', '.today-weekday', '.now-temp', '.ahead-head h1,.list-head h1', '.day-name b', '.mark', '.legend', '.tabs button', '.forecast', '.ahead-head,.list-head', '.dock'])
    assert.doesNotMatch(rule(selector), /var\(--ts\)/, selector + ' stays');
});

// The legend as the wall shows it: its step, the names it shows, and its "N more".
const calendarsNamed = names => { const base = require('./fixtures').stress.calendar; return {'/api/calendar': {...base, calendars: names.map((name, i) => ({id: (base.calendars[i] || {id: 'c' + i}).id, name, color: '#4793e0'}))}}; };
const legendOf = w => ({step: w.$('legend').className, names: w.$('legend').children.filter(el => el.tagName === 'SPAN' && !el.hidden).map(el => el.textContent), more: (w.$('legend').querySelector('.legend-more') || {textContent: ''}).textContent});
const LONG = ['Mara’s work', 'Family', 'Theo', 'School events', 'June', 'Soccer club', 'Grandma Rose', 'US Holidays'];

test('The legend steps down to fit the header, and past three tight lines keeps whole names and ends in "N more"', () => {
  // The fixture's three calendars on the first page: the normal legend.
  let w = load({now: '2026-09-28T09:30:00'});
  assert.deepEqual(legendOf(w), {step: 'legend', names: ['Mara', 'Family', 'Theo'], more: ''});
  // Eight short names beside Today: smaller and closer, every name shown.
  const SHORT = ['Mara', 'Family', 'Theo', 'School', 'June', 'Soccer', 'Grandma', 'Holidays'];
  w = load({now: '2026-09-28T09:30:00', overrides: calendarsNamed(SHORT)});
  w.$('next').click();
  assert.equal(w.$('back-today').hidden, false);
  assert.deepEqual(legendOf(w), {step: 'legend tight', names: SHORT, more: ''});
  // Eight long names beside Today: the names that fit, whole, then how many more.
  w = load({now: '2026-09-28T09:30:00', overrides: calendarsNamed(LONG)});
  const first = legendOf(w);
  w.$('next').click();
  const paged = legendOf(w);
  assert.equal(paged.step, 'legend tight');
  assert.ok(paged.names.length >= 4 && paged.names.length < LONG.length, 'some names, not all: ' + paged.names.join(', '));
  assert.deepEqual(paged.names, LONG.slice(0, paged.names.length), 'in order, the first ones');
  assert.equal(paged.more, (LONG.length - paged.names.length) + ' more');
  // With no Today button there is more room, and more names; going back to the first page gives them back.
  assert.ok(first.names.length > paged.names.length, first.names.length + ' names, against ' + paged.names.length + ' beside Today');
  w.$('back-today').click();
  assert.deepEqual(legendOf(w), first);
});

test('The legend\'s "N more" opens every calendar with its colour, and closes like any sheet', () => {
  const w = load({now: '2026-09-28T09:30:00', overrides: calendarsNamed([...LONG, 'Piano lessons'])});
  w.$('next').click();
  const more = w.$('legend').querySelector('.legend-more');
  assert.ok(more, 'too many for the header');
  assert.match(more.getAttribute('aria-label'), /^\d+ more calendars$/);
  more.click();
  assert.equal(w.$('legend-dialog').hidden, false);
  assert.deepEqual(w.$('legend-list').children.map(el => el.textContent), [...LONG, 'Piano lessons']);
  assert.ok(w.$('legend-list').children.every(el => el.querySelector('i').style.backgroundColor === '#4793e0'), 'each with its colour');
  w.$('close-legend').click();
  assert.equal(w.$('legend-dialog').hidden, true);
});

// The play page (DESIGN.md → "A play page, for one household"): holding the clock for three seconds opens a page the
// household's settings.json names; for every other household the clock is only a clock.
const PLAY = {url: 'https://example.com/play/', returnAfterMinutes: 3};
const playWall = (playPage, bridge) => load({now: '2026-09-23T15:40:00', bridge, overrides: settingsWith(playPage === undefined ? {} : {playPage})});
const clockOf = w => w.document.querySelector('.clock');
const touch = (x = 200, y = 300) => ({touches: [{clientX: x, clientY: y}]});

test('Play page: without one in the household\'s settings, holding the clock does nothing and shows nothing', () => {
  const w = playWall(undefined), clock = clockOf(w);
  clock.fire('touchstart', touch());
  assert.equal(w.due('playCue'), 0, 'no cue is even scheduled');
  assert.equal(w.due('playHeld'), 0);
  assert.equal(clock.hasAttribute('data-hold'), false);
  assert.equal(w.window.assigned, undefined);
  clock.fire('mousedown', {button: 0, clientX: 10, clientY: 10});
  assert.equal(w.due('playHeld'), 0, 'nor with a mouse');
});

test('Play page: a three-second hold on the clock goes there, with a quiet cue from the first second', () => {
  const w = playWall(PLAY), clock = clockOf(w);
  clock.fire('touchstart', touch());
  assert.equal(clock.hasAttribute('data-hold'), false, 'nothing changes at the touch itself');
  assert.equal(w.due('playCue'), 1);
  assert.equal(clock.hasAttribute('data-hold'), true, 'one second in, the clock dims');
  clock.fire('touchmove', touch(210, 305));
  assert.equal(w.due('playHeld'), 1, 'a finger that rests a little unevenly still holds');
  assert.equal(w.window.assigned, PLAY.url, 'in a browser, the page opens in this tab');
  assert.equal(clock.hasAttribute('data-hold'), false, 'and the cue is gone');
});

test('Play page: a tap, a scroll, a second finger or letting go early ends the hold', () => {
  const cases = {
    'a tap': c => c.fire('touchend'),
    'a scroll': c => c.fire('touchmove', touch(200, 360)),
    'a swipe': c => c.fire('touchmove', touch(260, 300)),
    'a second finger': c => c.fire('touchmove', {touches: [{clientX: 200, clientY: 300}, {clientX: 400, clientY: 300}]}),
    'the system taking the touch': c => c.fire('touchcancel')
  };
  for (const [name, end] of Object.entries(cases)) {
    const w = playWall(PLAY), clock = clockOf(w);
    clock.fire('touchstart', touch());
    w.due('playCue');
    end(clock);
    assert.equal(clock.hasAttribute('data-hold'), false, name + ': the cue goes');
    assert.equal(w.due('playHeld'), 0, name + ': nothing opens');
    assert.equal(w.window.assigned, undefined, name);
  }
  const w = playWall(PLAY), clock = clockOf(w);
  clock.fire('touchstart', {touches: [{clientX: 1, clientY: 1}, {clientX: 2, clientY: 2}]});
  assert.equal(w.due('playHeld'), 0, 'two fingers down at once never start one');
});

test('Play page: in Gingham\'s app the app opens it, and the page hands it no address', () => {
  const bridge = {...appBridge(), plays: 0};
  bridge.openPlayPage = function () { bridge.plays++; assert.equal(arguments.length, 0); };
  const w = playWall(PLAY, bridge), clock = clockOf(w);
  clock.fire('touchstart', touch());
  w.due('playHeld');
  assert.equal(bridge.plays, 1);
  assert.equal(w.window.assigned, undefined, 'the wall does not navigate itself');
  // Fully Kiosk has a bridge by the same name but no play page: the wall goes there itself.
  const fully = {setScreenBrightness() {}}, k = playWall(PLAY, fully);
  clockOf(k).fire('touchstart', touch());
  k.due('playHeld');
  assert.equal(k.window.assigned, PLAY.url);
});

test('Play page: the wall trusts only an https address, and Settings says nothing about it', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'http://example.com/', '//example.com/']) {
    const w = playWall({url, returnAfterMinutes: 3}), clock = clockOf(w);
    clock.fire('touchstart', touch());
    assert.equal(w.due('playHeld'), 0, url);
    assert.equal(w.window.assigned, undefined, url);
  }
  const w = playWall(PLAY);
  w.$('settings-button').click(); w.server.flush();
  assert.doesNotMatch(w.document.body.textContent, /example\.com|play/i);
});

test('Play page: the browser\'s own long press is held back only where there is a play page', () => {
  const menu = w => { let prevented = false; clockOf(w).fire('contextmenu', {preventDefault() { prevented = true; }}); return prevented; };
  assert.equal(menu(playWall(PLAY)), true, 'with one, no menu or selection interrupts the hold');
  assert.equal(menu(playWall(undefined)), false, 'without one, the clock behaves as it always has');
  assert.equal(clockOf(playWall(PLAY)).hasAttribute('data-play'), true, 'with one, the digits cannot be selected');
  assert.equal(clockOf(playWall(undefined)).hasAttribute('data-play'), false, 'without one, they can, as always');
});
