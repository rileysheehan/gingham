const {createHouseholds} = require('./households');
const {createGrants, mayManage} = require('./grants');
const {createSetup} = require('./setup');
const {createSettings} = require('./settings');
const {dayIn} = require('./zone');
const {upcoming} = require('./countdowns');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const {groups} = require('./safe-fetch');
const {createUpdates} = require('./updates');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const distDir = path.join(__dirname,'dist');
const dataDir = process.env.FRAME_DATA || path.join(__dirname,'data');
const log = m => console.error(new Date().toISOString()+' '+m);
// Design review only: FRAME_FIXTURE=<name> answers every /api/ call from test/fixtures.js and never touches live accounts.
const fixture = process.env.FRAME_FIXTURE ? require('./test/fixtures')[process.env.FRAME_FIXTURE] : null;
if (process.env.FRAME_FIXTURE && !fixture) throw Error('Unknown fixture ' + process.env.FRAME_FIXTURE);
const fixtureSettings = createSettings({persist: false});

// Whether a newer Gingham is out (updates.js): asked of GitHub once shortly after start and then once a day, for the
// whole server, unless Settings or GINGHAM_UPDATE_CHECK=off says not to. Design review never asks GitHub; it is given a
// release (FRAME_FIXTURE_UPDATE=available for a newer one) and checks against that at once.
const VERSION = require('./package.json').version;
const FORM = ['app', 'container'].includes(process.env.GINGHAM_FORM) ? process.env.GINGHAM_FORM : 'node';
const updates = fixture
  ? createUpdates({current: VERSION, form: FORM, env: {}, fetchImpl: async () => { const r = require('./test/release-fixture'); return new Response(JSON.stringify(process.env.FRAME_FIXTURE_UPDATE === 'available' ? r.newer : r.same(VERSION)), {status: 200}); }})
  : createUpdates({current: VERSION, form: FORM, file: path.join(dataDir, 'updates.json'), log});

// Who is asking decides whose data they get. A device that was paired (grants.js) carries its secret in a cookie and
// gets its own household. On the home network (FRAME_AUTH unset) an unpaired browser gets the default household, as
// it always has; on the internet (FRAME_AUTH=required) an unpaired browser gets nothing.
const households = createHouseholds({root: path.join(dataDir,'households'), log});
const grants = createGrants({file: path.join(dataDir,'grants.json')});
const setup = createSetup({households, grants});
const admin = require('./admin-api').createAdmin({households, grants});
const authRequired = process.env.FRAME_AUTH === 'required';
const defaultHousehold = () => households.get(process.env.FRAME_HOUSEHOLD || households.list()[0]);
const COOKIE = 'frame', OAUTH_COOKIE = 'gingham_oauth';
// Every write must carry a header that a form on another site cannot send: it forces a CORS preflight this server
// never answers. X-Gingham is the header; the name it had before the product had one is still taken, so that a page
// kept from before the change (the frame keeps its last good page for outages) can still check off a chore.
const fromOurPages = req => req.headers['x-gingham'] === '1' || req.headers['x-family-frame'] === '1';
function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0,i).trim() === name) return part.slice(i+1).trim(); }
  return '';
}
// Inside the kiosk app the server runs on the tablet itself (FRAME_LOCAL_FRAME=1), and that tablet's own screen is
// the household's frame without being paired: it is the one asker that is certainly in the home. Everything else,
// including a phone on the same Wi-Fi, still has to be let in.
const localFrame = process.env.FRAME_LOCAL_FRAME === '1';
const isLoopback = req => ['127.0.0.1','::1'].includes(String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
function whoIs(req) {
  if (localFrame && isLoopback(req) && !cookie(req, COOKIE)) { const home = defaultHousehold(); return {grant: home ? {id:'local',scope:'frame',household:home.id,label:'This tablet'} : null, household: home}; }
  const grant = grants.verify(cookie(req, COOKIE));
  // An admin belongs to no household; shown the frame's page, they see the first one.
  if (grant) { grants.seen(grant.id); return {grant, household: grant.household ? households.get(grant.household) : defaultHousehold()}; }
  return {grant: null, household: authRequired ? null : defaultHousehold()};
}
const secure = req => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
const sessionCookie = (req, secret) => COOKIE+'='+secret+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000'+(secure(req)?'; Secure':'');
// Guessable things (pairing codes) and free things (starting a pairing) are rationed per address. Which address is
// the asker's: on Fly its proxy says so in Fly-Client-IP, which it sets itself; behind another proxy that says who
// connected in X-Forwarded-For, FRAME_TRUST_PROXY=1 takes the address that proxy added; otherwise the connection's.
// A header is never believed by default, since anyone can send one.
const onFly = !!process.env.FLY_APP_NAME, trustProxy = process.env.FRAME_TRUST_PROXY === '1';
const clientAddress = req => String((onFly && req.headers['fly-client-ip']) ||
  (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const spent = new Map(), pinLocks = new Map();
const hasOwner = household => grants.list().some(g => g.household === household && g.scope === 'owner' && !g.revokedAt);
// One household's connection is one IPv6 /64 (a phone picks a new address in it every day), so that is one ration.
const rationKey = address => { if (!net.isIPv6(address)) return address; const g = groups(address); return g ? g.slice(0, 4).map(n => n.toString(16)).join(':') + '::/64' : address; };
let prunedAt = 0;
function rationed(req, what, max, windowMs) {
  const key = what+'|'+rationKey(clientAddress(req)), at = Date.now();
  let entry = spent.get(key);
  if (!entry) {
    // Bounded without ever forgetting someone still being held back: addresses whose window has passed go (looked
    // for at most once a second), and while the table is still full a new address waits like a held-back one.
    if (spent.size >= 5000 && at - prunedAt > 1000) { prunedAt = at; for (const [k, e] of spent) if (!e.times.length || at - e.times[e.times.length - 1] >= e.windowMs) spent.delete(k); }
    if (spent.size >= 5000) return true;
    entry = {windowMs, times: []}; spent.set(key, entry);
  }
  // Only as many times as it takes to know the limit is passed, so a flood from one address costs nothing to keep.
  entry.times = entry.times.filter(t => at - t < windowMs);
  entry.times.push(at);
  if (entry.times.length > max + 1) entry.times.splice(0, entry.times.length - max - 1);
  return entry.times.length > max;
}
const readBody = (req, max = 2000) => new Promise((resolve, reject) => { let body = ''; req.on('data', c => { body += c; if (body.length > max) { req.destroy(); reject(Error('Too large')); } }); req.on('end', () => resolve(body)); req.on('error', reject); });

// Weather is for where the household lives, fetched at most every fifteen minutes each.
const weatherCaches = new Map();
const fixturePlace = {timezone:'America/Chicago',label:'Austin',country:'US'};   // the design-review fixtures are written for this zone
async function weather(id, place) {
  if (place.latitude === null || place.longitude === null) throw Error('This household has not said where it lives');
  let weatherCache = weatherCaches.get(id);
  if (weatherCache && Date.now()-weatherCache.fetchedAt < 900000) return weatherCache;
  // unixtime keeps sunrise/sunset unambiguous for old WebViews that parse offset-less ISO strings as UTC.
  const response = await fetch('https://api.open-meteo.com/v1/forecast?latitude='+place.latitude+'&longitude='+place.longitude+'&current=temperature_2m,apparent_temperature,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&temperature_unit=fahrenheit&timezone='+encodeURIComponent(place.timezone)+'&forecast_days=8&timeformat=unixtime', {signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw Error('Weather unavailable');
  const result = await response.json();
  if (!result.current || !result.daily || !Array.isArray(result.daily.time)) throw Error('Invalid weather');
  const daily=result.daily;
  const days=daily.time.map((t,i)=>({date:dayIn(place.timezone,t*1000+43200000),code:daily.weather_code[i],high:daily.temperature_2m_max[i],low:daily.temperature_2m_min[i],rain:daily.precipitation_probability_max[i],sunrise:daily.sunrise[i]*1000,sunset:daily.sunset[i]*1000}));
  weatherCache = {location:place.label,temperature:result.current.temperature_2m,feelsLike:result.current.apparent_temperature,code:result.current.weather_code,high:days[0].high,low:days[0].low,rain:days[0].rain,days,fetchedAt:Date.now()};
  weatherCaches.set(id, weatherCache);
  return weatherCache;
}
// A paired frame may see its household's photos. Unpaired, on the home network only, the old rule still holds: the
// addresses in sources.json → photoViewers and this machine itself, not everything on the Wi-Fi.
const interfaces = () => { try { return Object.values(os.networkInterfaces()).flat(); } catch (e) { return []; } };   // Android 11+ refuses this to apps
const ownAddresses = () => interfaces().map(a => a.address);
function mayViewPhotos(req, who) {
  if (who.grant) return true;
  if (authRequired || !who.household) return false;
  const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return from === '127.0.0.1' || from === '::1' || (who.household.sources().photoViewers || []).includes(from) || ownAddresses().includes(from);
}
const photoList = m => m.photos.map(p=>({url:'/photos/'+encodeURIComponent(p.file),width:p.width,height:p.height,taken:p.taken,favorite:!!p.favorite,...(p.uploaded?{uploaded:true,file:p.file}:{})}));
const readBytes = (req, max) => new Promise((resolve, reject) => { const parts = []; let size = 0; req.on('data', c => { size += c.length; if (size > max) { req.destroy(); reject(Error('Too large')); } else parts.push(c); }); req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject); });
// Only regular files directly in dist/ and dist/fonts/ with a known type are served.
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
function assets() {
  const found={};
  for (const dir of ['','fonts']) {
    let entries=[];try{entries=fs.readdirSync(path.join(distDir,dir),{withFileTypes:true});}catch(e){}
    entries.filter(f=>f.isFile()&&types[path.extname(f.name)]).forEach(f=>{found['/'+(dir?dir+'/':'')+f.name]=path.join(distDir,dir,f.name);});
  }
  if (found['/index.html']) found['/']=found['/index.html'];
  if (found['/setup.html']) found['/setup']=found['/setup.html'];
  if (found['/lists.html']) found['/lists']=found['/lists.html'];
  if (found['/admin.html']) found['/admin']=found['/admin.html'];
  if (found['/photos.html']) found['/photos']=found['/photos.html'];
  return found;
}
// Frames reload themselves when this changes, so an update never needs someone at the wall.
let versionCache={at:0,value:''};
function version() {
  if (Date.now()-versionCache.at<5000) return versionCache.value;
  const hash=crypto.createHash('sha256');
  Object.entries(assets()).sort().forEach(([name,file])=>{const s=fs.statSync(file);hash.update(name+s.size+s.mtimeMs);});
  versionCache={at:Date.now(),value:hash.digest('hex').slice(0,12)};
  return versionCache.value;
}
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json','X-Frame-Version':version()});res.end(JSON.stringify(body));}
// One request that goes wrong answers 500 (or is cut off) and is logged; it never takes down the server, which on a
// hosted copy is every household's.
http.createServer((req,res)=>{
  serve(req,res).catch(e=>{ log('request failed: '+req.method+' '+String(req.url).slice(0,200)+': '+(e&&e.stack||e)); if(!res.headersSent){res.writeHead(500,{'Content-Type':'text/plain'});res.end('Something went wrong');} else res.destroy(); });
}).listen(port,host,()=>{
  console.log('Gingham: http://localhost:'+port+' · households: '+(households.list().join(', ')||'none')+(authRequired?' · pairing required':''));
  interfaces().filter(a=>a.family==='IPv4'&&!a.internal).forEach(a=>console.log('Local network: http://'+a.address+':'+port));
  if (networkName) networkName.start().catch(() => {});
});
async function serve(req,res){
  let url; try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400,{'Content-Type':'text/plain'}); return res.end('Bad request'); }
  const pathname = url.pathname;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  if (secure(req)) res.setHeader('Strict-Transport-Security','max-age=31536000');
  if (pathname === '/healthz') { res.writeHead(200,{'Content-Type':'text/plain'}); return res.end('ok'); }
  // Pairing: /?k=<secret> once. The secret moves into a cookie scripts cannot read, and the address is wiped clean.
  if (pathname === '/' && url.searchParams.has('k')) {
    if (!grants.verify(url.searchParams.get('k'))) { res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('This setup link is not valid. Ask whoever set up the frame for a new one.'); }
    res.writeHead(302,{'Set-Cookie':sessionCookie(req, url.searchParams.get('k')),Location:'/'});
    return res.end();
  }
  // A person's one-time link. Opening it only shows a button, because message apps fetch every address they are
  // sent to draw a preview, and that must not spend it. Pressing the button does: this device gets its own secret.
  const invite = pathname.match(/^\/s\/([A-Za-z0-9_-]{20,100})$/);
  if (invite) {
    if (rationed(req,'invite',30,600000)) { res.writeHead(429); return res.end('Too many tries. Wait a few minutes.'); }
    const page = (title, inner) => { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Robots-Tag':'noindex'}); res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Gingham</title><style>body{font:17px/1.45 -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;color:#0b2545}main{max-width:22rem;padding:2rem}h1{font-size:1.6rem;margin:0 0 .6rem}p{color:#475569;margin:0 0 1.4rem}button{font:600 1.05rem/1 inherit;width:100%;padding:1rem;border:0;border-radius:.8rem;background:#0b2545;color:#fff}@media(prefers-color-scheme:dark){body{background:#0b1220;color:#f1f5f9}p{color:#94a3b8}button{background:#f1f5f9;color:#0b1220}}</style><main><h1>'+title+'</h1>'+inner+'</main>'); };
    const link = grants.peekLink(invite[1]);
    if (!link) return page('This link has been used', '<p>Setup links work once and last three days. Ask for a new one, or use a device that is already set up to make one.</p>');
    if (req.method === 'POST') {
      const agent = String(req.headers['user-agent'] || ''), device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Macintosh/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows PC' : 'Browser';
      const made = grants.redeemLink(invite[1], device);
      if (!made) return page('This link has been used', '<p>Ask for a new one.</p>');
      res.writeHead(303,{'Set-Cookie':sessionCookie(req, made.secret),Location:made.grant.scope==='admin'?'/admin':'/setup'});
      return res.end();
    }
    const home = link.household && households.get(link.household);
    return page('Set up '+(home && home.sources().name ? String(home.sources().name).slice(0,40).replace(/[<>&"]/g,'') : 'your household'), '<p>This makes this device one that can manage the household: its calendars, lists, photos and frames. The link works once.</p><form method="post"><button>Continue on this device</button></form>');
  }
  // The way back in, from the home itself. A paired frame asks for a code with the household's PIN; a phone then
  // types that code at /setup and becomes an owner. Wrong PINs lock the door for longer each time, per household,
  // because four digits are few and whoever is trying is standing at the frame or holds its secret.
  if (pathname === '/api/owner-code') {
    if (req.method !== 'POST' || !fromOurPages(req)) return json(res,405,{error:'Use POST'});
    const asking = whoIs(req);
    if (!asking.grant || !asking.household) return json(res,401,{error:'This frame is not set up yet.'});
    const lock = pinLocks.get(asking.household.id) || {fails: 0, until: 0, locks: 0};
    if (Date.now() < lock.until) { const wait = Math.ceil((lock.until - Date.now()) / 60000); return json(res,429,{error:'Too many wrong PINs. Try again in ' + wait + (wait === 1 ? ' minute.' : ' minutes.')}); }
    let pin = ''; try { pin = String(JSON.parse(await readBody(req)).pin || ''); } catch(e) {}
    // The very first owner: asked for by the tablet's own screen, while nobody looks after the household, there is
    // no PIN to ask for and nobody who could have set one. The code still has to be read off that screen.
    if (asking.grant.id === 'local' && !hasOwner(asking.household.id)) return json(res,200,grants.startClaim(asking.household.id));
    try { const made = setup.ownerCode(asking.household, pin); pinLocks.delete(asking.household.id); return json(res,200,made); }
    catch(e) {
      if (e.status === 403) { lock.fails++; if (lock.fails >= 5) { lock.until = Date.now() + Math.min(24 * 3600000, 15 * 60000 * 2 ** lock.locks); lock.locks++; lock.fails = 0; } pinLocks.set(asking.household.id, lock); }
      return json(res, e.status || 500, {error: e.status ? e.message : 'That did not work. Try again.'});
    }
  }
  if (pathname === '/api/setup/claim') {
    if (req.method !== 'POST' || !fromOurPages(req)) return json(res,405,{error:'Use POST'});
    if (rationed(req,'claim',10,600000)) return json(res,429,{error:'Too many tries. Wait a few minutes.'});
    let code = ''; try { code = String(JSON.parse(await readBody(req)).code || ''); } catch(e) {}
    const agent = String(req.headers['user-agent'] || ''), device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Macintosh/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows PC' : 'Browser';
    const made = grants.redeemClaim(code, device);
    if (!made) return json(res,400,{error:'No frame is showing that code. Codes last ten minutes.'});
    res.setHeader('Set-Cookie', sessionCookie(req, made.secret));
    return json(res,200,{ok:true});
  }
  // The whole deployment, for an admin. Links it makes carry this server's own address as the asker reached it.
  if (pathname.startsWith('/api/admin')) {
    if (req.method === 'POST' && !fromOurPages(req)) return json(res,403,{error:'Not allowed'});
    if (rationed(req,'admin',60,60000)) return json(res,429,{error:'Slow down'});
    let body = {}; if (req.method === 'POST') { try { body = JSON.parse(await readBody(req, 4000) || '{}'); } catch(e) { return json(res,400,{error:'Send JSON'}); } }
    const asking = grants.verify(cookie(req, COOKIE)); if (asking) grants.seen(asking.id);
    const base = (process.env.FRAME_URL || (secure(req) ? 'https' : 'http') + '://' + String(req.headers.host || 'localhost:' + port)).replace(/\/$/, '');
    const answer = admin.handle({method: req.method, url, grant: asking, body, base});
    return json(res, answer.status, answer.body);
  }
  // Where Google sends a phone back after "Sign in with Google" (googletasks.js). The state in the address is the
  // only proof of who this is; setup.js checks it, and nothing about the code in the address is kept or shown.
  if (pathname === '/oauth/google') {
    if (rationed(req,'oauth',30,60000)) return json(res,429,{error:'Slow down'});
    const answer = await setup.oauthReturn({code: url.searchParams.get('code') || '', state: url.searchParams.get('state') || '', error: url.searchParams.get('error') || '', browser: cookie(req, OAUTH_COOKIE)});
    res.writeHead(answer.status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex','Set-Cookie':OAUTH_COOKIE+'=; Path=/oauth/google; HttpOnly; SameSite=Lax; Max-Age=0'+(secure(req)?'; Secure':'')});
    return res.end(answer.html);
  }
  if (pathname.startsWith('/api/setup')) {
    if (req.method === 'POST' && !fromOurPages(req)) return json(res,403,{error:'Not allowed'});
    if (rationed(req,'setup',120,60000)) return json(res,429,{error:'Slow down'});
    let body = {}; if (req.method === 'POST') { try { body = JSON.parse(await readBody(req, 8000) || '{}'); } catch(e) { return json(res,400,{error:'Send JSON'}); } }
    const asking = grants.verify(cookie(req, COOKIE)); if (asking) grants.seen(asking.id);
    const answer = await setup.handle({method: req.method, url, grant: asking, body});
    // A Google sign-in is finished only by the browser that started it: Google's return brings this cookie (Lax is
    // sent on the way back from another site; the household's own Strict cookie is not) and it must match the state.
    if (answer.bind) res.setHeader('Set-Cookie', OAUTH_COOKIE+'='+answer.bind+'; Path=/oauth/google; HttpOnly; SameSite=Lax; Max-Age=600'+(secure(req)?'; Secure':''));
    return json(res, answer.status, answer.body);
  }
  // Pairing a screen: it asks for a code, shows it, and polls until someone with authority has approved it. The
  // answer to the approved poll is the screen's own secret, set as its cookie and never seen by the page.
  if (pathname === '/api/pair/start' || pathname === '/api/pair/poll') {
    if (req.method !== 'POST' || !fromOurPages(req)) return json(res,405,{error:'Use POST'});
    if (pathname === '/api/pair/start') {
      if (rationed(req,'pair-start',12,600000)) return json(res,429,{error:'Too many tries. Wait a few minutes.'});
      const pairing = grants.startPairing();
      return pairing ? json(res,200,pairing) : json(res,503,{error:'Too many screens are waiting to be paired.'});
    }
    if (rationed(req,'pair-poll',40,60000)) return json(res,429,{error:'Slow down'});
    let device = ''; try { device = JSON.parse(await readBody(req)).device; } catch(e) {}
    const result = grants.pollPairing(String(device || ''));
    if (result.status === 'approved') { res.setHeader('Set-Cookie', sessionCookie(req, result.secret)); return json(res,200,{status:'approved'}); }
    return json(res, result.status === 'pending' ? 202 : 410, {status: result.status});
  }
  const who = pathname.startsWith('/api/') || pathname.startsWith('/photos/') ? whoIs(req) : null;
  if (who && !fixture && !who.household) return pathname.startsWith('/api/') ? json(res,401,{error:'This frame is not set up yet.'}) : (res.writeHead(401), res.end());
  const home = who && who.household;
  if (pathname === '/api/settings') {
    const settings = fixture ? fixtureSettings : home.settings;
    if (req.method === 'GET') return json(res,200,settings.read());
    // Same guard as the task write: the custom header forces a CORS preflight this server never answers.
    if (req.method !== 'POST') return json(res,405,{error:'Use GET or POST'});
    if (!fromOurPages(req)) return json(res,403,{error:'Not allowed'});
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on('end', () => { try { return json(res,200,settings.update(JSON.parse(body || '{}'))); } catch(e) { return json(res,400,{error:'Send settings as JSON'}); } });
    return;
  }
  // The version this is, and whether a newer one is out. `app` is the Android app's own version when the page runs in
  // it, which can differ from the server's when the app shows a server elsewhere. The check is the whole server's, so
  // a frame may turn it off only where the server has one household: on a shared server it is its operator's to set.
  if (pathname === '/api/updates') {
    if (req.method === 'GET') return json(res,200,{...updates.status(url.searchParams.get('app')),mayChange:!updates.status().locked&&(!!fixture||households.list().length<=1)});
    if (req.method !== 'POST') return json(res,405,{error:'Use GET or POST'});
    if (!fromOurPages(req)) return json(res,403,{error:'Not allowed'});
    if (!fixture && (updates.status().locked || households.list().length > 1)) return json(res,403,{error:'Whoever runs this frame’s server decides this.'});
    let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch(e) { return json(res,400,{error:'Send JSON'}); }
    if (typeof body.check !== 'boolean') return json(res,400,{error:'Send {"check": true} or {"check": false}'});
    return json(res,200,{...updates.setEnabled(body.check),mayChange:true});
  }
  if (fixture && pathname.startsWith('/api/')) {
    if (/\/close$/.test(pathname)) return json(res,200,{ok:true});
    if (pathname === '/api/household') return json(res,200,{name:'Household',timezone:fixturePlace.timezone,place:fixturePlace.label,country:fixturePlace.country});
    const key = {'/api/calendar':'calendar','/api/tasks':'tasks','/api/weather':'weather','/api/photos':'photos'}[pathname], body = key && fixture[key];
    if (body === 'album') { const d = defaultHousehold(); return json(res,200,{photos:photoList(d ? d.photoManifest() : {photos:[]}),configured:true}); }
    return body ? json(res,200,body) : json(res,503,{error:'Unavailable in this fixture'});
  }
  // Photos sent from a phone. Whoever may change the household may add to its pictures; a frame may not, so a
  // stolen frame secret cannot be used to put pictures on a family's wall.
  if (pathname === '/api/photos/add' || pathname === '/api/photos/remove') {
    if (req.method !== 'POST' || !fromOurPages(req)) return json(res,405,{error:'Use POST'});
    if (!mayManage(who.grant, home.id)) return json(res,403,{error:'Open your setup link on this device first.'});
    if (rationed(req,'photo-write',240,600000)) return json(res,429,{error:'Slow down'});
    if (pathname === '/api/photos/remove') {
      let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch(e) { return json(res,400,{error:'Send JSON'}); }
      return home.uploads.remove(String(body.file || '')) ? json(res,200,{ok:true}) : json(res,404,{error:'That photo is already gone.'});
    }
    let bytes; try { bytes = await readBytes(req, home.uploads.MAX_BYTES); } catch(e) { return json(res,413,{error:'That photo is too large.'}); }
    try { return json(res,200,{ok:true,...home.uploads.add(bytes,{taken:String(req.headers['x-taken']||''),today:dayIn(home.place().timezone,Date.now())})}); }
    catch(e) { return json(res, e.code==='FULL'?409:e.code?400:500, {error: e.code ? e.message : 'Can’t keep that photo right now.'}); }
  }
  // Adding to a list, at the wall or from a phone. Same guard as the other writes.
  if (pathname === '/api/tasks' && req.method === 'POST') {
    if (!fromOurPages(req)) return json(res,403,{error:'Not allowed'});
    if (rationed(req,'add-task',60,60000)) return json(res,429,{error:'Slow down'});
    let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch(e) { return json(res,400,{error:'Send JSON'}); }
    try { await home.addTask(String(body.list || ''), body.title); return json(res,200,{ok:true}); }
    catch(e) { return json(res, e.code==='UNKNOWN_LIST'?404:e.code==='EMPTY'||e.code==='FULL'?400:503, {error: e.code ? e.message : 'Can’t add that right now. Try again.'}); }
  }
  const close = pathname.match(/^\/api\/tasks\/([A-Za-z0-9]{1,40})\/close$/);
  if (close) {
    // The one write path. The custom header forces a CORS preflight this server never answers,
    // so another site open in a browser on the home network cannot complete tasks.
    if (req.method !== 'POST') return json(res,405,{error:'Use POST'});
    if (!fromOurPages(req)) return json(res,403,{error:'Not allowed'});
    try {await home.closeTask(close[1]);return json(res,200,{ok:true});}
    catch(e) {return json(res,e.code==='UNKNOWN_TASK'?404:503,{error:e.code==='UNKNOWN_TASK'?'That task is no longer on the list.':'Can’t check that off right now. Try again.'});}
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405);return res.end();}
  if (pathname === '/api/weather') {
    try {return json(res,200,await weather(home.id, home.place()));}
    catch(e) {const last=weatherCaches.get(home.id);return last?json(res,200,{...last,stale:true}):json(res,503,{error:'Weather unavailable'});}
  }
  // What the page needs to keep house time and name the place: nothing here is secret within the household.
  if (pathname === '/api/household') {
    const p = home.place(), local = !!(who.grant && who.grant.id === 'local');
    // A tablet running its own server: where a phone on the Wi-Fi finds it, for the QR codes its screen shows; and, while
    // nobody looks after the household yet, that the page should walk them through it.
    const named = networkName && networkName.host() ? 'http://' + networkName.host() + ':' + port : '';
    const address = process.env.FRAME_URL || (interfaces().filter(a=>a.family==='IPv4'&&!a.internal).map(a=>'http://'+a.address+':'+port)[0] || '');
    const counting = upcoming(home.sources().countdowns, dayIn(p.timezone, Date.now()));
    return json(res,200,{name:p.name,timezone:p.timezone,place:p.label,...(p.country?{country:p.country}:{}),...(counting.length?{countdowns:counting}:{}),...(local ? {address,...(named?{named}:{})} : {}),...(local && !hasOwner(home.id) ? {needsSetup:true} : {})});
  }
  if (pathname === '/api/photos') {
    if (!mayViewPhotos(req, who)) return json(res,403,{photos:[],error:'Photos are shown only on paired frames'});
    const m = home.photoManifest(), status = home.photoStatus();
    return json(res,200,{photos:photoList(m),syncedAt:m.syncedAt||null,error:status.error||undefined,configured:status.configured});
  }
  if (pathname.startsWith('/photos/')) {
    const from = fixture ? defaultHousehold() : home;
    if (!from || !(fixture || mayViewPhotos(req, who))) {res.writeHead(403);return res.end();}
    let name;try{name=decodeURIComponent(pathname.slice(8));}catch(e){res.writeHead(400);return res.end();}
    const onDisk = from.photoPath(name);
    if (!onDisk) {res.writeHead(404);return res.end();}
    // File names carry a checksum (iCloud's, or ours for an added photo), so a given name never changes content.
    res.setHeader('Content-Type','image/jpeg');res.setHeader('Cache-Control','private, max-age=31536000, immutable');
    const stream=fs.createReadStream(onDisk);stream.on('error',()=>res.destroy());return stream.pipe(res);
  }
  if (pathname === '/api/calendar' || pathname === '/api/tasks') {
    try {
      if(pathname==='/api/calendar') {
        try {require('./integrations').range(url.searchParams.get('from'),url.searchParams.get('to'));}
        catch(e){return json(res,400,{error:'Use a valid date range of at most 32 days'});}
      }
      const data=pathname==='/api/tasks'?await home.tasks():await home.calendar(url.searchParams.get('from'),url.searchParams.get('to'));
      return json(res,200,data);
    } catch(e) {return json(res,503,{error:'Sync unavailable. Retrying automatically.'});}
  }
  const file=assets()[pathname];
  if (!file) {res.writeHead(404);return res.end('Not found');}
  fs.readFile(file, (error,body)=>{
    if(error){res.writeHead(500);return res.end('Unable to load page');}
    const type=types[path.extname(file)];
    res.writeHead(200,{'Content-Type':type,...(type==='font/woff2'?{'Cache-Control':'public, max-age=31536000, immutable'}:{})});res.end(body);
  });
}
// FRAME_MDNS=frame answers to "frame.local" on the home network. For a tablet that is its own server; see mdns.js
// for why it stays off everywhere else.
const networkName = process.env.FRAME_MDNS ? require('./mdns').createResponder({name: process.env.FRAME_MDNS, log: text => console.log(text)}) : null;

// First run: with no household yet there is nothing to show and nobody who may change that, so one is made and a
// one-time setup link is printed where whoever started the server will see it (the terminal, `docker logs`).
if (!fixture && !households.list().length) {
  households.create('home');
  const link = (process.env.FRAME_URL || 'http://localhost:' + port).replace(/\/$/, '') + '/s/' + grants.mintLink({scope: 'owner', household: 'home', label: 'First setup'});
  console.log('\n  No household yet, so one was made. Open this once, on the phone or computer you will manage it from:\n\n    ' + link + '\n\n  It works once, for three days. Then open the server\'s address on your frame and pair it from that page.\n');
}

// Keep every household's window (today and the four weeks ahead) and photos fresh even when no frame is open.
const WINDOW_DAYS = require('./integrations').WINDOW_DAYS;
function backgroundSync() {
  households.list().map(id=>households.get(id)).filter(Boolean).forEach(h=>{
    // "Today" is the household's today, which the page asks for too, so both warm the same cache key.
    const zone=h.place().timezone, from=dayIn(zone), to=dayIn(zone, Date.parse(from+'T12:00:00Z')+WINDOW_DAYS*86400000);
    Promise.allSettled([h.calendar(from,to),h.tasks()]).then(results=>{
      if(results.some(r=>r.status==='rejected'||r.value.stale))log(h.id+' sync interrupted; retrying.');
    });
  });
}
const syncAllPhotos = () => households.list().map(id=>households.get(id)).filter(Boolean).forEach(h=>h.syncPhotos());
if (!fixture) { backgroundSync();setInterval(backgroundSync,60000); syncAllPhotos();setInterval(syncAllPhotos,15*60000); updates.start(); }
else updates.check();
