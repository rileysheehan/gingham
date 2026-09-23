// Gingham site. Two small things: the dock on the wall screen switches views, and the footer tells
// the time in Austin. Nothing here is essential to reading the page.
(function () {
  'use strict';

  // The dock on the hero screen. Tabs switch which view the right side shows, as they do on the wall.
  var screen = document.getElementById('screen');
  if (screen) {
    var tabs = screen.querySelectorAll('.s-tabs button[data-tab]');
    var views = screen.querySelectorAll('.s-view[data-view]');
    function show(name) {
      for (var i = 0; i < views.length; i++) views[i].hidden = views[i].getAttribute('data-view') !== name;
      for (var j = 0; j < tabs.length; j++) tabs[j].setAttribute('aria-pressed', tabs[j].getAttribute('data-tab') === name ? 'true' : 'false');
    }
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].addEventListener('click', function () {
        // On the wall, tapping the active tab again returns to the calendar.
        var name = this.getAttribute('data-tab');
        show(this.getAttribute('aria-pressed') === 'true' ? 'calendar' : name);
      });
    }
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

  // The time where it was made. Refreshes on the minute.
  var clock = document.getElementById('austin-clock');
  if (clock && window.Intl && Intl.DateTimeFormat) {
    var fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
    function tick() {
      clock.textContent = 'It’s ' + fmt.format(new Date()) + ' in Austin.';
      setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    }
    tick();
  }
})();
