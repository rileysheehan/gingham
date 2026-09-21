// A household's credentials, sealed on disk. With FRAME_MASTER_KEY set, credentials.json is AES-256-GCM ciphertext,
// so a copy of the volume, a snapshot or a backup gives nothing away without a key that lives somewhere else (the
// host's secret store). Each file is sealed to its own household's id, so one household's file cannot be dropped
// into another's folder and opened there. Without a key the file is plain JSON, as it always was, which is right
// for a single household on a machine at home.
//
// Secrets go in and do not come out: `names` lists what is set, never the values.
const fs = require('node:fs');
const crypto = require('node:crypto');

function keyFrom(text) {
  if (!text) return null;
  const key = Buffer.from(String(text).trim(), 'base64');
  if (key.length !== 32) throw Error('FRAME_MASTER_KEY must be 32 bytes, base64 (make one with: openssl rand -base64 32)');
  return key;
}
// A household PIN is four to eight digits, which is few: it is stretched with scrypt so that even the stored form,
// which already sits inside the sealed file, is slow to guess, and tries against the live server are rationed.
function hashPin(pin) { const salt = crypto.randomBytes(16); return 'scrypt$' + salt.toString('base64') + '$' + crypto.scryptSync(String(pin), salt, 32, {N: 16384}).toString('base64'); }
function checkPin(pin, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64'), got = crypto.scryptSync(String(pin), Buffer.from(salt, 'base64'), want.length, {N: 16384});
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function createVault({masterKey = process.env.FRAME_MASTER_KEY} = {}) {
  const key = keyFrom(masterKey);
  const sealed = value => !!value && value.v === 1 && value.alg === 'aes-256-gcm' && typeof value.data === 'string';
  function read(file, household) {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!sealed(stored)) return stored;
    if (!key) throw Error('Credentials are sealed and FRAME_MASTER_KEY is not set');
    const opener = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
    opener.setAAD(Buffer.from(String(household)));
    opener.setAuthTag(Buffer.from(stored.tag, 'base64'));
    return JSON.parse(Buffer.concat([opener.update(Buffer.from(stored.data, 'base64')), opener.final()]).toString('utf8'));
  }
  function write(file, household, value) {
    let body = value;
    if (key) {
      const iv = crypto.randomBytes(12), sealer = crypto.createCipheriv('aes-256-gcm', key, iv);
      sealer.setAAD(Buffer.from(String(household)));
      const data = Buffer.concat([sealer.update(JSON.stringify(value), 'utf8'), sealer.final()]);
      body = {v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: sealer.getAuthTag().toString('base64'), data: data.toString('base64')};
    }
    fs.writeFileSync(file + '.tmp', JSON.stringify(body, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
  }
  // A plain file found while a key is set is sealed where it lies. Returns whether it changed anything.
  function seal(file, household) {
    if (!key) return false;
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (sealed(stored)) return false;
    write(file, household, stored);
    return true;
  }
  // "google.refresh_token", "ics.c-1a2b3c4d": which secrets exist, for a person to look at. Never their values.
  function names(value, prefix = '') {
    return Object.entries(value || {}).flatMap(([k, v]) => v && typeof v === 'object' ? names(v, prefix + k + '.') : (v === '' || v == null ? [] : [prefix + k]));
  }
  function set(file, household, dotted, secret) {
    const parts = String(dotted).split('.');
    if (!parts.every(p => /^[A-Za-z0-9_@.-]{1,80}$/.test(p)) || parts.some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw Error('Not a usable name');
    let value = {}; try { value = read(file, household); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let at = value;
    for (const part of parts.slice(0, -1)) { if (!at[part] || typeof at[part] !== 'object') at[part] = {}; at = at[part]; }
    if (secret === null) delete at[parts[parts.length - 1]]; else at[parts[parts.length - 1]] = String(secret);
    write(file, household, value);
  }
  return {read, write, seal, names, set, sealing: !!key};
}
module.exports = {createVault, hashPin, checkPin};
