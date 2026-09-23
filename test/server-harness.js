// Running the real server in a test: on a port nothing else can be holding, and never talking to anything but the
// process this started.
//
// It used to be a guess — `4800 + Math.random() * 500`, a health probe that gave up after five seconds, and a test
// that carried on either way. A guess in that range is a bet against everything else on the machine (ADB listens on
// 5037, AirPlay on 5000, a container on 5055) and against the other test files, which `node --test` runs at the same
// time and which guessed from overlapping ranges. Losing the bet was silent: our own server died of EADDRINUSE with
// its output thrown away, the probe timed out, and the test spent its assertions on a stranger. Two of those strangers
// are on record: ADB, which accepts a connection and closes it, and something answering `<!DOCTYPE html>` where a
// household's JSON was expected.
//
// Now the operating system names a free port, the server says on stdout which port it bound, and nothing goes on
// until that line arrives from the child this spawned. The one race left is another process taking the port in the
// moment between the probe closing and the child binding; the child then exits, which is seen, and another port is
// tried. A server that never announces itself is an error carrying the child's own output — never a test that
// quietly continues.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');

const SERVER = path.join(__dirname, '..', 'server.js');
// Everything the product reads from the environment. A machine with FRAME_MASTER_KEY or FLY_APP_NAME set in its shell
// must not run different tests from everyone else, so each is dropped and only what a test asks for is put back.
const PRODUCT_ENV = ['FLY_APP_NAME', 'FRAME_ALLOW_PRIVATE_FEEDS', 'FRAME_AUTH', 'FRAME_DATA', 'FRAME_FIXTURE', 'FRAME_HOUSEHOLD',
  'FRAME_LOCAL_FRAME', 'FRAME_MASTER_KEY', 'FRAME_MDNS', 'FRAME_TRUST_PROXY', 'FRAME_URL', 'GINGHAM_GOOGLE_CLIENT_ID',
  'GINGHAM_GOOGLE_CLIENT_SECRET', 'GINGHAM_MS_CLIENT_ID', 'HOST', 'PORT', 'GINGHAM_FORM', 'GINGHAM_UPDATE_CHECK', 'GINGHAM_UPDATE_URL',
  'FRAME_FIXTURE_UPDATE'];
// A test server never asks GitHub whether a newer Gingham is out, unless the test says where to ask instead.
const QUIET = {GINGHAM_UPDATE_URL: 'http://127.0.0.1:9/nothing-listens-here'};

const makeData = (prefix = 'frame-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A household on disk, as the server expects to find one.
function writeHousehold(data, id, sources = {}) {
  const dir = path.join(data, 'households', id);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({name: id, timezone: 'America/Chicago', calendars: [], projects: [], ...sources}));
  return dir;
}

// A port the kernel says is free, rather than one this hopes is. TCP and UDP are separate spaces, so ask in the one
// that will be used.
const freePort = (kind = 'tcp') => new Promise((resolve, reject) => {
  if (kind === 'udp') {
    // Bound the way the responder binds it — every interface — since a port free on one is not free on all.
    const probe = require('node:dgram').createSocket('udp4');
    probe.once('error', reject);
    probe.bind(0, () => { const {port} = probe.address(); probe.close(() => resolve(port)); });
    return;
  }
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const {port} = probe.address(); probe.close(error => error ? reject(error) : resolve(port)); });
});

// Resolves 'listening' once the child says it has bound the port it was given, or 'exited' if it stopped before that.
// Never resolves on anything the child did not write itself.
function announced(child, port, output, timeoutMs) {
  return new Promise((resolve, reject) => {
    const said = 'Gingham: http://localhost:' + port + ' ';
    const finish = (what, error) => { clearTimeout(timer); child.stdout.off('data', look); child.off('exit', stopped); child.off('error', failed); error ? reject(error) : resolve(what); };
    const look = () => { if (output.text.includes(said)) finish('listening'); };
    const stopped = () => finish('exited');
    const failed = error => finish(null, error);
    const timer = setTimeout(() => finish(null, Error('The server said nothing in ' + timeoutMs + 'ms.')), timeoutMs);
    child.stdout.on('data', look);
    child.once('exit', stopped);
    child.once('error', failed);
    look();
  });
}

// `startServer({env})` → {url, port, data, server, stop}. `stop()` waits for the process to be gone before the scratch
// folder is removed, so nothing is still writing into a directory that is being deleted.
async function startServer({data = makeData(), env = {}, attempts = 5, timeoutMs = 20000} = {}) {
  const clean = {...process.env};
  for (const name of PRODUCT_ENV) delete clean[name];
  let lost = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await freePort();
    // Where it listens and where it keeps its data are the harness's to say, so a test cannot take back the port and
    // leave the handshake below waiting for a line that will never come.
    const child = spawn(process.execPath, [SERVER], {env: {...clean, ...QUIET, ...env, FRAME_DATA: data, HOST: '127.0.0.1', PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe']});
    const output = {text: ''};
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', chunk => { output.text += chunk; }); }
    const exited = once(child, 'exit');
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      fs.rmSync(data, {recursive: true, force: true});
    };
    let state;
    try { state = await announced(child, port, output, timeoutMs); }
    catch (error) { child.kill('SIGKILL'); await exited; fs.rmSync(data, {recursive: true, force: true}); throw Error(error.message + '\n' + output.text); }
    // A port that went to somebody else between the probe and the bind is worth another try; anything else the server
    // said as it stopped is the answer, and repeating it four more times would only bury it.
    if (state === 'exited') {
      if (!/EADDRINUSE/.test(output.text)) { fs.rmSync(data, {recursive: true, force: true}); throw Error('The server stopped instead of starting:\n' + output.text); }
      lost = output.text;
      continue;
    }
    const url = 'http://127.0.0.1:' + port;
    const health = await fetch(url + '/healthz').catch(error => error);
    if (!health.ok) { await stop(); throw Error('The server announced itself on ' + port + ' and then did not answer /healthz: ' + health + '\n' + output.text); }
    return {url, port, data, server: child, output: () => output.text, stop};
  }
  fs.rmSync(data, {recursive: true, force: true});
  throw Error('The port was taken out from under the server ' + attempts + ' times running.\n' + lost);
}

module.exports = {startServer, makeData, writeHousehold, freePort};
