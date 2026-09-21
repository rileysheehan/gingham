#!/usr/bin/env node
// Looking after households and frames, from a shell on the machine that holds the data (or `fly ssh console`).
//   node admin.js households
//   node admin.js admin link ["whose"] [--url https://<host>]   the way in to the admin page
//   node admin.js household add <id>
//   node admin.js owner link <household> ["<whose>"] [--url …]   a one-time link to that household's setup page
//   node admin.js frames                                   everything that holds a secret, and when it was last seen
//   node admin.js frame pair <code> <household> "<name>"    approve the code a screen is showing
//   node admin.js frame add <household> "<name>" [--url …]  a standing setup link, for setting up over ADB
//   node admin.js frame revoke <id>
//   node admin.js secret names <household>                   which secrets are set; values are never shown
//   echo "<value>" | node admin.js secret set <household> <name>     e.g. ics.<calendar id>, todoist.token
//   node admin.js secret remove <household> <name>
const fs = require('node:fs');
const path = require('node:path');
const {createHouseholds, validId} = require('./households');
const {createGrants} = require('./grants');

const dataDir = process.env.FRAME_DATA || path.join(__dirname, 'data');
const households = createHouseholds({root: path.join(dataDir, 'households')});
const grants = createGrants({file: path.join(dataDir, 'grants.json')});
const args = process.argv.slice(2), flag = name => { const i = args.indexOf('--' + name); return i >= 0 ? args.splice(i, 2)[1] : ''; };
const base = (flag('url') || process.env.FRAME_URL || 'http://localhost:4173').replace(/\/$/, '');
const fail = message => { console.error(message); process.exit(1); };

const [noun, verb, a, b] = args;
if (noun === 'households') {
  const ids = households.list();
  console.log(ids.length ? ids.map(id => id + '  (' + grants.list().filter(g => g.household === id && g.scope === 'frame' && !g.revokedAt).length + ' frames)').join('\n') : 'No households yet.');
} else if (noun === 'household' && verb === 'add') {
  if (!validId(a)) fail('A household id is lowercase letters, digits and dashes, like "smith".');
  try { households.create(a); } catch (e) { fail(e.message + '.'); }
  console.log('Created household "' + a + '". Send its owner a setup link: node admin.js owner link ' + a + ' "<whose>" --url https://<host>');
} else if (noun === 'frames') {
  const all = grants.list();
  console.log(all.length ? all.map(g => [g.id, g.scope.padEnd(5), g.household || '-', JSON.stringify(g.label), g.revokedAt ? 'revoked ' + g.revokedAt.slice(0, 10) : 'last seen ' + (g.lastSeen || 'never')].join('  ')).join('\n') : 'Nothing is paired yet.');
} else if (noun === 'admin' && verb === 'link') {
  console.log('Open this once on the device you will look after the whole deployment from. It works once, for three days,\nand opens the admin page, where households are made and their first links sent:\n\n  ' + base + '/s/' + grants.mintLink({scope: 'admin', label: a}) + '\n');
} else if (noun === 'owner' && verb === 'link') {
  if (!households.get(a)) fail('No household "' + a + '". See: node admin.js households');
  console.log('Send this to whoever looks after ' + a + '. It works once, for three days, and makes the device that opens it an owner:\n\n  ' + base + '/s/' + grants.mintLink({scope: 'owner', household: a, label: b}) + '\n');
} else if (noun === 'frame' && verb === 'pair') {
  const [, , code, household, label] = args;
  if (!households.get(household)) fail('No household "' + household + '". See: node admin.js households');
  console.log(grants.approvePairing(code, {household, label}) ? 'Approved. The screen showing ' + code + ' will connect to ' + household + ' within a few seconds.' : 'No screen is waiting with the code ' + code + '. Codes last ten minutes; read it again from the screen.');
} else if (noun === 'frame' && verb === 'add') {
  if (!households.get(a)) fail('No household "' + a + '". See: node admin.js households');
  const {grant: frame, secret} = grants.add({scope: 'frame', household: a, label: b});
  console.log('Frame ' + frame.id + ' (' + frame.label + ') for ' + a + '.\nOpen this once on the frame. It is shown only now, and it is the frame\'s whole identity, so treat it like a password:\n\n  ' + base + '/?k=' + secret + '\n');
} else if (noun === 'frame' && verb === 'revoke') {
  console.log(grants.revoke(a) ? 'Revoked ' + a + '. That frame shows nothing until it is paired again.' : 'No active frame "' + a + '".');
} else if (noun === 'secret' && ['names', 'set', 'remove'].includes(verb)) {
  if (!households.get(a)) fail('No household "' + a + '". See: node admin.js households');
  const file = path.join(households.root, a, 'credentials.json'), vault = households.vault;
  if (verb === 'names') { let held = {}; try { held = vault.read(file, a); } catch (e) { if (e.code !== 'ENOENT') fail(e.message); } console.log(vault.names(held).join('\n') || 'No secrets set.'); }
  else if (verb === 'remove') { vault.set(file, a, b, null); console.log('Removed ' + b + '.'); }
  else {
    // From standard input, so the value is never an argument: arguments land in shell history and process lists.
    const value = fs.readFileSync(0, 'utf8').trim();
    if (!value) fail('Pipe the value in: echo "<value>" | node admin.js secret set ' + a + ' ' + (b || '<name>'));
    vault.set(file, a, b, value);
    console.log('Set ' + b + ' for ' + a + (vault.sealing ? ', sealed.' : '. (No FRAME_MASTER_KEY is set, so credentials are stored as plain text.)'));
  }
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}
