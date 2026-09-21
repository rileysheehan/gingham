const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createUploads, jpegSize} = require('../uploads');

// The smallest thing that is structurally a JPEG: start, an application segment, a frame header, end.
const jpeg = (width, height, filler = 0) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, filler, 0x00]),
  Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]),
  Buffer.from([0xff, 0xd9])]);
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frame-'));

test('A JPEG says how big it is; nothing else gets an answer', () => {
  assert.deepEqual(jpegSize(jpeg(2560, 1440)), {width: 2560, height: 1440});
  assert.equal(jpegSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), null, 'a PNG');
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff])), null, 'cut short');
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0, 0, 0, 0, 0])), null, 'a segment that claims no length cannot loop forever');
});

test('Added photos are kept by content, listed newest first, and removed cleanly', () => {
  const dir = path.join(temp(), 'uploads'), uploads = createUploads({dir});
  assert.deepEqual(uploads.list(), []);
  const first = uploads.add(jpeg(1200, 800), {taken: '2024-07-04', today: '2026-09-20'});
  assert.match(first.file, /^up-[0-9a-f]{24}\.jpg$/);
  assert.equal(uploads.add(jpeg(1200, 800), {today: '2026-09-20'}).duplicate, true, 'the same picture twice is one picture');
  uploads.add(jpeg(800, 1200, 1), {taken: '2999-01-01', today: '2026-09-20'});
  const list = uploads.list();
  assert.deepEqual(list.map(p => [p.width, p.height, p.taken, p.uploaded]), [[800, 1200, '2026-09-20', true], [1200, 800, '2024-07-04', true]], 'a date in the future is not believed');
  assert.equal(fs.statSync(path.join(dir, first.file)).mode & 0o077, 0, 'only the server may read it');
  assert.equal(uploads.pathOf(first.file), path.join(dir, first.file));
  for (const name of ['../uploads.json', 'uploads.json', '/etc/passwd', '']) { assert.equal(uploads.pathOf(name), null); assert.equal(uploads.remove(name), false); }
  assert.ok(fs.existsSync(path.join(dir, 'uploads.json')), 'asking to remove the list itself removes nothing');
  assert.equal(uploads.remove(first.file), true);
  assert.equal(fs.existsSync(path.join(dir, first.file)), false);
  assert.equal(uploads.list().length, 1);
});

test('What is not a photo is refused, with a reason', () => {
  const uploads = createUploads({dir: path.join(temp(), 'uploads')});
  assert.throws(() => uploads.add(Buffer.from('<script>alert(1)</script>')), {code: 'NOT_JPEG'});
  assert.throws(() => uploads.add(Buffer.alloc(0)), {code: 'EMPTY'});
  assert.throws(() => uploads.add(jpeg(20000, 100)), {code: 'NOT_JPEG'}, 'dimensions no screen could want');
  assert.throws(() => uploads.add(Buffer.concat([jpeg(10, 10), Buffer.alloc(uploads.MAX_BYTES)])), {code: 'LARGE'});
  assert.deepEqual(uploads.list(), []);
});
