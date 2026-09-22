// Fetching an address that somebody typed in. A household owner gives the server a calendar link, and a server that
// fetches whatever it is given can be pointed at its own private network (the host's metadata service, a neighbour
// on the internal network, itself). So: https only, no credentials in the address, every name must resolve only to
// public addresses, redirects are followed by hand so each hop is checked the same way, and the body is capped.
// Someone running a single household at home, with a calendar server on their own LAN, opts out with
// FRAME_ALLOW_PRIVATE_FEEDS=1.
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const {Readable} = require('node:stream');

// An IPv6 address as its eight 16-bit groups, or null. Written out by hand rather than trusted to a library because
// the same address has many spellings: the URL parser turns ::ffff:127.0.0.1 into ::ffff:7f00:1, and both are loopback.
function groups(address) {
  let text = String(address).toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) { const [a, b, c, d] = dotted.slice(1).map(Number); text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16); }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = s => s ? s.split(':').map(h => /^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN) : [];
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const out = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail] : head;
  return out.length === 8 && out.every(n => n >= 0 && n <= 0xffff) ? out : null;
}
function isPrivate(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const g = groups(address);
  if (!g) return true;   // what cannot be read is not fetched
  const v4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  const zeros = n => g.slice(0, n).every(x => x === 0);
  if (zeros(6) && g[6] === 0 && g[7] <= 1) return true;                        // :: and ::1
  if (zeros(5) && (g[5] === 0xffff || g[5] === 0)) return isPrivate(v4(g[6], g[7]));   // IPv4 written as IPv6
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return isPrivate(v4(g[6], g[7]));
  if (g[0] === 0x2002) return isPrivate(v4(g[1], g[2]));                          // 6to4 carries an IPv4 address
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;                              // NAT64
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;             // Teredo, documentation
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}
// Whether a redirect or a server's answer stays with the same service, so a password or token may go along: the same
// origin exactly (scheme, name, port), or two hosts of a provider known to hand an account to another of its own
// (iCloud answers caldav.icloud.com with p42-caldav.icloud.com). Not "the last two labels of the name", which would
// count victim.co.uk and attacker.co.uk as one.
const SHARDED = ['icloud.com'];
function sameService(a, b) {
  const x = new URL(a), y = new URL(b), host = u => u.hostname.toLowerCase().replace(/\.$/, '');
  if (x.protocol !== y.protocol || x.port !== y.port) return false;
  return host(x) === host(y) || SHARDED.some(domain => host(x).endsWith('.' + domain) && host(y).endsWith('.' + domain));
}
// A fetch that connects only to the addresses the check above approved, so a name cannot resolve to a public address
// for the check and a private one for the connection (DNS rebinding). The certificate is still checked against the
// name. Without approved addresses (FRAME_ALLOW_PRIVATE_FEEDS=1) it is the ordinary fetch.
function pinnedFetch(address, options = {}) {
  const {pinned, ...rest} = options;
  if (!pinned) return fetch(address, rest);
  const url = new URL(address), {method = 'GET', headers = {}, body, signal} = rest;
  const approved = pinned.map(f => ({address: f.address, family: net.isIPv6(f.address) ? 6 : 4}));
  const lookup = (host, opts, callback) => {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    return opts && opts.all ? callback(null, approved) : callback(null, approved[0].address, approved[0].family);
  };
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {method, signal, lookup, agent: false, headers: {'Accept-Encoding': 'gzip, deflate, br', ...headers}}, response => {
      try {
        const status = response.statusCode, out = new Headers();
        for (const [name, value] of Object.entries(response.headers)) for (const v of [].concat(value)) out.append(name, v);
        if ([204, 205, 304].includes(status) || method === 'HEAD') { response.resume(); return resolve(new Response(null, {status, headers: out})); }
        const decode = {gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress}[String(response.headers['content-encoding'] || '').toLowerCase()];
        const stream = decode ? response.pipe(decode()) : response;
        if (decode) response.on('error', e => stream.destroy(e));
        resolve(new Response(Readable.toWeb(stream), {status, headers: out}));
      } catch (e) { response.destroy(); reject(e); }
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function safeFetchText(address, {fetchImpl = pinnedFetch, lookup = dns.lookup, maxBytes = 5000000, timeoutMs = 15000, headers = {}, allowPrivate = process.env.FRAME_ALLOW_PRIVATE_FEEDS === '1'} = {}) {
  let current = String(address || '').trim().replace(/^webcals?:\/\//i, 'https://');
  for (let hop = 0; hop < 4; hop++) {
    let url; try { url = new URL(current); } catch (e) { throw Error('Not a web address'); }
    if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw Error('Only https links are fetched');
    if (url.username || url.password) throw Error('Links with a name and password in them are not fetched');
    let found = null;
    if (!allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      found = net.isIP(host) ? [{address: host}] : await lookup(host, {all: true});
      if (!found.length || found.some(f => isPrivate(f.address))) throw Error('That address is not on the public internet');
    }
    const response = await fetchImpl(url, {redirect: 'manual', headers, signal: AbortSignal.timeout(timeoutMs), ...(found ? {pinned: found} : {})});
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { current = new URL(response.headers.get('location'), url).toString(); continue; }
    if (response.status === 304) return {status: 304, text: '', etag: headers['If-None-Match'] || ''};
    if (!response.ok) throw Error('The calendar link answered ' + response.status);
    // Read in pieces so a link to something enormous is dropped at the cap rather than swallowed whole.
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { reader.cancel(); throw Error('That calendar is too large'); } chunks.push(value); }
    return {status: 200, text: Buffer.concat(chunks).toString('utf8'), etag: response.headers.get('etag') || ''};
  }
  throw Error('Too many redirects');
}
// The same care for a request that is not a plain GET of a calendar: a CalDAV query, a Home Assistant service call.
// Any method, headers and body; redirects followed by hand with each hop checked; the answer capped and read as text.
// Errors carry a code (BAD_ADDRESS, PRIVATE, UNREACHABLE) and an HTTP status for whoever passes them on.
const refuse = (code, message, status) => Object.assign(Error(message), {code, status});
async function safeRequest(address, {method = 'GET', headers = {}, body, fetchImpl = pinnedFetch, lookup = dns.lookup, maxBytes = 5000000, timeoutMs = 15000, allowPrivate = process.env.FRAME_ALLOW_PRIVATE_FEEDS === '1'} = {}) {
  let current = address;
  for (let hop = 0; hop < 5; hop++) {
    let url; try { url = new URL(current); } catch (e) { throw refuse('BAD_ADDRESS', 'That isn’t a web address.', 400); }
    if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw refuse('BAD_ADDRESS', 'The address has to start with https://.', 400);
    if (url.username || url.password) throw refuse('BAD_ADDRESS', 'Put the username and password in their own boxes, not in the address.', 400);
    let found = null;
    if (!allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      try { found = net.isIP(host) ? [{address: host}] : await lookup(host, {all: true}); } catch (e) { throw refuse('UNREACHABLE', 'Can’t find that server.', 400); }
      if (!found.length || found.some(f => isPrivate(f.address))) throw refuse('PRIVATE', 'That server isn’t on the public internet.', 400);
    }
    let response;
    try { response = await fetchImpl(url, {method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...(body !== undefined ? {body} : {}), ...(found ? {pinned: found} : {})}); }
    catch (e) { throw refuse('UNREACHABLE', 'Can’t reach that server.', 503); }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
      const next = new URL(response.headers.get('location'), url).toString();
      // Sent somewhere else: the password or token stays behind, as a browser would leave it. A 303, or a 301/302
      // answering a POST, continues as a plain GET.
      if (!sameService(next, url)) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(authorization|cookie)$/i.test(name)));
      if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !/^content-type$/i.test(name))); }
      current = next; continue;
    }
    let text = '';
    if (response.body) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { reader.cancel(); throw refuse('UPSTREAM', 'The server answered with too much.', 502); } chunks.push(value); }
      text = Buffer.concat(chunks).toString('utf8');
    }
    return {status: response.status, text, url: url.toString(), etag: response.headers.get('etag') || ''};
  }
  throw refuse('UNREACHABLE', 'That server redirects too many times.', 502);
}
module.exports = {safeFetchText, safeRequest, isPrivate, sameService, pinnedFetch, groups};
