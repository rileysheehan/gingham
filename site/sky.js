// The hero's sky, painted the way the wall paints its sky window. A copy of the product's own, from dist/app.js:
//   SKY, the four skies                  (app.js, the "Sky" section, line 184)
//   the keyframes around sunrise/sunset  (paintSky, line 206)
//   the ink flip at luminance 0.22       (paintSky, line 223)
//   hold(), easing each end to the ink   (paintSky, line 228)
//   INK_NAVY, INK_CREAM, SKY_CONTRAST    (line 240)
// test/site-sky.test.js reads both files and fails if any of these differ, so a change on the wall must be made here too.
//
// What the site cannot know, it does not pretend to (docs/PLAN.md, the site and the product stay in sync): it has no
// forecast and no place, so it paints the product's own fallback day, sunrise 7 AM and sunset 7 PM, under a clear sky,
// from the visitor's clock. In the dark scheme the sky is night at any hour, as the wall paints it when Appearance is
// Dark. Loaded in <head>, so the first paint is already the right sky; without it the CSS defaults are the day and the
// night. It repaints once a minute and never animates.
(function () {
  'use strict';
  var SKY = {
    night: { top: [7, 11, 26], bottom: [20, 28, 58] },
    dawn: { top: [143, 166, 220], bottom: [246, 201, 181] },
    day: { top: [111, 180, 238], bottom: [212, 236, 250] },
    dusk: { top: [38, 48, 106], bottom: [181, 86, 107] }
  };
  var INK_NAVY = [11, 37, 69], INK_CREAM = [253, 246, 238], SKY_CONTRAST = 8;
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function luminance(c) {
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  }
  function contrast(a, b) { var x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }
  function skyAt(d, night) {
    var min = 60000, base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), t = d.getTime();
    // The product's day when it has no forecast yet (app.js sunTimes).
    var sun = { rise: base + 7 * 3600000, set: base + 19 * 3600000 };
    var frames = [
      [sun.rise - 70 * min, 'night'], [sun.rise - 10 * min, 'dawn'], [sun.rise + 75 * min, 'day'],
      [sun.set - 100 * min, 'day'], [sun.set - 5 * min, 'dusk'], [sun.set + 50 * min, 'night']
    ];
    var top = SKY.night.top, bottom = SKY.night.bottom, i;
    if (!night && t > frames[0][0] && t < frames[5][0]) for (i = 0; i < 5; i++) if (t >= frames[i][0] && t < frames[i + 1][0]) {
      var f = (t - frames[i][0]) / (frames[i + 1][0] - frames[i][0]), a = SKY[frames[i][1]], b = SKY[frames[i + 1][1]];
      top = mix(a.top, b.top, f); bottom = mix(a.bottom, b.bottom, f);
    }
    var light = luminance(mix(top, bottom, 0.5)) > 0.22;
    var ink = light ? INK_NAVY : INK_CREAM, away = light ? [255, 255, 255] : [0, 0, 0];
    function hold(c) { for (var k = 0; k < 40 && contrast(ink, c) < SKY_CONTRAST; k++) c = mix(c, away, 0.05); return c; }
    return { top: hold(top), bottom: hold(bottom), ink: ink, light: light };
  }
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  var root = document.documentElement;
  function paint() {
    var now = new Date(), night = !!(dark && dark.matches), s = skyAt(now, night), st = root.style;
    st.setProperty('--hero-top', rgb(s.top)); st.setProperty('--hero-bottom', rgb(s.bottom));
    st.setProperty('--hero-ink', rgb(s.ink));
    // Secondary words on the sky are the ink at 85%, never fainter: the wall's rule for its own secondary text.
    st.setProperty('--hero-ink-2', 'rgba(' + s.ink.join(',') + ',.85)');
    st.setProperty('--hero-line', 'rgba(' + s.ink.join(',') + ',.38)');
    root.classList.toggle('sky-cream', !s.light);
    // The browser's own bar takes the sky's top, so the header runs into it.
    var bars = document.querySelectorAll('meta[name="theme-color"]');
    for (var m = 0; m < bars.length; m++) bars[m].setAttribute('content', rgb(s.top));
  }
  paint();
  document.addEventListener('DOMContentLoaded', paint);
  function tick() { paint(); setTimeout(tick, 60000 - (Date.now() % 60000) + 50); }
  setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  if (dark && dark.addEventListener) dark.addEventListener('change', paint);
})();
