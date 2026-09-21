const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createAlbumSync, albumId, pickFile, takenDay} = require('../album');

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const res = (checksum, width = 1536, height = 2048) => ({value: {fileChecksum: checksum, size: 10, downloadURL: 'https://cvws.icloud-content.com/B/' + checksum + '/${f}?o=1'}});
const master = (name, fields) => ({recordName: name, recordType: 'CPLMaster', fields: {itemType: {value: 'public.heic'}, ...fields}});
const asset = (name, masterName, fields = {}) => ({recordName: name, recordType: 'CPLAsset', fields: {masterRef: {value: {recordName: masterName}}, assetDate: {value: Date.UTC(2026, 8, 19, 3, 30)}, timeZoneOffset: {value: -18000}, ...fields}});
const reply = (body, status = 200) => ({ok: status < 400, status, json: async () => body, arrayBuffer: async () => jpeg});

function fakeICloud(pages) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({url, body: options.body && JSON.parse(options.body)});
    if (url.includes('/public/records/resolve')) return reply({results: [{zoneID: {zoneName: 'SharedCollection-1'}, anonymousPublicAccess: {token: 'anon', databasePartition: 'https://p118-ckdatabasews.icloud.com:443'}}]});
    if (url.includes('/shared/records/query')) {
      const marker = options.body && JSON.parse(options.body).continuationMarker;
      return reply(pages[marker ? Number(marker) : 0]);
    }
    if (url.startsWith('https://cvws.icloud-content.com/')) return reply(null);
    return reply({}, 404);
  };
  return {fetchImpl, calls};
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'album-test-'));

test('Album links are accepted whole or as a bare id', () => {
  assert.equal(albumId('https://photos.icloud.com/shared/album/B0exampleSharedAlbum1234'), 'B0exampleSharedAlbum1234');
  assert.equal(albumId('B0exampleSharedAlbum1234'), 'B0exampleSharedAlbum1234');
  assert.throws(() => albumId('https://example.com/nope'));
});

test('An edited render wins over the stored JPEG, and videos are skipped', () => {
  const plain = master('m', {resJPEGMedRes: res('MED'), resJPEGMedWidth: {value: 1536}, resJPEGMedHeight: {value: 2048}});
  assert.equal(pickFile(asset('a', 'm'), plain).checksum, 'MED');
  assert.equal(pickFile(asset('a', 'm', {resJPEGMedRes: res('EDIT')}), plain).checksum, 'EDIT');
  assert.equal(pickFile(asset('a', 'm'), master('v', {itemType: {value: 'com.apple.quicktime-movie'}, resJPEGMedRes: res('X')})), null);
});

test('The caption date is the day where the photo was taken', () => {
  // 03:30 UTC on Sep 19 is 22:30 on Sep 18 in Austin.
  assert.equal(takenDay(asset('a', 'm')), '2026-09-18');
});

test('Sync pages through the album, downloads each photo once, and keeps the album as the whole truth', async () => {
  const dir = tempDir();
  const pages = [
    {records: [master('m1', {resJPEGMedRes: res('ONE')}), asset('a1', 'm1')], continuationMarker: '1'},
    {records: [master('m2', {resJPEGMedRes: res('TWO')}), asset('a2', 'm2', {isFavorite: {value: 1}}), master('mv', {itemType: {value: 'com.apple.quicktime-movie'}, resJPEGMedRes: res('VID')}), asset('av', 'mv')]}
  ];
  const {fetchImpl, calls} = fakeICloud(pages);
  fs.writeFileSync(path.join(dir, 'gone-OLD.jpg'), jpeg);
  const album = createAlbumSync({link: 'https://photos.icloud.com/shared/album/B0exampleSharedAlbum1234', dir, fetchImpl});
  const manifest = await album.sync();
  assert.deepEqual(manifest.photos.map(p => p.file), ['a1-ONE.jpg', 'a2-TWO.jpg']);
  assert.equal(manifest.photos[1].favorite, true);
  assert.ok(!fs.existsSync(path.join(dir, 'gone-OLD.jpg')), 'a photo no longer in the album is deleted');
  const query = calls.find(c => c.url.includes('/shared/records/query'));
  assert.ok(query.url.startsWith('https://p118-ckdatabasews.icloud.com'), 'queries go to the partition the resolve named');
  assert.ok(query.url.includes('publicAccessAuthToken=anon'));
  assert.ok(calls.some(c => c.url === 'https://cvws.icloud-content.com/B/ONE/photo.jpg?o=1'), 'the ${f} placeholder is filled in');
  const downloads = calls.filter(c => c.url.startsWith('https://cvws')).length;
  await album.sync();
  assert.equal(calls.filter(c => c.url.startsWith('https://cvws')).length, downloads, 'a second sync downloads nothing new');
  assert.deepEqual(album.readManifest().photos.length, 2);
});

test('A failed sync leaves the last good photos in place', async () => {
  const dir = tempDir();
  const good = createAlbumSync({link: 'B0exampleSharedAlbum1234', dir, fetchImpl: fakeICloud([{records: [master('m1', {resJPEGMedRes: res('ONE')}), asset('a1', 'm1')]}]).fetchImpl});
  await good.sync();
  const broken = createAlbumSync({link: 'B0exampleSharedAlbum1234', dir, fetchImpl: async () => reply({results: [{serverErrorCode: 'NOT_FOUND'}]})});
  await assert.rejects(broken.sync(), /public link/);
  assert.ok(fs.existsSync(path.join(dir, 'a1-ONE.jpg')));
  assert.equal(broken.readManifest().photos.length, 1);
});
