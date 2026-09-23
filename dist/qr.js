/*
  QR codes for the setup links the wall shows, written for this project from the standard (ISO/IEC 18004): byte mode,
  error correction level M, versions 1 to 10 (up to 213 bytes, far more than a setup link needs), and whichever of the
  eight masks scores best. Plain ES5 for the frame's old WebView, no dependencies. test/qr.test.js reads its output
  back with a decoder written separately from the same standard.

  qrMatrix('http://…') returns {size, dark: [[true, false, …], …]} (row by row), or null when the text will not fit.
*/
(function (root) {
  'use strict';

  // Level M, per version: check words per block, then [blocks, data words per block] for each of the two groups.
  var LEVEL_M = [null,
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
  var LEVEL_M_BITS = 0;   // the two bits that name level M in the format information

  // Arithmetic in GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
  var EXP = [], LOG = [];
  (function () { for (var i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); } })();
  function mul(a, b) { return a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0; }

  // Reed-Solomon check words: the remainder of the data, times x^n, divided by the product of (x - 2^i), i < n.
  function checkWords(data, n) {
    var divisor = [], i, j, root = 1;
    for (i = 0; i < n - 1; i++) divisor.push(0);
    divisor.push(1);
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) { divisor[j] = mul(divisor[j], root); if (j + 1 < n) divisor[j] ^= divisor[j + 1]; }
      root = mul(root, 2);
    }
    var rest = [];
    for (i = 0; i < n; i++) rest.push(0);
    for (i = 0; i < data.length; i++) {
      var factor = data[i] ^ rest.shift();
      rest.push(0);
      for (j = 0; j < n; j++) rest[j] ^= mul(divisor[j], factor);
    }
    return rest;
  }

  function utf8(text) {
    var out = [], s = unescape(encodeURIComponent(text));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  // Where the alignment patterns' centres go, as the standard's table has them.
  function alignment(version) {
    if (version === 1) return [];
    var count = Math.floor(version / 7) + 2, size = version * 4 + 17, step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2, at = [6];
    for (var pos = size - 7; at.length < count; pos -= step) at.splice(1, 0, pos);
    return at;
  }

  // BCH codes for the format information (15 bits) and the version information (18 bits).
  function formatBits(mask) {
    var data = (LEVEL_M_BITS << 3) | mask, rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function versionBits(version) {
    var rem = version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; }, function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; }, function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }];

  function qrMatrix(text) {
    var bytes = utf8(String(text)), version, spec;
    for (version = 1; version <= 10; version++) {
      spec = LEVEL_M[version];
      var capacity = (spec[1] * spec[2] + spec[3] * spec[4]) * 8, countBits = version < 10 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= capacity) break;
    }
    if (version > 10) return null;
    var dataWords = spec[1] * spec[2] + spec[3] * spec[4], lengthBits = version < 10 ? 8 : 16;

    // The bit stream: byte mode, the length, the bytes, a terminator, then padding to fill every data word.
    var bits = [], i, j;
    function put(value, length) { for (var k = length - 1; k >= 0; k--) bits.push((value >>> k) & 1); }
    put(4, 4); put(bytes.length, lengthBits);
    for (i = 0; i < bytes.length; i++) put(bytes[i], 8);
    put(0, Math.min(4, dataWords * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0; bits.length < dataWords * 8; pad ^= 1) put(pad ? 0x11 : 0xec, 8);
    var words = [];
    for (i = 0; i < bits.length; i += 8) { var w = 0; for (j = 0; j < 8; j++) w = (w << 1) | bits[i + j]; words.push(w); }

    // Split into blocks, give each its check words, and interleave: data words across blocks, then check words.
    var blocks = [], at = 0;
    for (i = 0; i < spec[1] + spec[3]; i++) {
      var length = i < spec[1] ? spec[2] : spec[4], data = words.slice(at, at + length);
      at += length; blocks.push({ data: data, check: checkWords(data, spec[0]) });
    }
    var stream = [], longest = Math.max(spec[2], spec[4]);
    for (i = 0; i < longest; i++) for (j = 0; j < blocks.length; j++) if (i < blocks[j].data.length) stream.push(blocks[j].data[i]);
    for (i = 0; i < spec[0]; i++) for (j = 0; j < blocks.length; j++) stream.push(blocks[j].check[i]);

    // The fixed patterns.
    var size = version * 4 + 17, dark = [], fixed = [];
    for (i = 0; i < size; i++) { dark.push([]); fixed.push([]); for (j = 0; j < size; j++) { dark[i].push(false); fixed[i].push(false); } }
    function set(r, c, on) { if (r >= 0 && c >= 0 && r < size && c < size) { dark[r][c] = on; fixed[r][c] = true; } }
    for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    var corners = [[3, 3], [3, size - 4], [size - 4, 3]];
    for (var f = 0; f < 3; f++) for (i = -4; i <= 4; i++) for (j = -4; j <= 4; j++) {
      var d = Math.max(Math.abs(i), Math.abs(j));
      set(corners[f][0] + i, corners[f][1] + j, d !== 2 && d !== 4);
    }
    var centres = alignment(version), last = centres.length - 1;
    for (var a = 0; a < centres.length; a++) for (var b = 0; b < centres.length; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
      for (i = -2; i <= 2; i++) for (j = -2; j <= 2; j++) set(centres[a] + i, centres[b] + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
    }
    function drawFormat(mask) {
      var v = formatBits(mask);
      for (var k = 0; k <= 5; k++) set(k, 8, ((v >>> k) & 1) === 1);
      set(7, 8, ((v >>> 6) & 1) === 1); set(8, 8, ((v >>> 7) & 1) === 1); set(8, 7, ((v >>> 8) & 1) === 1);
      for (k = 9; k < 15; k++) set(8, 14 - k, ((v >>> k) & 1) === 1);
      for (k = 0; k < 8; k++) set(8, size - 1 - k, ((v >>> k) & 1) === 1);
      for (k = 8; k < 15; k++) set(size - 15 + k, 8, ((v >>> k) & 1) === 1);
      set(size - 8, 8, true);
    }
    drawFormat(0);
    if (version >= 7) {
      var vb = versionBits(version);
      for (i = 0; i < 18; i++) { var on = ((vb >>> i) & 1) === 1, x = size - 11 + i % 3, y = Math.floor(i / 3); set(y, x, on); set(x, y, on); }
    }

    // The data, two columns at a time from the right, up and down in turn, stepping over the vertical timing line.
    var n = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var v = 0; v < size; v++) for (j = 0; j < 2; j++) {
        var col = right - j, row = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (fixed[row][col]) continue;
        dark[row][col] = n < stream.length * 8 && ((stream[n >>> 3] >>> (7 - (n & 7))) & 1) === 1;
        n++;
      }
    }

    // Try each mask; keep the one the standard's penalty rules like best.
    var best = null, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      var grid = [];
      for (i = 0; i < size; i++) { grid.push([]); for (j = 0; j < size; j++) grid[i].push(fixed[i][j] ? dark[i][j] : dark[i][j] !== MASKS[m](i, j)); }
      var saved = dark; dark = grid; drawFormat(m); dark = saved;
      var score = penalty(grid, size);
      if (score < bestScore) { best = grid; bestScore = score; }
    }
    return { size: size, dark: best };
  }

  // The standard's four penalty rules: long runs, 2 x 2 blocks, finder-like patterns, and dark-light balance.
  function penalty(g, size) {
    var score = 0, i, j, darkCount = 0;
    function line(get) {
      var s = 0, run = 1, k, cells = [];
      for (k = 0; k < size; k++) cells.push(get(k));
      for (k = 1; k <= size; k++) {
        if (k < size && cells[k] === cells[k - 1]) run++;
        else { if (run >= 5) s += 3 + run - 5; run = 1; }
      }
      // 1:1:3:1:1 with four light modules on one side, the edge counting as light.
      var at = function (x) { return x >= 0 && x < size && cells[x]; };
      for (k = -4; k < size; k++) {
        if (at(k) && !at(k + 1) && at(k + 2) && at(k + 3) && at(k + 4) && !at(k + 5) && at(k + 6)) {
          if (!at(k - 1) && !at(k - 2) && !at(k - 3) && !at(k - 4)) s += 40;
          if (!at(k + 7) && !at(k + 8) && !at(k + 9) && !at(k + 10)) s += 40;
        }
      }
      return s;
    }
    for (i = 0; i < size; i++) {
      score += line(function (k) { return g[i][k]; }) + line(function (k) { return g[k][i]; });
      for (j = 0; j < size; j++) {
        if (g[i][j]) darkCount++;
        if (i + 1 < size && j + 1 < size && g[i][j] === g[i][j + 1] && g[i][j] === g[i + 1][j] && g[i][j] === g[i + 1][j + 1]) score += 3;
      }
    }
    var total = size * size;
    return score + (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  }

  root.qrMatrix = qrMatrix;
  if (typeof module !== 'undefined') module.exports = { qrMatrix: qrMatrix };
})(typeof window !== 'undefined' ? window : this);
