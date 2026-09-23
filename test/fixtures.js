// Canned API responses for design review: `FRAME_FIXTURE=stress PORT=4174 HOST=127.0.0.1 node server.js`, then open
// http://127.0.0.1:4174/?now=2026-09-23T17:40:00. "stress" is built to break layouts (long titles, a packed day,
// multi-day and past-midnight events, overdue chores, a 34-item list, an empty list); "quiet" mirrors a sparse
// week; "sparse" has nothing today or tomorrow; "empty" has nothing at all; "offline" has every source down. The live service never loads this file.
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
  // Four empty weeks.
  empty: {
    calendar: {mode: 'live', calendars, events: [], from: '2026-09-23', to: '2026-10-21', updatedAt: stamp},
    tasks: {projects: ['Family', 'Chores', 'Grocery', 'June'], people, lists: lists(['Family', 'Chores', 'Grocery', 'June']), tasks: [], updatedAt: stamp},
    weather: {location: 'Springfield', temperature: 84, feelsLike: 86, code: 0, high: 94, low: 75, rain: 0, days: weatherDays([0, 0, 1, 0, 2, 3, 0, 0], 94, 73, []), fetchedAt: Date.now()},
    photos: 'album'
  },
  offline: {calendar: null, tasks: null, weather: null, photos: null}
};
