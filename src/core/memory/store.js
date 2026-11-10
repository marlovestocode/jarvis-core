// Long-term memory: short facts and preferences about the user, kept in one local JSON file.
// Nothing here leaves the PC. A few facts are put in the system prompt each turn; the user adds
// and removes them by voice or chat ("remember that...", "forget that...").
const fs = require('node:fs');
const path = require('node:path');

const MAX_FACTS = 100;
const MAX_LEN = 200;
// Never keep secrets: passwords, keys, card-like numbers.
const SECRET = /\b(?:password|passcode|passphrase|pin\s*(?:code|number)?|api[\s_-]?key|secret|token|cvv|ssn|social security)\b|\b(?:\d[ -]?){13,19}\b/i;

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'my', 'that', 'i', 'is', 'am', 'are', 'to', 'of', 'and', 'it', 'about', 'me', 'on', 'in']);
const words = s => norm(s).split(' ').filter(w => w && !STOP.has(w));

function createMemory({ file, now = Date.now, max = MAX_FACTS, log = () => {} } = {}) {
  let facts = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j.facts)) facts = j.facts.filter(f => f && typeof f.text === 'string' && f.text.trim()).map(f => ({ id: String(f.id), text: f.text, at: Number(f.at) || 0 }));
  } catch { /* none yet, or unreadable: start empty */ }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ facts }, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) { log('memory save failed: ' + err.message); }
  }

  const nextId = () => { let n = Date.now().toString(36); while (facts.some(f => f.id === n)) n += 'x'; return n; };

  // add(text) → { ok, text?, reason?, duplicate? }
  function add(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!\s]+$/, '');
    if (t.length < 3) return { ok: false, reason: 'empty' };
    if (t.length > MAX_LEN) return { ok: false, reason: 'long' };
    if (SECRET.test(t)) return { ok: false, reason: 'secret' };
    const same = facts.find(f => norm(f.text) === norm(t));
    if (same) return { ok: true, text: same.text, duplicate: true };
    if (facts.length >= max) facts.shift();   // oldest goes first
    facts.push({ id: nextId(), text: t, at: now() });
    save();
    return { ok: true, text: t };
  }

  // find(query) → facts that best match; every query word must appear (or all words of a fact, for short facts)
  function find(query) {
    const q = words(query);
    if (!q.length) return [];
    const scored = facts.map(f => {
      const fw = new Set(words(f.text));
      const hit = q.filter(w => fw.has(w)).length;
      return { f, hit };
    }).filter(x => x.hit === q.length || (q.length >= 3 && x.hit >= q.length - 1));
    return scored.sort((a, b) => b.hit - a.hit).map(x => x.f);
  }

  // forget(query) → { removed: [text], ambiguous?: [text] }; several matches are not deleted unless all=true
  function forget(query, { all = false } = {}) {
    const m = find(query);
    if (!m.length) return { removed: [] };
    if (m.length > 1 && !all) return { removed: [], ambiguous: m.map(f => f.text) };
    const ids = new Set(m.map(f => f.id));
    facts = facts.filter(f => !ids.has(f.id));
    save();
    return { removed: m.map(f => f.text) };
  }

  function clear() { const n = facts.length; facts = []; save(); return n; }
  const list = () => facts.map(f => f.text);

  // for the system prompt: newest first within a character budget
  function digest(maxChars = 900) {
    if (!facts.length) return '';
    const out = [];
    let used = 0;
    for (const f of [...facts].reverse()) {
      if (used + f.text.length + 3 > maxChars) break;
      out.push(f.text); used += f.text.length + 3;
    }
    return out.join('; ');
  }

  return { add, find, forget, clear, list, digest, count: () => facts.length };
}

module.exports = { createMemory, MAX_FACTS, MAX_LEN };
