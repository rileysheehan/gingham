// Household preferences the frame's Settings view can change, kept on the server (settings.json in the household's folder) so they survive a
// browser reset on the frame. Only the listed values are accepted; anything else is ignored rather than stored.
const fs = require('node:fs');
const path = require('node:path');

const OPTIONS = {
  rest: ['photos', 'calendar'],          // what the frame shows when no one is using it
  restAfter: [2, 5, 10, 15, 30],         // minutes of quiet before it goes there
  mornings: [0, 8, 9, 10],               // show the week from 4 AM until this hour; 0 is off
  photoEvery: [30, 60, 120, 300],        // seconds per photo
  appearance: ['auto', 'light', 'dark'], // auto follows sunrise and sunset where the household lives
  screen: ['auto', 'bright', 'dim'],     // backlight: with the sun, always bright, or always dim
  clock: ['auto', '12', '24'],           // auto is the convention of the household's country; 12-hour until that is known
  calendarView: ['week', 'agenda'],      // the days ahead as six columns, or as one list grouped by day
  textSize: ['smaller', 'standard', 'larger'] // what is read scales, rows with it; the glance layer and the layout do not
};
const DEFAULTS = {rest: 'photos', restAfter: 5, mornings: 0, photoEvery: 60, appearance: 'auto', screen: 'auto', clock: 'auto', calendarView: 'week', textSize: 'standard'};

function clean(input) {
  const out = {};
  for (const [key, allowed] of Object.entries(OPTIONS)) if (input && allowed.includes(input[key])) out[key] = input[key];
  return out;
}

// The play page (DESIGN.md → "A play page, for one household"): a web page the household's own frame may open full
// screen from a long press on the clock. It is set only by editing settings.json on the server, never through
// POST /api/settings, so nothing on the home network can point the wall somewhere else. Absent unless someone writes
// it, and dropped whole if it is not a plain https address. {url, returnAfterMinutes} — minutes of no touch before
// the app goes back to the wall, 3 unless given.
const PLAY_RETURN = {min: 1, max: 30, fallback: 3};
function cleanPlayPage(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || value.url.length > 2000) return null;
  let url;
  try { url = new URL(value.url.trim()); } catch (e) { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  const minutes = value.returnAfterMinutes;
  const returnAfterMinutes = Number.isInteger(minutes) && minutes >= PLAY_RETURN.min && minutes <= PLAY_RETURN.max ? minutes : PLAY_RETURN.fallback;
  return {url: url.href, returnAfterMinutes};
}
// What the household's file says, as the frame may see it: the listed choices, and the play page if it is valid.
function fromFile(input) {
  const out = clean(input), play = cleanPlayPage(input && input.playPage);
  if (play) out.playPage = play;
  return out;
}
// `initial` is for design review only (persist: false): what the file would have said.
function createSettings({file = path.join(__dirname, 'data/settings.json'), persist = true, initial = {}} = {}) {
  let memory = fromFile(initial);
  function raw() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
  function read() {
    if (!persist) return {...DEFAULTS, ...memory};
    return {...DEFAULTS, ...fromFile(raw())};
  }
  // A change from the frame carries only the listed choices. The play page, if the file has one, is written back
  // exactly as someone typed it, even when it is not valid, so a tap in Settings never erases a line being fixed.
  function update(patch) {
    const next = {...read(), ...clean(patch)};
    if (!persist) { memory = next; return next; }
    const before = raw(), written = {...next};
    if (before && typeof before === 'object' && 'playPage' in before) written.playPage = before.playPage;
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', JSON.stringify(written, null, 2), {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
    return next;
  }
  return {read, update};
}
module.exports = {createSettings, OPTIONS, DEFAULTS, clean, cleanPlayPage};
