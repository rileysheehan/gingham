// Mirrors one iCloud shared album into a local folder for the frame.
// A shared album's public link (photos.icloud.com/shared/album/<id>) is read the way that page reads it: CloudKit
// resolves the id to the album's zone plus a short-lived anonymous token, then a records query lists each photo
// (CPLAsset) and its files (CPLMaster). No Photos app, no Mac permission and no Apple ID are involved.
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');

const CONTAINER = '/database/1/com.apple.photos.cloud/production/';
const RESOLVE_HOST = 'https://ckdatabasews.icloud.com';
const QUERY = {recordType: 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted', filterBy: [{fieldName: 'direction', comparator: 'EQUALS', fieldValue: {value: 'DESCENDING', type: 'STRING'}}]};

// Accepts the link as copied from Photos, or just the id at its end.
function albumId(link) {
  const match = String(link || '').trim().match(/(?:\/shared\/album\/)?([A-Za-z0-9]{15,})\/?(?:[?#].*)?$/);
  if (!match) throw Error('Not an iCloud shared album link');
  return match[1];
}
const value = (fields, name) => fields && fields[name] ? fields[name].value : undefined;
// The file to show: an edited render if the photo was edited, else the ~2048px JPEG iCloud keeps of every photo,
// else the full-size JPEG, else the original (converted, since HEIC is common). Videos are skipped.
function pickFile(asset, master) {
  const type = String(value(master.fields, 'itemType') || '');
  if (/movie|video|mpeg|avi/i.test(type)) return null;
  for (const [record, res, prefix] of [[asset, 'resJPEGMedRes', 'resJPEGMed'], [asset, 'resJPEGFullRes', 'resJPEGFull'], [master, 'resJPEGMedRes', 'resJPEGMed'], [master, 'resJPEGFullRes', 'resJPEGFull'], [master, 'resOriginalRes', 'resOriginal']]) {
    const file = value(record.fields, res);
    if (file && file.downloadURL && file.fileChecksum) return {url: file.downloadURL, checksum: file.fileChecksum, width: value(record.fields, prefix + 'Width') || 0, height: value(record.fields, prefix + 'Height') || 0};
  }
  return null;
}
// assetDate is UTC milliseconds and timeZoneOffset is where the photo was taken; the caption wants that local day.
function takenDay(asset) {
  const at = value(asset.fields, 'assetDate');
  if (!at) return '';
  return new Date(at + (value(asset.fields, 'timeZoneOffset') || 0) * 1000).toISOString().slice(0, 10);
}
const safe = text => String(text).replace(/[^A-Za-z0-9]/g, '');
const fileName = (asset, file) => safe(asset.recordName).slice(0, 40) + '-' + safe(file.checksum).slice(0, 12) + '.jpg';
const isJpeg = buffer => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
function sipsToJpeg(from, to) {
  return new Promise((resolve, reject) => execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '2048', from, '--out', to], {timeout: 60000}, error => error ? reject(error) : resolve()));
}

function createAlbumSync({link, dir, fetchImpl = fetch, convert = sipsToJpeg, log = () => {}}) {
  const id = albumId(link);
  async function post(url, body) {
    const response = await fetchImpl(url, {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw Error('iCloud answered ' + response.status);
    return response.json();
  }
  async function records() {
    const resolved = await post(RESOLVE_HOST + CONTAINER + 'public/records/resolve?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=' + encodeURIComponent(id), {shortGUIDs: [{value: id}]});
    const share = resolved.results && resolved.results[0];
    const access = share && share.anonymousPublicAccess;
    if (!share || !share.zoneID || !access || !access.token) throw Error('iCloud did not open the album; check that its public link is on');
    const query = access.databasePartition.replace(/\/$/, '') + CONTAINER + 'shared/records/query?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=' + encodeURIComponent(id) + '&publicAccessAuthToken=' + encodeURIComponent(access.token);
    const all = [];
    let marker;
    for (let page = 0; page < 100; page++) {
      const result = await post(query, {query: QUERY, zoneID: share.zoneID, resultsLimit: 200, ...(marker ? {continuationMarker: marker} : {})});
      all.push(...(result.records || []));
      marker = result.continuationMarker;
      if (!marker) return all;
    }
    throw Error('iCloud album never finished paging');
  }
  function readManifest() { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { return {photos: []}; } }
  async function sync() {
    const all = await records();
    const masters = new Map(all.filter(r => r.recordType === 'CPLMaster').map(r => [r.recordName, r]));
    const wanted = all.filter(r => r.recordType === 'CPLAsset').map(asset => {
      const master = masters.get(value(asset.fields, 'masterRef') && value(asset.fields, 'masterRef').recordName);
      const file = master && pickFile(asset, master);
      return file ? {asset, file, name: fileName(asset, file)} : null;
    }).filter(Boolean);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    // The list of photos is what the frame shows, so it is rewritten as photos arrive: a first mirror of hundreds
    // shows its first photos within a minute, and a restart part-way through loses nothing.
    const writeManifest = () => {
      const photos = wanted.filter(item => fs.existsSync(path.join(dir, item.name))).map(item => ({
        file: item.name, width: item.file.width, height: item.file.height, taken: takenDay(item.asset), favorite: value(item.asset.fields, 'isFavorite') === 1
      }));
      const manifest = {photos, skipped: [...skipped], syncedAt: new Date().toISOString()};
      fs.writeFileSync(path.join(dir, 'manifest.json.tmp'), JSON.stringify(manifest), {mode: 0o600});
      fs.renameSync(path.join(dir, 'manifest.json.tmp'), path.join(dir, 'manifest.json'));
      return manifest;
    };
    // A photo that arrived but cannot be shown here (not a JPEG, and nothing to convert it with) is remembered by
    // name, which carries its checksum, so it is not downloaded again every fifteen minutes only to be skipped.
    const skipped = new Set((readManifest().skipped || []).filter(name => wanted.some(item => item.name === name)));
    let arrived = 0;
    for (const item of wanted) {
      const target = path.join(dir, item.name);
      if (fs.existsSync(target) || skipped.has(item.name)) continue;
      if (arrived++ % 25 === 0) writeManifest();
      const response = await fetchImpl(item.file.url.replace('${f}', 'photo.jpg'), {signal: AbortSignal.timeout(60000)});
      if (!response.ok) { log('Download failed (' + response.status + ') for ' + item.asset.recordName); continue; }
      const buffer = Buffer.from(await response.arrayBuffer()), temp = target + '.part';
      fs.writeFileSync(temp, buffer, {mode: 0o600});
      if (isJpeg(buffer)) fs.renameSync(temp, target);
      else { try { await convert(temp, target); } catch (e) { skipped.add(item.name); log('Skipped ' + item.asset.recordName + ': not a JPEG and cannot be converted here'); } fs.rmSync(temp, {force: true}); }
    }
    // The album is the whole truth: a photo removed from it leaves the frame.
    const keep = new Set(wanted.map(item => item.name));
    for (const name of fs.readdirSync(dir)) if (/\.(jpg|part)$/.test(name) && !keep.has(name)) fs.rmSync(path.join(dir, name), {force: true});
    return writeManifest();
  }
  return {sync, readManifest};
}
module.exports = {createAlbumSync, albumId, pickFile, takenDay};
