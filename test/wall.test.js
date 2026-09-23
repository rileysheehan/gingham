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
  assert.equal(w.$('mornings-note').textContent, 'Shows the week instead of photos from 04:00 until the time you pick.');
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
