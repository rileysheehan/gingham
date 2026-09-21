// Who may do what. There are no accounts, passwords or email addresses here: authority is possession of a long
// random secret, and every secret has a scope, a label and an off switch.
//
//   frame  reads one household, checks off its tasks, changes its display settings
//   owner  also configures that household and pairs or revokes its frames
//   admin  looks after the whole deployment
//
// A secret reaches a device in one of two ways, and in both it is minted on the spot for that device alone:
//   a pairing code  the screen shows six characters, someone with authority approves them (the "sign in on your
//                   TV" flow), and the next poll hands the screen its secret;
//   a one-time link sent to a person, redeemed once with a deliberate press, dead afterwards.
// Only SHA-256 hashes are stored, so this file does not let its reader pose as anyone.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCOPES = ['frame', 'owner', 'admin'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // nothing that reads as something else across a kitchen
const PAIRING_MS = 10 * 60000, LINK_MS = 72 * 3600000, MAX_PENDING = 50;
const hash = secret => crypto.createHash('sha256').update(String(secret)).digest('hex');
const random = bytes => crypto.randomBytes(bytes).toString('base64url');
const sameHash = (a, b) => { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const tidyCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function createGrants({file = path.join(__dirname, 'data/grants.json'), now = () => Date.now()} = {}) {
  function read() {
    try { const all = JSON.parse(fs.readFileSync(file, 'utf8')); return {grants: all.grants || [], links: all.links || [], pairings: all.pairings || [], claims: all.claims || []}; }
    catch (e) { return {grants: [], links: [], pairings: [], claims: []}; }
  }
  function write(all) {
    const at = now();
    all.links = all.links.filter(l => !l.usedAt && l.expiresAt > at);
    all.pairings = all.pairings.filter(p => p.expiresAt > at);
    all.claims = (all.claims || []).filter(c => c.expiresAt > at);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', JSON.stringify(all, null, 2), {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
  }
  const iso = ms => new Date(ms).toISOString();
  function mint(all, {scope, household, label}) {
    if (!SCOPES.includes(scope)) throw Error('Unknown scope');
    if (scope !== 'admin' && !household) throw Error('A ' + scope + ' belongs to a household');
    const secret = random(32);
    const grant = {id: crypto.randomBytes(6).toString('hex'), scope, household: scope === 'admin' ? null : household, label: String(label || scope).slice(0, 60), hash: hash(secret), createdAt: iso(now()), lastSeen: null};
    all.grants.push(grant);
    return {grant, secret};
  }

  // A standing secret, shown once. The fallback for setting a frame up over ADB; people get links, screens get codes.
  function add(details) { const all = read(), made = mint(all, details); write(all); return made; }

  // Every stored hash is compared, each in constant time, so a wrong guess learns nothing from how long it took.
  function verify(secret) {
    if (typeof secret !== 'string' || secret.length < 20 || secret.length > 200) return null;
    const given = hash(secret);
    let found = null;
    for (const grant of read().grants) if (sameHash(grant.hash, given) && !grant.revokedAt) found = grant;
    return found;
  }
  function revoke(id) {
    const all = read(), grant = all.grants.find(g => g.id === id && !g.revokedAt);
    if (!grant) return false;
    grant.revokedAt = iso(now());
    write(all);
    return true;
  }
  // Last seen is for whoever looks after the frames; written at most every ten minutes per grant.
  const touched = new Map();
  function seen(id) {
    if (now() - (touched.get(id) || 0) < 600000) return;
    touched.set(id, now());
    const all = read(), grant = all.grants.find(g => g.id === id);
    if (grant) { grant.lastSeen = iso(now()); try { write(all); } catch (e) {} }
  }

  // ---- one-time links, for people
  function mintLink({scope, household, label, ttlMs = LINK_MS}) {
    if (!['owner', 'admin'].includes(scope)) throw Error('Links are for people: owner or admin');
    if (scope === 'owner' && !household) throw Error('An owner belongs to a household');
    const token = random(32), all = read();
    all.links.push({hash: hash(token), scope, household: scope === 'admin' ? null : household, label: String(label || '').slice(0, 60), expiresAt: now() + ttlMs});
    write(all);
    return token;
  }
  // Looking at a link must not spend it: message apps fetch every address they see to draw a preview.
  function peekLink(token) {
    const given = hash(token), link = read().links.find(l => sameHash(l.hash, given) && !l.usedAt && l.expiresAt > now());
    return link ? {scope: link.scope, household: link.household} : null;
  }
  function redeemLink(token, device) {
    const given = hash(token), all = read(), link = all.links.find(l => sameHash(l.hash, given) && !l.usedAt && l.expiresAt > now());
    if (!link) return null;
    link.usedAt = now();
    const made = mint(all, {scope: link.scope, household: link.household, label: device || link.label || link.scope});
    write(all);
    return made;
  }

  // ---- pairing codes, for screens
  function startPairing() {
    const all = read(), at = now();
    if (all.pairings.filter(p => p.expiresAt > at).length >= MAX_PENDING) return null;
    let code;
    do { code = Array.from(crypto.randomBytes(6), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); } while (all.pairings.some(p => p.code === code));
    const device = random(32);
    all.pairings.push({device: hash(device), code, expiresAt: at + PAIRING_MS, approved: null});
    write(all);
    return {device, code: code.slice(0, 3) + '-' + code.slice(3), expiresIn: PAIRING_MS / 1000};
  }
  function approvePairing(code, {household, label}) {
    const wanted = tidyCode(code), all = read(), pairing = all.pairings.find(p => p.code === wanted && p.expiresAt > now() && !p.approved);
    if (!pairing || !household) return false;
    pairing.approved = {household, label: String(label || 'Frame').slice(0, 60)};
    write(all);
    return true;
  }
  // The screen asks until it is told. Approval is answered exactly once, with the screen's own new secret.
  function pollPairing(device) {
    const given = hash(device), all = read(), pairing = all.pairings.find(p => sameHash(p.device, given) && p.expiresAt > now());
    if (!pairing) return {status: 'expired'};
    if (!pairing.approved) return {status: 'pending'};
    all.pairings = all.pairings.filter(p => p !== pairing);
    const made = mint(all, {scope: 'frame', household: pairing.approved.household, label: pairing.approved.label});
    write(all);
    return {status: 'approved', secret: made.secret, grant: made.grant};
  }

  // ---- the way back in. A paired frame, standing in the home, vouches for a phone: it asks for a code (the
  // household's PIN is checked before this is called), shows it, and the phone that types it becomes an owner.
  // The mirror image of pairing a screen, and what a person does after a new phone or a cleared browser.
  function startClaim(household) {
    const all = read(), at = now();
    all.claims = all.claims.filter(c => c.household !== household);          // one at a time per household
    let code;
    do { code = Array.from(crypto.randomBytes(6), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); } while (all.claims.some(c => c.code === code));
    all.claims.push({code, household, expiresAt: at + PAIRING_MS});
    write(all);
    return {code: code.slice(0, 3) + '-' + code.slice(3), expiresIn: PAIRING_MS / 1000};
  }
  function redeemClaim(code, device) {
    const wanted = tidyCode(code), all = read(), claim = all.claims.find(c => c.code === wanted && c.expiresAt > now());
    if (!claim) return null;
    all.claims = all.claims.filter(c => c !== claim);
    const made = mint(all, {scope: 'owner', household: claim.household, label: device || 'Phone'});
    write(all);
    return made;
  }

  const list = () => read().grants.map(({hash: hidden, ...rest}) => rest);
  return {add, verify, revoke, seen, list, mintLink, peekLink, redeemLink, startPairing, approvePairing, pollPairing, startClaim, redeemClaim};
}
// An owner may act for their own household, an admin for any, a frame for none.
const mayManage = (grant, household) => !!grant && (grant.scope === 'admin' || (grant.scope === 'owner' && grant.household === household));
module.exports = {createGrants, mayManage, tidyCode};
