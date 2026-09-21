/* Adding photos to the frame from a phone. No build, no libraries. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAX_SIDE = 2560, QUALITY = 0.86, busy = false;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function toast(text) { var t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 3200); }
  function json(r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); }
  var headers = { 'X-Gingham': '1' };

  // The day a picture was taken, from what the camera wrote into it (Exif DateTimeOriginal). Read here because the
  // copy that is sent has none of that left in it. Anything unexpected reads as "unknown".
  function takenDay(buffer) {
    try {
      var v = new DataView(buffer), at = 2;
      if (v.getUint16(0) !== 0xffd8) return '';
      while (at + 4 < v.byteLength) {
        var marker = v.getUint16(at), size = v.getUint16(at + 2);
        if (marker === 0xffe1 && v.getUint32(at + 4) === 0x45786966) return exifDay(v, at + 10);
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return '';
        at += 2 + size;
      }
    } catch (e) {}
    return '';
  }
  function exifDay(v, tiff) {
    var little = v.getUint16(tiff) === 0x4949, u16 = function (o) { return v.getUint16(o, little); }, u32 = function (o) { return v.getUint32(o, little); };
    function find(dir, tag) { var n = u16(dir); for (var i = 0; i < n; i++) { var e = dir + 2 + i * 12; if (u16(e) === tag) return e; } return 0; }
    var exif = find(tiff + u32(tiff + 4), 0x8769); if (!exif) return '';
    var when = find(tiff + u32(exif + 8), 0x9003); if (!when) return '';
    var o = tiff + u32(when + 8), text = ''; for (var i = 0; i < 10; i++) text += String.fromCharCode(v.getUint8(o + i));
    return /^\d{4}:\d{2}:\d{2}$/.test(text) ? text.replace(/:/g, '-') : '';
  }

  // Through a canvas: the right way up, no larger than the frame can use, a JPEG whatever it was, and nothing of
  // the original file's hidden details.
  function shrink(file) {
    var decode = window.createImageBitmap ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return viaImage(file); }) : viaImage(file);
    return decode.then(function (img) {
      var w = img.width, h = img.height, scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      var canvas = document.createElement('canvas'); canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      if (img.close) img.close();
      return new Promise(function (resolve, reject) { canvas.toBlob(function (b) { b ? resolve(b) : reject(Error('encode')); }, 'image/jpeg', QUALITY); });
    });
  }
  function viaImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(Error('decode')); };
      img.src = url;
    });
  }
  function send(file) {
    return file.slice(0, 262144).arrayBuffer().then(takenDay, function () { return ''; }).then(function (day) {
      return shrink(file).then(function (blob) {
        var h = { 'X-Gingham': '1', 'Content-Type': 'image/jpeg' }; if (day) h['X-Taken'] = day;
        return fetch('/api/photos/add', { method: 'POST', headers: h, body: blob, credentials: 'same-origin' }).then(json);
      });
    });
  }

  $('add').onclick = function () { if (!busy) $('pick').click(); };
  $('pick').onchange = function () {
    var files = [].slice.call($('pick').files || []), done = 0, failed = 0, last = '';
    if (!files.length) return;
    busy = true; $('add').disabled = true; $('problem').textContent = ''; $('progress').hidden = false;
    // One at a time: a phone has little memory to spare, and a full-size picture on a canvas takes a lot of it.
    (function next(i) {
      if (i >= files.length) {
        busy = false; $('add').disabled = false; $('progress').hidden = true; $('pick').value = '';
        if (failed) $('problem').textContent = (failed === 1 ? 'One photo' : failed + ' photos') + ' could not be added. ' + last;
        if (done) toast(done === 1 ? 'Added 1 photo' : 'Added ' + done + ' photos');
        return load();
      }
      $('progress').textContent = 'Sending ' + (i + 1) + ' of ' + files.length + '…';
      send(files[i]).then(function (r) { if (r.status === 200) done++; else { failed++; last = r.data.error || ''; } }, function () { failed++; last = 'That kind of picture can’t be read on this phone.'; }).then(function () { next(i + 1); });
    })(0);
  };

  function render(data) {
    var all = data.photos || [], added = all.filter(function (p) { return p.uploaded; }), album = all.length - added.length;
    $('state').textContent = !all.length ? 'No photos yet. Add some from this phone, or connect a shared album on the setup page.'
      : [added.length ? added.length + ' added from a phone' : '', album ? album + ' from your shared album' : ''].filter(Boolean).join(' · ');
    $('added-card').hidden = !added.length;
    var grid = $('grid'); grid.textContent = '';
    added.forEach(function (p) {
      var cell = el('button', 'thumb'); cell.type = 'button'; cell.style.backgroundImage = 'url("' + p.url + '")'; cell.setAttribute('aria-label', 'Photo from ' + p.taken + '. Press to remove');
      cell.onclick = function () {
        if (!cell.classList.contains('armed')) { cell.classList.add('armed'); cell.appendChild(el('span', '', 'Remove?')); setTimeout(function () { cell.classList.remove('armed'); cell.textContent = ''; }, 4000); return; }
        fetch('/api/photos/remove', { method: 'POST', headers: { 'X-Gingham': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ file: p.file }), credentials: 'same-origin' }).then(json).then(function () { toast('Removed'); load(); });
      };
      grid.appendChild(cell);
    });
  }
  function load() {
    return fetch('/api/photos', { headers: headers, credentials: 'same-origin' }).then(json).then(function (r) {
      if (r.status === 401 || r.status === 403) { $('app').hidden = true; $('locked').hidden = false; return; }
      $('app').hidden = false; render(r.data);
    }, function () { $('app').hidden = false; $('problem').textContent = 'Can’t reach the server.'; });
  }
  fetch('/api/household', { credentials: 'same-origin' }).then(json).then(function (r) { if (r.status === 200 && r.data.name) { $('household').textContent = r.data.name; document.title = r.data.name + ' · Photos'; } }, function () {});
  load();
})();
