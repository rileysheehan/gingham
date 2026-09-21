// A folder of photos, for a household whose pictures already live on a disk. There is nothing to configure and no
// path to type: every household has a `folder/` of its own beside its other data, and whoever runs the server puts
// JPEGs there or mounts a directory onto it. A path typed on a web page would let one household read another's.
//
// Pictures are shown as they are, so ones too large for a small tablet to decode are passed over and counted, as
// are kinds that are not JPEG; the setup page says how many, and the phone page (which makes pictures smaller as it
// sends them) is the way round.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {jpegSize} = require('./uploads');

const MAX_FILES = 5000, MAX_DEPTH = 5, MAX_BYTES = 12 * 1024 * 1024, MAX_SIDE = 6000, HEAD = 768 * 1024;

// The day a camera says it took the picture (Exif DateTimeOriginal), or nothing.
function exifDay(bytes) {
  try {
    let at = 2;
    while (at + 4 < bytes.length) {
      const marker = bytes.readUInt16BE(at), size = bytes.readUInt16BE(at + 2);
      if (marker === 0xffe1 && bytes.toString('latin1', at + 4, at + 8) === 'Exif') return fromTiff(bytes, at + 10);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda || size < 2) return '';
      at += 2 + size;
    }
  } catch (e) {}
  return '';
}
function fromTiff(b, tiff) {
  const little = b.toString('latin1', tiff, tiff + 2) === 'II';
  const u16 = o => little ? b.readUInt16LE(o) : b.readUInt16BE(o), u32 = o => little ? b.readUInt32LE(o) : b.readUInt32BE(o);
  const find = (dir, tag) => { const n = u16(dir); for (let i = 0; i < n && i < 200; i++) { const e = dir + 2 + i * 12; if (u16(e) === tag) return e; } return 0; };
  const exif = find(tiff + u32(tiff + 4), 0x8769); if (!exif) return '';
  const when = find(tiff + u32(exif + 8), 0x9003); if (!when) return '';
  const text = b.toString('latin1', tiff + u32(when + 8), tiff + u32(when + 8) + 10);
  return /^\d{4}:\d{2}:\d{2}$/.test(text) ? text.replace(/:/g, '-') : '';
}

function createFolder({dir, cacheFile, log = () => {}}) {
  let known = {photos: [], passedOver: 0, scannedAt: null}, byName = new Map();
  try { const kept = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (Array.isArray(kept.photos)) { known = kept; index(); } } catch (e) {}
  function index() { byName = new Map(known.photos.map(p => [p.file, p.path])); }

  function walk() {
    const found = [];
    (function into(at, depth) {
      let entries = []; try { entries = fs.readdirSync(at, {withFileTypes: true}); } catch (e) { return; }
      for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
        if (found.length >= MAX_FILES || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;   // a link could lead anywhere
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) { if (depth < MAX_DEPTH) into(full, depth + 1); }
        else if (entry.isFile()) found.push(full);
      }
    })(dir, 0);
    return found;
  }
  // Reads only what changed: a picture is known by where it is, when it was written and how long it is.
  function scan() {
    const before = new Map(known.photos.map(p => [p.key, p])), photos = []; let passedOver = 0;
    for (const full of walk()) {
      let stat; try { stat = fs.statSync(full); } catch (e) { continue; }
      if (!/\.jpe?g$/i.test(full) || stat.size > MAX_BYTES || stat.size < 100) { passedOver++; continue; }
      const key = path.relative(dir, full) + '|' + stat.mtimeMs + '|' + stat.size;
      if (before.has(key)) { photos.push(before.get(key)); continue; }
      let head; try { const fd = fs.openSync(full, 'r'); head = Buffer.alloc(Math.min(HEAD, stat.size)); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd); } catch (e) { passedOver++; continue; }
      const size = jpegSize(head);
      if (!size || size.width > MAX_SIDE || size.height > MAX_SIDE) { passedOver++; continue; }
      // The name a frame asks for is made here and looked up here; nothing a frame sends is ever joined to a path.
      photos.push({key, path: full, file: 'fo-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24) + '.jpg', width: size.width, height: size.height,
        taken: exifDay(head) || new Date(stat.mtimeMs).toISOString().slice(0, 10)});
    }
    const changed = photos.length !== known.photos.length || passedOver !== known.passedOver || photos.some((p, i) => p !== known.photos[i]);
    known = {photos, passedOver, scannedAt: new Date().toISOString()}; index();
    if (changed) {
      log(photos.length + ' photos in the folder' + (passedOver ? ', ' + passedOver + ' passed over' : ''));
      try { fs.mkdirSync(path.dirname(cacheFile), {recursive: true, mode: 0o700}); fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(known), {mode: 0o600}); fs.renameSync(cacheFile + '.tmp', cacheFile); } catch (e) {}
    }
    return known;
  }
  const list = () => known.photos.map(p => ({file: p.file, width: p.width, height: p.height, taken: p.taken, folder: true}));
  const pathOf = name => byName.get(name) || null;
  return {scan, list, pathOf, status: () => ({count: known.photos.length, passedOver: known.passedOver, exists: fs.existsSync(dir)})};
}
module.exports = {createFolder, exifDay};
