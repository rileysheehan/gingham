// Canned API responses for design review: `FRAME_FIXTURE=stress PORT=4174 HOST=127.0.0.1 node server.js`, then open
// http://127.0.0.1:4174/?now=2026-09-23T17:40:00. "stress" is built to break layouts (long titles, a packed day,
// multi-day and past-midnight events, overdue chores, a 34-item list, an empty list); "quiet" mirrors a sparse
// week; "sparse" has nothing today or tomorrow; "empty" has nothing at all; "offline" has every source down. "evening"
// is a Wednesday whose last timed thing is over by dinner, with a real Thursday ahead; "dinner" is "stress" with
// tonight's dinner written as a chore. The live service never loads this file.
const calendars = [{id: 'mara', name: 'Mara', color: '#4793e0'}, {id: 'family', name: 'Family', color: '#b37dcc'}, {id: 'theo', name: 'Theo', color: '#38977b'}];
let n = 0;
const at = (day, time) => '2026-' + day + 'T' + time + ':00-05:00';
const timed = (cal, title, day, start, end, location = '', endDay = day) => ({id: 'e' + (++n), uid: 'e' + n, title, calendar: cal, start: at(day, start), end: at(endDay, end), allDay: false, location});
const allDay = (cal, title, first, afterLast) => ({id: 'e' + (++n), uid: 'e' + n, title, calendar: cal, start: '2026-' + first, end: '2026-' + afterLast, allDay: true, location: ''});
const task = (project, title, due = '', extra = {}) => ({id: 't' + (++n), title, priority: 'p4', due, project, section: '', labels: '', recurring: false, assignee: '', ...extra});
const people = {'1': {name: 'Mara', color: '#4793e0'}, '2': {name: 'Theo', color: '#38977b'}};
const stamp = '2026-09-23T22:39:00.000Z';
// An invented household, the Ashbys: household lists carry a glyph, June's list is a young child's, and each subhead is a list description.
const subheads = {Family: 'For the home and the whole family', Chores: 'Everything on a schedule', Grocery: 'The shopping list, by aisle', June: 'June’s own tasks'};
const lists = names => names.map(name => ({name, icon: {Family: 'home', Chores: 'repeat', Grocery: 'cart'}[name] || 'list', person: name === 'June', kid: name === 'June', color: name === 'June' ? '#e0823d' : '', description: subheads[name] || ''}));

const stressEvents = [
  allDay('theo', 'Theo in Chicago for work', '09-22', '09-26'),
  allDay('family', 'June’s school picture day', '09-23', '09-24'),
  timed('mara', 'Drop-off', '09-23', '07:30', '08:15'),
  {...timed('theo', 'Busy', '09-23', '10:00', '11:00'), private: true, busy: true},
  timed('family', 'Lunch with the Montgomery-Abernathy family', '09-23', '12:00', '13:00', 'Maple Street Pizza, 1200 Maple Street, Springfield'),
  timed('family', 'Soccer practice', '09-23', '17:30', '18:30', 'Northside Fields, 40 Park Road'),
  timed('mara', 'Pediatric dentist appointment for June with Dr. Priya Ramaswamy-Whitfield (bring the insurance card and the new referral form)', '09-23', '19:15', '20:00', 'Springfield Pediatric Dentistry, 2000 Oak Avenue, Springfield'),
  timed('theo', 'Late flight pickup at the airport', '09-23', '23:30', '00:30', 'Springfield Regional Airport', '09-24'),
  allDay('mara', 'Priya’s birthday', '09-24', '09-25'),
  timed('mara', 'Gym', '09-24', '06:00', '07:00'),
  timed('family', 'June to school', '09-24', '07:45', '08:15'),
  timed('mara', 'Design review', '09-24', '09:30', '10:30'),
  timed('theo', 'Lunch with Dana', '09-24', '12:30', '13:30'),
  timed('family', 'Pickup', '09-24', '15:00', '15:30'),
  timed('family', 'Dinner at the noodle place', '09-24', '18:00', '19:30', 'Golden Noodle, 88 Market Street'),
  timed('mara', 'Coffee with Sam', '09-25', '11:30', '12:30'),
  timed('mara', 'Grandpa Joe’s retirement party', '09-27', '14:00', '15:30', 'The Lakeside Hall, 12 Shore Drive'),
  timed('mara', 'Standup', '09-28', '08:30', '08:45'), timed('mara', 'Dentist', '09-28', '09:00', '10:00'), timed('theo', 'Haircut', '09-28', '10:30', '11:15'),
  timed('family', 'June swim lesson', '09-28', '11:30', '12:00'), timed('mara', 'Lunch with Marcus', '09-28', '12:15', '13:15'), timed('mara', 'Roadmap planning', '09-28', '13:30', '15:00'),
  timed('family', 'Pickup', '09-28', '15:15', '15:45'), timed('theo', 'Book club', '09-28', '18:30', '20:00'), timed('mara', 'Call with Mom', '09-28', '20:30', '21:00'),
  timed('family', 'Supercalifragilisticexpialidocious-reading-club', '09-29', '16:00', '17:00'),
  timed('mara', 'Coffee with Sam', '10-02', '11:30', '12:30'), timed('family', 'June’s birthday party', '10-03', '16:00', '18:00', 'Lucky Lanes, 300 Lake Road'),
  allDay('mara', 'Denver trip', '10-09', '10-12'), timed('family', 'Parent-teacher conference', '10-14', '16:30', '17:00'), timed('theo', 'Halloween costume shopping', '10-18', '10:00', '12:00')
];
const grocerySections = {'Produce': ['Bananas', 'Honeycrisp apples', 'Baby spinach', 'Avocados (ripe for Saturday guacamole)', 'Limes', 'Cilantro', 'Yellow onions'], 'Dairy + Eggs': ['Shredded cheese', 'Mozz', 'Greek yogurt', 'Large eggs, two dozen', 'Oat milk'], 'Meat': ['Chicken thighs', 'Ground beef'], 'Dry Goods': ['Shirodashi', 'Jasmine rice', 'Tortillas', 'Pasta', 'Peanut butter', 'Everything bagel seasoning'], 'Drinks': ['Ginger beer', 'Sparkling water'], 'Miscellaneous': ['Sponges', 'Wipes', 'Halloweiners Candy', 'Dish detergent', 'Dish soap', 'Paper towels', 'Trash bags (13 gallon, drawstring)', 'Aluminum foil', 'Ziploc freezer bags gallon', 'Batteries AA', 'Light bulbs']};
const stressTasks = [
  task('Family', 'Pay: water bill', '2026-09-21', {assignee: '1'}), task('Family', 'Return: library books', '2026-09-19', {assignee: '2'}),
  task('Family', 'Schedule: HVAC maintenance before the first cold front, and ask about the upstairs airflow'),
  task('Chores', 'Clean: out fridge', '2026-09-23T21:00:00', {recurring: true, assignee: '2'}), task('Chores', 'Take: trash to street', '2026-09-23T23:00:00', {recurring: true}),
  task('Chores', 'Take: recycling to street', '2026-09-23T23:00:00', {recurring: true}), task('Chores', 'Water: plants', '2026-09-24', {recurring: true}),
  task('Chores', 'Return: trash cans', '2026-09-25', {recurring: true}), task('Chores', 'Plan: meals'), task('Chores', 'Buy: groceries'), task('Chores', 'Wash: sheets'),
  task('Chores', 'Do: Laundry'), task('Chores', 'Do: June’s laundry'), task('Chores', 'Vacuum: stairs'), task('Chores', 'Clean: bathrooms'),
  task('June', '🎹 Practice: piano', '2026-09-23T16:00:00', {recurring: true}), task('June', '⚽️ Pack: soccer bag', '2026-09-24'), task('June', '📚 Return: library book', '2026-10-01'), task('June', '🦷 Brush teeth', '', {recurring: true}),
  ...Object.entries(grocerySections).flatMap(([section, items]) => items.map((title, i) => task('Grocery', title, '', {section, labels: section === 'Miscellaneous' && i % 2 ? 'Costco' : ''})))
];
// What the household counts down to, as the server hands it to the frame: one this week (the Saturday of the fixtures'
// week) and June's birthday the week after, so the week rail has a star to show on either side of the weekend.
const countdowns = [{name: 'the pumpkin patch', date: '2026-09-26', word: 'sleeps'}, {name: 'June’s birthday', date: '2026-10-03', word: 'sleeps'}];
const weatherDays = (codes, high, low, rain) => codes.map((code, i) => ({date: '2026-09-' + (23 + i), code, high: high + (i % 3), low: low - (i % 2), rain: rain[i] || 0, sunrise: Date.UTC(2026, 8, 23 + i, 12, 17), sunset: Date.UTC(2026, 8, 24 + i, 0, 29)}));

module.exports = {
  stress: {
    calendar: {mode: 'live', calendars, events: stressEvents, from: '2026-09-23', to: '2026-10-21', updatedAt: stamp},
    tasks: {projects: ['Family', 'Chores', 'Grocery', 'Garage', 'June'], people, lists: lists(['Family', 'Chores', 'Grocery', 'Garage', 'June']), tasks: stressTasks, updatedAt: stamp},
    weather: {location: 'Springfield', temperature: 101, feelsLike: 108, code: 95, high: 104, low: 79, rain: 80, days: weatherDays([95, 61, 3, 0, 2, 45, 80, 71], 101, 76, [80, 60, 10, 0, 20, 30, 70, 40]), fetchedAt: Date.now()},
    photos: 'album', countdowns
  },
  quiet: {
    calendar: {mode: 'live', calendars, events: [allDay('mara', 'Priya’s birthday', '09-24', '09-25'), timed('mara', 'Coffee with Sam', '09-25', '11:30', '12:30'), timed('mara', 'Grandpa Joe’s retirement party', '09-27', '14:00', '15:30')], from: '2026-09-23', to: '2026-10-21', updatedAt: stamp},
    tasks: {projects: ['Family', 'Chores', 'Grocery', 'June'], people, lists: lists(['Family', 'Chores', 'Grocery', 'June']), tasks: [task('Chores', 'Return: trash cans', '2026-09-25', {recurring: true}), task('Grocery', 'Ginger beer', '', {section: 'Drinks'})], updatedAt: stamp},
    weather: {location: 'Springfield', temperature: 84, feelsLike: 90, code: 2, high: 94, low: 75, rain: 0, days: weatherDays([2, 3, 3, 0, 1, 2, 3, 0], 94, 73, []), fetchedAt: Date.now()},
    photos: 'album', countdowns
  },
  // Nothing today or tomorrow, something later: the left panel should say what is next rather than sit empty.
  sparse: {
    calendar: {mode: 'live', calendars, events: [timed('mara', 'Grandpa Joe’s retirement party', '09-27', '14:00', '15:30', 'The Lakeside Hall, 12 Shore Drive'), timed('mara', 'Coffee with Sam', '10-02', '11:30', '12:30')], from: '2026-09-23', to: '2026-10-21', updatedAt: stamp},
    tasks: {projects: ['Family', 'Chores', 'Grocery', 'June'], people, lists: lists(['Family', 'Chores', 'Grocery', 'June']), tasks: [task('Grocery', 'Ginger beer', '', {section: 'Drinks'})], updatedAt: stamp},
    weather: {location: 'Springfield', temperature: 84, feelsLike: 86, code: 0, high: 94, low: 75, rain: 0, days: weatherDays([0, 0, 1, 0, 2, 3, 0, 0], 94, 73, []), fetchedAt: Date.now()},
    photos: 'album', countdowns
  },
  // An ordinary Wednesday evening: soccer is over by 6:30 and the trash went out late (overdue by 8:40 PM), so nothing
  // timed is left today; Thursday has a birthday, school at 7:45, a design review and June's soccer bag, under rain.
  // A grandparent's birthday in October reaches Later.
  evening: {
    calendar: {mode: 'live', calendars, events: [timed('family', 'Soccer practice', '09-23', '17:30', '18:30', 'Northside Fields, 40 Park Road'), allDay('mara', 'Priya’s birthday', '09-24', '09-25'), timed('family', 'June to school', '09-24', '07:45', '08:15'), timed('mara', 'Design review', '09-24', '09:30', '10:30'), timed('mara', 'Coffee with Sam', '09-25', '11:30', '12:30'), timed('mara', 'Grandpa Joe’s retirement party', '09-27', '14:00', '15:30'), allDay('family', 'Grandma Rosa’s birthday', '10-05', '10-06')], from: '2026-09-23', to: '2026-10-21', updatedAt: stamp},
    tasks: {projects: ['Family', 'Chores', 'Grocery', 'June'], people, lists: lists(['Family', 'Chores', 'Grocery', 'June']), tasks: [task('Chores', 'Take: trash to street', '2026-09-23T19:00:00', {recurring: true}), task('June', '⚽️ Pack: soccer bag', '2026-09-24'), task('Grocery', 'Ginger beer', '', {section: 'Drinks'})], updatedAt: stamp},
    weather: {location: 'Springfield', temperature: 81, feelsLike: 84, code: 1, high: 94, low: 75, rain: 0, days: weatherDays([1, 61, 3, 0, 1, 2, 3, 0], 94, 72, [0, 70]), fetchedAt: Date.now()},
    photos: 'album', countdowns
  },
  // Four empty weeks.
  empty: {
    calendar: {mode: 'live', calendars, events: [], from: '2026-09-23', to: '2026-10-21', updatedAt: stamp},
    tasks: {projects: ['Family', 'Chores', 'Grocery', 'June'], people, lists: lists(['Family', 'Chores', 'Grocery', 'June']), tasks: [], updatedAt: stamp},
    weather: {location: 'Springfield', temperature: 84, feelsLike: 86, code: 0, high: 94, low: 75, rain: 0, days: weatherDays([0, 0, 1, 0, 2, 3, 0, 0], 94, 73, []), fetchedAt: Date.now()},
    photos: 'album'
  },
  offline: {calendar: null, tasks: null, weather: null, photos: null}
};
// The packed day again, with tonight's dinner written as a chore, the way a household writes "Verb: object".
module.exports.dinner = {...module.exports.stress, tasks: {...module.exports.stress.tasks, tasks: [task('Chores', 'Dinner: tacos al pastor', '2026-09-23'), ...stressTasks]}};
// Screen time (rewards.js) for June, the Ashbys' youngest, on the fixtures' Wednesday at 5:40 PM: a 30-minute day, 15 minutes
// earned, 5 taken away and a ten-minute timer, so 30 are left. The other states change only the timer: one running since
// 5:25 PM, one started at 5 PM that time's up stopped at 5:30 (the server stops it on reading), and a day used up. "screen-newday" is five past midnight, after a timer that
// was still running at midnight. The server keeps these in memory on the fixture's own clock (server.js).
const st = (time, day = '09-23') => '2026-' + day + 'T' + time + ':00-05:00';
const juneDay = extra => ({allowance: 30, timer: null, ...extra, entries: [
  {id: 'e1', at: st('15:00'), kind: 'earn', minutes: 10, reason: 'chores'},
  {id: 'e2', at: st('15:30'), kind: 'earn', minutes: 5, reason: 'reading'},
  {id: 'e3', at: st('16:00'), kind: 'adjust', minutes: -5},
  {id: 'e4', at: st('16:20'), kind: 'timer', seconds: 600, from: st('16:10')},
  ...((extra && extra.entries) || [])]});
const screenTime = (day, clock) => ({clock, data: {people: [{id: 'june', name: 'June', on: true, allowance: 30, days: day}]}});
module.exports.screen = {...module.exports.stress, rewards: screenTime({'2026-09-23': juneDay()})};
module.exports['screen-running'] = {...module.exports.stress, rewards: screenTime({'2026-09-23': juneDay({timer: {since: st('17:25')}})})};
module.exports['screen-over'] = {...module.exports.stress, rewards: screenTime({'2026-09-23': juneDay({timer: {since: st('17:00')}})})};
module.exports['screen-none'] = {...module.exports.stress, rewards: screenTime({'2026-09-23': juneDay({entries: [{id: 'e5', at: st('17:10'), kind: 'timer', seconds: 1800, from: st('16:40')}]})})};
// A day the build before time's up let run past its total: a 50-minute timer against 40, kept as it was recorded.
module.exports['screen-oldover'] = {...module.exports.stress, rewards: screenTime({'2026-09-23': juneDay({entries: [{id: 'e5', at: st('17:31'), kind: 'timer', seconds: 3000, from: st('16:41')}]})})};
module.exports['screen-newday'] = {...module.exports.stress, rewards: screenTime({'2026-09-23': juneDay({timer: {since: st('23:40')}})}, st('00:05', '09-24'))};
// The seconds on the ring (MER-2089), each on a still clock at 5:40 PM: a timer on for 30:00, 24:37, 0:42 and, with 35
// minutes more earned, 1:04:37 left; one that time's up stopped 1:12 ago (so a page loading now chimes); and stopped
// at 24:37 and on a whole 25.
const sec = time => '2026-09-23T' + time + '-05:00';
const stillDay = (extra, entries = []) => ({...module.exports.stress, rewards: {still: true, data: {people: [{id: 'june', name: 'June', on: true, allowance: 30, days: {'2026-09-23': {...juneDay({...extra, entries}), allowance: 30}}}]}}});
const earnedMore = [{id: 'e6', at: st('17:00'), kind: 'earn', minutes: 35, reason: 'chores'}];
module.exports['screen-s3000'] = stillDay({timer: {since: sec('17:40:00')}});
module.exports['screen-s2437'] = stillDay({timer: {since: sec('17:34:37')}});
module.exports['screen-s0042'] = stillDay({timer: {since: sec('17:10:42')}});
module.exports['screen-s10437'] = stillDay({timer: {since: sec('17:39:37')}}, earnedMore);
module.exports['screen-sover'] = stillDay({timer: {since: sec('17:08:48')}});
module.exports['screen-stop2437'] = stillDay({}, [{id: 'e7', at: st('17:30'), kind: 'timer', seconds: 323, from: sec('17:24:37')}]);
module.exports['screen-stop25'] = stillDay({}, [{id: 'e7', at: st('17:30'), kind: 'timer', seconds: 300, from: st('17:25')}]);
