// Things a household is counting down to: a birthday, a trip, the last day of school. Each is a name and a day; a
// yearly one comes round again by itself. The frame is told only what is still ahead, soonest first.
const MAX = 12, HORIZON_DAYS = 99;
const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day || '') && !Number.isNaN(Date.parse(day + 'T00:00:00Z')) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day;
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

// The next time a day comes round, on or after today. Someone born on 29 February has their day on the 28th in
// the years that have no 29th.
function nextYearly(day, today) {
  const [, month, date] = day.split('-').map(Number);
  for (let year = Number(today.slice(0, 4)); year <= Number(today.slice(0, 4)) + 1; year++) {
    const leapless = month === 2 && date === 29 && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1;
    const candidate = year + '-' + String(month).padStart(2, '0') + '-' + String(leapless ? 28 : date).padStart(2, '0');
    if (candidate >= today) return candidate;
  }
  return null;
}
// What the frame shows: those still ahead and near enough to be worth a line, soonest first.
function upcoming(countdowns, today) {
  return (Array.isArray(countdowns) ? countdowns : []).filter(c => c && validDay(c.date) && c.name)
    .map(c => ({name: String(c.name).slice(0, 40), date: c.yearly ? nextYearly(c.date, today) : c.date, word: c.word === 'days' ? 'days' : 'sleeps'}))
    .filter(c => c.date && c.date >= today && daysBetween(today, c.date) <= HORIZON_DAYS)
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}
module.exports = {upcoming, nextYearly, validDay, daysBetween, MAX};
