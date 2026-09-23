// The QR codes the wall shows (dist/qr.js) are read back here by a decoder written separately from the standard
// (ISO/IEC 18004): format and version information, mask, placement, block interleaving, Reed-Solomon check words and the
// byte-mode payload are all checked, so a code that a phone could not read fails here first.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {qrMatrix} = require('../dist/qr.js');

// Level M, versions 1-10, from the standard's tables: check words per block, then the data words of each block in order.
const rep = (count, words) => Array(count).fill(words);
const BLOCKS_M = {1: [10, rep(1, 16)], 2: [16, rep(1, 28)], 3: [26, rep(1, 44)], 4: [18, rep(2, 32)], 5: [24, rep(2, 43)], 6: [16, rep(4, 27)],
  7: [18, rep(4, 31)], 8: [22, [...rep(2, 38), ...rep(2, 39)]], 9: [22, [...rep(3, 36), ...rep(2, 37)]], 10: [26, [...rep(4, 43), 44]]};
const ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]};
const VERSION_INFO = {7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3};   // the standard's Table D.1
const MASKS = [(i, j) => (i + j) % 2 === 0, i => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
  (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0, (i, j) => ((i + j) % 2 + (i * j) % 3) % 2 === 0];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = [], LOG = [];
for (let i = 0, x = 1; i < 255; i++, x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)) { EXP[i] = x; LOG[x] = i; }
const syndromesZero = (block, ecCount) => {
  for (let k = 0; k < ecCount; k++) {
    let s = 0;
    for (const c of block) s = (s === 0 ? 0 : EXP[(LOG[s] + k) % 255]) ^ c;   // Horner at alpha^k
    if (s !== 0) return false;
  }
  return true;
};
const formatBits = (level, mask) => {           // BCH(15,5), then the fixed XOR, as the standard writes it
  const data = (level << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
};

function decode(dark) {
  const n = dark.length, version = (n - 17) / 4;
  assert.ok(Number.isInteger(version) && BLOCKS_M[version], 'a version this test knows: ' + version);
  // Format information, first copy: bits 0-5 down column 8, then (7,8), (8,8), (8,7), then row 8 leftwards.
  let read = 0;
  const at = (r, c) => dark[r][c] ? 1 : 0;
  const spots = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  spots.forEach(([r, c], i) => { read |= at(r, c) << i; });
  let level = -1, mask = -1;
  for (let l = 0; l < 4; l++) for (let m = 0; m < 8; m++) if (formatBits(l, m) === read) { level = l; mask = m; }
  assert.equal(level, 0, 'format information says level M');
  // Second copy, split between the other two finders, must agree.
  let second = 0;
  for (let i = 0; i < 8; i++) second |= at(8, n - 1 - i) << i;
  for (let i = 8; i < 15; i++) second |= at(n - 15 + i, 8) << i;
  assert.equal(second, read, 'both copies of the format information agree');
  assert.equal(at(n - 8, 8), 1, 'the dark module');
  // Version information, from version 7: both copies, as the standard lists them.
  if (version >= 7) {
    let top = 0, left = 0;
    for (let i = 0; i < 18; i++) { top |= at(Math.floor(i / 3), n - 11 + i % 3) << i; left |= at(n - 11 + i % 3, Math.floor(i / 3)) << i; }
    assert.equal(top, VERSION_INFO[version], 'version information, top right');
    assert.equal(left, VERSION_INFO[version], 'version information, bottom left');
  }
  // Which modules are function patterns.
  const fn = Array.from({length: n}, () => Array(n).fill(false)), mark = (r, c) => { if (r >= 0 && c >= 0 && r < n && c < n) fn[r][c] = true; };
  // Finders with their separators and format areas: 9 x 9 at the top left, 9 x 8 at the top right, 8 x 9 at the bottom left.
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) { mark(r, c); if (c < 8) mark(r, n - 1 - c); if (r < 8) mark(n - 1 - r, c); }
  for (let i = 0; i < n; i++) { mark(6, i); mark(i, 6); }
  if (version >= 7) for (let i = 0; i < 6; i++) for (let j = n - 11; j < n - 8; j++) { mark(i, j); mark(j, i); }
  const align = ALIGN[version];
  for (const r of align) for (const c of align) {
    if ((r === 6 && c === 6) || (r === 6 && c === align[align.length - 1]) || (r === align[align.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }
  // The zigzag, two columns at a time from the right, skipping the vertical timing column.
  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
      const c = right - j, up = ((right + 1) & 2) === 0, r = up ? n - 1 - v : v;
      if (!fn[r][c]) bits.push(at(r, c) ^ (MASKS[mask](r, c) ? 1 : 0));
    }
  }
  const [check, sizes] = BLOCKS_M[version], totalWords = sizes.reduce((a, b) => a + b, 0) + check * sizes.length, words = [];
  for (let i = 0; i + 8 <= bits.length && words.length < totalWords; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // Undo the interleaving: data words round-robin across the blocks (the shorter ones drop out at the end), then check
  // words likewise.
  const blocks = sizes.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((len, b) => { if (i < len) blocks[b].push(words[k++]); });
  for (let i = 0; i < check; i++) blocks.forEach(b => b.push(words[k++]));
  blocks.forEach((b, i) => assert.ok(syndromesZero(b, check), 'Reed-Solomon check words are right in block ' + i));
  // Byte mode: 0100, an 8-bit count (versions 1-9), then the bytes.
  const data = blocks.flatMap((b, i) => b.slice(0, sizes[i])), stream = data.flatMap(w => [7, 6, 5, 4, 3, 2, 1, 0].map(k => (w >> k) & 1));
  const take = (from, len) => stream.slice(from, from + len).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(take(0, 4), 4, 'byte mode');
  const countBits = version < 10 ? 8 : 16, length = take(4, countBits);
  return Buffer.from(Array.from({length}, (_, i) => take(4 + countBits + 8 * i, 8))).toString('utf8');
}

const draw = text => qrMatrix(text).dark.map(row => row.slice());

test('Every setup link the wall shows reads back as itself', () => {
  for (const link of [
    'http://192.168.4.23:4173/setup#code=3TW9B8',                        // a tablet's own server, first run
    'http://192.168.100.200:4173/setup#code=ABCDEF',
    'https://gingham.example.com/setup#pair=XYZ234',                 // a frame waiting on a hosted server
    'https://a-rather-long-household-server-name.example.org/setup#pair=MNP789',
    'http://gingham.local:4173/setup'
  ]) assert.equal(decode(draw(link)), link, link);
});

test('Every version from 1 to 10 reads back, and past 10 there is no code rather than a wrong one', () => {
  const seen = new Set();
  for (let length = 1; length <= 213; length += 4) {
    const text = 'https://x.example/'.concat('a'.repeat(213)).slice(0, length);
    const qr = qrMatrix(text);
    seen.add((qr.size - 17) / 4);
    assert.equal(decode(qr.dark), text, 'length ' + text.length);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(decode(draw('Grüße, Café ☕')), 'Grüße, Café ☕', 'UTF-8');
  assert.equal(qrMatrix('x'.repeat(214)), null);
});

test('The decoder is not fooled: one wrong module is caught', () => {
  const dark = draw('http://192.168.4.23:4173/setup#code=3TW9B8');
  dark[dark.length - 1][dark.length - 1] = !dark[dark.length - 1][dark.length - 1];   // a data module, far from any pattern
  assert.throws(() => decode(dark), /Reed-Solomon/);
});
