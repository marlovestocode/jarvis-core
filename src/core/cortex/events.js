// Cortex events: an append-only log with range queries (core spec §4.1 event, §5).
const { CortexError, EVENT_KINDS, RAW_EVENT_KINDS, checkData } = require('./guard');

const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const out = r => ({ id: r.id, at: r.at, kind: r.kind, nodeId: r.node_id, payload: parse(r.payload) });

function createEvents(db, { now = Date.now } = {}) {
  const checkKind = kind => { if (!EVENT_KINDS.has(kind)) throw new CortexError('event_kind', 'unknown event kind: ' + kind); };

  function add({ kind, nodeId = null, payload = {}, at } = {}) {
    checkKind(kind);
    const json = checkData(payload ?? {}, { secrets: !RAW_EVENT_KINDS.has(kind) });
    return Number(db.stmt('INSERT INTO event(at, kind, node_id, payload) VALUES (?, ?, ?, ?)')
      .run(Number.isFinite(at) ? at : now(), kind, nodeId, json).lastInsertRowid);
  }

  function query({ kind, since = null, until = null, nodeId = null, limit = 100, order = 'asc' } = {}) {
    checkKind(kind);
    const dir = order === 'desc' ? 'DESC' : 'ASC';
    const lim = Math.max(1, Math.min(1e6, Number(limit) || 100));
    return db.stmt(`SELECT * FROM event WHERE kind = ?1 AND (?2 IS NULL OR at >= ?2) AND (?3 IS NULL OR at < ?3) AND (?4 IS NULL OR node_id = ?4)
                    ORDER BY at ${dir}, id ${dir} LIMIT ?5`).all(kind, since, until, nodeId, lim).map(out);
  }

  const count = ({ kind = null } = {}) => db.stmt('SELECT count(*) n FROM event WHERE (?1 IS NULL OR kind = ?1)').get(kind).n;

  // retention: drop events of a kind older than `before`, and/or all but the newest `keepNewest`
  // except: event ids that stay whatever their age (W2 E4: the undoable action)
  function deleteWhere({ kind, before = null, keepNewest = null, except = [] } = {}) {
    checkKind(kind);
    const keep = Number.isInteger(keepNewest) ? keepNewest : -1;
    const ids = JSON.stringify((Array.isArray(except) ? except : []).filter(Number.isInteger).slice(0, 1000));
    return db.stmt(`DELETE FROM event WHERE kind = ?1 AND (?2 IS NULL OR at < ?2)
                    AND (?3 < 0 OR id NOT IN (SELECT id FROM event WHERE kind = ?1 ORDER BY at DESC, id DESC LIMIT ?3))
                    AND id NOT IN (SELECT value FROM json_each(?4))`).run(kind, before, keep, ids).changes;
  }

  return { add, query, count, deleteWhere };
}

module.exports = { createEvents };
