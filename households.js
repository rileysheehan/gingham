// One deployment serves several households. Each is a folder under data/households/<id>/ holding everything that is
// theirs: sources.json (calendars, lists, album, people, place), credentials.json (their Google and Todoist
// authorizations), settings.json, photos/ and cache/. Nothing is shared between folders, so a bug that mixes
// households has to cross a directory boundary to do it.
const fs = require('node:fs');
const path = require('node:path');
const integrations = require('./integrations');
const {createClient} = require('./api-client');
const {createAlbumSync} = require('./album');
const {createSettings, overlayFrom, OVERLAY} = require('./settings');
const {validZone} = require('./zone');
const {createVault} = require('./vault');
const {createLists} = require('./lists');
const {createUploads} = require('./uploads');
const {createFolder} = require('./folder');
const {createMicrosoft} = require('./microsoft');
const {createCalDav} = require('./caldav');
const {createHomeAssistant} = require('./homeassistant');
const {createGoogleTasks} = require('./googletasks');

const validId = id => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id || '');

// A household's config in the deployment's own repository: deploy/households/<id>.json beside this file, shipped in
// the deployment's image and changed only by a merge (DESIGN.md → "Household config lives in git"). It may set only
// the keys settings.js lists in OVERLAY. FRAME_HOUSEHOLD_CONFIG names another folder; tests use it to stay out of this
// repository's own. A household without a file is exactly as it was.
const CONFIG_DIR = path.join(__dirname, 'deploy', 'households');

function createHouseholds({root = path.join(__dirname, 'data/households'), log = () => {}, vault = createVault(), config = process.env.FRAME_HOUSEHOLD_CONFIG || CONFIG_DIR} = {}) {
  const open = new Map();
  // Read once, when the household is first opened: the config is part of the code, and changes only with a deploy.
  // A file that cannot be read is said in the log and applies nothing, rather than stopping the household.
  function configOf(id) {
    const file = path.join(config, id + '.json');
    let input;
    try { input = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') log(id + ': its household config (' + file + ') could not be read, so none of it applies: ' + e.message); return null; }
    const overlay = overlayFrom(input);
    if (overlay.ignored.length) log(id + ': household config: ignored ' + overlay.ignored.join(', ') + ' (only ' + Object.keys(OVERLAY).join(', ') + ' may be set there)');
    for (const key of overlay.invalid) log(id + ': household config: ' + key + ' is not valid, so the household has none until it is fixed');
    return overlay;
  }
  function list() {
    try { return fs.readdirSync(root, {withFileTypes: true}).filter(d => d.isDirectory() && validId(d.name)).map(d => d.name).sort(); }
    catch (e) { return []; }
  }
  function get(id) {
    if (!validId(id) || !fs.existsSync(path.join(root, id, 'sources.json'))) return null;
    if (open.has(id)) return open.get(id);
    const dir = path.join(root, id), photoDir = path.join(dir, 'photos');
    const readJson = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const sources = () => { try { return readJson('sources.json'); } catch (e) { return {}; } };
    // Credentials are read through the vault, which opens them if they are sealed. With a master key set, a plain
    // file (a household just added by hand, or one from before the key existed) is sealed the first time it is seen.
    const credentialsFile = path.join(dir, 'credentials.json');
    try { if (vault.seal(credentialsFile, id)) log(id + ': credentials sealed'); } catch (e) { if (e.code !== 'ENOENT') log(id + ': could not seal credentials: ' + e.message); }
    const credentials = () => vault.read(credentialsFile, id);
    const local = createLists({file: path.join(dir, 'lists.json')});
    const uploads = createUploads({dir: path.join(dir, 'uploads')});
    const folder = createFolder({dir: path.join(dir, 'folder'), cacheFile: path.join(dir, 'cache', 'folder.json'), log: m => log(id + ' photos: ' + m)});
    const microsoft = createMicrosoft({credentials, saveSecret: (name, value) => vault.set(credentialsFile, id, name, value)});
    const caldav = createCalDav({credentials}), homeassistant = createHomeAssistant({credentials}), googletasks = createGoogleTasks({credentials});
    const service = integrations.create({api: createClient({credentials}), config: sources, secrets: credentials, cacheDir: path.join(dir, 'cache'), local, microsoft, caldav, homeassistant, googletasks});
    // The album follows sources.json: a changed link starts a fresh mirror, a removed link stops syncing.
    let album = null, albumLink = '', albumError = '';
    async function syncPhotos() {
      try { folder.scan(); } catch (e) { log(id + ' photos: the folder could not be read: ' + e.message); }
      // The album link lets anyone holding it add photos, so it is kept with the secrets; sources.json is the old home.
      let kept = ''; try { kept = (credentials().album || {}).link || ''; } catch (e) {}
      const link = kept || sources().photoAlbum || '';
      if (link !== albumLink) { albumLink = link; album = link ? createAlbumSync({link, dir: photoDir, log: m => log(id + ' photos: ' + m)}) : null; }
      if (!album) return;
      try { await album.sync(); albumError = ''; } catch (e) { albumError = e.message; log(id + ' photos sync failed: ' + e.message); }
    }
    // Settings, with whatever the household's config owns laid over them. What settings.json still says about a key the
    // config now owns is taken out, once, and said in the log with its old value: that is how a value once written by
    // hand on the server is retired by a merge instead of by another hand edit.
    const overlay = configOf(id), settings = createSettings({file: path.join(dir, 'settings.json'), overlay});
    try {
      const removed = settings.retire();
      for (const [key, value] of Object.entries(removed)) log(id + ': ' + key + ' is set in its household config now; removed it from settings.json, where it was ' + JSON.stringify(value));
    } catch (e) { log(id + ': could not tidy settings.json: ' + e.message); }
    const household = {
      id, dir, photoDir, sources, syncPhotos,
      // Where and when this household lives. Until its owner says, it lives nowhere: UTC, and no weather.
      place() {
        const s = sources(), p = s.place || {};
        return {name: String(s.name || id).slice(0, 40), timezone: validZone(s.timezone) ? s.timezone : 'UTC', label: String(p.label || '').slice(0, 40),
          latitude: Number.isFinite(p.latitude) ? p.latitude : null, longitude: Number.isFinite(p.longitude) ? p.longitude : null,
          country: /^[A-Z]{2}$/.test(String(p.country || '')) ? p.country : ''};
      },
      calendar: service.calendar, tasks: service.tasks, closeTask: service.closeTask, addTask: service.addTask, lists: local,
      settings,
      // The album's photos and the ones added from a phone, as one set. Added ones come first: whoever just sent
      // a picture is standing there waiting to see it.
      photoManifest() {
        let album = {photos: []}; try { album = JSON.parse(fs.readFileSync(path.join(photoDir, 'manifest.json'), 'utf8')); } catch (e) {}
        return {...album, photos: [...uploads.list(), ...(album.photos || []), ...folder.list()]};
      },
      photoPath(name) { const added = uploads.pathOf(name) || folder.pathOf(name); return added || (this.photoManifest().photos.some(p => p.file === name) ? path.join(photoDir, name) : null); },
      uploads, folder, microsoft, caldav, homeassistant, googletasks,
      photoStatus: () => ({configured: !!albumLink || !!sources().photoAlbum || uploads.list().length > 0 || folder.list().length > 0, error: albumError})
    };
    open.set(id, household);
    return household;
  }
  // A new, empty household: nothing to show until its owner fills it in on the setup page.
  function create(id, {name = ''} = {}) {
    if (!validId(id)) throw Error('A household id is lowercase letters, digits and dashes');
    const dir = path.join(root, id);
    if (fs.existsSync(dir)) throw Error('Household "' + id + '" already exists');
    fs.mkdirSync(path.join(dir, 'photos'), {recursive: true, mode: 0o700});
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({...(name ? {name: String(name).slice(0, 40)} : {}), calendars: [], projects: [], people: []}, null, 2) + '\n', {mode: 0o600});
    vault.write(path.join(dir, 'credentials.json'), id, {});
    return get(id);
  }
  return {list, get, create, root, vault};
}
module.exports = {createHouseholds, validId, CONFIG_DIR};
