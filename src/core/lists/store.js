// Named lists ("grocery", "todo") kept in one JSON file next to the other local data. Writes are atomic (temp file + rename).
// Names are case-insensitive; an item is one line of text; the same item is never added twice to a list.
const fs = require('node:fs');
const path = require('node:path');

const MAX_LISTS = 50, MAX_ITEMS = 500, MAX_ITEM = 200;
const key = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*list$/, '');
const clean = s => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_ITEM);

function createListStore({ file, log = () => {} }) {
  let data = null;   // { [key]: { name, items: [] } }
  function load() {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (err) { if (err.code !== 'ENOENT') log('lists unreadable, starting empty:', err.message); data = {}; }
    return data;
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }
  const names = () => Object.values(load()).map(l => ({ name: l.name, count: l.items.length }));
  const get = name => { const l = load()[key(name)]; return l ? { name: l.name, items: [...l.items] } : null; };
  function add(name, items) {
    const k = key(name);
    if (!k) throw new Error('Which list?');
    const d = load();
    if (!d[k] && Object.keys(d).length >= MAX_LISTS) throw new Error(`There is room for ${MAX_LISTS} lists`);
    const l = d[k] || (d[k] = { name: String(name).trim().replace(/\s*list$/i, '') || k, items: [] });
    const added = [], dupes = [];
    for (const raw of items) {
      const it = clean(raw);
      if (!it) continue;
      if (l.items.some(x => x.toLowerCase() === it.toLowerCase())) dupes.push(it);
      else if (l.items.length >= MAX_ITEMS) throw new Error(`A list holds ${MAX_ITEMS} items at most`);
      else { l.items.push(it); added.push(it); }
    }
    save();
    return { name: l.name, added, dupes, total: l.items.length };
  }
  function remove(name, item) {
    const l = load()[key(name)];
    if (!l) return { found: false };
    const want = clean(item).toLowerCase();
    let hits = l.items.filter(x => x.toLowerCase() === want);
    if (!hits.length) hits = l.items.filter(x => x.toLowerCase().includes(want));
    if (!hits.length) return { found: true, removed: [] };
    if (hits.length > 1) return { found: true, removed: [], ambiguous: hits };
    l.items = l.items.filter(x => x !== hits[0]);
    save();
    return { found: true, removed: hits, name: l.name, total: l.items.length };
  }
  function clear(name) {
    const d = load(), k = key(name);
    if (!d[k]) return { found: false };
    const n = d[k].items.length;
    d[k].items = [];
    save();
    return { found: true, removed: n, name: d[k].name };
  }
  return { names, get, add, remove, clear };
}

module.exports = { createListStore };
