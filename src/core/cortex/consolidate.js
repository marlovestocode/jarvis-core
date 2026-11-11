// Cortex consolidation, the idle "sleep" job (core spec §7). One tick = one slice of work; it never runs during a turn.
const EMBED_KINDS = new Set(['fact', 'entity', 'chat', 'knowledge', 'reminder']);
const BATCH = 16;

function createConsolidate({ db, vectors, embedder = null, isIdle = () => true, log = () => {} }) {
  const pending = new Set();
  let running = false, lastAt = null;

  const queue = {
    push(id, kind) { if (embedder && (!kind || EMBED_KINDS.has(kind))) pending.add(id); },
    get size() { return pending.size; },
  };

  // 1. embed queue: up to 16 queued nodes, else stale vectors from an older model
  async function embedBatch() {
    if (!embedder) return 0;
    let ids = [...pending].slice(0, BATCH);
    if (!ids.length) ids = vectors.staleIds(BATCH);
    if (!ids.length) return 0;
    for (const id of ids) pending.delete(id);
    const rows = db.stmt("SELECT id, text FROM node WHERE id IN (SELECT value FROM json_each(?)) AND status != 'archived'").all(JSON.stringify(ids));
    if (!rows.length) return 0;
    let vs;
    try { vs = await embedder.embed(rows.map(r => r.text), { role: 'doc' }); } catch (err) {
      for (const r of rows) pending.add(r.id);   // retry later
      log('cortex embed failed: ' + err.message);
      return 0;
    }
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!db.stmt('SELECT 1 x FROM node WHERE id = ?').get(rows[i].id)) continue;   // removed while embedding
      try { vectors.put(rows[i].id, vs[i]); n++; } catch (err) { log('cortex vector refused: ' + err.message); }
    }
    return n;
  }

  async function tick({ deadlineMs = 8, isIdle: idle = isIdle } = {}) {
    if (running) return { did: [], aborted: true };
    running = true;
    const did = [];
    try {
      if (!idle()) return { did, aborted: true };
      if (await embedBatch()) did.push('embed');
      lastAt = Date.now();
      return { did, aborted: false };
    } finally { running = false; }
  }

  return { tick, queue, lastAt: () => lastAt };
}

module.exports = { createConsolidate, EMBED_KINDS };
