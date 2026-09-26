// Household preferences the frame's Settings view can change, kept on the server (settings.json in the household's folder) so they survive a
// browser reset on the frame. Only the listed values are accepted; anything else is ignored rather than stored.
// A deployment may also keep a few keys of a household's settings in its own repository (households.js → the
// household's config; DESIGN.md → "Household config lives in git"): those are read from there, and nothing on the
// home network, nor a hand edit of settings.json, can change them.
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
// screen from a long press on the clock. It is set in the household's config in the deployment's repository, or else
// by editing settings.json on the server, and never through POST /api/settings, so nothing on the home network can
// point the wall somewhere else. Absent unless someone writes
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

// The keys a household's config in the deployment's repository may set, each cleaned exactly as it is from
// settings.json. Only the play page so far: it is the one key that is set by hand on the server, which is the thing
// this replaces. A key is added here only with a reason to take it out of the family's hands.
const OVERLAY = {playPage: cleanPlayPage};
// What a household's config file says, as settings will use it. `owned` are the keys it takes over: the file's own value
// for them is never read again, whatever it says. A key set to null says "none", with the same authority. `retire`
// are the owned keys whose value is valid (or null), which are therefore safe to take out of settings.json; an
// invalid one is still owned, so the household has none until the config is fixed, but nothing is thrown away on the
// strength of a typo. `ignored` and `invalid` are for the log.
function overlayFrom(input) {
  const out = {values: {}, owned: [], retire: [], ignored: [], invalid: []};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(OVERLAY, key)) { out.ignored.push(key); continue; }
    out.owned.push(key);
    if (input[key] === null) { out.retire.push(key); continue; }
    const value = OVERLAY[key](input[key]);
    if (value) { out.values[key] = value; out.retire.push(key); } else out.invalid.push(key);
  }
  return out;
}

// `initial` is for design review only (persist: false): what the file would have said. `overlay` is overlayFrom()'s
// answer for this household's config, if it has one.
function createSettings({file = path.join(__dirname, 'data/settings.json'), persist = true, initial = {}, overlay = null} = {}) {
  let memory = fromFile(initial);
  const owned = overlay ? overlay.owned : [];
  const withOverlay = settings => { for (const key of owned) delete settings[key]; return overlay ? {...settings, ...overlay.values} : settings; };
  function raw() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
  function write(value) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
  }
  function read() {
    if (!persist) return withOverlay({...DEFAULTS, ...memory});
    return withOverlay({...DEFAULTS, ...fromFile(raw())});
  }
  // A change from the frame carries only the listed choices, and never one the household's config owns. The play
  // page, if the file has one the config does not own, is written back exactly as someone typed it, even when it is
  // not valid, so a tap in Settings never erases a line being fixed.
  function update(patch) {
    const change = clean(patch);
    for (const key of owned) delete change[key];
    const next = {...read(), ...change};
    const kept = {...next};
    for (const key of owned) delete kept[key];
    if (!persist) { memory = kept; return next; }
    const before = raw();
    if (before && typeof before === 'object' && 'playPage' in before && !owned.includes('playPage')) kept.playPage = before.playPage;
    write(kept);
    return next;
  }
  // Once, when the household is opened: the keys its config now owns are taken out of settings.json, so the file no
  // longer holds a value nothing reads. Returns what was taken out, for the log; nothing when there was nothing.
  function retire() {
    if (!persist || !overlay || !overlay.retire.length) return {};
    const before = raw(), removed = {};
    if (!before || typeof before !== 'object' || Array.isArray(before)) return removed;
    for (const key of overlay.retire) if (key in before) { removed[key] = before[key]; delete before[key]; }
    if (Object.keys(removed).length) write(before);
    return removed;
  }
  return {read, update, retire};
}
module.exports = {createSettings, OPTIONS, DEFAULTS, OVERLAY, clean, cleanPlayPage, overlayFrom};
