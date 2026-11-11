// Cortex nodes: write with provenance, the slot conflict policy and confidence (core spec §4.2, §4.3, §5).
const { CortexError, checkText, checkData, MAX_QUOTE } = require('./guard');

const STATUSES = new Set(['active', 'pending', 'archived']);
const ORDERS = { updated: 'updated DESC, id DESC', last_used: 'last_used DESC NULLS LAST, id DESC', uses: 'uses DESC, updated DESC, id DESC', created: 'created DESC, id DESC' };
const same = (a, b) => String(a).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === String(b).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function createNodes(db, { now = Date.now, sources, onWrite = () => {} } = {}) {
  const row = id => db.stmt('SELECT * FROM node WHERE id = ?').get(id);

  function addProvenance(nodeId, sourceId, quote) {
    db.stmt('INSERT INTO provenance(node_id, source_id, at, quote) VALUES (?, ?, ?, ?) ON CONFLICT(node_id, source_id) DO UPDATE SET quote = coalesce(excluded.quote, quote)')
      .run(nodeId, sourceId, now(), quote);
  }

  // highest trust + 5 per additional independent (kind, ref) source, cap 100 (plan D5)
  function refreshConfidence(nodeId) {
    const r = db.stmt(`SELECT max(s.trust) top, count(DISTINCT s.kind || char(31) || coalesce(s.ref, '')) n
                       FROM provenance p JOIN source s ON s.id = p.source_id WHERE p.node_id = ?`).get(nodeId);
    const c = r.top === null ? 0 : Math.min(100, r.top + 5 * Math.max(0, r.n - 1));
    db.stmt('UPDATE node SET confidence = ? WHERE id = ?').run(c, nodeId);
  }

  const topTrust = nodeId => db.stmt('SELECT max(s.trust) t FROM provenance p JOIN source s ON s.id = p.source_id WHERE p.node_id = ?').get(nodeId).t ?? 0;

  function insert({ kind, key, text, data, importance, status, confidence = 0, created }) {
    const t = now();
    return Number(db.stmt('INSERT INTO node(kind, key, text, data, status, importance, confidence, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, key, text, data, status, importance, confidence, created ?? t, t).lastInsertRowid);
  }

  function edge(src, dst, type, weight) {
    const t = now();
    db.stmt('INSERT INTO edge(src, dst, type, weight, created, last_used) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(src, dst, type) DO UPDATE SET weight = excluded.weight, last_used = excluded.last_used')
      .run(src, dst, type, weight, t, t);
  }

  function upsert({ kind, key = null, text, data, importance = 0.5, status = 'active', source, quote = null, tainted = false, created } = {}) {
    const clean = checkText(kind, text);
    if (!STATUSES.has(status)) throw new CortexError('status');
    const src = sources.get(source);
    if (!src) throw new CortexError('no_source', 'every node needs a source');
    if (tainted && (src.kind === 'user' || src.kind === 'tool')) throw new CortexError('tainted', 'a turn that read outside text cannot write ' + src.kind + ' trust');
    const json = checkData(data);
    const imp = Math.max(0, Math.min(1, Number(importance) || 0));
    const q = quote === null || quote === undefined ? null : String(quote).slice(0, MAX_QUOTE);
    const k = key === null || key === undefined ? null : String(key).slice(0, 300);

    const out = db.tx(() => {
      const existing = k === null ? null : db.stmt('SELECT * FROM node WHERE kind = ? AND key = ?').get(kind, k);
      if (!existing) {
        const at = Number.isFinite(created) && created > 0 ? Math.min(created, now()) : undefined;   // importers keep the original date
        const id = insert({ kind, key: k, text: clean, data: json, importance: imp, status, created: at });
        addProvenance(id, src.id, q); refreshConfidence(id);
        return { id, created: true, wrote: true };
      }
      if (same(existing.text, clean)) {
        addProvenance(existing.id, src.id, q); refreshConfidence(existing.id);
        if (existing.status === 'archived' && status !== 'archived') db.stmt('UPDATE node SET status = ?, updated = ? WHERE id = ?').run(status, now(), existing.id);
        return { id: existing.id, created: false, wrote: false };
      }
      const slotData = d => JSON.stringify({ ...(parse(d) || {}), _slot: k });
      if (src.trust >= topTrust(existing.id)) {
        // keep the old value as an archived copy, linked by supersedes; the slot takes the new value and only the new source
        const copy = insert({ kind, key: null, text: existing.text, data: slotData(existing.data), importance: existing.importance, status: 'archived', confidence: existing.confidence, created: existing.created });
        db.stmt('INSERT INTO provenance(node_id, source_id, at, quote) SELECT ?, source_id, at, quote FROM provenance WHERE node_id = ?').run(copy, existing.id);
        db.stmt('DELETE FROM provenance WHERE node_id = ?').run(existing.id);
        db.stmt('UPDATE node SET text = ?, data = ?, importance = ?, status = ?, updated = ? WHERE id = ?').run(clean, json, imp, status, now(), existing.id);
        addProvenance(existing.id, src.id, q); refreshConfidence(existing.id);
        edge(existing.id, copy, 'supersedes', 1);
        return { id: existing.id, created: false, conflict: 'replaced', wrote: true };
      }
      // lower trust: a separate node (no key, the slot named in data) that contradicts the slot
      const id = insert({ kind, key: null, text: clean, data: slotData(json), importance: imp, status });
      addProvenance(id, src.id, q); refreshConfidence(id);
      edge(id, existing.id, 'contradicts', 0.3);
      return { id, created: true, conflict: 'contradicts', wrote: true };
    });
    const { wrote, ...result } = out;
    if (wrote) { try { onWrite(result.id, kind); } catch { /* a listener must not undo a committed write */ } }
    return result;
  }

  function get(id) {
    const n = row(id);
    if (!n) return null;
    const srcs = db.stmt(`SELECT s.kind, s.trust, s.ref, s.title, p.at, p.quote FROM provenance p JOIN source s ON s.id = p.source_id
                          WHERE p.node_id = ? ORDER BY s.trust DESC, p.at`).all(id);
    return { ...n, data: parse(n.data), sources: srcs };
  }

  function find({ kind, key }) {
    const n = db.stmt('SELECT id FROM node WHERE kind = ? AND key = ?').get(kind, String(key));
    return n ? get(n.id) : null;
  }

  function list({ kind = null, status = 'active', limit = 50, offset = 0, order = 'updated' } = {}) {
    const by = ORDERS[order] || ORDERS.updated;
    const lim = Math.max(1, Math.min(1000, Number(limit) || 50)), off = Math.max(0, Number(offset) || 0);
    return db.stmt(`SELECT * FROM node WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY ${by} LIMIT ?3 OFFSET ?4`)
      .all(kind, status, lim, off).map(n => ({ ...n, data: parse(n.data) }));
  }

  // edit or approve an existing node in place (W1 E1): same checks as upsert, provenance for `source`,
  // onWrite (re-embed) only when the text changed. A keyed node keeps its key.
  function update(id, { text, data, status, importance } = {}, { source, tainted = false } = {}) {
    const cur = row(id);
    if (!cur) throw new CortexError('not_found');
    const src = sources.get(source);
    if (!src) throw new CortexError('no_source', 'every node needs a source');
    if (tainted && (src.kind === 'user' || src.kind === 'tool')) throw new CortexError('tainted', 'a turn that read outside text cannot write ' + src.kind + ' trust');
    const set = {};
    if (text !== undefined) { const t = checkText(cur.kind, text); if (t !== cur.text) set.text = t; }
    if (data !== undefined) { const j = checkData(data); if (j !== cur.data) set.data = j; }
    if (status !== undefined) { if (!STATUSES.has(status)) throw new CortexError('status'); if (status !== cur.status) set.status = status; }
    if (importance !== undefined) { const i = Math.max(0, Math.min(1, Number(importance) || 0)); if (i !== cur.importance) set.importance = i; }
    const cols = Object.keys(set);
    if (!cols.length) return { id, changed: false };
    db.tx(() => {
      db.stmt(`UPDATE node SET ${cols.map(c => c + ' = ?').join(', ')}, updated = ? WHERE id = ?`).run(...cols.map(c => set[c]), now(), id);
      addProvenance(id, src.id, null); refreshConfidence(id);
    });
    if (set.text !== undefined) { try { onWrite(id, cur.kind); } catch { /* a listener must not undo a committed write */ } }
    return { id, changed: true };
  }

  const archive = id => db.stmt("UPDATE node SET status = 'archived', updated = ? WHERE id = ? AND status != 'archived'").run(now(), id).changes > 0;
  const remove = id => db.stmt('DELETE FROM node WHERE id = ?').run(id).changes > 0;

  // use counts are batched: touch() is free on the turn path, flushUses() writes once (spec §4.4)
  const pending = new Map();
  function touch(ids) { for (const id of ids || []) pending.set(id, (pending.get(id) || 0) + 1); }
  function flushUses() {
    if (!pending.size) return 0;
    const batch = [...pending]; pending.clear();
    const t = now();
    db.tx(() => { for (const [id, n] of batch) db.stmt('UPDATE node SET uses = uses + ?, last_used = ? WHERE id = ?').run(n, t, id); });
    return batch.length;
  }

  return { upsert, update, get, find, list, archive, remove, touch, flushUses, topTrust, pendingUses: () => pending.size };
}

module.exports = { createNodes };
