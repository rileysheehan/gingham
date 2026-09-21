// Lists a household keeps here, needing no account anywhere else: lists.json in its folder. To the page they are
// indistinguishable from Todoist's; integrations.js puts both behind the same answer.
const fs = require('node:fs');
const crypto = require('node:crypto');

const MAX_ITEMS = 500;
const clean = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function createLists({file}) {
  function read() { try { const all = JSON.parse(fs.readFileSync(file, 'utf8')); return {items: Array.isArray(all.items) ? all.items : []}; } catch (e) { return {items: []}; } }
  function write(all) { fs.writeFileSync(file + '.tmp', JSON.stringify(all, null, 2) + '\n', {mode: 0o600}); fs.renameSync(file + '.tmp', file); }
  return {
    items: list => read().items.filter(i => i.list === list),
    has: id => read().items.some(i => i.id === id),
    add(list, title, section) {
      const text = clean(title, 200); if (!text) throw Object.assign(Error('Nothing to add'), {code: 'EMPTY'});
      const all = read(); if (all.items.length >= MAX_ITEMS) throw Object.assign(Error('That is a lot of items. Check some off first.'), {code: 'FULL'});
      const item = {id: 'Li' + crypto.randomBytes(8).toString('hex'), list, title: text, section: clean(section, 60), createdAt: new Date().toISOString()};
      all.items.push(item); write(all);
      return item;
    },
    // Checked off is gone: the frame already waits ten seconds for an undo before it asks for this.
    close(id) { const all = read(), before = all.items.length; all.items = all.items.filter(i => i.id !== id); if (all.items.length === before) return false; write(all); return true; },
    removeList(list) { const all = read(); all.items = all.items.filter(i => i.list !== list); write(all); }
  };
}
module.exports = {createLists};
