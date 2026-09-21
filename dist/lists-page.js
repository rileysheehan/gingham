/* The household's lists on a phone: add from the shop, check off in the aisle. No build, no libraries. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var UNDO_MS = 5000, REFRESH_MS = 30000;
  var data = null, current = null, pending = {};      // pending: task id -> timer, checked off but not yet sent
  try { current = localStorage.getItem('lists.current'); } catch (e) {}
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function toast(text) { var t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 3200); }
  function tidy(text) { return String(text || '').replace(/(\w)'/g, '$1’').replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/g, ''); }
  function call(method, path, body) {
    return fetch(path, { method: method, headers: { 'X-Gingham': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }
  function show(which) { ['app', 'empty', 'locked'].forEach(function (id) { $(id).hidden = id !== which; }); }
  function due(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text || ''); if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function render() {
    var names = data.projects || [];
    if (!names.length) return show('empty');
    if (names.indexOf(current) < 0) current = names[0];
    show('app');
    var open = function (name) { return data.tasks.filter(function (t) { return t.project === name && !pending[t.id]; }).length; };
    var tabs = $('tabs'); tabs.textContent = '';
    names.forEach(function (name) {
      var b = el('button', 'chip', name + ' ' + open(name)); b.type = 'button'; b.setAttribute('aria-pressed', String(name === current));
      b.onclick = function () { current = name; try { localStorage.setItem('lists.current', name); } catch (e) {} render(); };
      tabs.appendChild(b);
    });
    $('add-input').placeholder = 'Add to ' + current;
    var problem = (data.problems || []).indexOf(current) >= 0;
    $('problem').textContent = problem ? 'This list could not be refreshed just now, so it may be out of date.' : '';

    var box = $('items'), tasks = data.tasks.filter(function (t) { return t.project === current; }), sections = [], by = {};
    box.textContent = '';
    tasks.forEach(function (t) { var s = t.section || ''; if (!by[s]) { by[s] = []; sections.push(s); } by[s].push(t); });
    if (!tasks.length) { box.appendChild(el('p', 'note', 'Nothing on this list')); return; }
    sections.forEach(function (s) {
      if (s) box.appendChild(el('h2', 'eyebrow section', s));
      var ul = el('ul', 'rows checks');
      by[s].forEach(function (t) {
        var li = el('li', pending[t.id] ? 'done' : ''), grow = el('div', 'grow');
        li.appendChild(el('span', 'check'));
        grow.appendChild(el('div', 'name', tidy(t.title)));
        var sub = pending[t.id] ? 'Tap again to undo' : [t.assignee, due(t.due)].filter(Boolean).join(' · ');
        if (sub) grow.appendChild(el('div', 'sub', sub));
        li.appendChild(grow);
        li.onclick = function () { toggle(t); };
        ul.appendChild(li);
      });
      box.appendChild(ul);
    });
  }

  // A check-off waits a few seconds before it is sent, so a thumb that lands on the wrong row costs nothing.
  function toggle(task) {
    if (pending[task.id]) { clearTimeout(pending[task.id]); delete pending[task.id]; return render(); }
    pending[task.id] = setTimeout(function () {
      call('POST', '/api/tasks/' + encodeURIComponent(task.id) + '/close').then(function (r) {
        delete pending[task.id];
        if (r.status === 200 || r.status === 404) data.tasks = data.tasks.filter(function (t) { return t.id !== task.id; });
        else toast(r.data.error || 'Can’t check that off right now');
        render();
      }, function () { delete pending[task.id]; toast('Can’t reach the server'); render(); });
    }, UNDO_MS);
    render();
  }

  function load() {
    return call('GET', '/api/tasks').then(function (r) {
      if (r.status === 401) return show('locked');
      if (r.status !== 200) { if (!data) { data = { projects: [], tasks: [] }; show('app'); } $('problem').textContent = 'Can’t load the lists right now. Trying again soon.'; return; }
      data = r.data; render();
    }, function () { if (data) $('problem').textContent = 'No connection. Showing what was here a moment ago.'; });
  }

  $('add').onsubmit = function (e) {
    e.preventDefault();
    var title = tidy($('add-input').value); if (!title || !current) return;
    $('add-go').disabled = true;
    call('POST', '/api/tasks', { list: current, title: title }).then(function (r) {
      $('add-go').disabled = false;
      if (r.status !== 200) return toast(r.data.error || 'Can’t add that right now');
      $('add-input').value = ''; $('add-input').focus(); toast('Added “' + title + '”'); load();
    }, function () { $('add-go').disabled = false; toast('Can’t reach the server'); });
  };
  // Pressing Add must not take the keyboard away between items.
  $('add-go').onmousedown = function (e) { e.preventDefault(); };

  call('GET', '/api/household').then(function (r) { if (r.status === 200 && r.data.name) { $('household').textContent = r.data.name; document.title = r.data.name + ' · Lists'; } }, function () {});
  // The list, as last seen, where the shop has no signal.
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/sw.js').catch(function () {}); } catch (e) {} }
  load();
  setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
})();
