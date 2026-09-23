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
  clock: ['auto', '12', '24']            // auto is the convention of the household's country; 12-hour until that is known
};
const DEFAULTS = {rest: 'photos', restAfter: 5, mornings: 0, photoEvery: 60, appearance: 'auto', screen: 'auto', clock: 'auto'};

function clean(input) {
  const out = {};
  for (const [key, allowed] of Object.entries(OPTIONS)) if (input && allowed.includes(input[key])) out[key] = input[key];
  return out;
}
function createSettings({file = path.join(__dirname, 'data/settings.json'), persist = true} = {}) {
  let memory = {};
  function read() {
    if (!persist) return {...DEFAULTS, ...memory};
    try { return {...DEFAULTS, ...clean(JSON.parse(fs.readFileSync(file, 'utf8')))}; } catch (e) { return {...DEFAULTS}; }
  }
  function update(patch) {
    const next = {...read(), ...clean(patch)};
    if (!persist) { memory = next; return next; }
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
    return next;
  }
  return {read, update};
}
module.exports = {createSettings, OPTIONS, DEFAULTS, clean};
