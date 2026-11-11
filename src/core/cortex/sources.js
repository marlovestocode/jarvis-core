// Cortex sources: who said it, and how much to trust it (core spec §4.2).
const { CortexError, SOURCE_KINDS } = require('./guard');

const TRUST = Object.freeze({ user: 100, tool: 90, import: 100, wiki: 70, web: 40, model: 20 });
const cut = (s, n) => (s === undefined || s === null ? null : String(s).slice(0, n));

function createSources(db, { now = Date.now } = {}) {
  function add({ kind, ref = null, title = null, trust } = {}) {
    if (!SOURCE_KINDS.has(kind)) throw new CortexError('source_kind', 'unknown source kind: ' + kind);
    const t = Number.isFinite(trust) ? Math.max(0, Math.min(100, Math.round(trust))) : TRUST[kind];
    return Number(db.stmt('INSERT INTO source(kind, trust, ref, title, at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, t, cut(ref, 500), cut(title, 200), now()).lastInsertRowid);
  }
  function get(id) {
    if (!Number.isInteger(id)) return null;
    return db.stmt('SELECT id, kind, trust, ref, title, at FROM source WHERE id = ?').get(id) ?? null;
  }
  // the newest source of this kind and ref, so a caller can reuse one row instead of adding another
  function find({ kind, ref } = {}) {
    if (!SOURCE_KINDS.has(kind)) return null;
    return db.stmt('SELECT id FROM source WHERE kind = ? AND ref IS ? ORDER BY id DESC LIMIT 1').get(kind, cut(ref, 500))?.id ?? null;
  }
  return { add, get, find };
}

module.exports = { createSources, TRUST };
