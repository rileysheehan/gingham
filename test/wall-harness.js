// The wall's page, run in Node with no browser: dist/index.html parsed into a small DOM, dist/app.js run against it in a
// vm, and every /api/ call answered from a fixture in test/fixtures.js. It is enough DOM for what app.js does and no
// more, and it lays nothing out: every box measures zero, so `fitItems` keeps every row — except Today's list, which
// is given a model of the real panel (below) so that it folds, and the rows that survive the fold can be read.
//
// Time: `now` (house wall time, "2026-09-23T19:05:00") goes in as ?now=, the way design review drives the page. `clock`
// (an instant, "2026-09-24T05:10:00Z") instead fakes the device's own clock, so house time is found the way the frame
// finds it; set process.env.TZ before loading to put the device somewhere else.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtures = require('./fixtures');

const DIST = path.join(__dirname, '..', 'dist');
const VOID = new Set(['meta', 'link', 'img', 'input', 'br', 'hr', 'source']);

class Text {
  constructor(text) { this.nodeType = 3; this.data = text; this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Style {
  constructor() { this._props = {}; }
  setProperty(k, v) { this._props[k] = String(v); }
  getPropertyValue(k) { return this._props[k] || ''; }
}

class Element {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.nodeType = 1;
    this.childNodes = []; this.parentNode = null; this.attributes = {}; this.style = new Style();
    this.scrollTop = 0; this.innerHTML = ''; this.value = ''; this.disabled = false;
  }
  get id() { return this.attributes.id || ''; }
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = String(v); }
  get hidden() { return 'hidden' in this.attributes; }
  set hidden(v) { if (v) this.attributes.hidden = ''; else delete this.attributes.hidden; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach(n => { n.parentNode = null; }); this.childNodes = []; if (v !== '' && v != null) this.appendChild(new Text(String(v))); }
  // Nothing is laid out, except Today's list, which gets a model of the real panel so that it folds as it does on the
  // wall. Measured in Chrome at 1920×1080: 361 px of room, 105 px for a two-line row, 53 px for a one-line (compact) row
  // and 44 px for "N more".
  get clientHeight() { return this.id === 'today-list' ? 361 : 0; }
  get scrollHeight() { return this.id === 'today-list' ? this.children.reduce((h, el) => h + (el.classes.includes('more') ? 44 : el.classes.includes('compact') ? 53 : 105), 0) : 0; }
  get clientWidth() { return 0; } get scrollWidth() { return 0; }
  // Every other box counts as not displayed, which is what a zero height means to app.js.
  get offsetParent() { return this.id === 'today-list' ? this.parentNode : null; }
  get offsetWidth() { return 0; } get offsetHeight() { return 0; } get offsetLeft() { return 0; }
  // The calendar legend gets a model of the real header as well (Chrome at 1920×1080): a 56 px header, and a legend that
  // wraps its names into 336 px, or 222 px beside the Today button (364 and 274 set tight), a name taking about 0.54 em a
  // letter plus its dot and the gap before it.
  getBoundingClientRect() {
    const height = this.id === 'legend' ? legendHeight(this) : this.children.some(c => c.id === 'legend') ? 56 : 0;
    return {top: 0, left: 0, right: 0, bottom: height, width: 0, height};
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(n); else this.childNodes.splice(at, 0, n);
    n.parentNode = this; return n;
  }
  removeChild(n) { const at = this.childNodes.indexOf(n); if (at >= 0) this.childNodes.splice(at, 1); n.parentNode = null; return n; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  // Listeners are kept so a test can fire an event at an element (`fire`); nothing else ever dispatches one.
  addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = (this.listeners[type] || []).concat(fn); }
  removeEventListener() {}
  fire(type, event = {}) { (this.listeners && this.listeners[type] || []).forEach(fn => fn({type, target: this, touches: [], changedTouches: [], ...event})); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { if (this.onclick) this.onclick({target: this, preventDefault() {}}); }
  *descendants() { for (const c of this.children) { yield c; yield* c.descendants(); } }
  querySelectorAll(selector) { const parts = selector.trim().split(/\s+/); return [...this.descendants()].filter(el => matchesChain(el, parts, this)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get classes() { return this.className.split(/\s+/).filter(Boolean); }
}

function legendHeight(legend) {
  const tight = legend.classes.includes('tight'), font = tight ? 17.6 : 20.8, today = !legend.ownerDocument.getElementById('back-today').hidden;
  const room = today ? (tight ? 274 : 222) : (tight ? 364 : 336);
  let lines = 1, x = 0;
  for (const el of legend.children.filter(c => !c.hidden)) {
    const w = (tight ? 36 : 50.4) + el.textContent.length * 0.54 * font;
    if (x && x + w > room) { lines++; x = 0; }
    x += w;
  }
  return legend.children.length ? lines * font * (tight ? 1.15 : 1.5) : 0;
}

// tag, #id, .class and [attr] compounds joined by descendant spaces: all app.js asks for.
function matchesOne(el, compound) {
  const re = /([#.]?)([\w-]+)|\[([\w-]+)\]/g; let m;
  while ((m = re.exec(compound))) {
    if (m[3]) { if (!el.hasAttribute(m[3])) return false; }
    else if (m[1] === '#') { if (el.id !== m[2]) return false; }
    else if (m[1] === '.') { if (!el.classes.includes(m[2])) return false; }
    else if (el.tagName !== m[2].toUpperCase()) return false;
  }
  return true;
}
function matchesChain(el, parts, root) {
  if (!matchesOne(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let x = el.parentNode; x && x !== root.parentNode && i >= 0; x = x.parentNode) if (x.nodeType === 1 && matchesOne(x, parts[i])) i--;
  return i < 0;
}

function parse(doc, html, into) {
  const stack = [into], re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) { const at = stack.map(el => el.tagName).lastIndexOf(m[1].toUpperCase()); if (at > 0) stack.length = at; }
    else if (m[2]) {
      const el = new Element(doc, m[2]);
      const attrs = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let a;
      while ((a = attrs.exec(m[3] || ''))) el.attributes[a[1]] = a[2] ?? a[3] ?? a[4] ?? '';
      top.appendChild(el);
      if (!m[4] && !VOID.has(m[2].toLowerCase()) && m[2].toLowerCase() !== 'script') stack.push(el);
    } else if (m[5] && m[5].trim()) top.appendChild(new Text(m[5]));
  }
}

function makeDocument() {
  const doc = {activeElement: null, title: '', hidden: false, listeners: {}};
  const html = new Element(doc, 'html'), body = new Element(doc, 'body');
  html.appendChild(body);
  const source = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  parse(doc, source.slice(source.indexOf('<body'), source.lastIndexOf('</body>')).replace(/^<body[^>]*>/, ''), body);
  body.className = 'theme-light';
  Object.assign(doc, {
    documentElement: html, body,
    getElementById: id => [...html.descendants()].find(el => el.id === id) || null,
    querySelector: s => html.querySelector(s), querySelectorAll: s => html.querySelectorAll(s),
    createElement: tag => new Element(doc, tag), createElementNS: (ns, tag) => new Element(doc, tag),
    createTextNode: text => new Text(text),
    addEventListener() {}
  });
  doc.activeElement = body;
  return doc;
}

// The API, from a fixture, answered only when the test flushes, as a network would.
function makeServer(fixture, overrides) {
  const data = fixtures[fixture];
  if (!data) throw Error('Unknown fixture ' + fixture);
  const answers = {
    '/api/household': {name: 'Household', timezone: 'America/Chicago', place: 'Austin'},
    '/api/settings': {rest: 'calendar', restAfter: 5, mornings: 0, photoEvery: 60, appearance: 'auto', screen: 'auto'},
    '/api/calendar': data.calendar, '/api/tasks': data.tasks, '/api/weather': data.weather,
    '/api/photos': {photos: [], configured: false},
    ...overrides
  };
  const queue = [];
  class XMLHttpRequest {
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    getResponseHeader(name) { return name === 'X-Frame-Version' ? server.version : null; }
    send() { queue.push(this); }
  }
  function flush() {
    for (let rounds = 0; queue.length && rounds < 20; rounds++) {
      for (const xhr of queue.splice(0)) {
        // A POST is answered by an answer named 'POST /api/…' if the test gave one, and with an empty 200 otherwise.
        const route = (xhr.method === 'POST' ? 'POST ' : '') + xhr.url.split('?')[0], given = typeof answers[route] === 'function' ? answers[route]() : answers[route];
        const body = xhr.method === 'POST' ? given || {} : given;
        xhr.status = body ? 200 : 503;
        xhr.responseText = JSON.stringify(body || {error: 'Unavailable'});
        if (xhr.onload) xhr.onload();
      }
    }
  }
  const server = {XMLHttpRequest, flush, answers, version: 'v1'};
  return server;
}

function load({fixture = 'stress', now, clock, overrides, bridge} = {}) {
  const document = makeDocument(), server = makeServer(fixture, overrides), timers = [];
  // The device clock: real unless `clock` fixes it, and either way it can be moved on with `advance(ms)`.
  let fixed = clock ? Date.parse(clock) : null, offset = 0;
  const FakeDate = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(fixed === null ? Date.now() + offset : fixed + offset); }
    static now() { return (fixed === null ? Date.now() : fixed) + offset; }
  };
  const storage = {};
  const window = {
    document, navigator: {}, innerWidth: 1920, innerHeight: 1080,
    location: {search: now ? '?now=' + now : '', host: '127.0.0.1', origin: 'http://127.0.0.1', reload() { window.reloaded = true; }, assign(url) { window.assigned = url; }},
    localStorage: {getItem: k => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); }},
    XMLHttpRequest: server.XMLHttpRequest, Date: FakeDate, Image: class { set src(v) { this._src = v; } },
    setInterval: (fn, ms) => { timers.push({fn, ms, repeat: true}); return timers.length; },
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
    clearInterval() {}, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    addEventListener() {}
  };
  window.window = window;
  // A device bridge (`fully`): Fully Kiosk's, or Gingham's own app's, as a test fakes it.
  if (bridge) window.fully = bridge;
  // The frame remembers its household's zone from the last start; so does this one.
  window.localStorage.setItem('frame.household', JSON.stringify({name: 'Household', timezone: 'America/Chicago', place: 'Austin'}));
  vm.createContext(window);
  // The page's scripts, in the order index.html loads them.
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  for (const [, src] of html.matchAll(/<script src="\/([^"]+)"/g)) vm.runInContext(fs.readFileSync(path.join(DIST, src), 'utf8'), window, {filename: 'dist/' + src});
  server.flush();
  const $ = id => document.getElementById(id);
  // A row as read from the wall: its classes, its meta line and its title.
  const row = el => ({classes: el.classes, meta: (el.querySelector('.item-meta') || {textContent: ''}).textContent, title: (el.querySelector('.item-title') || el).childNodes.filter(n => n.nodeType === 3).map(n => n.textContent).join('')});
  // Today's rows as the wall shows them: the ones that survived the fold, and the "N more" link if there is one.
  const today = () => $('today-list').children.filter(el => !el.classes.includes('more')).map(row);
  const more = () => $('today-list').children.find(el => el.classes.includes('more')) || null;
  const sheetRow = text => $('day-list').children.find(el => row(el).title.includes(text));
  // Runs the page's own repeating timer that calls `name` (loadTasks, loadCalendar, …), then answers what it asked.
  const every = name => { timers.filter(t => t.repeat && t.fn.name === name).forEach(t => t.fn()); server.flush(); };
  const advance = ms => { offset += ms; };
  // Runs the page's one-shot timers named `name` that are still pending (not cleared, not yet run), as if their time
  // had come, and says how many ran.
  const due = name => { const ready = timers.filter(t => !t.repeat && !t.cleared && !t.ran && t.fn.name === name); ready.forEach(t => { t.ran = true; t.fn(); }); return ready.length; };
  return {window, document, server, $, row, today, more, sheet: () => $('day-list').children.map(row), sheetRow, every, advance, due};
}

module.exports = {load};
