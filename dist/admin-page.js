/* The admin page: the households in this deployment, a new one, and the first link for whoever looks after it. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function toast(text) { var t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 3200); }
  function showError(action, message) { var p = document.querySelector('.error[data-for="' + action + '"]'); if (p) p.textContent = message || ''; }
  function call(method, path, body) {
    return fetch('/api/admin' + path, { method: method, headers: { 'X-Gingham': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }
  function ago(iso) {
    if (!iso) return 'never seen';
    var mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return mins < 60 ? 'seen in the last hour' : mins < 2880 ? 'seen ' + Math.round(mins / 60) + ' hours ago' : 'seen ' + Math.round(mins / 1440) + ' days ago';
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function act(action, body, button) {
    showError(action, ''); button.disabled = true;
    return call('POST', '/' + action, body).then(function (r) {
      button.disabled = false;
      if (r.status !== 200) { showError(action, r.data.error || 'That did not work. Try again.'); return null; }
      render(r.data); if (r.data.made) showLink(r.data.made);
      return r.data;
    }, function () { button.disabled = false; showError(action, 'Can’t reach the server. Check your connection.'); return null; });
  }
  function showLink(made) {
    $('made').hidden = false; $('made-title').textContent = 'Send this to ' + made.name;
    $('made-note').textContent = 'By text or however you like. Opening it makes that device the one that sets ' + made.name + ' up.';
    $('made-link').textContent = made.link; $('made').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('made-copy').onclick = function () {
    var link = $('made-link').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { toast('Copied'); }, function () { toast('Press and hold the link to copy it'); });
    else toast('Press and hold the link to copy it');
  };

  function render(data) {
    var list = $('list'); list.textContent = '';
    (data.households || []).forEach(function (h) {
      var li = el('li'), grow = el('div', 'grow'), buttons = el('div', 'pair');
      grow.appendChild(el('div', 'name', h.name));
      grow.appendChild(el('div', 'sub', [h.place || 'no place set', plural(h.frames, 'frame'), h.owners ? plural(h.owners, 'owner') : 'nobody looks after it yet', ago(h.lastSeen)].join(' · ')));
      var open = el('a', 'small button-link', 'Set up'); open.href = '/setup?household=' + encodeURIComponent(h.id);
      var link = el('button', 'small', 'New link'); link.onclick = function () { act('owner-link', { household: h.id, whose: '' }, link); };
      buttons.appendChild(open); buttons.appendChild(link);
      li.appendChild(grow); li.appendChild(buttons); list.appendChild(li);
    });
  }

  $('n-add').onclick = function () {
    act('household-add', { name: $('n-name').value, whose: $('n-whose').value }, $('n-add')).then(function (done) { if (done) { $('n-name').value = ''; $('n-whose').value = ''; } });
  };

  call('GET', '').then(function (r) {
    if (r.status !== 200) { $('locked').hidden = false; return; }
    $('app').hidden = false; render(r.data);
  }, function () { $('locked').hidden = false; });
})();
