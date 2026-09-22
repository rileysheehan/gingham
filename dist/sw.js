/* Keeps the last good frame. If the server or the internet is away when the page reloads (a power cut, a router
   restart, a deploy), the frame comes back showing what it last knew, and says from when, instead of an error page.

   The network always goes first, so this never holds a household on old code or old data while the server can be
   reached. Only things a paired device was already shown are kept, and they are thrown away the moment the server
   says this device is no longer let in. */
var SHELL = 'shell-v1', DATA = 'data-v1', PHOTOS = 'photos-v1';
var DATA_PATHS = ['/api/calendar', '/api/tasks', '/api/weather', '/api/household', '/api/settings', '/api/photos'];
var MAX_DATA = 24, MAX_PHOTOS = 200, PATIENCE_MS = 10000;

// What to do with a request: 'data' and 'shell' try the network and fall back to the last good answer, 'photo'
// is kept once seen (a photo's name is its content), and 'pass' is none of this file's business.
function policy(method, url, origin) {
  var u; try { u = new URL(url); } catch (e) { return 'pass'; }
  if (method !== 'GET' || u.origin !== origin) return 'pass';
  if (u.pathname.indexOf('/photos/') === 0) return 'photo';
  if (u.pathname.indexOf('/api/') === 0) return DATA_PATHS.indexOf(u.pathname) >= 0 ? 'data' : 'pass';
  if (u.pathname.indexOf('/s/') === 0 || u.searchParams.has('k')) return 'pass';           // links that carry a secret
  if (u.pathname === '/setup' || u.pathname === '/admin' || u.pathname === '/photos' || u.pathname === '/healthz') return 'pass';
  return 'shell';
}
// A pairing or setup link can make this browser somebody else, another household or another person, so what was
// kept for whoever it was before is thrown away when one is followed.
function changesWho(url) {
  var u; try { u = new URL(url); } catch (e) { return false; }
  return u.pathname.indexOf('/s/') === 0 || u.searchParams.has('k');
}
// The same from the page itself: a code typed on the setup page, or a screen's pairing approved, answers 200 with a
// new cookie for this browser.
var BECOMES = ['/api/setup/claim', '/api/pair/poll'];
function becomesSomeone(method, url, origin) {
  var u; try { u = new URL(url); } catch (e) { return false; }
  return method === 'POST' && u.origin === origin && BECOMES.indexOf(u.pathname) >= 0;
}
// An answer from the cupboard says so, in the words the page already understands.
function markStale(text) {
  try { var data = JSON.parse(text); if (data && typeof data === 'object' && !Array.isArray(data)) { data.stale = true; return JSON.stringify(data); } } catch (e) {}
  return text;
}
if (typeof module !== 'undefined') module.exports = { policy: policy, markStale: markStale, changesWho: changesWho, becomesSomeone: becomesSomeone };

if (typeof self !== 'undefined' && self.addEventListener && typeof caches !== 'undefined') {
  self.addEventListener('install', function () { self.skipWaiting(); });
  self.addEventListener('activate', function (event) {
    event.waitUntil(caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return [SHELL, DATA, PHOTOS].indexOf(n) < 0; }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); }));
  });

  var trim = function (name, max) {
    return caches.open(name).then(function (cache) { return cache.keys().then(function (keys) { return Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map(function (k) { return cache.delete(k); })); }); });
  };
  var forgetEverything = function () { return Promise.all([caches.delete(DATA), caches.delete(PHOTOS)]); };
  var stale = function (cached) {
    return cached.text().then(function (text) { return new Response(markStale(text), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-From-Cache': '1' } }); });
  };

  function networkFirst(request, name, max, isData) {
    return caches.open(name).then(function (cache) {
      return cache.match(request).then(function (cached) {
        var fromNetwork = fetch(request).then(function (response) {
          // No longer let in: what was kept for this device goes, and the page hears the refusal itself.
          if (response.status === 401 || response.status === 403) return forgetEverything().then(function () { return response; });
          if (response.status === 200) { cache.put(request, response.clone()).then(function () { return trim(name, max); }); return response; }
          if (response.status >= 500 && cached) return isData ? stale(cached) : cached;
          return response;
        }, function (error) { if (cached) return isData ? stale(cached) : cached; throw error; });
        if (!cached) return fromNetwork;
        // With something in hand, a network that neither answers nor fails is not waited on for ever.
        var patience = new Promise(function (resolve) { setTimeout(function () { resolve(isData ? stale(cached.clone()) : cached.clone()); }, PATIENCE_MS); });
        return Promise.race([fromNetwork, patience]);
      });
    });
  }
  function keptOnceSeen(request) {
    return caches.open(PHOTOS).then(function (cache) {
      return cache.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response.status === 200) cache.put(request, response.clone()).then(function () { return trim(PHOTOS, MAX_PHOTOS); });
          else if (response.status === 401 || response.status === 403) return forgetEverything().then(function () { return response; });
          return response;
        });
      });
    });
  }

  self.addEventListener('fetch', function (event) {
    var what = policy(event.request.method, event.request.url, self.location.origin);
    if (event.request.mode === 'navigate' && changesWho(event.request.url)) event.waitUntil(forgetEverything());
    if (becomesSomeone(event.request.method, event.request.url, self.location.origin)) {
      return event.respondWith(fetch(event.request).then(function (response) {
        return response.status === 200 ? forgetEverything().then(function () { return response; }) : response;
      }));
    }
    if (what === 'data') event.respondWith(networkFirst(event.request, DATA, MAX_DATA, true));
    else if (what === 'shell') event.respondWith(networkFirst(event.request, SHELL, 60, false));
    else if (what === 'photo') event.respondWith(keptOnceSeen(event.request));
  });
}
