/*
  The frame's page. Plain ES5 on purpose: photo-frame WebViews are old, and there is no build step.
  Layout: Today (a sky-colored panel with the clock) on the left, the next six days on the right,
  a "Later" reach to four weeks out, and one tab per Todoist list.
*/
(function () {
  'use strict';

  var WINDOW_DAYS = 28;      // keep in step with integrations.js
  var STRIP_DAYS = 6;        // days shown to the right of Today
  var UNDO_MS = 10000;        // long enough to notice a chore checked off by a passing five-year-old
  var HOME_AFTER_MS = 120000;   // drift back to the calendar, on today
  var LIST_AFTER_MS = 600000;   // a list is read while cooking, so it holds the screen far longer
  var PHOTO_CHROME_MS = 12000;  // photo mode is for the photo; the title and dock are only a way back

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  var cal = null, tasks = null, weather = null, photos = [];
  var calProblem = false, tasksProblem = false;
  var page = 0, mode = 'calendar', themeChoice = 'auto';
  // Household preferences from the Settings view, stored on the server. These defaults are used until they load.
  var prefs = { rest: 'photos', restAfter: 5, mornings: 0, photoEvery: 60, appearance: 'auto' };
  var pending = {};          // task id -> true while "done" but not yet sent or not yet refetched
  var undo = null;           // {task, timer}
  var lastTouch = Date.now(), loadedDay = '', version = null, previousFocus = null;
  var slideFront = 'a', slideTimer = null, photoInfo = {};
  var slideDeck = {items: []}, slideSeen = [], slideAt = -1;

  var query = {};
  location.search.replace(/[?&]([^=&]+)=([^&]*)/g, function (m, k, v) { query[k] = decodeURIComponent(v); });

  function $(id) { return document.getElementById(id); }
  function node(tag, cls, text) { var el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
  function pad(n) { return ('0' + n).slice(-2); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function sameDay(a, b) { return iso(a) === iso(b); }
  // Every date in this app is house time: a Date whose local fields read as the wall clock where the household
  // lives, whatever timezone the frame itself is set to. Frameo resets the device to its own zone each time it
  // restarts, and a frame six hours off is worse than no frame. The zone comes from the server (/api/household) and
  // is remembered, so the clock is right from the first paint on every start after the first.
  var household = { name: '', timezone: 'UTC', place: '' };
  var countdowns = [];       // what the household is counting down to, soonest first: {name, date, word}
  try { household.timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) {}   // until the server says, the device's own
  try { var remembered = JSON.parse(localStorage.getItem('frame.household') || 'null'); if (remembered && remembered.timezone) household = remembered; } catch (e) {}
  var HOUSE_TZ = household.timezone, houseClock = null;
  try { houseClock = new Intl.DateTimeFormat('en-US', { timeZone: HOUSE_TZ, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch (e) {}
  function toHouse(instant) {
    if (!houseClock || !houseClock.formatToParts) return instant;
    var p = {};
    houseClock.formatToParts(instant).forEach(function (part) { p[part.type] = part.value; });
    return new Date(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second, instant.getMilliseconds());
  }
  function now() { return query.now ? parse(query.now) : toHouse(new Date()); }

  // Old Chrome reads "2026-09-23" and "2026-09-23T21:00:00" as UTC. Anything without an explicit
  // offset is already wall-clock time in this house, so build those by hand; anything with one is an
  // absolute instant, converted to house time.
  function parse(value) {
    var m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?)?$/.exec(value);
    return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : toHouse(new Date(value));
  }
  function houseTime(ms) { return toHouse(new Date(ms)); }
  function hasTime(value) { return value.length > 10; }
  function clockTime(d) { var h = d.getHours(), m = d.getMinutes(); return (h % 12 || 12) + (m ? ':' + pad(m) : '') + (h < 12 ? ' AM' : ' PM'); }
  function shortDay(d) { return DAYS[d.getDay()].slice(0, 3) + ', ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate(); }

  var unpaired = false;      // the server does not know this frame: it was never paired, or was revoked
  var pairing = null;        // {device, code, until}: the code this screen is showing while it waits to be approved
  var firstRun = null;       // {address}: this tablet runs its own server and nobody looks after the household yet
  var firstCode = null;      // {code, until}: the code that lets a phone become its first owner
  function firstRunStep() {
    if (!firstRun) { firstCode = null; return; }
    if (!firstCode || Date.now() > firstCode.until) post('/api/owner-code', {}, function (status, data) { if (status === 200 && data.code) { firstCode = { code: data.code, until: Date.now() + (data.expiresIn - 30) * 1000 }; render(); } });
    loadHousehold();
  }
  setInterval(firstRunStep, 5000);
  function post(url, body, done) {
    var xhr = new XMLHttpRequest(); xhr.open('POST', url); xhr.timeout = 20000;
    xhr.setRequestHeader('X-Gingham', '1'); xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () { var data = null; try { data = JSON.parse(xhr.responseText); } catch (e) {} done(xhr.status, data || {}); };
    xhr.onerror = xhr.ontimeout = function () { done(0, {}); };
    xhr.send(JSON.stringify(body || {}));
  }
  function pairStep() {
    if (!unpaired) { pairing = null; return; }
    if (!pairing || Date.now() > pairing.until) {
      post('/api/pair/start', {}, function (status, data) {
        if (status === 200 && data.code) { pairing = { device: data.device, code: data.code, until: Date.now() + (data.expiresIn - 20) * 1000 }; render(); }
      });
      return;
    }
    post('/api/pair/poll', { device: pairing.device }, function (status) {
      if (status === 200) { unpaired = false; pairing = null; loadHousehold(); loadSettings(); loadCalendar(); loadTasks(); loadWeather(); loadPhotos(); }
      else if (status === 410) { pairing = null; pairStep(); }
    });
  }
  setInterval(pairStep, 5000);
  // Keeps the last good frame for a reload during an outage; see sw.js. Absent on plain http away from this device.
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/sw.js')['catch'](function () {}); } catch (e) {} }
  function get(url, done, fail) {
    var xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.timeout = 55000;
    xhr.onload = function () {
      var data = null;
      try { if (xhr.status === 200) data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status === 401 && !unpaired) { unpaired = true; render(); pairStep(); } else if (xhr.status === 200 && unpaired) { unpaired = false; }
      checkVersion(xhr.getResponseHeader('X-Frame-Version'));
      if (data) done(data); else fail();
    };
    xhr.onerror = xhr.ontimeout = fail; xhr.send();
  }
  // The server hashes its own assets. A changed hash means the app was updated: reload, but never
  // out from under someone's hands.
  function checkVersion(v) {
    if (!v) return;
    if (version === null) { version = v; return; }
    if (v !== version && !undo && $('event-dialog').hidden && Date.now() - lastTouch > 10000) location.reload();
  }

  /* ---------- Sky ---------- */
  var SKY = {
    night: { top: [7, 11, 26], bottom: [20, 28, 58] },
    dawn: { top: [143, 166, 220], bottom: [246, 201, 181] },
    day: { top: [111, 180, 238], bottom: [212, 236, 250] },
    dusk: { top: [38, 48, 106], bottom: [181, 86, 107] }
  };
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function luminance(c) {
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  }
  function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }
  function sunTimes(t) {
    var today = iso(t), found = null;
    if (weather && weather.days) weather.days.forEach(function (d) { if (d.date === today) found = d; });
    if (found && !query.now) return { rise: houseTime(found.sunrise).getTime(), set: houseTime(found.sunset).getTime() };
    var base = startOfDay(t).getTime(); // no forecast yet: a plausible day
    return { rise: base + 7 * 3600000, set: base + 19 * 3600000 };
  }
  function paintSky() {
    var t = now().getTime(), sun = sunTimes(now()), min = 60000;
    // Keyframes around the real sunrise and sunset; colors blend continuously between them.
    var frames = [
      [sun.rise - 70 * min, 'night'], [sun.rise - 10 * min, 'dawn'], [sun.rise + 75 * min, 'day'],
      [sun.set - 100 * min, 'day'], [sun.set - 5 * min, 'dusk'], [sun.set + 50 * min, 'night']
    ];
    var forced = query.sky || (themeChoice === 'light' ? 'day' : themeChoice === 'dark' ? 'night' : '');
    var top, bottom, i;
    if (forced && SKY[forced]) { top = SKY[forced].top; bottom = SKY[forced].bottom; }
    else if (t <= frames[0][0] || t >= frames[5][0]) { top = SKY.night.top; bottom = SKY.night.bottom; }
    else for (i = 0; i < 5; i++) if (t >= frames[i][0] && t < frames[i + 1][0]) {
      var f = (t - frames[i][0]) / (frames[i + 1][0] - frames[i][0]), a = SKY[frames[i][1]], b = SKY[frames[i + 1][1]];
      top = mix(a.top, b.top, f); bottom = mix(a.bottom, b.bottom, f);
    }
    // Cloud cover drains the color toward grey: WMO 0 clear, 1 mostly clear, 2 partly, 3 overcast, 45+ fog or wet. The
    // drifting clouds carry the rest, so an overcast sky reads as clouds rather than as a flat grey.
    var code = skyCode(), cloud = query.clear ? 0 : code === 0 ? 0 : code === 1 ? 0.15 : code === 2 ? 0.3 : code === 3 ? 0.5 : code < 50 ? 0.55 : 0.65;
    function grey(c) { var l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; return mix(c, [l, l, l * 1.04], cloud); }
    top = grey(top); bottom = grey(bottom);
    var light = luminance(mix(top, bottom, 0.5)) > 0.22;
    var style = document.documentElement.style;
    style.setProperty('--sky-top', rgb(top)); style.setProperty('--sky-bottom', rgb(bottom));
    style.setProperty('--sky-ink', light ? '#0b2545' : '#fdf6ee');
    var dark = forced ? forced === 'night' || forced === 'dusk' : (t < sun.rise - 10 * min || t > sun.set + 5 * min);
    document.body.className = dark ? 'theme-dark' : 'theme-light';
    paintWeather(code, dark);
  }
  function skyCode() { return query.wx !== undefined ? Number(query.wx) : weather ? weather.code : 0; }
  // Weather moves in the sky window, faintly: a sun glow or stars, clouds that take minutes to cross, rain, snow or fog.
  // Motion is a position computed from the clock once a second, never a CSS animation. Measured on the Frameo, whose
  // WebView composites on the CPU: smooth CSS drift cost 140% CPU, the same drift stepped by CSS 20%, this under 3%.
  // Rain stays still, since rain at one frame a second reads as flicker, and a storm has no lightning: a flash on a
  // dark kitchen wall pulls the eye, which ambient motion must not. Rebuilt only when the weather changes.
  var fxKind = '', fxItems = [];
  function paintWeather(code, dark) {
    var kind = code === 0 ? 'clear' : code === 1 ? 'mostly' : code === 2 ? 'partly' : code === 3 ? 'overcast' : code < 50 ? 'fog' :
      code < 60 ? 'drizzle' : code < 70 || (code >= 80 && code < 85) ? 'rain' : code < 90 ? 'snow' : 'storm';
    var key = kind + (dark ? '-night' : '-day'), box = $('sky-fx'), seed = 7, i;
    if (key === fxKind) return;
    fxKind = key; fxItems = []; box.textContent = ''; box.className = 'sky-fx ' + (dark ? 'night' : 'day');
    function random() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    function add(cls, css, motion) {
      var el = node('div', cls); for (var k in css) el.style[k] = css[k];
      box.appendChild(el); if (motion) { motion.el = el; motion.phase = random(); fxItems.push(motion); } return el;
    }
    if (kind === 'clear' || kind === 'mostly' || kind === 'partly') {
      if (!dark) add('sun', {}, { kind: 'breathe', period: 16, low: kind === 'partly' ? 0.45 : 0.6, high: kind === 'partly' ? 0.65 : 0.9 });
      else for (i = 0; i < (kind === 'partly' ? 14 : 26); i++) add('star', { left: (random() * 96) + '%', top: (random() * 58) + '%' }, { kind: 'twinkle', period: 5 + random() * 6 });
    }
    var clouds = { mostly: 1, partly: 2, overcast: 4, drizzle: 3, rain: 3, storm: 4, snow: 3 }[kind] || 0;
    for (i = 0; i < clouds; i++) add('cloud', { top: (4 + i * 17 + random() * 8) + '%', width: (34 + random() * 20) + 'rem', opacity: String(kind === 'overcast' || kind === 'storm' ? 0.75 : 0.55) }, { kind: 'drift', period: 170 + random() * 110 });
    if (kind === 'fog') for (i = 0; i < 3; i++) add('fog', { top: (18 + i * 26) + '%' }, { kind: 'sway', period: 140 + i * 50 });
    if (kind === 'drizzle' || kind === 'rain' || kind === 'storm') { add('rain far', {}); if (kind !== 'drizzle') add('rain near', {}); }
    if (kind === 'snow') { add('snow far', {}, { kind: 'fall', period: 90, tile: 8 }); add('snow near', {}, { kind: 'fall', period: 60, tile: 12 }); }
    tickSky();
  }
  // The frame has no light sensor, so the backlight follows the household's sun: up with sunrise, down after sunset, lowest
  // overnight, and full for two minutes after a touch so a 1 AM glance is never dim. Needs Fully Kiosk's website
  // integration (Settings -> Advanced Web Settings); without it nothing here runs and the night veil takes over.
  var lastBrightness = -1;
  function screenBridge() { return typeof fully === 'object' && fully && typeof fully.setScreenBrightness === 'function'; }
  function setBrightness(t, idle) {
    if (!screenBridge()) return;
    var sun = sunTimes(t), min = 60000, day = startOfDay(t), at = t.getTime();
    var frames = [
      [day.getTime(), 45], [addHours(day, 5.75), 45], [addHours(day, 6.25), 95], [sun.rise + 45 * min, 210],
      [sun.set - 45 * min, 210], [sun.set + 20 * min, 120], [addHours(day, 22.5), 45], [addHours(day, 24), 45]
    ];
    var level = 45, i;
    for (i = 0; i < frames.length - 1; i++) if (at >= frames[i][0] && at < frames[i + 1][0]) {
      var span = frames[i + 1][0] - frames[i][0];
      level = Math.round(frames[i][1] + (frames[i + 1][1] - frames[i][1]) * (span ? (at - frames[i][0]) / span : 0));
    }
    if (prefs.screen === 'bright') level = 210;
    else if (prefs.screen === 'dim') level = 45;
    else if (idle < 120000) level = Math.max(level, 170);
    if (Math.abs(level - lastBrightness) < 4) return;
    lastBrightness = level;
    try { fully.setScreenBrightness(level); } catch (e) { lastBrightness = -1; }
  }
  function addHours(day, hours) { return day.getTime() + hours * 3600000; }
  function tickSky() {
    if (!fxItems.length) return;
    var s = Date.now() / 1000, rem = window.innerWidth / 120, width = $('sky-fx').clientWidth;
    fxItems.forEach(function (m) {
      var cycle = m.period ? (s / m.period + m.phase) % 1 : 0, wave = Math.sin(cycle * 2 * Math.PI), st = m.el.style;
      if (m.kind === 'drift') { var w = m.el.offsetWidth; st.transform = 'translate3d(' + Math.round(-w + cycle * (width + w)) + 'px,0,0)'; }
      else if (m.kind === 'sway') st.transform = 'translate3d(' + Math.round(wave * width * 0.08) + 'px,0,0)';
      else if (m.kind === 'fall') st.transform = 'translate3d(0,' + Math.round(cycle * m.tile * rem) + 'px,0)';
      else if (m.kind === 'breathe') { st.opacity = (m.low + (m.high - m.low) * (wave + 1) / 2).toFixed(2); st.transform = 'scale(' + (1 + 0.04 * wave).toFixed(3) + ')'; }
      else if (m.kind === 'twinkle') st.opacity = (0.3 + 0.2 * wave).toFixed(2);
    });
  }

  /* ---------- Weather ---------- */
  function describe(code) { if (code === 0) return 'Clear'; if (code === 1) return 'Mostly clear'; if (code === 2) return 'Partly cloudy'; if (code === 3) return 'Overcast'; if (code < 50) return 'Foggy'; if (code < 60) return 'Drizzle'; if (code < 70) return 'Rain'; if (code < 80) return 'Snow'; if (code < 85) return 'Showers'; if (code < 90) return 'Snow showers'; return 'Thunderstorms'; }
  // `night` swaps the sun for a moon; only the current conditions use it, since forecasts describe the day.
  function drawIcon(svg, code, night) {
    var sun = night ? '<path class="moon" d="M38 10a22 22 0 1 0 16 36 18 18 0 0 1-16-36Z"/>' : '<circle class="sun" cx="32" cy="32" r="11"/><path class="sun" d="M32 11V6m0 52v-5M11 32H6m52 0h-5M17 17l-3.5-3.5m37 37L47 47M17 47l-3.5 3.5m37-37L47 17"/>';
    var cloud = '<path d="M18 46a10 10 0 0 1-1-20 15 15 0 0 1 28-2 11 11 0 1 1 4 22Z"/>';
    var mark;
    if (code === 0 || code === 1) mark = sun;
    else if (code === 2) mark = '<g transform="translate(14,-6) scale(.62)">' + sun + '</g>' + cloud.replace('<path', '<path fill="var(--wx-fill,none)"');
    else if (code === 3) mark = cloud;
    else if (code < 50) mark = '<path d="M21 33a8 8 0 0 1-1-16 12 12 0 0 1 23-2 9 9 0 1 1 3 18Z"/><path d="M10 43h44M17 51h30"/>'; // fog: a cloud over drifting lines, not a menu glyph
    else if ((code >= 71 && code <= 77) || code === 85 || code === 86) mark = cloud + '<path d="M22 53v7m-3-5.5 6 4m0-4-6 4M42 53v7m-3-5.5 6 4m0-4-6 4"/>';
    else if (code >= 95) mark = cloud + '<path class="bolt" d="m35 40-9 13h8l-4 10 14-16h-9l4-7Z"/>';
    else mark = cloud + '<path class="drop" d="m22 52-3 7m15-7-3 7m15-7-3 7"/>';
    svg.innerHTML = mark;
  }
  function renderNow() {
    if (!weather) { $('now').hidden = true; return; }
    $('now').hidden = false;
    var t = now().getTime(), sun = sunTimes(now());
    drawIcon($('now-icon'), weather.code, t < sun.rise || t > sun.set);
    $('now-temp').textContent = Math.round(weather.temperature) + '°';
    $('now-summary').textContent = describe(weather.code);
    // Non-breaking spaces keep each label with its number when the line wraps ("low 73°", never "low / 73°").
    // Apple's form: H and L first, then the one extra that matters today (rain, or a big feels-like gap).
    var feels = Math.round(weather.feelsLike), detail = 'H:' + Math.round(weather.high) + '°  L:' + Math.round(weather.low) + '°';
    if (weather.rain >= 20) detail += ' · ' + weather.rain + '% rain';
    else if (Math.abs(feels - Math.round(weather.temperature)) >= 4) detail += ' · Feels like ' + feels + '°';
    $('now-detail').textContent = detail + (weather.stale ? ' · not updating' : '');
  }
  function forecastFor(day) {
    var key = iso(day), found = null;
    if (weather && weather.days) weather.days.forEach(function (d) { if (d.date === key) found = d; });
    return found;
  }

  /* ---------- Items ---------- */
  function calendarOf(id) { var found = null; (cal ? cal.calendars : []).forEach(function (c) { if (c.id === id) found = c; }); return found || { name: 'Calendar', color: '#7f8aa3' }; }
  // Everything that belongs to one day, in the order a glance needs it: all-day events (compact), then anything with
  // a time, then chores due that day, then overdue chores. `today` drops events that are already over.
  function itemsFor(day, today) {
    var next = addDays(day, 1), list = [], t = now();
    (cal ? cal.events : []).forEach(function (e) {
      var start = parse(e.start), end = parse(e.end);
      if (!(start < next && end > day)) return;
      // A timed event belongs to the day it starts; only one that runs a full day or longer spills onto the next.
      if (!e.allDay && start < day && end - start < 86400000) return;
      if (today && !e.allDay && end <= t) return;
      var spans = e.allDay || start < day || end - start >= 86400000;
      var lastDay = e.allDay ? addDays(end, -1) : startOfDay(end);
      list.push({ kind: 'event', event: e, allDay: spans, at: start < day ? day : start, end: end, continues: start < day, through: spans && lastDay > day ? lastDay : null, rank: spans ? 0 : 1 });
    });
    (tasks ? tasks.tasks : []).forEach(function (task) {
      if (!task.due) return;
      var due = parse(task.due), timed = hasTime(task.due), overdue = today && due < day;
      if ((due >= day && due < next) || overdue) list.push({ kind: 'task', task: task, allDay: !timed || overdue, at: due, overdue: overdue, rank: overdue ? 3 : timed ? 1 : 2 });
    });
    list.sort(function (a, b) { return a.rank - b.rank || a.at - b.at; });
    // One row, at most, says how soon: the next timed thing, when it is within three hours. Every row saying it was a
    // column of arithmetic; one row saying it is the answer to "do I need to move?".
    if (today) for (var i = 0; i < list.length; i++) if (!list[i].allDay && list[i].at > t && relative(list[i].at)) { list[i].next = true; break; }
    return list;
  }
  // The first event or dated chore on or after `from`, within the loaded window.
  function upNext(from) {
    for (var d = from, end = parse(cal.to); d < end; d = addDays(d, 1)) { var items = itemsFor(d, false); if (items.length) return items[0]; }
    return null;
  }
  function relative(at) {
    var mins = Math.round((at - now()) / 60000);
    if (mins <= 0 || mins > 180) return '';
    if (mins < 60) return 'in ' + mins + ' min';
    return 'in ' + Math.floor(mins / 60) + ' hr' + (mins % 60 >= 5 ? ' ' + (mins % 60) + ' min' : '');
  }
  var LEADING_EMOJI = /^((?:[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2190-\u2BFF\u2600-\u27BF\u3030\uFE0F])+)\s*/;
  // A row is a meta line over a title. The meta line holds one fact, when: a time ("4 PM"), a span ("Through Friday") or
  // a state that stands for a time ("Overdue"). It opens with that fact on every row, so the left edge of a day reads as a
  // column of times from across the room; a place may trail the time, and nothing else may. Whose it is goes after the
  // title as a monogram, and a date the section already implies is never repeated.
  function itemNode(item, inToday) {
    var el = node('button', 'item ' + item.kind), body = node('span', 'item-body'), meta = '', note = '', emoji = '';
    if (item.kind === 'event') {
      var c = calendarOf(item.event.calendar);
      el.style.setProperty('--rail', c.color);
      // A private event is the time it takes and nothing else: set in its calendar's colour, so it reads as taken
      // rather than as an event called "Busy".
      if (item.event.busy) el.className += ' busy';
      if (item.allDay) {
        // All-day and multi-day events are one line: they frame the day rather than fill it.
        el.className += ' allday' + (item.continues ? ' continues' : '');
        // Today's panel says how long a trip runs; the week's columns show it by repeating it, dimmed, on each day.
        if (item.through && inToday) meta = 'Through ' + DAYS[item.through.getDay()];
      } else {
        meta = clockTime(item.at);
        if (inToday) {
          if (item.at <= now()) { meta = 'Now, until ' + clockTime(item.end); el.className += ' happening'; }
          else if (item.next) meta += ' · ' + relative(item.at);
          if (item.event.location) meta += ' · ' + item.event.location.split(/\n|,/)[0];
        }
      }
      el.onclick = function () { openEvent(item.event, el); };
    } else {
      var done = !!pending[item.task.id];
      el.insertBefore(node('span', 'check'), null);
      el.setAttribute('role', 'checkbox'); el.setAttribute('aria-checked', String(done));
      if (done) el.className += ' done';
      // Under Today the day is given, so an overdue chore says only that it is; its date is in the list view.
      if (item.overdue) { el.className += ' overdue'; meta = 'Overdue'; }
      else if (!item.allDay) { meta = clockTime(item.at); if (inToday && item.next) meta += ' · ' + relative(item.at); }
      var owner = listOf(item.task.project);
      if (owner.person && owner.color) el.style.setProperty('--tick', owner.color);
      el.onclick = function () { toggleTask(item.task); };
    }
    if (meta) body.appendChild(node('span', 'item-meta', meta));
    var text = item.kind === 'event' ? item.event.title : cleanTitle(item.task.title);
    if (item.kid) { var lead = LEADING_EMOJI.exec(text); if (lead) { emoji = lead[1]; text = text.slice(lead[0].length); } }
    if (emoji) el.appendChild(node('span', 'kid-emoji', emoji));
    var title = node('span', 'item-title', text);
    if (note) title.appendChild(node('span', 'item-note', ' · ' + note));
    // Whose: a person's list outside that list, then an assignee, each as the monogram their list carries.
    if (item.kind === 'task') {
      var who = assigneeMark(item.task);
      if (!item.inList && owner.person && !(who && who.title === owner.name)) title.appendChild(personMark(owner.name, owner.color, 'On ' + owner.name + '’s list'));
      if (who) title.appendChild(who);
    }
    body.appendChild(title);
    el.appendChild(body);
    return el;
  }
  // Shows as many whole items as fit in `box`, then "and N more" (a button when there is somewhere to go).
  // Nothing is ever cut mid-line. Skipped while the box is hidden, since a hidden box measures zero.
  function fitItems(box, nodes, onMore) {
    box.textContent = '';
    for (var i = 0; i < nodes.length; i++) box.appendChild(nodes[i]);
    if (!box.clientHeight || box.scrollHeight <= box.clientHeight + 2) return nodes.length;
    var more = node(onMore ? 'button' : 'p', 'more'), shown = nodes.length;
    if (onMore) more.onclick = onMore;
    box.appendChild(more);
    do { shown--; box.removeChild(nodes[shown]); more.textContent = (nodes.length - shown) + ' more'; } while (shown > 0 && box.scrollHeight > box.clientHeight + 2);
    return shown;
  }
  // Todoist titles may carry markdown links; show the words, not the syntax.
  function cleanTitle(title) { return tidy(title.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|__/g, '')); }
  // A list is marked by what it is: a household list by a glyph, a person's list by their monogram in their color.
  var GLYPHS = {
    home: ['M4 10.5 12 4l8 6.5', 'M6 9v10.5h12V9', 'M10 19.5v-5h4v5'],
    sparkles: ['M10.5 3.5c.7 4.2 2.3 5.8 6.5 6.5-4.2.7-5.8 2.3-6.5 6.5-.7-4.2-2.3-5.8-6.5-6.5 4.2-.7 5.8-2.3 6.5-6.5z', 'M18.5 14.5c.35 1.8 1 2.45 2.75 2.75-1.75.3-2.4.95-2.75 2.75-.35-1.8-1-2.45-2.75-2.75 1.75-.3 2.4-.95 2.75-2.75z'],
    cart: ['M2.5 4h2.6l2.3 10.5h10.2L20 7.5H6', 'M8 19.5a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0', 'M15 19.5a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0'],
    repeat: ['M17 2.5l3 3-3 3', 'M4 11.5v-1a5 5 0 0 1 5-5h11', 'M7 21.5l-3-3 3-3', 'M20 12.5v1a5 5 0 0 1-5 5H4'],
    suitcase: ['M4 8h16v11H4z', 'M9 8V5.5h6V8', 'M9 8v11M15 8v11'],
    list: ['M9.5 6.5h10M9.5 12h10M9.5 17.5h10', 'M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01']
  };
  function listOf(name) {
    var found = (tasks && tasks.lists || []).filter(function (l) { return l.name === name; })[0];
    return found || { name: name, icon: 'list', person: false, color: '' };
  }
  // A person, as their initial in the color their calendar uses: the mark their own list carries.
  function personMark(name, color, label) {
    var a = node('span', 'avatar', name.charAt(0).toUpperCase());
    if (color) a.style.backgroundColor = color;
    a.setAttribute('title', name); a.setAttribute('aria-label', label);
    return a;
  }
  function assigneeMark(task) {
    var who = task.assignee && tasks && tasks.people && tasks.people[task.assignee];
    return who ? personMark(who.name, who.color, 'Assigned to ' + who.name) : null;
  }
  function listMark(name) {
    var l = listOf(name), svg;
    if (l.person) { var a = node('span', 'avatar', l.name.charAt(0).toUpperCase()); if (l.color) a.style.backgroundColor = l.color; a.setAttribute('aria-hidden', 'true'); return a; }
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'glyph'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    (GLYPHS[l.icon] || GLYPHS.list).forEach(function (d) { var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); svg.appendChild(p); });
    return svg;
  }
  // Typed titles mix straight and curly apostrophes ("Sam's", "Sam’s"); at wall size the difference shows.
  function tidy(text) { return String(text || '').replace(/(\w)'/g, '$1\u2019').replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/g, ''); }

  /* ---------- Render ---------- */
  // The left panel is the same in every view: the day, the clock, the weather, today, and tomorrow. Today always gets
  // the room it needs; tomorrow gets what is left, and both end in "and N more" rather than a clipped line.
  function renderToday() {
    var t = now(), today = startOfDay(t), h = t.getHours(), tomorrowDay = addDays(today, 1);
    $('today-weekday').textContent = DAYS[t.getDay()];
    $('today-date').textContent = MONTHS[t.getMonth()] + ' ' + t.getDate();
    $('clock').textContent = (h % 12 || 12) + ':' + pad(t.getMinutes());
    $('ampm').textContent = h < 12 ? 'AM' : 'PM';
    var sun = sunTimes(t), tomorrowSky = forecastFor(tomorrowDay), line = '';
    if (weather && !query.now) line = t.getTime() < sun.rise ? 'Sunrise ' + clockTime(new Date(sun.rise)) : t.getTime() < sun.set ? 'Sunset ' + clockTime(new Date(sun.set)) : tomorrowSky ? 'Sunrise tomorrow ' + clockTime(houseTime(tomorrowSky.sunrise)) : '';
    $('sun-line').textContent = line;

    // The nearest thing the household is counting down to: one line, set before the lists are fitted so they
    // give it the room. "Sleeps" is nights still to sleep, which is the same number as days.
    var counting = '';
    for (var ci = 0; ci < countdowns.length && !counting; ci++) {
      var left = Math.round((parse(countdowns[ci].date) - today) / 86400000);
      if (left === 0) counting = 'Today: ' + countdowns[ci].name;
      else if (left > 0) counting = left + ' ' + (countdowns[ci].word === 'days' ? (left === 1 ? 'day' : 'days') : (left === 1 ? 'sleep' : 'sleeps')) + ' until ' + countdowns[ci].name;
    }
    $('countdown').textContent = counting; $('countdown').hidden = !counting;

    // Tomorrow appears only when all of today fits; on a packed day today gets the whole panel.
    var todayItems = itemsFor(today, true), list = $('today-list'), allToday = true;
    $('tomorrow').hidden = true;
    if (!todayItems.length) {
      list.textContent = '';
      list.appendChild(node('p', 'today-empty', cal ? (itemsFor(today, false).length ? 'Nothing else today' : 'Nothing planned') : unpaired ? 'Not set up yet' : calProblem ? 'Can’t reach the calendar' : ''));
    } else allToday = fitItems(list, todayItems.map(function (item) { return itemNode(item, true); }), function () { openDay(today); }) === todayItems.length;
    // An empty tomorrow is not shown: "Nothing planned" twice says nothing. When today and tomorrow are both empty, the
    // space answers the next question instead: what is the next thing actually planned?
    var coming = cal && allToday ? itemsFor(tomorrowDay, false) : [], label = 'Tomorrow', onMore = function () { openDay(tomorrowDay); };
    if (!coming.length && cal && !todayItems.length) { var next = upNext(addDays(today, 2)); if (next) { coming = [next]; label = 'Up next'; } }
    if (!coming.length) return;
    $('tomorrow-label').textContent = label; $('tomorrow').hidden = false;
    var nodes = coming.map(function (item) {
      var el = itemNode(item, false);
      if (label === 'Up next') { var meta = el.querySelector('.item-meta') || el.lastChild.insertBefore(node('span', 'item-meta'), el.lastChild.firstChild); meta.textContent = shortDay(item.at) + (item.allDay ? '' : ' · ' + clockTime(item.at)); }
      return el;
    });
    if (!fitItems($('tomorrow-list'), nodes, onMore)) $('tomorrow').hidden = true;
  }
  function renderStrip() {
    $('view-calendar').className = 'view' + (cal && !firstRun ? '' : ' no-calendar');
    if (firstRun) {
      // A tablet that is its own server, not yet looked after by anyone: say how to become that person.
      var intro = node('div', 'loading pairing');
      intro.appendChild(node('p', 'loading-title', 'Set up from a phone'));
      intro.appendChild(node('p', '', 'On the same Wi-Fi, open this address and enter the code.'));
      // The name is kinder to type; the numbers always work, and older Android phones need them.
      var plain = (firstRun.address || location.origin).replace(/^https?:\/\//, '') + '/setup';
      intro.appendChild(node('p', 'pair-address', firstRun.named ? firstRun.named.replace(/^https?:\/\//, '') + '/setup' : plain));
      if (firstRun.named) intro.appendChild(node('p', 'pair-or', 'or ' + plain));
      intro.appendChild(node('p', 'pair-code', firstCode ? firstCode.code : '··· ···'));
      intro.appendChild(node('p', 'pair-host', 'Your calendar links and tokens stay on this tablet.'));
      $('strip').textContent = ''; $('strip').appendChild(intro); $('later').hidden = true;
      $('month').textContent = 'Welcome'; return;
    }
    if (!cal) {
      // The failure could be the server, the network or the calendar's provider, and the frame cannot tell which, so it names none of them.
      var note = node('div', 'loading'); note.appendChild(node('p', 'loading-title', unpaired ? 'This frame isn’t set up yet' : calProblem ? 'Can’t reach the calendar' : 'Loading the calendar…'));
      if (unpaired) {
        note.className = 'loading pairing';
        note.appendChild(node('p', '', 'Enter this code on your household’s setup page, or give it to whoever looks after your frames.'));
        note.appendChild(node('p', 'pair-code', pairing ? pairing.code : '··· ···'));
        note.appendChild(node('p', 'pair-host', location.host));
      }
      else if (calProblem) note.appendChild(node('p', '', 'Trying again every minute'));
      $('strip').textContent = ''; $('strip').appendChild(note); $('later').hidden = true;
      $('month').textContent = MONTHS[addDays(startOfDay(now()), 1).getMonth()]; return;
    }
    var today = startOfDay(now()), first = addDays(today, 1 + page * STRIP_DAYS), last = addDays(first, STRIP_DAYS - 1);
    var strip = $('strip'), busiest = 0, columns = []; strip.textContent = '';
    $('month').textContent = MONTHS[first.getMonth()] + (first.getMonth() !== last.getMonth() ? ' – ' + MONTHS[last.getMonth()] : '');
    for (var i = 0; i < STRIP_DAYS; i++) {
      var d = addDays(first, i), col = node('section', 'day' + (d.getDay() % 6 === 0 ? ' weekend' : ''));
      col.setAttribute('aria-label', DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate());
      // The weekday as an eyebrow over the date, as in Apple's calendar widget.
      var name = node('p', 'day-name');
      name.appendChild(node('span', 'eyebrow', page === 0 && i === 0 ? 'Tomorrow' : DAYS[d.getDay()].slice(0, 3)));
      name.appendChild(node('b', '', String(d.getDate()))); col.appendChild(name);
      var fc = forecastFor(d), row = node('div', 'forecast');
      if (fc) {
        // The chance of rain sits under the icon, where weather apps put it, so a wet day never overflows the row.
        var wx = node('span', 'wx'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'wx-icon'); svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('aria-hidden', 'true');
        drawIcon(svg, fc.code); wx.appendChild(svg);
        if (fc.rain >= 30) wx.appendChild(node('small', '', fc.rain + '%'));
        row.appendChild(wx);
        row.appendChild(node('b', '', Math.round(fc.high) + '°')); row.appendChild(node('span', '', Math.round(fc.low) + '°'));
        row.setAttribute('aria-label', describe(fc.code) + ', high ' + Math.round(fc.high) + ', low ' + Math.round(fc.low) + (fc.rain >= 30 ? ', ' + fc.rain + ' percent chance of rain' : ''));
      }
      col.appendChild(row);
      var items = node('div', 'day-items'), dayItems = itemsFor(d, false); busiest = Math.max(busiest, dayItems.length);
      col.appendChild(items); strip.appendChild(col);
      columns.push({ box: items, items: dayItems, day: d });
    }
    $('previous').disabled = page === 0;
    $('next').disabled = (page + 2) * STRIP_DAYS + 1 > WINDOW_DAYS;
    $('back-today').hidden = page === 0;
    renderLater(addDays(last, 1), busiest);
    // Fit the columns only now: the Later rows below take height from the week, so measuring earlier would overflow.
    columns.forEach(function (c) { fitItems(c.box, c.items.map(function (item) { return itemNode(item, false); }), function () { openDay(c.day); }); });
  }
  // Past the strip, only what is actually planned, one line per distinct thing (a weekly event
  // shows its next occurrence, not four of them).
  function renderLater(from, busiest) {
    var rows = [], seen = {}, windowEnd = parse(cal.to), room = busiest <= 3 ? 6 : busiest <= 5 ? 4 : 3;
    cal.events.forEach(function (e) { var at = parse(e.start); if (at >= from) rows.push({ at: at, title: e.title, allDay: e.allDay, event: e }); });
    (tasks ? tasks.tasks : []).forEach(function (t) { if (t.due && parse(t.due) >= from && parse(t.due) < windowEnd) rows.push({ at: parse(t.due), title: cleanTitle(t.title), allDay: !hasTime(t.due), task: t }); });
    rows.sort(function (a, b) { return a.at - b.at; });
    rows = rows.filter(function (r) { if (seen[r.title]) return false; seen[r.title] = true; return true; });
    var box = $('later-rows'); box.textContent = ''; $('later').hidden = false;
    rows.slice(0, room).forEach(function (r) {
      var row = node('button', 'later-row'), dot = node('i', r.task ? 'ring' : '');
      var owner = r.task ? listOf(r.task.project) : null, what = node('span', 'what');
      if (r.event) dot.style.backgroundColor = calendarOf(r.event.calendar).color;
      else if (owner.person && owner.color) dot.style.borderColor = owner.color;
      row.appendChild(dot);
      row.appendChild(node('span', 'when', shortDay(r.at))); row.appendChild(node('span', 'time', r.allDay ? '' : clockTime(r.at)));
      if (owner && owner.person) what.appendChild(node('span', 'owner', owner.name + ' · '));
      what.appendChild(document.createTextNode(r.title)); row.appendChild(what);
      row.onclick = r.event ? function () { openEvent(r.event, row); } : function () { setMode('list:' + r.task.project); };
      box.appendChild(row);
    });
    var through = addDays(windowEnd, -1), until = MONTHS[through.getMonth()].slice(0, 3) + ' ' + through.getDate();
    if (!rows.length) box.appendChild(node('p', 'later-note', 'Nothing else planned through ' + until));
    else if (rows.length > room) box.appendChild(node('p', 'later-note', (rows.length - room) + ' more through ' + until));
  }
  function renderLegend() {
    var legend = $('legend'); legend.textContent = '';
    (cal ? cal.calendars : []).forEach(function (c) { var s = node('span', '', c.name), dot = node('i'); dot.style.backgroundColor = c.color; s.insertBefore(dot, s.firstChild); legend.appendChild(s); });
  }
  function renderTabs() {
    var tabs = $('tabs');
    while (tabs.children.length > 1) tabs.removeChild(tabs.lastChild);
    $('tab-calendar').setAttribute('aria-pressed', String(mode === 'calendar'));
    (tasks ? tasks.projects : []).forEach(function (project) {
      var count = tasks.tasks.filter(function (t) { return t.project === project && !pending[t.id]; }).length;
      var style = listOf(project), b = node('button', 'list-tab' + (style.person || GLYPHS[style.icon] && style.icon !== 'list' ? ' marked' : '')); b.appendChild(listMark(project)); b.appendChild(node('span', 'label', project)); b.appendChild(node('b', '', String(count)));
      b.setAttribute('aria-label', project + ', ' + count + (count === 1 ? ' item' : ' items'));
      b.setAttribute('aria-pressed', String(mode === 'list:' + project));
      b.onclick = function () { setMode(mode === 'list:' + project ? 'calendar' : 'list:' + project); };
      tabs.appendChild(b);
    });
    // Photos is a view like the lists, so it lives in the same row with its count.
    if (photos.length) {
      var p = node('button', '', 'Photos');
      p.setAttribute('aria-pressed', String(mode === 'photos'));
      p.onclick = function () { setMode(mode === 'photos' ? 'calendar' : 'photos'); };
      tabs.appendChild(p);
    }
    // More lists than the dock can hold: a list whose mark already says which it is keeps only mark and count; the open
    // list, and any list with the plain glyph, keep their names.
    tabs.className = 'tabs';
    if (tabs.scrollWidth + $('settings-button').offsetWidth + 24 > tabs.parentNode.clientWidth) tabs.className = 'tabs compact';
  }
  function renderList() {
    if (mode.indexOf('list:') !== 0 || !tasks) return;
    var project = mode.slice(5), body = $('list-body'), groups = {}, order = [], style = listOf(project);
    var items = tasks.tasks.filter(function (t) { return t.project === project; });
    var heading = $('list-title'); heading.textContent = ''; heading.appendChild(listMark(project)); heading.appendChild(document.createTextNode(project));
    // The subhead says what the list is for, from its Todoist description; a stale list says so instead.
    $('list-status').textContent = tasksProblem || tasks.stale ? 'Can’t refresh this list. It is from ' + clockTime(houseTime(tasks.updatedAt)) + '.' : listOf(project).description || 'Tap to check off';
    body.textContent = ''; body.className = 'list-body' + (style.kid ? ' kid' : '');
    // The card scrolls; the columns inside it grow with the list, so nothing can end up in a column off to the side.
    var columns = node('div', 'list-columns');
    body.appendChild(columns);
    // Todoist's own order, grouped by its sections: a grocery list reads aisle by aisle.
    items.forEach(function (t) { var key = t.section || ''; if (!groups[key]) { groups[key] = []; order.push(key); } groups[key].push(t); });
    order.forEach(function (key) {
      var group = node('div', key ? 'group named' : 'group'); if (key) group.appendChild(node('h3', '', key));
      groups[key].forEach(function (t) {
        var meta = [], due = t.due ? parse(t.due) : null;
        if (due) meta.push((due < startOfDay(now()) ? 'Overdue since ' : '') + shortDay(due) + (hasTime(t.due) ? ' · ' + clockTime(due) : '') + (t.recurring ? ' · repeats' : ''));
        if (t.labels) meta.push(t.labels);
        var el = itemNode({ kind: 'task', task: t, allDay: true, at: due, inList: true, kid: style.kid }, false);
        if (meta.length) el.lastChild.appendChild(node('span', 'item-meta', meta.join(' · ')));
        group.appendChild(el);
      });
      columns.appendChild(group);
    });
    if (!items.length) {
      var empty = node('p', 'list-empty', 'Nothing on this list');
      // Said where it is needed and only while it is: how a picture gets onto a row of a young child's list.
      if (style.kid) empty.appendChild(node('span', 'list-empty-hint', 'Start an item with an emoji, like “🦷 Brush teeth”, and it becomes the picture here.'));
      columns.appendChild(empty);
    }
    // One column reads best, so a list spreads into two, then three, only when it would otherwise scroll.
    if (body.scrollHeight > body.clientHeight + 2) columns.className = 'list-columns two';
    if (body.scrollHeight > body.clientHeight + 2) columns.className = 'list-columns three';
    // An item whose follower starts a new column ends that column, so it drops its divider too.
    var rows = columns.querySelectorAll('.item');
    for (var r = 0; r < rows.length - 1; r++) if (rows[r + 1].offsetLeft > rows[r].offsetLeft + 2) rows[r].className += ' column-end';
    fadeIfScrolls(body);
  }
  // A scrolling list fades at the bottom until it has been scrolled to the end, so "there is more" is visible.
  function fadeIfScrolls(box) {
    var more = box.scrollHeight - box.clientHeight - box.scrollTop > 4;
    box.className = box.className.replace(/ ?has-more/g, '') + (more ? ' has-more' : '');
  }
  function renderNotice() {
    var text = '';
    if (calProblem || (cal && cal.stale)) text = cal ? 'Can’t refresh the calendar. Showing it from ' + clockTime(houseTime(cal.updatedAt)) + ' and retrying every minute.' : 'Can’t reach the calendar. Trying again every minute.';
    // With no calendar at all the card itself says so; the notice is for a calendar that is showing stale data.
    $('notice').textContent = text; $('notice').hidden = !text || !cal || mode !== 'calendar';
    var updated = function (at, stuck) { return 'Updated ' + clockTime(houseTime(at)) + (stuck ? ', not updating now' : ''); };
    $('status-calendar').textContent = cal ? updated(cal.updatedAt, cal.stale || calProblem) : 'Not loaded yet';
    $('status-tasks').textContent = tasks ? updated(tasks.updatedAt, tasks.stale || tasksProblem) : 'Not loaded yet';
    $('status-weather').textContent = weather ? 'Open-Meteo, updated ' + clockTime(houseTime(weather.fetchedAt)) + (weather.stale ? ', not updating now' : '') : 'Not loaded yet';
    $('status-photos').textContent = !photoInfo.configured ? 'No album connected' : !photos.length ? 'The album is empty' : photos.length + ' photos' + (photoInfo.syncedAt ? ', updated ' + clockTime(houseTime(photoInfo.syncedAt)) : '') + (photoInfo.error ? ', can’t reach the album now' : '');
  }
  function render() { paintSky(); renderNow(); renderToday(); renderLegend(); renderStrip(); renderTabs(); renderList(); renderNotice(); }

  /* ---------- Modes ---------- */
  function setMode(next) {
    if (next === 'photos' && !photos.length) next = 'calendar';
    var leaving = mode;
    mode = next;
    $('view-calendar').hidden = mode !== 'calendar'; $('view-list').hidden = mode.indexOf('list:') !== 0;
    $('view-photos').hidden = mode !== 'photos'; $('view-settings').hidden = mode !== 'settings';
    $('settings-button').setAttribute('aria-pressed', String(mode === 'settings'));
    if (mode === 'settings') fadeIfScrolls(document.querySelector('.settings-card'));
    if (mode === 'photos' && leaving !== 'photos') startSlides();
    if (mode !== 'photos' && leaving === 'photos') stopSlides();
    render();
  }

  /* ---------- Settings ---------- */
  var CHOICES = {
    rest: [['photos', 'Photos'], ['calendar', 'This week']],
    restAfter: [[2, '2 min'], [5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min']],
    mornings: [[0, 'Off'], [8, 'Until 8 AM'], [9, 'Until 9 AM'], [10, 'Until 10 AM']],
    photoEvery: [[30, '30 sec'], [60, '1 min'], [120, '2 min'], [300, '5 min']],
    appearance: [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']],
    screen: [['auto', 'With the sun'], ['bright', 'Bright'], ['dim', 'Dim']]
  };
  function renderSettings() {
    var groups = document.querySelectorAll('[data-setting]');
    for (var i = 0; i < groups.length; i++) (function (box) {
      var key = box.getAttribute('data-setting');
      box.textContent = '';
      CHOICES[key].forEach(function (choice) {
        var b = node('button', '', choice[1]);
        b.setAttribute('aria-pressed', String(prefs[key] === choice[0]));
        b.onclick = function () { saveSetting(key, choice[0]); };
        box.appendChild(b);
      });
    })(groups[i]);
    renderRepair();
  }
  // Fixing the frame at the wall, so nobody needs a computer for the usual trouble. Reloading always works; restarting
  // the browser or the frame needs Fully Kiosk's website integration (Settings → Advanced Web Settings), and those
  // buttons stay hidden until it is on. Unplugging the frame is the last resort and always works.
  function renderRepair() {
    var box = $('repair'), bridge = typeof fully === 'object' && fully, actions = [['Reload', function () { location.reload(); }]];
    if (bridge && fully.restartApp) actions.push(['Restart browser', function () { fully.restartApp(); }]);
    if (bridge && fully.rebootDevice) actions.push(['Restart frame', function () { fully.rebootDevice(); }]);
    box.textContent = '';
    actions.forEach(function (action) {
      var b = node('button', '', action[0]);
      if (action[0] === 'Reload') { b.onclick = action[1]; box.appendChild(b); return; }
      // Second tap confirms a restart, so a passing hand never does one.
      b.onclick = function () {
        if (b.getAttribute('aria-pressed') === 'true') { b.setAttribute('aria-pressed', 'false'); action[1](); return; }
        for (var i = 0; i < box.children.length; i++) box.children[i].setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true'); b.textContent = 'Tap again to confirm';
        setTimeout(function () { b.setAttribute('aria-pressed', 'false'); b.textContent = action[0]; }, 6000);
      };
      box.appendChild(b);
    });
    $('repair-note').textContent = bridge ? 'Still stuck? Unplug it.' : 'Unplug the frame and plug it back in to fix the rest.';
  }
  // Adding to a list at the wall, whichever kind of list it is. The dialog sits at the top of the screen so the
  // keyboard, which takes the bottom half of a wall display, never covers what is being typed; it stays open,
  // because a grocery list is rarely one thing.
  function openAdd() {
    if (mode.indexOf('list:') !== 0) return;
    $('add-title').textContent = 'Add to ' + mode.slice(5); $('add-note').textContent = ''; $('add-input').value = '';
    $('add-dialog').hidden = false; $('add-input').focus();
  }
  function submitAdd() {
    var title = $('add-input').value.replace(/^\s+|\s+$/g, ''); if (!title) return;
    $('add-go').disabled = true;
    post('/api/tasks', { list: mode.slice(5), title: title }, function (status, data) {
      $('add-go').disabled = false;
      if (status !== 200) { $('add-note').textContent = data.error || 'Can’t add that right now. Try again.'; return; }
      $('add-input').value = ''; $('add-note').textContent = 'Added “' + title + '”'; loadTasks(); $('add-input').focus();
    });
  }
  function closeAdd() { $('add-dialog').hidden = true; if ($('add-input').blur) $('add-input').blur(); }
  // The way back in. Someone standing at the frame, who knows the household's PIN, gets a code; the phone that types
  // it at /setup becomes one that can manage the household. The keypad is drawn here so that no system keyboard ever
  // slides up over a wall display.
  var pinSoFar = '';
  function drawPin() { var dots = ''; for (var i = 0; i < pinSoFar.length; i++) dots += '●'; $('pin-dots').textContent = dots || ' '; }
  function openManage() {
    pinSoFar = ''; drawPin();
    $('manage-title').textContent = 'Enter the household PIN'; $('manage-note').textContent = 'Set on your household’s setup page.';
    $('keypad').hidden = false; $('pin-dots').hidden = false; $('manage-code').hidden = true;
    var pad = $('keypad'); pad.textContent = '';
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'].forEach(function (key) {
      var b = node('button', key === 'OK' ? 'key go' : 'key', key);
      b.onclick = function () {
        if (key === '⌫') pinSoFar = pinSoFar.slice(0, -1);
        else if (key === 'OK') { askForCode(); return; }
        else if (pinSoFar.length < 8) pinSoFar += key;
        drawPin();
      };
      pad.appendChild(b);
    });
    $('manage-dialog').hidden = false;
  }
  function askForCode() {
    if (pinSoFar.length < 4) { $('manage-note').textContent = 'A PIN is at least four digits.'; return; }
    post('/api/owner-code', { pin: pinSoFar }, function (status, data) {
      pinSoFar = ''; drawPin();
      if (status !== 200) { $('manage-note').textContent = data.error || 'Can’t reach the server. Try again.'; return; }
      $('manage-title').textContent = 'On your phone, open ' + location.host + '/setup';
      $('manage-note').textContent = 'Enter this code there. It works once, for ten minutes.';
      $('keypad').hidden = true; $('pin-dots').hidden = true;
      $('manage-code').textContent = data.code; $('manage-code').hidden = false;
    });
  }
  function closeManage() { $('manage-dialog').hidden = true; pinSoFar = ''; $('manage-code').textContent = ''; }
  function applyPrefs() {
    themeChoice = prefs.appearance; paintSky();
    if (mode === 'photos') restartSlideTimer();
    renderSettings();
  }
  // A tap applies at once and saves in the background; if the server cannot be reached the choice is put back.
  function saveSetting(key, value) {
    var before = prefs[key];
    prefs[key] = value; applyPrefs();
    var xhr = new XMLHttpRequest(), change = {}; change[key] = value;
    xhr.open('POST', '/api/settings'); xhr.timeout = 15000;
    xhr.setRequestHeader('X-Gingham', '1'); xhr.setRequestHeader('Content-Type', 'application/json');
    function failed() { prefs[key] = before; applyPrefs(); toast('Couldn’t save that setting. The frame’s server isn’t answering.', false); }
    xhr.onload = function () { if (xhr.status === 200) { try { prefs = JSON.parse(xhr.responseText); } catch (e) {} applyPrefs(); } else failed(); };
    xhr.onerror = xhr.ontimeout = failed; xhr.send(JSON.stringify(change));
  }
  function loadSettings() { get('/api/settings', function (data) { if (data.rest) { prefs = data; applyPrefs(); } }, function () {}); }
  // Where the frame settles when no one is using it: the week on a morning if that is set, otherwise the chosen view.
  function restingView() {
    var hour = now().getHours(), morning = prefs.mornings && hour >= 4 && hour < prefs.mornings;
    return prefs.rest === 'photos' && photos.length && !morning && !query.nophotos ? 'photos' : 'calendar';
  }

  /* ---------- Checking things off ---------- */
  // A tap marks the chore done at once but nothing is sent for six seconds, so Undo is a true undo
  // even for repeating chores (which Todoist cannot un-complete back to the same date).
  function toggleTask(task) {
    if (pending[task.id]) { if (undo && undo.task.id === task.id) cancelUndo(); return; }
    if (undo) commit();
    pending[task.id] = true;
    undo = { task: task, timer: setTimeout(commit, UNDO_MS) };
    if (listOf(task.project).kid) cheer();
    toast('Checked off “' + cleanTitle(task.title) + '”', true);
    render();
  }
  var CHEERS = ['🎉', '⭐️', '🚀', '🦖', '🏆'], cheerTimer = null;
  function cheer() {
    var el = $('cheer');
    el.textContent = CHEERS[Math.floor(Math.random() * CHEERS.length)];
    el.className = 'cheer on'; clearTimeout(cheerTimer);
    cheerTimer = setTimeout(function () { el.className = 'cheer'; }, 1100);
  }
  function cancelUndo() { clearTimeout(undo.timer); delete pending[undo.task.id]; undo = null; $('toast').hidden = true; render(); }
  function commit() {
    var task = undo.task; clearTimeout(undo.timer); undo = null; $('toast').hidden = true;
    var xhr = new XMLHttpRequest(); xhr.open('POST', '/api/tasks/' + encodeURIComponent(task.id) + '/close'); xhr.timeout = 45000;
    xhr.setRequestHeader('X-Gingham', '1');
    function failed() { delete pending[task.id]; toast('Couldn’t check that off. “' + cleanTitle(task.title) + '” is still on the list.', false); render(); }
    xhr.onload = function () { if (xhr.status === 200 || xhr.status === 404) loadTasks(function () { delete pending[task.id]; }); else failed(); };
    xhr.onerror = xhr.ontimeout = failed; xhr.send();
  }
  var toastTimer = null;
  function toast(text, canUndo) {
    $('toast-text').textContent = text; $('toast-undo').hidden = !canUndo; $('toast').hidden = false;
    clearTimeout(toastTimer); if (!canUndo) toastTimer = setTimeout(function () { $('toast').hidden = true; }, 6000);
  }

  /* ---------- Event detail ---------- */
  function openEvent(event, from) {
    previousFocus = from; var c = calendarOf(event.calendar), start = parse(event.start), end = parse(event.end), when;
    if (event.allDay) { var lastDay = addDays(end, -1); when = shortDay(start) + (sameDay(start, lastDay) ? ', all day' : ' to ' + shortDay(lastDay)); }
    else when = shortDay(start) + ', ' + clockTime(start) + ' to ' + (sameDay(start, end) ? '' : shortDay(end) + ', ') + clockTime(end);
    var label = $('event-calendar'), dot = node('i'); dot.style.backgroundColor = c.color; label.textContent = c.name; label.insertBefore(dot, label.firstChild);
    $('event-title').textContent = event.title; $('event-title').className = event.title.length > 60 ? 'long' : ''; $('event-time').textContent = when; $('event-location').textContent = event.location || '';
    $('event-dialog').hidden = false; $('close-dialog').focus();
  }
  function closeEvent() { $('event-dialog').hidden = true; if (previousFocus && document.body.contains(previousFocus)) previousFocus.focus(); }

  /* ---------- Day sheet ---------- */
  // Everything on one day, reached from any "and N more".
  function openDay(day) {
    var isToday = sameDay(day, now()), list = $('day-list');
    var isTomorrow = sameDay(day, addDays(startOfDay(now()), 1));
    $('day-eyebrow').textContent = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : DAYS[day.getDay()];
    $('day-title').textContent = (isToday || isTomorrow ? DAYS[day.getDay()] + ', ' : '') + MONTHS[day.getMonth()] + ' ' + day.getDate();
    list.textContent = '';
    itemsFor(day, isToday).forEach(function (item) { list.appendChild(itemNode(item, isToday)); });
    $('day-dialog').hidden = false; list.scrollTop = 0; fadeIfScrolls(list); $('close-day').focus();
  }
  function closeDay() { $('day-dialog').hidden = true; }

  /* ---------- Photos ---------- */
  // Photos is a view on the right like the calendar and the lists: the left panel stays, and so does the dock.
  // After five quiet minutes the frame opens it on its own. Order is shuffled so nothing repeats until all have shown.
  function draw(deck) {
    if (!deck.items.length) {
      var a = photos.slice(), last = slideSeen[slideSeen.length - 1];
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), x = a[i]; a[i] = a[j]; a[j] = x; }
      if (last && a.length > 1 && a[a.length - 1].url === last.url) a.unshift(a.pop());
      deck.items = a;
    }
    return deck.items.pop();
  }
  function photoWhen(taken) {
    if (!taken) return '';
    var d = parse(taken), today = now();
    if (d.getMonth() === today.getMonth() && d.getDate() === today.getDate() && d.getFullYear() < today.getFullYear()) return 'This day in ' + d.getFullYear();
    return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }
  // step 1 is the next photo (new from the shuffle once history runs out), -1 goes back through what was shown.
  function showSlide(step) {
    if (!photos.length) return;
    var photo;
    if (step < 0) { if (slideAt <= 0) return; slideAt--; photo = slideSeen[slideAt]; }
    else if (slideAt < slideSeen.length - 1) { slideAt++; photo = slideSeen[slideAt]; }
    else { photo = draw(slideDeck); slideSeen.push(photo); if (slideSeen.length > 50) slideSeen.shift(); slideAt = slideSeen.length - 1; }
    var loader = new Image();
    loader.onload = function () {
      var back = slideFront === 'a' ? 'b' : 'a';
      $('slide-' + back).src = photo.url; $('slide-' + back).className = 'slide on'; $('slide-' + slideFront).className = 'slide';
      $('slide-fill').style.backgroundImage = 'url("' + photo.url + '")'; slideFront = back;
      $('photo-when').textContent = photoWhen(photo.taken);
      $('photo-prev').disabled = slideAt <= 0;
    };
    loader.src = photo.url;
  }
  function restartSlideTimer() { clearInterval(slideTimer); slideTimer = setInterval(function () { showSlide(1); }, prefs.photoEvery * 1000); }
  function startSlides() { showSlide(1); restartSlideTimer(); }
  function stopSlides() { clearInterval(slideTimer); slideTimer = null; }

  /* ---------- Data ---------- */
  function loadCalendar() {
    var today = startOfDay(now()), key = iso(today);
    get('/api/calendar?from=' + key + '&to=' + iso(addDays(today, WINDOW_DAYS)), function (data) {
      if (!data.events || !data.calendars) { calProblem = true; render(); return; }
      if (loadedDay !== key) page = 0;
      // Maps locations arrive as "Place\nStreet, City, State ZIP, Country": the panel shows the place, the dialog all of it.
      data.events.forEach(function (e) { e.title = tidy(e.title); e.location = tidy(e.location).replace(/,? *United States$/, ''); });
      cal = data; loadedDay = key; calProblem = false; render();
    }, function () { calProblem = true; if (cal && loadedDay !== key) cal = null; render(); });
  }
  function loadTasks(after) {
    get('/api/tasks', function (data) { if (data.tasks) { tasks = data; tasksProblem = false; } if (after) after(); render(); },
      function () { tasksProblem = true; if (after) after(); render(); });
  }
  function loadHousehold() {
    get('/api/household', function (data) {
      if (!data.timezone) return;
      var changed = data.timezone !== household.timezone;
      var wasNew = firstRun; firstRun = data.needsSetup ? { address: data.address || '', named: data.named || '' } : null;
      if (firstRun && !wasNew) firstRunStep();
      if (!firstRun && wasNew) { loadCalendar(); loadTasks(); loadWeather(); loadPhotos(); }
      household = { name: data.name || '', timezone: data.timezone, place: data.place || '' };
      countdowns = data.countdowns || []; renderToday();
      if (household.name) document.title = household.name;
      try { localStorage.setItem('frame.household', JSON.stringify(household)); } catch (e) {}
      if (changed) { location.reload(); return; }
      $('sun-note').textContent = 'Both follow sunrise and sunset' + (household.place ? ' in ' + household.place : '') + '; brightness lifts at a touch.';
    }, function () {});
  }
  // Weather is asked for every fifteen minutes, which is too long to sit on an answer that was already old: after
  // a power cut the frame boots with no clock, nothing secure connects until the network sets it, and the first
  // answers come from what was kept. An old answer is tried again in a minute.
  var weatherRetry = null;
  function loadWeather() {
    get('/api/weather', function (data) {
      weather = data; render();
      clearTimeout(weatherRetry); if (data.stale) weatherRetry = setTimeout(loadWeather, 60000);
    }, function () { clearTimeout(weatherRetry); weatherRetry = setTimeout(loadWeather, 60000); });
  }
  function loadPhotos() {
    get('/api/photos', function (data) {
      var before = photos.map(function (p) { return p.url; }).join();
      photos = data.photos || []; photoInfo = data;
      if (photos.map(function (p) { return p.url; }).join() !== before) {
        slideDeck.items = []; slideSeen = []; slideAt = -1;
        if (mode === 'photos') { if (photos.length) startSlides(); else setMode('calendar'); }
      }
      renderTabs(); renderNotice();
    }, function () {});
  }

  /* ---------- Wiring ---------- */
  $('tab-calendar').onclick = function () { setMode('calendar'); };
  $('photo-next').onclick = function () { showSlide(1); restartSlideTimer(); };
  $('photo-prev').onclick = function () { showSlide(-1); restartSlideTimer(); };
  $('photo-card').onclick = function () { showSlide(1); restartSlideTimer(); };
  $('close-day').onclick = closeDay;
  $('day-dialog').onclick = function (e) { if (e.target === $('day-dialog')) closeDay(); };
  $('previous').onclick = function () { if (page > 0) { page--; renderStrip(); } };
  $('next').onclick = function () { if (!$('next').disabled) { page++; renderStrip(); } };
  $('back-today').onclick = function () { page = 0; renderStrip(); };
  $('toast-undo').onclick = function () { if (undo) cancelUndo(); };
  $('close-dialog').onclick = closeEvent;
  $('event-dialog').onclick = function (e) { if (e.target === $('event-dialog')) closeEvent(); };
  $('settings-button').onclick = function () { setMode(mode === 'settings' ? 'calendar' : 'settings'); };
  document.addEventListener('keydown', function (e) {
    lastTouch = Date.now();
    if (e.key === 'Escape') { if (!$('event-dialog').hidden) closeEvent(); else if (!$('day-dialog').hidden) closeDay(); else if (mode !== 'calendar') setMode('calendar'); }
    if (e.key === 'Tab' && !$('event-dialog').hidden) { e.preventDefault(); $('close-dialog').focus(); }
  });

  // Horizontal swipes page the week and step through photos; vertical scrolling is left alone.
  function onSwipe(el, left, right) {
    var start = null;
    el.addEventListener('touchstart', function (e) { start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
    el.addEventListener('touchend', function (e) {
      if (!start) return;
      var dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y; start = null;
      if (Math.abs(dx) < 90 || Math.abs(dx) < Math.abs(dy) * 2) return;
      (dx < 0 ? left : right)();
    }, { passive: true });
  }
  onSwipe($('strip'), function () { $('next').onclick(); }, function () { $('previous').onclick(); });
  onSwipe($('photo-card'), function () { $('photo-next').onclick(); }, function () { $('photo-prev').onclick(); });
  // Anything that scrolls fades at the bottom until it has been scrolled to the end.
  [$('list-body'), $('day-list'), document.querySelector('.settings-card')].forEach(function (box) {
    box.addEventListener('scroll', function () { fadeIfScrolls(box); }, { passive: true });
  });

  $('manage-button').onclick = openManage; $('close-manage').onclick = closeManage;
  $('list-add').onclick = openAdd; $('add-go').onclick = submitAdd; $('close-add').onclick = closeAdd;
  $('add-input').onkeydown = function (e) { if (e.keyCode === 13) submitAdd(); };
  // Pressing Add must not take focus from the box, or the keyboard drops between every item.
  $('add-go').onmousedown = function (e) { e.preventDefault(); };
  function touched() { lastTouch = Date.now(); }
  document.addEventListener('touchstart', touched, { passive: true }); document.addEventListener('mousedown', touched); document.addEventListener('keydown', touched);

  var lastMinute = -1;
  setInterval(function () {
    var t = now(), idle = Date.now() - lastTouch, busy = !$('event-dialog').hidden || !$('day-dialog').hidden || !$('manage-dialog').hidden || !$('add-dialog').hidden || !!undo;
    tickSky();
    if (t.getMinutes() !== lastMinute) {
      lastMinute = t.getMinutes();
      if (loadedDay && loadedDay !== iso(t)) loadCalendar(); // midnight: slide the whole window forward
      render();
    }
    // Quiet for two minutes: a list, Settings or a paged-ahead week goes back to this week. Quiet for the time set in
    // Settings: the resting view (photos, or the week on a morning), which also follows the morning hours as they pass.
    // An open day or event used to suspend every timer, so the frame could sit on a dialog all night.
    if (idle > HOME_AFTER_MS && (!$('event-dialog').hidden || !$('day-dialog').hidden || !$('manage-dialog').hidden || !$('add-dialog').hidden)) { closeEvent(); closeDay(); closeManage(); closeAdd(); busy = !!undo; }
    var onList = mode.indexOf('list:') === 0, hold = onList ? LIST_AFTER_MS : HOME_AFTER_MS;
    if (!busy && idle > hold && mode !== 'photos' && (mode !== 'calendar' || page !== 0)) { page = 0; setMode('calendar'); }
    if (!busy && idle > Math.max(prefs.restAfter * 60000, onList ? LIST_AFTER_MS : 0) && (mode !== restingView() || page !== 0)) { page = 0; setMode(restingView()); }
    // Photo mode goes bare a few seconds after the last touch, however it was reached: nobody wants a shrunken photo
    // with a dock under it, and the dock is only there to leave by. A touch brings it back. Night: dim rather than
    // dark, since the clock and the weather are exactly what a 1 AM or 6 AM glance wants.
    var resting = !busy && mode === 'photos' && idle > PHOTO_CHROME_MS;
    if (resting !== document.body.hasAttribute('data-rest')) { if (resting) document.body.setAttribute('data-rest', ''); else document.body.removeAttribute('data-rest'); }
    setBrightness(t, idle);
    // Without a backlight to dim, night is a black veil over the whole screen; with one, the backlight does the work.
    var hour = t.getHours() + t.getMinutes() / 60, night = hour >= 22.5 || hour < 6;
    var dim = night && idle > 120000 && !screenBridge() && prefs.screen !== 'bright' ? '0.4' : '0';
    if ($('nightfall').style.opacity !== dim) $('nightfall').style.opacity = dim;
  }, 1000);

  // ?tab=Grocery opens straight to a list, e.g. for a second screen by the pantry.
  if (query.tab) { mode = 'list:' + query.tab; $('view-calendar').hidden = true; $('view-list').hidden = false; }
  // Layout is measured to fit whole items, so measure again once the web fonts have arrived.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { render(); });
  renderSettings(); render(); loadHousehold(); loadSettings(); loadCalendar(); loadTasks(); loadWeather(); loadPhotos();
  setInterval(loadHousehold, 600000); setInterval(loadCalendar, 60000); setInterval(loadTasks, 60000); setInterval(loadWeather, 900000); setInterval(loadPhotos, 60000); setInterval(loadSettings, 60000); setInterval(loadHousehold, 3600000);
  window.addEventListener('online', function () { loadCalendar(); loadTasks(); loadWeather(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { loadCalendar(); loadTasks(); } });
})();
