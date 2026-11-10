// Chat history: one JSON file per session in <dir>/history/.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 48;

function titleFor(messages) {
  const first = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!first) return 'New chat';
  const flat = first.content.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX).trimEnd() + '…' : flat;
}

function createSessionStore(dir) {
  const hist = path.join(dir, 'history');
  const broken = path.join(hist, 'broken');
  fs.mkdirSync(hist, { recursive: true });
  const fileOf = id => path.join(hist, id + '.json');

  function quarantine(id) {
    try {
      fs.mkdirSync(broken, { recursive: true });
      fs.renameSync(fileOf(id), path.join(broken, id + '.json'));
    } catch { /* best effort */ }
  }

  function read(id) {
    let text;
    try { text = fs.readFileSync(fileOf(id), 'utf8'); } catch { return null; }
    try {
      const s = JSON.parse(text);
      if (!s || typeof s !== 'object' || !Array.isArray(s.messages)) throw new Error('bad shape');
      return s;
    } catch {
      quarantine(id);
      return null;
    }
  }

  function create() {
    const now = Date.now();
    return { id: crypto.randomUUID(), title: 'New chat', created: now, updated: now, messages: [] };
  }

  function load(id) {
    if (!ID_RE.test(String(id))) return null;
    return read(id);
  }

  function save(s) {
    if (!ID_RE.test(String(s.id))) throw new Error('bad session id');
    s.title = titleFor(s.messages);
    s.updated = Math.max(Date.now(), (s.updated || 0) + 1);
    const file = fileOf(s.id);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  }

  function list() {
    let names = [];
    try { names = fs.readdirSync(hist); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const s = read(id);
      if (s) out.push({ id: s.id, title: s.title, updated: s.updated });
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  function remove(id) {
    if (!ID_RE.test(String(id))) return;
    try { fs.unlinkSync(fileOf(id)); } catch { /* already gone */ }
  }

  return { create, load, save, list, remove };
}

module.exports = { createSessionStore, titleFor };
