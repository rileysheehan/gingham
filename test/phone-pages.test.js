// The phone pages' own scripts, run with no browser: dist/setup-page.js and dist/lists-page.js in a vm, against a page of
// stand-in elements (any id the script asks for exists, and remembers what is put in it) and a fetch the test answers.
// Enough to read back the words a script writes; the layout is test/shots.cjs's job.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.style = {setProperty() {}}; this.attrs = {}; this.text = ''; this.hidden = false; this.value = ''; this.placeholder = ''; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  get firstChild() { return this.children[0] || null; }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  querySelector() { return new El('div'); }
  querySelectorAll() { return []; }
  focus() {} scrollIntoView() {} addEventListener() {}
}
function page(script, answers) {
  const ids = {}, document = {
    title: '', getElementById: id => ids[id] || (ids[id] = new El('div')), createElement: tag => new El(tag),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, hidden: false
  };
  const respond = url => { const key = Object.keys(answers).find(k => url.startsWith(k)); return key ? {status: 200, body: answers[key]} : {status: 404, body: {}}; };
  const fetch = url => { const r = respond(url); return Promise.resolve({status: r.status, json: () => Promise.resolve(r.body)}); };
  const window = {document, fetch, location: {search: '', hash: '', pathname: '/'}, history: {}, navigator: {}, localStorage: {getItem: () => null, setItem() {}},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, addEventListener() {}, console};
  window.window = window;
  vm.createContext(window);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', script), 'utf8'), window, {filename: 'dist/' + script});
  return {$: id => document.getElementById(id), settle: () => new Promise(r => setImmediate(r))};
}

test('The setup page says where each list comes from, Todoist too, never "undefined" (polish pass, P-09)', async () => {
  const setup = {household: {name: 'The Ashbys', place: 'Springfield', timezone: 'America/Chicago'}, calendars: [], countdowns: [], frames: [], devices: [],
    lists: [{id: 'l1', name: 'Family', person: false, kind: 'here'}, {id: 'l2', name: 'Grocery', person: false, kind: 'todoist'}, {id: 'l3', name: 'June', person: true, kid: true, color: '#e0823d', kind: 'microsoft'}],
    todoist: {connected: true}, googletasks: {available: false}, microsoft: {available: true, connected: true}, caldav: {connected: false}, homeassistant: {connected: false},
    photos: {connected: false, folder: {}}, pin: {set: false}};
  const p = page('setup-page.js', {'/api/setup': setup});
  await p.settle(); await p.settle();
  const sub = li => li.children.find(c => c.className === 'grow').children.find(c => /^sub/.test(c.className)).textContent;
  assert.deepEqual(p.$('l-list').children.map(sub), ['A household list · kept here', 'A household list · from Todoist', 'A young child’s list · from Microsoft To Do']);
});

test('The lists page shows no zero counts and always has something in the add box (polish pass, P-11)', async () => {
  const tasks = {projects: ['Grocery', 'Garage'], tasks: [{id: 't1', title: 'Limes', project: 'Grocery', section: '', due: ''}, {id: 't2', title: 'Eggs', project: 'Grocery', section: '', due: ''}]};
  const p = page('lists-page.js', {'/api/tasks': tasks, '/api/household': {name: 'The Ashbys'}});
  await p.settle(); await p.settle();
  assert.deepEqual(p.$('tabs').children.map(b => b.textContent), ['Grocery 2', 'Garage']);
  assert.equal(p.$('add-input').placeholder, 'Add to Grocery');
  // The markup's own placeholder covers the page before any list has loaded (offline, or still loading).
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'dist', 'lists.html'), 'utf8'), /id="add-input" placeholder="Add something"/);
});
