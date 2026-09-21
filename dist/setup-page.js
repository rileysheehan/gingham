/* The setup page. Runs in a phone's browser, so it is written for one: no build, no libraries. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = null, picked = null, query = location.search.indexOf('household=') >= 0 ? location.search : '';
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function toast(text) { var t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 3200); }
  function showError(action, message) { var p = document.querySelector('.error[data-for="' + action + '"]'); if (p) p.textContent = message || ''; }
  function api(method, path, body) {
    return fetch('/api/setup' + path + (path.indexOf('?') < 0 ? query : query.replace('?', '&')), { method: method, headers: { 'X-Gingham': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; }); });
  }
  // Every change is one POST; the answer carries the household as it now stands, so the page never guesses.
  function act(action, body, button, done) {
    showError(action, '');
    if (button) button.disabled = true;
    return api('POST', '/' + action, body).then(function (r) {
      if (button) button.disabled = false;
      if (r.status !== 200) { showError(action, r.data.error || 'That did not work. Try again.'); return; }
      if (r.data.setup) { state = r.data.setup; render(); }
      if (done) done(r.data);
    }, function () { if (button) button.disabled = false; showError(action, 'Can’t reach the server. Check your connection.'); });
  }
  function ago(iso) {
    if (!iso) return 'Never seen';
    var mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return mins < 20 ? 'Seen just now' : mins < 90 ? 'Seen ' + mins + ' minutes ago' : mins < 2880 ? 'Seen ' + Math.round(mins / 60) + ' hours ago' : 'Seen ' + Math.round(mins / 1440) + ' days ago';
  }
  function row(list, lead, name, sub, subClass, button) {
    var li = el('li'), grow = el('div', 'grow');
    if (lead) li.appendChild(lead);
    grow.appendChild(el('div', 'name', name));
    if (sub) grow.appendChild(el('div', 'sub' + (subClass ? ' ' + subClass : ''), sub));
    li.appendChild(grow);
    if (button) li.appendChild(button);
    list.appendChild(li);
    return li;
  }
  function removeButton(label, confirmText, fn) {
    var b = el('button', 'small', label);
    b.onclick = function () { if (b.textContent === label) { b.textContent = confirmText; setTimeout(function () { b.textContent = label; }, 4000); } else fn(b); };
    return b;
  }

  function render() {
    $('title').textContent = state.household.name;
    document.title = state.household.name + ' · Gingham setup';
    if (document.activeElement !== $('h-name')) $('h-name').value = state.household.name;
    if (document.activeElement !== $('h-place') && !picked) $('h-place').value = state.household.place;
    $('h-zone').textContent = 'Time zone: ' + (picked ? picked.timezone : state.household.timezone).replace(/_/g, ' ');

    var cl = $('c-list'); cl.textContent = ''; cl.setAttribute('data-empty', 'No calendars yet.');
    state.calendars.forEach(function (c) {
      var dot = el('span', 'dot'); dot.style.background = c.color;
      var li = row(cl, dot, c.name, c.connected ? (c.kind === 'google' ? 'Connected by Google sign-in' : 'Connected by link') : 'Needs its link again', c.connected ? 'good' : 'bad',
        removeButton('Remove', 'Really remove?', function (b) { act('calendar-remove', { id: c.id }, b, function () { toast('Removed ' + c.name); }); }));
      // Events their author marked private: the wall is read by guests too.
      var options = el('div', 'options'); options.appendChild(el('span', 'sub', 'Private events'));
      [['busy', 'Show as Busy'], ['show', 'Show in full'], ['hide', 'Leave out']].forEach(function (pair) {
        var b = el('button', 'chip', pair[1]); b.setAttribute('aria-pressed', String(c.private === pair[0]));
        b.onclick = function () { act('calendar-edit', { id: c.id, private: pair[0] }, b, function () { toast('Saved'); }); };
        options.appendChild(b);
      });
      li.className = 'wrap'; li.appendChild(options);
    });

    var dl = $('cd-list'); dl.textContent = '';
    $('cd-state').textContent = (state.countdowns || []).length ? '' : 'A birthday, a trip, the last day of school. The frame shows the nearest one: “3 sleeps until…”';
    (state.countdowns || []).forEach(function (c) {
      var when = new Date(c.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      row(dl, null, c.name, (c.passed ? 'Passed · ' : '') + when + (c.yearly ? ' · every year' : '') + ' · in ' + c.word, c.passed ? 'bad' : '',
        removeButton('Remove', 'Really remove?', function (b) { act('countdown-remove', { id: c.id }, b, function () { toast('Removed ' + c.name); }); }));
    });

    $('l-state').textContent = state.lists.length ? '' : 'Make a list here, or connect an app you already keep lists in. Any of them can be added to and checked off at the frame.';
    drawGoogle(); drawMicrosoft(); drawCalDav(); drawHomeAssistant();
    $('l-connect').querySelector('summary').textContent = state.todoist.connected ? 'Change the Todoist token' : 'Connect Todoist';
    $('l-choose').hidden = !state.todoist.connected || !$('l-picker').hidden;
    var ll = $('l-list'); ll.textContent = ''; ll.setAttribute('data-empty', state.todoist.connected ? 'No lists chosen yet.' : '');
    state.lists.forEach(function (l) {
      var lead = el('span', l.person ? 'avatar' : 'dot', l.person ? l.name.charAt(0).toUpperCase() : '');
      if (l.person && l.color) lead.style.background = l.color; if (!l.person) lead.style.background = 'var(--ink-2)';
      row(ll, lead, l.name, (l.person ? (l.kid ? 'A young child’s list' : 'A person’s list') : 'A household list') + ({ here: ' · kept here', microsoft: ' · from Microsoft To Do', caldav: ' · from ' + (state.caldav.server || 'CalDAV'), homeassistant: ' · from Home Assistant', googletasks: ' · from Google Tasks' })[l.kind] || ' · from Todoist', '',
        l.kind === 'here' ? removeButton('Remove', 'And its items?', function (b) { act('list-remove', { id: l.id }, b, function () { toast('Removed ' + l.name); }); }) : null);
    });

    $('p-state').textContent = state.photos.connected ? state.photos.count + ' photos from your shared album.' : 'Photos come from an iCloud shared album that you choose, from this phone, or both.';
    var f = state.photos.folder || {};
    $('p-folder').textContent = f.count || f.passedOver ? f.count + ' from the folder on the server' + (f.passedOver ? ', and ' + f.passedOver + ' passed over for being too large or not JPEG. Sending those from a phone makes them fit.' : '.') : '';
    $('p-summary').textContent = state.photos.connected ? 'Change the album' : 'Connect an album';

    var fl = $('f-list'); fl.textContent = ''; fl.setAttribute('data-empty', 'No frames paired yet.');
    state.frames.forEach(function (f) { row(fl, null, f.name, ago(f.lastSeen), '', removeButton('Remove', 'Really remove?', function (b) { act('revoke', { id: f.id }, b, function () { toast(f.name + ' is disconnected'); }); })); });
    $('f-address').textContent = location.host;

    $('pin-state').textContent = state.pin.set ? 'A PIN is set. Anyone at a frame who knows it can add their phone here: Settings, then "Manage from a phone".' : 'With a PIN, you can get back into this page from your frame if you change phones or clear your browser. Without one, you would need a new link.';
    $('pin-summary').textContent = state.pin.set ? 'Change the PIN' : 'Set a PIN'; $('pin-remove').hidden = !state.pin.set;

    var dl = $('d-list'); dl.textContent = '';
    state.devices.forEach(function (d) { row(dl, null, d.name, ago(d.lastSeen), '', state.devices.length > 1 ? removeButton('Remove', 'Really remove?', function (b) { act('revoke', { id: d.id }, b); }) : null); });
  }

  // ---- household and place
  var searchTimer = null;
  $('h-place').oninput = function () {
    picked = null; clearTimeout(searchTimer);
    var q = $('h-place').value.trim(), box = $('h-results');
    if (q.length < 2) { box.hidden = true; return; }
    searchTimer = setTimeout(function () {
      api('GET', '/places?q=' + encodeURIComponent(q)).then(function (r) {
        box.textContent = ''; box.hidden = !(r.data.places || []).length;
        (r.data.places || []).forEach(function (p) {
          var li = el('li', '', p.place); li.appendChild(el('small', '', p.detail));
          li.onclick = function () { picked = p; $('h-place').value = p.place; box.hidden = true; $('h-zone').textContent = 'Time zone: ' + p.timezone.replace(/_/g, ' '); };
          box.appendChild(li);
        });
      });
    }, 350);
  };
  $('h-save').onclick = function () {
    var body = { name: $('h-name').value };
    if (picked) { body.place = picked.place; body.latitude = picked.latitude; body.longitude = picked.longitude; body.timezone = picked.timezone; }
    else if ($('h-place').value.trim() !== state.household.place) { showError('household', 'Pick your town from the list so the weather and the clock are right.'); return; }
    else { body.keepPlace = true; }
    if (body.keepPlace) { api('POST', '/household-name', { name: body.name }).then(function (r) { if (r.status === 200) { state = r.data.setup; render(); toast('Saved'); } else showError('household', r.data.error); }); return; }
    act('household', body, $('h-save'), function () { picked = null; toast('Saved'); });
  };

  // ---- calendars
  $('c-add').onclick = function () {
    act('calendar-add', { name: $('c-name').value, link: $('c-link').value }, $('c-add'), function (data) {
      toast(data.found ? 'Added. ' + data.found + ' events in the next two months.' : 'Added. Nothing on it in the next two months.');
      $('c-name').value = ''; $('c-link').value = '';
    });
  };

  // ---- lists
  // One picker for any service's lists: it knows which, and saving replaces only that service's lists.
  var pickerSource = 'todoist';
  function showPicker(projects, source) {
    pickerSource = source || 'todoist';
    var box = $('l-projects'); box.textContent = ''; $('l-picker').hidden = false; $('l-choose').hidden = true;
    var chosen = {}; state.lists.forEach(function (l, i) { if (l.kind === pickerSource) chosen[l.id] = { order: i, list: l }; });
    projects.sort(function (a, b) { return (chosen[a.id] ? chosen[a.id].order : 99) - (chosen[b.id] ? chosen[b.id].order : 99); });
    projects.forEach(function (p) {
      var had = chosen[p.id] && chosen[p.id].list, li = el('li'), check = el('input'), grow = el('div', 'grow'), options = el('div', 'options');
      check.type = 'checkbox'; check.checked = !!had; li._project = p; li._check = check;
      grow.appendChild(el('div', 'name', p.name)); if (p.under) grow.appendChild(el('div', 'sub', 'Under ' + p.under));
      var person = el('button', 'chip', 'A person’s list'), kid = el('button', 'chip', 'For a young child');
      person.setAttribute('aria-pressed', String(!!(had && had.person))); kid.setAttribute('aria-pressed', String(!!(had && had.kid)));
      person.onclick = function () { var on = person.getAttribute('aria-pressed') !== 'true'; person.setAttribute('aria-pressed', String(on)); kid.hidden = !on; if (!on) kid.setAttribute('aria-pressed', 'false'); };
      kid.onclick = function () { kid.setAttribute('aria-pressed', String(kid.getAttribute('aria-pressed') !== 'true')); };
      kid.hidden = !(had && had.person); options.hidden = !check.checked;
      check.onchange = function () { options.hidden = !check.checked; };
      li._person = person; li._kid = kid; li._had = had;
      options.appendChild(person); options.appendChild(kid);
      li.appendChild(check); li.appendChild(grow); li.appendChild(options); box.appendChild(li);
    });
  }
  $('l-save-token').onclick = function () { act('todoist', { token: $('l-token').value }, $('l-save-token'), function (data) { $('l-token').value = ''; $('l-connect').open = false; toast('Todoist connected'); showPicker(data.projects || []); }); };
  $('l-choose').onclick = function () { act('todoist-projects', {}, $('l-choose'), function (data) { showPicker(data.projects || []); }); };
  $('l-save').onclick = function () {
    var lists = []; [].forEach.call($('l-projects').children, function (li) {
      if (!li._check.checked) return;
      var person = li._person.getAttribute('aria-pressed') === 'true', had = li._had || {};
      lists.push({ id: li._project.id, name: had.name || li._project.name, person: person, kid: person && li._kid.getAttribute('aria-pressed') === 'true', color: had.color || '', icon: had.icon || 'list' });
    });
    act('lists', { source: pickerSource, lists: lists }, $('l-save'), function () { $('l-picker').hidden = true; toast('Lists saved'); render(); });
  };

  // ---- Google Tasks: this phone goes to Google and comes back here, to #google-connected
  function drawGoogle() {
    var g = state.googletasks;
    $('l-google').hidden = !g.available;
    $('gt-summary').textContent = g.connected && !g.signIn ? 'Google Tasks' : 'Connect Google Tasks';
    $('gt-connected').hidden = !g.connected || g.signIn; $('gt-idle').hidden = g.connected && !g.signIn;
    $('gt-account').textContent = g.account ? 'Connected as ' + g.account + '.' : 'Connected.';
    if (g.signIn) { $('gt-note').textContent = 'Google needs you to sign in again.'; $('l-google').open = true; }
  }
  $('gt-start').onclick = function () { act('googletasks-start', {}, $('gt-start'), function (data) { location.href = data.url; }); };
  $('gt-choose').onclick = function () { act('googletasks-lists', {}, $('gt-choose'), function (data) { showPicker(data.lists || [], 'googletasks'); }); };
  $('gt-disconnect').onclick = function () {
    var b = $('gt-disconnect');
    if (b.textContent !== 'Really disconnect?') { b.textContent = 'Really disconnect?'; setTimeout(function () { b.textContent = 'Disconnect'; }, 4000); return; }
    act('googletasks-disconnect', {}, b, function () { b.textContent = 'Disconnect'; toast('Google Tasks disconnected, here and at Google. Its lists are off the frame.'); });
  };
  function backFromGoogle() {
    if (location.hash !== '#google-connected') return;
    history.replaceState(null, '', location.pathname + location.search);
    toast('Google Tasks connected'); $('l-google').open = true;
    act('googletasks-lists', {}, $('gt-choose'), function (data) { showPicker(data.lists || [], 'googletasks'); });
  }

  // ---- Microsoft To Do: a code on this phone, entered at Microsoft, while this page asks the server how it went.
  var msTimer = null;
  function drawMicrosoft() {
    var ms = state.microsoft, signingIn = !$('ms-code').hidden;
    $('l-microsoft').hidden = !ms.available;
    $('ms-summary').textContent = ms.connected && !ms.signIn ? 'Microsoft To Do' : 'Connect Microsoft To Do';
    $('ms-connected').hidden = !ms.connected || ms.signIn || signingIn;
    $('ms-idle').hidden = (ms.connected && !ms.signIn) || signingIn;
    $('ms-account').textContent = ms.account ? 'Connected as ' + ms.account + '.' : 'Connected.';
    if (ms.signIn) $('ms-idle-note').textContent = 'Microsoft needs you to sign in again. Get a new code and enter it on Microsoft’s page.';
    if (ms.signIn && !signingIn) $('l-microsoft').open = true;
  }
  function stopMicrosoft(note) {
    clearTimeout(msTimer); $('ms-code').hidden = true;
    if (note) $('ms-idle-note').textContent = note;
    render();
  }
  function askMicrosoft(interval) {
    msTimer = setTimeout(function () {
      api('POST', '/microsoft-poll', {}).then(function (r) {
        if (r.status !== 200) return stopMicrosoft(r.data.error || 'That did not work. Get a new code.');
        if (r.data.setup) state = r.data.setup;
        if (r.data.status === 'pending') return askMicrosoft(interval);
        if (r.data.status === 'connected') { stopMicrosoft(); toast('Microsoft To Do connected'); return showPicker(r.data.lists || [], 'microsoft'); }
        stopMicrosoft(r.data.status === 'declined' ? 'Microsoft said no. Get a new code to try again.' : 'That code ran out. Get a new one.');
      }, function () { askMicrosoft(interval); });
    }, interval * 1000);
  }
  $('ms-start').onclick = function () {
    act('microsoft-start', {}, $('ms-start'), function (data) {
      $('ms-code-text').textContent = data.code; $('ms-open').href = data.url;
      $('ms-code').hidden = false; $('ms-idle').hidden = true; $('ms-connected').hidden = true;
      clearTimeout(msTimer); askMicrosoft(Math.max(3, data.interval || 5));
    });
  };
  $('ms-copy').onclick = function () {
    var code = $('ms-code-text').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(function () { toast('Copied'); }, function () { toast('Press and hold the code to copy it'); });
    else toast('Press and hold the code to copy it');
  };
  $('ms-choose').onclick = function () { act('microsoft-lists', {}, $('ms-choose'), function (data) { showPicker(data.lists || [], 'microsoft'); }); };
  $('ms-disconnect').onclick = function () {
    var b = $('ms-disconnect');
    if (b.textContent !== 'Really disconnect?') { b.textContent = 'Really disconnect?'; setTimeout(function () { b.textContent = 'Disconnect'; }, 4000); return; }
    act('microsoft-disconnect', {}, b, function () { b.textContent = 'Disconnect'; toast('Microsoft To Do disconnected. Its lists are off the frame.'); });
  };

  // ---- a CalDAV account: tried when it is connected, by finding its task lists
  function drawCalDav() {
    var cd = state.caldav;
    $('cd-summary').textContent = cd.connected ? 'Tasks from ' + cd.server : 'Connect Nextcloud or Fastmail';
    $('cd-form').hidden = cd.connected; $('cd-connected').hidden = !cd.connected;
    $('cd-account').textContent = 'Connected to ' + cd.server + (cd.username ? ' as ' + cd.username : '') + '.';
  }
  $('cd-connect').onclick = function () {
    act('caldav', { url: $('cd-url').value, username: $('cd-user').value, password: $('cd-pass').value }, $('cd-connect'), function (data) {
      $('cd-pass').value = ''; toast('Connected'); showPicker(data.lists || [], 'caldav');
    });
  };
  $('cd-choose').onclick = function () { act('caldav-lists', {}, $('cd-choose'), function (data) { showPicker(data.lists || [], 'caldav'); }); };
  $('cd-disconnect').onclick = function () {
    var b = $('cd-disconnect');
    if (b.textContent !== 'Really disconnect?') { b.textContent = 'Really disconnect?'; setTimeout(function () { b.textContent = 'Disconnect'; }, 4000); return; }
    act('caldav-disconnect', {}, b, function () { b.textContent = 'Disconnect'; toast('Disconnected. Its lists are off the frame.'); });
  };

  // ---- Home Assistant: its address and a token, tried when connected by finding its lists
  function drawHomeAssistant() {
    var ha = state.homeassistant;
    $('ha-summary').textContent = ha.connected ? 'Home Assistant' : 'Connect Home Assistant';
    $('ha-form').hidden = ha.connected; $('ha-connected').hidden = !ha.connected;
    $('ha-account').textContent = 'Connected to ' + ha.server + '.';
  }
  $('ha-connect').onclick = function () {
    act('homeassistant', { url: $('ha-url').value, token: $('ha-token').value }, $('ha-connect'), function (data) {
      $('ha-token').value = ''; toast('Home Assistant connected'); showPicker(data.lists || [], 'homeassistant');
    });
  };
  $('ha-choose').onclick = function () { act('homeassistant-lists', {}, $('ha-choose'), function (data) { showPicker(data.lists || [], 'homeassistant'); }); };
  $('ha-disconnect').onclick = function () {
    var b = $('ha-disconnect');
    if (b.textContent !== 'Really disconnect?') { b.textContent = 'Really disconnect?'; setTimeout(function () { b.textContent = 'Disconnect'; }, 4000); return; }
    act('homeassistant-disconnect', {}, b, function () { b.textContent = 'Disconnect'; toast('Disconnected. Its lists are off the frame.'); });
  };

  // ---- a list kept here
  var newKind = 'household', newIcon = 'list';
  function drawNewList() {
    [].forEach.call($('ln-kind').children, function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-kind') === newKind)); });
    var icons = $('ln-icons'); icons.hidden = newKind !== 'household'; icons.textContent = '';
    [['list', 'Plain'], ['cart', 'Shopping'], ['home', 'Home'], ['repeat', 'Routine'], ['suitcase', 'Packing'], ['sparkles', 'Cleaning']].forEach(function (pair) {
      var b = el('button', 'chip', pair[1]); b.setAttribute('aria-pressed', String(newIcon === pair[0])); b.onclick = function () { newIcon = pair[0]; drawNewList(); }; icons.appendChild(b);
    });
  }
  [].forEach.call($('ln-kind').children, function (b) { b.onclick = function () { newKind = b.getAttribute('data-kind'); drawNewList(); }; });
  drawNewList();
  $('ln-add').onclick = function () {
    act('list-add', { name: $('ln-name').value, icon: newIcon, person: newKind !== 'household', kid: newKind === 'kid' }, $('ln-add'), function () { toast('Made ' + $('ln-name').value); $('ln-name').value = ''; $('l-new').open = false; });
  };

  // ---- countdowns
  var countYearly = '', countWord = 'sleeps';
  function pressed(box, attr, value) { [].forEach.call($(box).children, function (b) { b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value)); }); }
  [].forEach.call($('cd-yearly').children, function (b) { b.onclick = function () { countYearly = b.getAttribute('data-yearly'); pressed('cd-yearly', 'data-yearly', countYearly); }; });
  [].forEach.call($('cd-word').children, function (b) { b.onclick = function () { countWord = b.getAttribute('data-word'); pressed('cd-word', 'data-word', countWord); }; });
  $('cd-add').onclick = function () {
    act('countdown-add', { name: $('cd-name').value, date: $('cd-date').value, yearly: !!countYearly, word: countWord }, $('cd-add'), function () { toast('Counting down to ' + $('cd-name').value); $('cd-name').value = ''; $('cd-date').value = ''; $('cd-new').open = false; });
  };

  // ---- photos, frames, devices
  $('p-save').onclick = function () { act('photos', { link: $('p-link').value }, $('p-save'), function () { $('p-link').value = ''; toast('Album saved. Photos arrive over the next few minutes.'); }); };
  $('f-code').oninput = function () { var v = $('f-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); $('f-code').value = v.length > 3 ? v.slice(0, 3) + '-' + v.slice(3) : v; };
  $('f-pair').onclick = function () { act('frame-pair', { code: $('f-code').value, name: $('f-name').value }, $('f-pair'), function () { toast('Paired. The frame connects within a few seconds.'); $('f-code').value = ''; $('f-name').value = ''; setTimeout(load, 8000); }); };
  $('d-add').onclick = function () {
    act('link', { name: '' }, $('d-add'), function (data) {
      var url = location.origin + '/s/' + data.token; $('d-url').textContent = url; $('d-link').hidden = false;
      $('d-share').hidden = !navigator.share; $('d-share').onclick = function () { navigator.share({ title: 'Gingham setup', url: url }).catch(function () {}); };
    });
  };

  $('pin-save').onclick = function () { act('pin', { pin: $('pin-value').value }, $('pin-save'), function () { $('pin-value').value = ''; toast('PIN saved'); }); };
  $('pin-remove').onclick = function () { act('pin', { pin: '' }, $('pin-remove'), function () { toast('PIN removed'); }); };
  function codeField(id) { $(id).oninput = function () { var v = $(id).value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); $(id).value = v.length > 3 ? v.slice(0, 3) + '-' + v.slice(3) : v; }; }
  codeField('claim-code');
  $('claim-go').onclick = function () {
    showError('claim', ''); $('claim-go').disabled = true;
    fetch('/api/setup/claim', { method: 'POST', headers: { 'X-Gingham': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('claim-code').value }), credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (r) { $('claim-go').disabled = false; if (r.status === 200) load(); else showError('claim', r.data.error || 'That did not work.'); }, function () { $('claim-go').disabled = false; showError('claim', 'Can’t reach the server.'); });
  };
  function load() {
    api('GET', '').then(function (r) {
      if (r.status === 200) { state = r.data; $('app').hidden = false; $('locked').hidden = true; render(); backFromGoogle(); }
      else { $('app').hidden = true; $('locked').hidden = false; }
    }, function () { $('locked').hidden = false; });
  }
  load();
})();
