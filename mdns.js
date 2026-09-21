// A name on the home network: "frame.local" instead of a row of numbers that the router may change next week.
// This is the smallest useful piece of multicast DNS (RFC 6762): it answers "who is <name>.local?" with this
// machine's address, and nothing else. Phones from Apple, computers, and Android 12 and later ask this way by
// themselves; older Androids do not, which is why the numbers are always shown beside the name.
//
// Off unless FRAME_MDNS names it. Inside a container multicast never arrives, and on a shared host the name belongs
// to the host, not to this program.
const dgram = require('node:dgram');

const GROUP = '224.0.0.251', PORT = 5353, A = 1, AAAA = 28, NSEC = 47, ANY = 255, IN = 1, FLUSH = 0x8000;
const tidyName = name => String(name || '').toLowerCase().replace(/\.local\.?$/, '').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 40);

function encodeName(name) {
  const parts = name.split('.').filter(Boolean).map(label => { const b = Buffer.from(label); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...parts, Buffer.from([0])]);
}
// Names in a packet may point back at earlier ones. Bounded, so a packet that points at itself reads as nothing.
function readName(packet, at) {
  const labels = []; let next = at, end = -1, hops = 0;
  for (;;) {
    if (next >= packet.length) return null;
    const length = packet[next];
    if (length === 0) { if (end < 0) end = next + 1; break; }
    if ((length & 0xc0) === 0xc0) {
      if (next + 1 >= packet.length || ++hops > 16) return null;
      if (end < 0) end = next + 2;
      next = ((length & 0x3f) << 8) | packet[next + 1];
      continue;
    }
    if (length > 63 || next + 1 + length > packet.length) return null;
    labels.push(packet.toString('utf8', next + 1, next + 1 + length));
    next += 1 + length;
  }
  return {name: labels.join('.').toLowerCase(), end};
}
function parse(packet) {
  if (packet.length < 12) return null;
  const flags = packet.readUInt16BE(2), counts = [4, 6].map(at => packet.readUInt16BE(at));
  const questions = [], answers = [];
  let at = 12;
  for (let i = 0; i < Math.min(counts[0], 32); i++) {
    const read = readName(packet, at);
    if (!read || read.end + 4 > packet.length) return null;
    questions.push({name: read.name, type: packet.readUInt16BE(read.end), unicast: !!(packet.readUInt16BE(read.end + 2) & 0x8000)});
    at = read.end + 4;
  }
  for (let i = 0; i < Math.min(counts[1], 32); i++) {
    const read = readName(packet, at);
    if (!read || read.end + 10 > packet.length) break;
    const type = packet.readUInt16BE(read.end), length = packet.readUInt16BE(read.end + 8);
    answers.push({name: read.name, type});
    at = read.end + 10 + length;
  }
  return {id: packet.readUInt16BE(0), response: !!(flags & 0x8000), questions, answers};
}
function record(name, type, ttl, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0); head.writeUInt16BE(IN | FLUSH, 2); head.writeUInt32BE(ttl, 4); head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), head, data]);
}
// The answer, and beside it a note that this name has an IPv4 address and nothing else, so nobody waits on IPv6.
function answer(name, address, {id = 0, question = null, ttl = 120} = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0); header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(question ? 1 : 0, 4); header.writeUInt16BE(1, 6); header.writeUInt16BE(1, 10);
  const asked = question ? Buffer.concat([encodeName(name), Buffer.from([question.type >> 8, question.type & 255, 0, IN])]) : Buffer.alloc(0);
  const only = Buffer.concat([encodeName(name), Buffer.from([0, 1, 0x40])]);      // window 0, one byte, bit 1: A
  return Buffer.concat([header, asked, record(name, A, ttl, Buffer.from(address.split('.').map(Number))), record(name, NSEC, ttl, only)]);
}
function query(name) {
  const header = Buffer.alloc(12); header.writeUInt16BE(1, 4);
  return Buffer.concat([header, encodeName(name), Buffer.from([0, A, 0, IN])]);
}

// Which of this machine's addresses does that asker reach? The system knows: aim a socket at them and read where
// it would send from. Nothing is sent. Asking for the list of interfaces instead fails on newer Androids.
function addressFacing(them) {
  return new Promise(resolve => {
    const probe = dgram.createSocket('udp4'), done = found => { try { probe.close(); } catch (e) {} resolve(found); };
    probe.on('error', () => done(null));
    try { probe.connect(PORT, them, () => { let mine = null; try { mine = probe.address().address; } catch (e) {} done(mine && mine !== '0.0.0.0' ? mine : null); }); }
    catch (e) { done(null); }
  });
}

function createResponder({name, log = () => {}, port = PORT, group = GROUP, address = addressFacing, settleMs = 750} = {}) {
  const wanted = tidyName(name);
  if (!wanted) throw Error('A network name needs letters or numbers');
  let host = wanted + '.local', socket = null, rejoin = null, settled = false, taken = false, closed = false;
  const join = () => { try { socket.dropMembership(group); } catch (e) {} try { socket.addMembership(group); } catch (e) {} };

  async function heard(packet, from) {
    const message = parse(packet);
    if (!message) return;
    // While settling, another machine answering to the name means it is theirs.
    if (message.response) { if (!settled && message.answers.some(a => a.name === host && a.type === A)) taken = true; return; }
    if (!settled) return;
    const question = message.questions.find(q => q.name === host && [A, AAAA, ANY].includes(q.type));
    if (!question) return;
    const mine = await address(from.address);
    if (!mine || closed) return;
    // Proper askers listen on the group; simple ones (a plain DNS lookup aimed at 5353) want it sent straight back.
    if (from.port !== PORT) socket.send(answer(host, mine, {id: message.id, question, ttl: 10}), from.port, from.address);
    else socket.send(answer(host, mine), port, question.unicast ? from.address : group);
  }

  // Two frames in one home must not both be "frame": ask first, and take frame-2 if somebody answers.
  async function settle() {
    for (let n = 1; n <= 9; n++) {
      host = (n === 1 ? wanted : wanted + '-' + n) + '.local'; taken = false;
      for (let i = 0; i < 3 && !taken; i++) { try { socket.send(query(host), port, group); } catch (e) {} await new Promise(r => setTimeout(r, settleMs / 3)); }
      if (!taken) break;
    }
    settled = true;
    log('On this network as ' + host);
    return host;
  }

  function start() {
    return new Promise((resolve, reject) => {
      socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
      socket.on('error', e => { log('Network name unavailable: ' + e.message); reject(e); });
      socket.on('message', (packet, from) => { heard(packet, from).catch(() => {}); });
      socket.bind(port, () => {
        try { socket.setMulticastTTL(255); socket.setMulticastLoopback(true); } catch (e) {}
        join();
        rejoin = setInterval(join, 60000); rejoin.unref();      // Wi-Fi comes and goes, and takes the membership with it
        settle().then(resolve);
      });
    });
  }
  function stop() { closed = true; clearInterval(rejoin); try { socket.close(); } catch (e) {} }
  return {start, stop, host: () => settled ? host : null};
}
module.exports = {createResponder, parse, answer, query, encodeName, tidyName};
