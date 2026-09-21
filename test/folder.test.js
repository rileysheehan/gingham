const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createFolder, exifDay} = require('../folder');

const jpeg = (width, height, exif = Buffer.alloc(0)) => Buffer.concat([Buffer.from([0xff, 0xd8]), exif,
  Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]), Buffer.alloc(120), Buffer.from([0xff, 0xd9])]);
// What a camera writes: an Exif block holding the moment the picture was taken.
function exifBlock(when) {
  const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0x03, 0x90, 2, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(when + '\0', 'latin1')]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]), head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0); head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frame-'));

test('A camera\'s own date is read, and anything odd reads as no date', () => {
  assert.equal(exifDay(jpeg(10, 10, exifBlock('2019:08:04 17:30:00'))), '2019-08-04');
  assert.equal(exifDay(jpeg(10, 10)), '');
  assert.equal(exifDay(Buffer.from('not a picture at all')), '');
  assert.equal(exifDay(jpeg(10, 10, exifBlock('yesterday, around tea'))), '');
});

test('A folder of pictures: JPEGs of a sensible size are shown, the rest are counted, and links are not followed', () => {
  const root = temp(), dir = path.join(root, 'folder'), cacheFile = path.join(root, 'cache', 'folder.json');
  const folder = createFolder({dir, cacheFile});
  assert.deepEqual(folder.scan().photos, [], 'no folder is simply no photos');
  fs.mkdirSync(path.join(dir, '2019', 'summer'), {recursive: true});
  fs.writeFileSync(path.join(dir, '2019', 'summer', 'beach.JPG'), jpeg(3000, 2000, exifBlock('2019:08:04 17:30:00')));
  fs.writeFileSync(path.join(dir, 'garden.jpeg'), jpeg(1600, 1200));
  fs.writeFileSync(path.join(dir, 'huge.jpg'), jpeg(12000, 9000));
  fs.writeFileSync(path.join(dir, 'phone.heic'), Buffer.alloc(500));
  fs.writeFileSync(path.join(dir, 'liar.jpg'), Buffer.from('<html>' + 'x'.repeat(200)));
  fs.writeFileSync(path.join(dir, '.hidden.jpg'), jpeg(100, 100));
  const secret = path.join(root, 'elsewhere'); fs.mkdirSync(secret); fs.writeFileSync(path.join(secret, 'private.jpg'), jpeg(800, 600));
  fs.symlinkSync(secret, path.join(dir, 'link-out'));
  fs.symlinkSync(path.join(secret, 'private.jpg'), path.join(dir, 'link.jpg'));

  const seen = folder.scan();
  assert.deepEqual(seen.photos.map(p => [path.basename(p.path), p.width, p.height, p.taken.slice(0, 4)]).sort(), [['beach.JPG', 3000, 2000, '2019'], ['garden.jpeg', 1600, 1200, String(new Date().getUTCFullYear())]]);
  assert.equal(seen.passedOver, 3, 'too large, not a JPEG by name, not a JPEG by content');
  const listed = folder.list();
  assert.ok(listed.every(p => /^fo-[0-9a-f]{24}\.jpg$/.test(p.file) && p.folder && !('path' in p)), 'a frame is told a made-up name, never where a file is');
  assert.equal(folder.pathOf(listed[0].file), seen.photos[0].path);
  for (const name of ['../elsewhere/private.jpg', 'beach.JPG', '2019/summer/beach.JPG', '', 'fo-000000000000000000000000.jpg']) assert.equal(folder.pathOf(name), null, name);

  // What was learned is kept, so a restart does not read five thousand files again; a changed file is read again.
  const again = createFolder({dir, cacheFile});
  assert.equal(again.list().length, 2);
  assert.equal(again.status().passedOver, 3);
  fs.rmSync(path.join(dir, 'garden.jpeg'));
  assert.equal(again.scan().photos.length, 1);
});
