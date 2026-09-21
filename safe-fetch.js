// Fetching an address that somebody typed in. A household owner gives the server a calendar link, and a server that
// fetches whatever it is given can be pointed at its own private network (the host's metadata service, a neighbour
// on the internal network, itself). So: https only, no credentials in the address, every name must resolve only to
// public addresses, redirects are followed by hand so each hop is checked the same way, and the body is capped.
// Someone running a single household at home, with a calendar server on their own LAN, opts out with
// FRAME_ALLOW_PRIVATE_FEEDS=1.
const dns = require('node:dns').promises;
const net = require('node:net');

function isPrivate(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivate(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8:');
}

async function safeFetchText(address, {fetchImpl = fetch, lookup = dns.lookup, maxBytes = 5000000, timeoutMs = 15000, headers = {}, allowPrivate = process.env.FRAME_ALLOW_PRIVATE_FEEDS === '1'} = {}) {
  let current = String(address || '').trim().replace(/^webcals?:\/\//i, 'https://');
  for (let hop = 0; hop < 4; hop++) {
    let url; try { url = new URL(current); } catch (e) { throw Error('Not a web address'); }
    if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw Error('Only https links are fetched');
    if (url.username || url.password) throw Error('Links with a name and password in them are not fetched');
    if (!allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const found = net.isIP(host) ? [{address: host}] : await lookup(host, {all: true});
      if (!found.length || found.some(f => isPrivate(f.address))) throw Error('That address is not on the public internet');
    }
    const response = await fetchImpl(url, {redirect: 'manual', headers, signal: AbortSignal.timeout(timeoutMs)});
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
async function safeRequest(address, {method = 'GET', headers = {}, body, fetchImpl = fetch, lookup = dns.lookup, maxBytes = 5000000, timeoutMs = 15000, allowPrivate = process.env.FRAME_ALLOW_PRIVATE_FEEDS === '1'} = {}) {
  let current = address;
  for (let hop = 0; hop < 5; hop++) {
    let url; try { url = new URL(current); } catch (e) { throw refuse('BAD_ADDRESS', 'That isn’t a web address.', 400); }
    if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw refuse('BAD_ADDRESS', 'The address has to start with https://.', 400);
    if (url.username || url.password) throw refuse('BAD_ADDRESS', 'Put the username and password in their own boxes, not in the address.', 400);
    if (!allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let found; try { found = net.isIP(host) ? [{address: host}] : await lookup(host, {all: true}); } catch (e) { throw refuse('UNREACHABLE', 'Can’t find that server.', 400); }
      if (!found.length || found.some(f => isPrivate(f.address))) throw refuse('PRIVATE', 'That server isn’t on the public internet.', 400);
    }
    let response;
    try { response = await fetchImpl(url, {method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...(body !== undefined ? {body} : {})}); }
    catch (e) { throw refuse('UNREACHABLE', 'Can’t reach that server.', 503); }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) { current = new URL(response.headers.get('location'), url).toString(); continue; }
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
module.exports = {safeFetchText, safeRequest, isPrivate};
