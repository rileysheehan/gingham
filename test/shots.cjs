/*
  The ruler: screenshots of the wall and the phone pages, taken the same way every time, so a change that should look
  like nothing can be shown to look like nothing. Take a set before a change and a set after it, and compare the two
  folders file by file.

    node test/shots.cjs --out <folder> [--root <checkout>] [--ports 4550-4599] [--fixtures stress,quiet,offline] [--only <regexp>]

  --out       where the PNGs go (made if missing).
  --root      the checkout whose server is photographed; this one by default. Point it at a second worktree of an
              older commit to take the "before" set with this script.
  --ports     the ports the servers may use, one per screenshot; 34 are needed with the default fixtures.
  --fixtures  test/fixtures.js names. The first gets every view in day and night (week, agenda, each list, photos,
              settings, Larger text, and the week with the tablet itself in dark mode); each other one gets the week
              in day and night. The phone pages are shown with the first.
  --only      take only the screenshots whose names match, e.g. --only 'week|phone-lists'.

  It needs two things this repository does not install, named by environment variables:
    PLAYWRIGHT_CORE  a path to playwright-core (or leave it unset if `require('playwright-core')` finds one);
    CHROME           a Chrome or Chromium executable, e.g. "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                     on a Mac (unset, Playwright looks for an installed Google Chrome).
  It is a tool for people changing the design, not a test: `npm test` does not run it and nothing depends on it.

  What makes two runs comparable:
  - one fresh server per screenshot (FRAME_FIXTURE, never a live account; settings are kept in memory, so a server
    that showed Larger text would show it to the next page too);
  - the album is always the site's public photo (site/photo-june.jpg): /api/photos and /photos/… are answered here,
    so no household's pictures are ever captured;
  - service workers are blocked, so nothing is served from a cache;
  - the clock is fixed and Math.random is seeded, so the weather's drift and any shuffle land the same way;
  - animations and transitions are finished before each screenshot, and Chrome draws on the CPU (CHROME_FLAGS).

  To compare two sets: `cmp` each pair, and where the bytes differ count the pixels that differ at all, e.g.
    magick before/x.png after/x.png -compose difference -composite -threshold 0 -separate -evaluate-sequence max \
      -format '%[fx:mean*w*h]' info:
*/
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!/^--(out|root|ports|fixtures|only)$/.test(key) || value === undefined) { console.error('usage: node test/shots.cjs --out <folder> [--root <checkout>] [--ports 4550-4599] [--fixtures stress,quiet,offline] [--only <regexp>]'); process.exit(2); }
  args[key.slice(2)] = value;
}
if (!args.out) { console.error('--out is required'); process.exit(2); }
const OUT = path.resolve(args.out);
const ROOT = path.resolve(args.root || path.join(__dirname, '..'));
const [FIRST_PORT, LAST_PORT] = (args.ports || '4550-4599').split('-').map(Number);
const FIXTURES = (args.fixtures || 'stress,quiet,offline').split(',').filter(Boolean);
const ONLY = args.only ? new RegExp(args.only) : null;
if (!(FIRST_PORT > 0 && LAST_PORT >= FIRST_PORT)) { console.error('--ports is a range, like 4550-4599'); process.exit(2); }
if (!fs.existsSync(path.join(ROOT, 'server.js'))) { console.error(ROOT + ' has no server.js'); process.exit(2); }
fs.mkdirSync(OUT, {recursive: true});

// The photo is read from this checkout, not --root's, so both sides of a comparison show the same bytes.
const PHOTO = fs.readFileSync(path.join(__dirname, '..', 'site', 'photo-june.jpg'));
const PHOTO_SIZE = jpegSize(PHOTO);
const FIXED_TIME = new Date('2026-09-23T17:40:00-05:00');
// Drawn on the CPU: with the GPU, the edges of the clock's digits and a card's corners came out one to three levels apart
// from one run to the next on the same code, which would hide a real one-level change or invent one.
const CHROME_FLAGS = ['--disable-gpu', '--disable-gpu-rasterization', '--disable-partial-raster', '--force-color-profile=srgb'];

let nextPort = FIRST_PORT;
const running = new Set();
async function fresh(fixture) {
  if (nextPort > LAST_PORT) throw Error('Out of ports: widen --ports');
  const port = nextPort++;
  const srv = spawn(process.execPath, ['server.js'], {cwd: ROOT, env: {...process.env, FRAME_FIXTURE: fixture, PORT: String(port), HOST: '127.0.0.1'}, stdio: 'ignore'});
  const gone = new Promise(resolve => srv.once('exit', resolve));
  running.add(srv);
  const stop = async () => { if (srv.exitCode === null && srv.signalCode === null) srv.kill(); await gone; running.delete(srv); };
  for (let i = 0; i < 100; i++) {
    if (srv.exitCode !== null) break;
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return {base: `http://127.0.0.1:${port}`, stop}; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  await stop();
  throw Error(`The server on port ${port} did not start (fixture ${fixture})`);
}
const stopAll = () => { for (const srv of running) srv.kill(); };
process.on('exit', stopAll);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopAll(); process.exit(130); });

async function contextFor(browser, options) {
  const ctx = await browser.newContext({...options, serviceWorkers: 'block'});
  await ctx.clock.setFixedTime(FIXED_TIME);
  await ctx.addInitScript(() => { let s = 20260923; Math.random = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; });
  await ctx.route(/^http:\/\/127\.0\.0\.1:\d+\/api\/photos(\?.*)?$/, r => r.fulfill({json: {configured: true, photos: [{url: '/photos/site-photo-june.jpg', width: PHOTO_SIZE.width, height: PHOTO_SIZE.height, taken: '2026-09-20', favorite: false}]}}));
  await ctx.route(/^http:\/\/127\.0\.0\.1:\d+\/photos\/./, r => r.fulfill({body: PHOTO, contentType: 'image/jpeg'}));
  return ctx;
}

const taken = [];
async function shoot(page, name, fullPage) {
  await page.screenshot({path: path.join(OUT, name + '.png'), fullPage, animations: 'disabled'});
  taken.push(name);
  console.log(name);
}
const clickText = (p, sel, text) => p.locator(sel, {hasText: text}).first().click();
const openSetting = async (p, choice) => { await p.click('#settings-button'); await p.waitForTimeout(500); await clickText(p, '#view-settings button', choice); await p.waitForTimeout(400); await p.click('#tab-calendar'); };

async function wall(browser, {fixture, now, sky, name, setup, scheme = 'light'}) {
  if (ONLY && !ONLY.test(name)) return;
  const server = await fresh(fixture);
  try {
    const ctx = await contextFor(browser, {viewport: {width: 1920, height: 1080}, colorScheme: scheme});
    const p = await ctx.newPage();
    await p.goto(`${server.base}/?now=${now}&sky=${sky}`); await p.waitForTimeout(2500);
    if (setup) await setup(p);
    await p.waitForTimeout(1200);
    await shoot(p, name, false);
    await ctx.close();
  } finally { await server.stop(); }
}

async function phone(browser, {fixture, pathname, name, scheme}) {
  if (ONLY && !ONLY.test(name)) return;
  const server = await fresh(fixture);
  try {
    const ctx = await contextFor(browser, {viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: scheme, isMobile: true, hasTouch: true});
    const p = await ctx.newPage();
    await p.goto(server.base + pathname); await p.waitForTimeout(1500);
    await shoot(p, name, true);
    await ctx.close();
  } finally { await server.stop(); }
}

(async () => {
  const browser = await chromium.launch({...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: 'chrome'}), headless: true, args: CHROME_FLAGS});
  try {
    const [first, ...others] = FIXTURES;
    const times = [['day', '2026-09-23T17:40:00', 'day'], ['night', '2026-09-23T19:16:00', 'night']];
    for (const [mode, now, sky] of times) {
      const at = {fixture: first, now, sky}, prefix = `wall-${first}-${mode}`;
      await wall(browser, {...at, name: `${prefix}-week`});
      await wall(browser, {...at, name: `${prefix}-agenda`, setup: p => openSetting(p, 'Agenda')});
      for (const list of ['Family', 'Chores', 'Grocery', 'June'])
        await wall(browser, {...at, name: `${prefix}-${list.toLowerCase()}`, setup: p => clickText(p, '.dock button', list)});
      await wall(browser, {...at, name: `${prefix}-photos`, setup: p => clickText(p, '.dock button', 'Photos')});
      await wall(browser, {...at, name: `${prefix}-settings`, setup: p => p.click('#settings-button')});
      await wall(browser, {...at, name: `${prefix}-week-larger`, setup: p => openSetting(p, 'Larger')});
      // A tablet set to dark mode must not change the wall, which themes by the sky, not by the tablet.
      await wall(browser, {...at, name: `${prefix}-week-tablet-dark`, scheme: 'dark'});
    }
    for (const fixture of others) for (const [mode, now, sky] of times) await wall(browser, {fixture, now, sky, name: `wall-${fixture}-${mode}-week`});
    // The phone pages, and the page Google sends the phone back to (here refusing an unknown sign-in).
    for (const scheme of ['light', 'dark'])
      for (const [page, pathname] of [['setup', '/setup'], ['lists', '/lists'], ['admin', '/admin'], ['photos', '/photos'], ['google-return', '/oauth/google?state=none']])
        await phone(browser, {fixture: first, pathname, name: `phone-${page}-${scheme}`, scheme});
  } finally { await browser.close(); stopAll(); }
  console.log(`${taken.length} screenshots in ${OUT}`);
})().catch(e => { console.error(e); stopAll(); process.exit(1); });

// A JPEG's pixel size, from its first frame header.
function jpegSize(buf) {
  for (let i = 2; i < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1], length = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return {height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7)};
    i += 2 + length;
  }
  throw Error('Not a JPEG');
}
