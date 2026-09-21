// Photos added straight from a phone, for a household with no shared album, or beside one. They live in their own
// folder: the album's sync owns photos/ and clears out anything there it does not recognise.
//
// Only JPEGs are taken. The phone page draws every picture onto a canvas before sending it, which makes it a JPEG
// of a sensible size whatever it started as, and leaves behind everything a camera writes into a file: where it was
// taken, the phone's name, the rest. What is checked here is that the bytes really are one.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 8 * 1024 * 1024, MAX_PHOTOS = 1500, MAX_SIDE = 8192;
const fail = (code, message) => Object.assign(Error(message), {code});

// A JPEG says how big it is in its first start-of-frame segment. Walking to it also proves the file is one.
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }                                  // padding
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) { const height = bytes.readUInt16BE(at + 5), width = bytes.readUInt16BE(at + 7); return width && height ? {width, height} : null; }
    at += 2 + length;
  }
  return null;
}
const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day || '') && !Number.isNaN(Date.parse(day + 'T00:00:00Z')) && day >= '1900-01-01';

function createUploads({dir}) {
  const file = path.join(dir, 'uploads.json');
  function read() { try { const all = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(all.photos) ? all.photos : []; } catch (e) { return []; } }
  function write(photos) {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    fs.writeFileSync(file + '.tmp', JSON.stringify({photos}), {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
  }
  // In the frame's own photo shape, newest first.
  const list = () => read().map(p => ({file: p.file, width: p.width, height: p.height, taken: p.taken, addedAt: p.addedAt, uploaded: true})).reverse();
  function add(bytes, {taken = '', today = new Date().toISOString().slice(0, 10)} = {}) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw fail('EMPTY', 'No photo arrived.');
    if (bytes.length > MAX_BYTES) throw fail('LARGE', 'That photo is too large.');
    const size = jpegSize(bytes);
    if (!size || size.width > MAX_SIDE || size.height > MAX_SIDE) throw fail('NOT_JPEG', 'That is not a photo this frame can show.');
    const photos = read();
    if (photos.length >= MAX_PHOTOS) throw fail('FULL', 'This frame holds ' + MAX_PHOTOS + ' added photos. Remove some first.');
    // Named by content, so the same picture sent twice is one picture.
    const name = 'up-' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24) + '.jpg';
    if (photos.some(p => p.file === name)) return {file: name, duplicate: true};
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    fs.writeFileSync(path.join(dir, name + '.part'), bytes, {mode: 0o600});
    fs.renameSync(path.join(dir, name + '.part'), path.join(dir, name));
    photos.push({file: name, width: size.width, height: size.height, taken: validDay(taken) && taken <= today ? taken : today, addedAt: new Date().toISOString()});
    write(photos);
    return {file: name};
  }
  function remove(name) {
    const photos = read(), kept = photos.filter(p => p.file !== name);
    if (kept.length === photos.length) return false;
    write(kept);
    fs.rmSync(path.join(dir, path.basename(name)), {force: true});
    return true;
  }
  const pathOf = name => read().some(p => p.file === name) ? path.join(dir, name) : null;
  return {list, add, remove, pathOf, MAX_BYTES};
}
module.exports = {createUploads, jpegSize, MAX_BYTES};
