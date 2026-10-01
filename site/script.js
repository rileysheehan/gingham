// Gingham site. A few small things: the download button leads to the install step anywhere but on Android, the dock
// on the wall screen switches views, its rings check things off with Undo, the crops play their moment once as they
// scroll in, and the footer tells the time in Austin.
// Nothing here is essential to reading the page.
(function () {
  'use strict';

  // The app is installed from the frame itself, so on a laptop or an iPhone the button shows how instead of handing over
  // a file that cannot be opened there. The link stays the APK: on Android, and without this script, it downloads.
  var get = document.querySelector('.hero .btn.primary'), install = document.getElementById('install');
  if (get && install && !/Android/i.test(navigator.userAgent)) {
    get.addEventListener('click', function (e) {
      e.preventDefault();
      if (location.hash === '#install') install.scrollIntoView(); else location.hash = 'install';
      install.focus({ preventScroll: true });
    });
  }

  // The dock on the hero screen. Tabs switch which view the right side shows, as they do on the wall.
  var screen = document.getElementById('screen');
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (screen) {
    var tabs = screen.querySelectorAll('.s-tabs button[data-tab]');
    var views = screen.querySelectorAll('.s-view[data-view]');
    var tabsBox = screen.querySelector('.s-tabs');

    // The selected pill slides from the tab that was on to the tab that was tapped (style.css .s-pill). At rest each
    // pressed tab draws its own pill, as it always did; this one exists only for the slide. It is placed from layout
    // (the computed widths, which are not rounded to whole pixels as offsetWidth is, and not the screen box, which
    // would include a press that is still springing back).
    var pill = document.createElement('i'), sliding = null;
    pill.className = 's-pill'; pill.setAttribute('aria-hidden', 'true'); tabsBox.insertBefore(pill, tabsBox.firstChild);
    function place(button) {
      var x = parseFloat(getComputedStyle(tabsBox).paddingLeft), w = 0;
      for (var i = 0; i < tabs.length; i++) { w = parseFloat(getComputedStyle(tabs[i]).width); if (tabs[i] === button) break; x += w; }
      pill.style.width = w + 'px'; pill.style.transform = 'translateX(' + x + 'px)';
    }
    function landed() { clearTimeout(sliding); sliding = null; tabsBox.classList.remove('sliding'); }
    function slide(from, to) {
      if (!from || from === to || (still && still.matches)) return;
      if (!sliding) { pill.style.transition = 'none'; tabsBox.classList.add('sliding'); place(from); void pill.offsetWidth; pill.style.transition = ''; }
      place(to);
      clearTimeout(sliding); sliding = setTimeout(landed, 600);
    }
    pill.addEventListener('transitionend', function (e) { if (e.propertyName === 'transform') landed(); });

    // The view a tap brings in rises and fades in (.s-arrive) while the one it replaces fades out where it was (.s-leave),
    // held out of the flow for the length of its fade, so the pane is never empty between the two.
    var leaveTimer = null;
    function arrived() {
      // Done when every animation inside has ended: the photo's own fade outlasts the view's.
      if (this.getAnimations && this.getAnimations({ subtree: true }).some(function (a) { return a.playState !== 'finished'; })) return;
      this.classList.remove('s-arrive');
    }
    for (var v = 0; v < views.length; v++) views[v].addEventListener('animationend', arrived);
    function show(name) {
      var from = tabsBox.querySelector('button[aria-pressed="true"]'), to = null;
      for (var i = 0; i < views.length; i++) {
        var view = views[i], is = view.getAttribute('data-view') === name, was = !view.hidden && !view.classList.contains('s-leave');
        if (is && !was) { view.classList.remove('s-leave'); view.inert = false; view.hidden = false; view.classList.add('s-arrive'); }
        else if (was && !is) { view.classList.remove('s-arrive'); view.classList.add('s-leave'); view.inert = true; }
      }
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(function () {
        for (var k = 0; k < views.length; k++) if (views[k].classList.contains('s-leave')) { views[k].classList.remove('s-leave'); views[k].inert = false; views[k].hidden = true; }
      }, 200);
      for (var j = 0; j < tabs.length; j++) {
        var on = tabs[j].getAttribute('data-tab') === name;
        tabs[j].setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) to = tabs[j];
      }
      slide(from, to);
    }
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].addEventListener('click', function () {
        // On the wall, tapping the active tab again returns to the calendar.
        var name = this.getAttribute('data-tab');
        show(this.getAttribute('aria-pressed') === 'true' ? 'calendar' : name);
      });
    }
    // On a phone the screen is a picture: the tabs take no taps and the views they switch are cropped away, so they
    // leave the tab order too, and come back if the window widens.
    var narrow = window.matchMedia && window.matchMedia('(max-width:600px)');
    function reach() { for (var t = 0; t < tabs.length; t++) { if (narrow.matches) tabs[t].setAttribute('tabindex', '-1'); else tabs[t].removeAttribute('tabindex'); } }
    if (narrow) { reach(); if (narrow.addEventListener) narrow.addEventListener('change', reach); }
  }

  // Checking off in the hero, as the wall does it (app.js toggleTask): the ring fills with one small pop and the title is
  // struck, a toast offers Undo for the wall's ten seconds, the list's count on its tab falls by one (and goes, at none),
  // and June's list cheers. One check-off can be undone at a time: checking another settles the last, as the wall sends
  // it. A task in two places (Trash to the curb in Today and in Chores) checks off in both. Once its ten seconds are up a
  // check-off stays until a reload, which is a fresh morning; nothing is sent anywhere. On a phone the screen is a
  // picture, so the rows, like the tabs, take no taps there.
  if (screen) {
    var CHEERS = ['🎉', '⭐️', '🚀', '🦖', '🏆'], UNDO_MS = 10000;
    var toastEl = screen.querySelector('.s-toast'), toastText = toastEl.querySelector('span'), cheerEl = screen.querySelector('.s-cheer');
    var rows = screen.querySelectorAll('.s-item[data-task]'), undo = null, toastTimer = null, cheerTimer = null, popped = {};
    function rowsOf(task) { return screen.querySelectorAll('.s-item[data-task="' + task + '"]'); }
    function shown(row) { return row.getClientRects().length > 0; }
    function mark(task, done) {
      var same = rowsOf(task);
      for (var i = 0; i < same.length; i++) {
        same[i].classList.toggle('done', done);
        same[i].setAttribute('aria-checked', done ? 'true' : 'false');
        // Only a ring in view pops; one in a view that is not showing is simply checked when it is next seen.
        same[i].classList.toggle('just', done && shown(same[i]));
      }
      clearTimeout(popped[task]);
      popped[task] = setTimeout(function () { for (var j = 0; j < same.length; j++) same[j].classList.remove('just'); }, 450);
    }
    function count(list, by) {
      var tab = screen.querySelector('.s-tabs button[data-tab="' + list + '"]'), b = tab && tab.querySelector('b');
      if (!b) return;
      var n = Number(b.textContent) + by;
      b.textContent = String(n); b.hidden = n === 0;
      tab.setAttribute('aria-label', tab.getAttribute('aria-label').replace(/\d+/, String(n)));
    }
    function showToast(text) {
      clearTimeout(toastTimer);
      toastText.textContent = text;
      // A toast already up takes the new words where it is, as the wall's does; one that is not rises in (style.css).
      toastEl.classList.remove('leaving'); toastEl.hidden = false;
    }
    function hideToast(task) {
      if (toastEl.hidden || toastEl.classList.contains('leaving')) return;
      // A keyboard on Undo is not left on nothing: it goes back to the row.
      if (toastEl.contains(document.activeElement)) {
        var same = rowsOf(task);
        for (var i = 0; i < same.length; i++) if (shown(same[i])) { same[i].focus(); break; }
      }
      toastEl.classList.add('leaving');
      toastTimer = setTimeout(function () { toastEl.hidden = true; toastEl.classList.remove('leaving'); }, 200);
    }
    function cheer() {
      cheerEl.textContent = CHEERS[Math.floor(Math.random() * CHEERS.length)];
      cheerEl.classList.add('on'); clearTimeout(cheerTimer);
      cheerTimer = setTimeout(function () { cheerEl.classList.remove('on'); }, 1100);
    }
    function settle() { if (!undo) return; var task = undo.task; clearTimeout(undo.timer); undo = null; hideToast(task); }
    function restore() {
      var u = undo; clearTimeout(u.timer); undo = null;
      mark(u.task, false); count(u.list, 1); hideToast(u.task);
    }
    function toggle(row) {
      var task = row.getAttribute('data-task'), list = row.getAttribute('data-list');
      // A second tap is Undo while the toast offers it; after that the row stays checked, as on the wall.
      if (row.classList.contains('done')) { if (undo && undo.task === task) restore(); return; }
      settle();
      mark(task, true); count(list, -1);
      undo = { task: task, list: list, timer: setTimeout(settle, UNDO_MS) };
      var emoji = row.querySelector('.s-emoji');
      showToast('Checked off “' + (emoji ? emoji.textContent + ' ' : '') + row.querySelector('.s-title').firstChild.nodeValue + '”');
      if (list === 'june') cheer();
    }
    toastEl.querySelector('.s-undo').addEventListener('click', function () { if (undo) restore(); });
    function onKeyDown(e) {
      // Enter checks at once; Space on its release, as a checkbox does, and never scrolls the page.
      if (e.key === ' ') e.preventDefault();
      else if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); toggle(this); }
    }
    function onKeyUp(e) { if (e.key === ' ') { e.preventDefault(); toggle(this); } }
    for (var r = 0; r < rows.length; r++) {
      rows[r].setAttribute('role', 'checkbox'); rows[r].setAttribute('aria-checked', 'false');
      rows[r].addEventListener('click', function () { toggle(this); });
      rows[r].addEventListener('keydown', onKeyDown);
      rows[r].addEventListener('keyup', onKeyUp);
    }
    function reachRows() { for (var t = 0; t < rows.length; t++) { if (narrow && narrow.matches) rows[t].removeAttribute('tabindex'); else rows[t].setAttribute('tabindex', '0'); } }
    reachRows();
    if (narrow && narrow.addEventListener) narrow.addEventListener('change', reachRows);
  }

  // After dark the hero screen shows the product's evening, so its clock reads later. The rest of the Thursday stays;
  // soccer runs until 7:30 either way, so only the clock and the sun line change.
  var clockEl = screen && screen.querySelector('.s-clock');
  var sunline = screen && screen.querySelector('.s-sunline');
  if (clockEl && sunline && window.matchMedia) {
    var dark = window.matchMedia('(prefers-color-scheme: dark)');
    var day = { clock: clockEl.firstChild.nodeValue, sun: sunline.textContent };
    function hour() {
      clockEl.firstChild.nodeValue = dark.matches ? '7:16' : day.clock;
      // After sunset the product's sun line looks ahead to the morning.
      sunline.textContent = dark.matches ? 'Sunrise tomorrow 7:26 AM' : day.sun;
    }
    hour();
    if (dark.addEventListener) dark.addEventListener('change', hour);
  }

  // The crops come alive once each, as they scroll into view: the Grocery crop checks Cilantro off and its toast rises,
  // June's checks Tidy up off and lands the cheer, and the Monday panel turns its minute to 12:20, its countdown to "in
  // 40 min" and its day line's dot to its place, a plain swap, as the wall turns a minute. Each crop is complete as
  // written. This winds one back to the moment before only when it will play it forward, so without the script, without
  // IntersectionObserver, with reduced motion, or for a crop already on screen when the page opens, a crop is simply what
  // it shows; once played, it is that again.
  if ('IntersectionObserver' in window && !(still && still.matches)) {
    var plays = [];
    function arm(id, wind, delay) {
      var el = document.querySelector('#' + id + ' .crop'), box = el && el.getBoundingClientRect();
      if (!el || (box.bottom > 0 && box.top < window.innerHeight)) return;
      plays.push({ el: el, play: wind(el), delay: delay });
    }
    function bump(el, by) { var n = el.querySelector('.s-tabs button[aria-pressed="true"] b'); if (n) n.textContent = String(Number(n.textContent) + by); }
    function uncheck(el) {
      el.classList.add('wound'); bump(el, 1);
      return function () { el.classList.remove('wound'); el.classList.add('played'); bump(el, -1); };
    }
    arm('lists', uncheck, 700);
    arm('kids', uncheck, 900);
    arm('calendars', function (el) {
      var clock = el.querySelector('.s-clock').firstChild, meta = el.querySelector('.s-item.next .s-meta');
      var dot = el.querySelector('.s-dl-now'), past = el.querySelector('.s-dl-rule.past'), ahead = el.querySelector('.s-dl-rule:not(.past)');
      var as = [clock.nodeValue, meta.textContent, dot.style.left, past.style.width, ahead.style.left, ahead.style.width];
      // 12:19 on the day line: 379 of its 1,080 minutes, the rules keeping their gap around the dot.
      clock.nodeValue = '12:19'; meta.textContent = '1 PM · in 41 min';
      dot.style.left = '35.093%'; past.style.width = '32.676%'; ahead.style.left = '37.51%'; ahead.style.width = '62.49%';
      return function () { clock.nodeValue = as[0]; meta.textContent = as[1]; dot.style.left = as[2]; past.style.width = as[3]; ahead.style.left = as[4]; ahead.style.width = as[5]; };
    }, 1600);
    // Most of a crop in view, or most of a short window filled by one.
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.intersectionRatio < 0.6 && !(e.rootBounds && e.intersectionRect.height >= 0.6 * e.rootBounds.height)) return;
        seen.unobserve(e.target);
        for (var i = 0; i < plays.length; i++) if (plays[i].el === e.target) setTimeout(plays[i].play, plays[i].delay);
      });
    }, { threshold: [0.2, 0.4, 0.6, 0.8] });
    for (var p = 0; p < plays.length; p++) seen.observe(plays[p].el);
  }

  // The time where it was made. Refreshes on the minute, and each new minute fades in (style.css .tick), as the first
  // reading does: a plain swap of the words, as the wall turns its own clock, never a roll.
  var clock = document.getElementById('austin-clock');
  if (clock && window.Intl && Intl.DateTimeFormat) {
    var fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
    function tick() {
      var words = 'It’s ' + fmt.format(new Date()) + ' in Austin.';
      if (words !== clock.textContent) { clock.textContent = words; clock.classList.remove('tick'); void clock.offsetWidth; clock.classList.add('tick'); }
      setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    }
    tick();
  }
})();
