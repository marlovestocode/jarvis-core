// engine_event access: the one writer and reader of that table. Append-only; old rows are pruned by age, never edited.
//   createEventLog(db, { now }) → { append({ at?, level, source, message, data? }), recent({ limit, level, source }), prune(days), count() }
// append never throws: a full disk or a locked file must not turn a log line into a crash. It returns true when the row was stored.
const LEVELS = ['debug', 'info', 'warn', 'error'];
const MAX_MESSAGE = 2000, MAX_DATA = 8000;

function createEventLog(db, { now = Date.now } = {}) {
  return {
    append({ at = now(), level, source, message, data }) {
      try {
        if (!LEVELS.includes(level) || typeof source !== 'string' || !source) return false;
        let json = null;
        if (data !== undefined) { json = JSON.stringify(data); if (json.length > MAX_DATA) json = JSON.stringify({ truncated: true, head: json.slice(0, MAX_DATA - 40) }); }
        db.stmt('INSERT INTO engine_event(at, level, source, message, data) VALUES (?, ?, ?, ?, ?)').run(at, level, source, String(message).slice(0, MAX_MESSAGE), json);
        return true;
      } catch { return false; }
    },
    // newest first
    recent({ limit = 50, level, source } = {}) {
      const where = [], args = [];
      if (level) { where.push('level = ?'); args.push(level); }
      if (source) { where.push('source = ?'); args.push(source); }
      const sql = `SELECT id, at, level, source, message, data FROM engine_event ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
      return db.stmt(sql).all(...args, Math.max(1, Math.min(1000, Math.trunc(limit)))).map(r => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
    },
    prune(days) { return Number(db.stmt('DELETE FROM engine_event WHERE at < ?').run(now() - days * 86400000).changes); },
    count: () => db.stmt('SELECT COUNT(*) AS n FROM engine_event').get().n,
  };
}

module.exports = { createEventLog, LEVELS };
