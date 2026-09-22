const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const {createResponder, parse, answer, query, tidyName} = require('../mdns');
const {freePort} = require('./server-harness');

test('a name is tidied to what a network name may be', () => {
  assert.equal(tidyName('Frame.local'), 'frame');
  assert.equal(tidyName(' Kitchen Frame! '), 'kitchenframe');
  assert.equal(tidyName('-frame-'), 'frame');
  assert.throws(() => createResponder({name: '...'}));
});

test('a question and its answer survive the trip through a packet', () => {
  const asked = parse(query('frame.local'));
  assert.deepEqual(asked.questions, [{name: 'frame.local', type: 1, unicast: false}]);
  assert.equal(asked.response, false);
  const packet = answer('frame.local', '192.168.1.40'), told = parse(packet);
  assert.equal(told.response, true);
  assert.deepEqual(told.answers, [{name: 'frame.local', type: 1}]);
  assert.ok(packet.includes(Buffer.from([192, 168, 1, 40])));
});

test('a packet that points at itself, or stops short, reads as nothing', () => {
  const loop = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from([0xc0, 12, 0, 1, 0, 1])]);
  assert.equal(parse(loop), null);
  assert.equal(parse(Buffer.from([1, 2, 3])), null);
  assert.equal(parse(query('frame.local').subarray(0, 20)), null);
});

const ask = (port, name) => new Promise((resolve, reject) => {
  const socket = dgram.createSocket('udp4'), timer = setTimeout(() => { socket.close(); resolve(null); }, 600);
  socket.on('message', packet => { clearTimeout(timer); socket.close(); resolve(packet); });
  socket.on('error', reject);
  const packet = query(name); packet.writeUInt16BE(0x1234, 0);
  socket.send(packet, port, '127.0.0.1');
});

test('it answers to its own name, with the address that faces the asker, and to no other name', async () => {
  // A port the kernel says is free. The responder asks for SO_REUSEADDR, as an mDNS responder must, so a guessed port
  // another process already held would be bound without complaint and the answers would go to whoever got there first.
  const port = await freePort('udp');
  const responder = createResponder({name: 'Frame', port, settleMs: 30, address: async them => { assert.equal(them, '127.0.0.1'); return '192.168.1.40'; }});
  try {
    assert.equal(await responder.start(), 'frame.local');
    const packet = await ask(port, 'FRAME.local');
    assert.ok(packet, 'an answer came back');
    assert.equal(packet.readUInt16BE(0), 0x1234, 'a plain lookup gets its own id back');
    assert.deepEqual(parse(packet).answers, [{name: 'frame.local', type: 1}]);
    assert.ok(packet.includes(Buffer.from([192, 168, 1, 40])));
    assert.equal(await ask(port, 'somebody-else.local'), null);
  } finally { responder.stop(); }
});
