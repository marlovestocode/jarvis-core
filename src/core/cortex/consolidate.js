// Cortex consolidation, the idle "sleep" job (core spec §7). One tick = one slice: each step is synchronous work
// kept short, the tick yields (setImmediate) between steps, checks isIdle() before each, and stops when the slice
// deadline is spent; what is left waits for the next tick. One tick at a time.
const { getMeta, setMeta } = require('./maintenance');

const EMBED_KINDS = new Set(['fact', 'entity', 'chat', 'knowledge', 'reminder']);
const BATCH = 16, SIMILAR = 0.82, DUPLICATE = 0.95, NEIGHBORS = 5;
const STALE_DAYS = 180, DAY = 864e5, HOUR = 36e5;
const PRUNE_SRCS = 500, ARCHIVE_ROWS = 200;
const yieldNow = () => new Promise(r => setImmediate(r));

function createConsolidate({ db, vectors, edges, maintenance = null, embedder = null, isIdle = () => true, now = Date.now, log = () => {} }) {
  const pending = new Set();   // node ids waiting for a vector
  const toLink = [];           // { id, v } embedded, not yet linked
  let running = false, lastAt = null, pruneFrom = 0;

  const queue = {
    push(id, kind) { if (embedder && (!kind || EMBED_KINDS.has(kind))) pending.add(id); },
    get size() { return pending.size; },
  };

  // 1. embed: up to 16 queued nodes, else stale vectors from an older model. Returns sync ms spent.
  async function embed() {
    if (!embedder) return null;
    let ids = [...pending].slice(0, BATCH);
    if (!ids.length) ids = vectors.staleIds(BATCH);
    if (!ids.length) return null;
    let t = performance.now();
    for (const id of ids) pending.delete(id);
    const rows = db.stmt("SELECT id, text FROM node WHERE id IN (SELECT value FROM json_each(?)) AND status != 'archived'").all(JSON.stringify(ids));
    let ms = performance.now() - t;
    if (!rows.length) return ms;
    let vs;
    try { vs = await embedder.embed(rows.map(r => r.text), { role: 'doc' }); } catch (err) {
      for (const r of rows) pending.add(r.id);   // retry on a later tick
      log('cortex embed failed: ' + err.message);
      return ms;
    }
    t = performance.now();
    for (let i = 0; i < rows.length; i++) {
      if (!db.stmt('SELECT 1 x FROM node WHERE id = ?').get(rows[i].id)) continue;   // removed while embedding
      try { vectors.put(rows[i].id, vs[i]); toLink.push({ id: rows[i].id, v: vs[i] }); } catch (err) { log('cortex vector refused: ' + err.message); }
    }
    return ms + performance.now() - t;
  }

  const hasUser = id => !!db.stmt("SELECT 1 x FROM provenance p JOIN source s ON s.id = p.source_id WHERE p.node_id = ? AND s.kind = 'user'").get(id);
  const topTrust = id => db.stmt('SELECT max(s.trust) t FROM provenance p JOIN source s ON s.id = p.source_id WHERE p.node_id = ?').get(id).t ?? 0;
  const nodeRow = id => db.stmt('SELECT id, kind, status, created FROM node WHERE id = ?').get(id);

  // 2 + 3. link and dedupe from one search per freshly embedded node, until the slice is spent
  function link(deadline) {
    if (!toLink.length) return null;
    const t0 = performance.now();
    let deduped = false;
    while (toLink.length && (performance.now() - t0 < deadline || performance.now() === t0)) {
      const { id, v } = toLink.shift();
      const me = nodeRow(id);
      if (!me || me.status === 'archived') continue;
      for (const hit of vectors.search(v, NEIGHBORS + 1)) {
        if (hit.id === id || hit.score < SIMILAR) continue;
        const other = nodeRow(hit.id);
        if (!other || other.status === 'archived') continue;
        const [lo, hi] = id < hit.id ? [id, hit.id] : [hit.id, id];
        edges.link(lo, hi, 'similar', { weight: Math.min(1, hit.score) });
        if (hit.score < DUPLICATE || other.kind !== me.kind || topTrust(id) !== topTrust(hit.id)) continue;
        const [older, newer] = other.created < me.created || (other.created === me.created && other.id < me.id) ? [other, me] : [me, other];
        if (hasUser(older.id) || hasUser(newer.id)) {
          // the user's own words are never merged by the machine; the Memory tab shows the proposal
          db.stmt("UPDATE node SET data = json_set(coalesce(data, '{}'), '$.proposedMerge', ?) WHERE id = ?").run(older.id, newer.id);
        } else {
          edges.link(newer.id, older.id, 'same_as', { weight: 1 });
          db.stmt("UPDATE node SET status = 'archived', updated = ? WHERE id = ?").run(now(), older.id);
        }
        deduped = true;
      }
    }
    return { ms: performance.now() - t0, deduped };
  }

  // 4. prune: faded edges (a chunk of source ids per tick), and knowledge/chat unused for 180 days unless the user said it
  function prune() {
    const t0 = performance.now();
    const r = edges.prune({ fromSrc: pruneFrom, limit: PRUNE_SRCS });
    pruneFrom = r.nextSrc ?? 0;
    db.stmt(`UPDATE node SET status = 'archived', updated = ?1 WHERE id IN (
               SELECT n.id FROM node n WHERE n.kind IN ('knowledge', 'chat') AND n.status = 'active' AND coalesce(n.last_used, n.updated) < ?2
               AND NOT EXISTS (SELECT 1 FROM provenance p JOIN source s ON s.id = p.source_id WHERE p.node_id = n.id AND s.kind = 'user')
               LIMIT ${ARCHIVE_ROWS})`).run(now(), now() - STALE_DAYS * DAY);
    return performance.now() - t0;
  }

  // 5. housekeeping by period: optimize daily, checkpoint hourly, backup daily
  function housekeeping(did) {
    const t0 = performance.now(), t = now();
    const due = (key, every) => { const last = Number(getMeta(db, key)) || 0; return !last || t - last >= every; };
    if (due('hk_optimize', DAY)) { db.raw.exec('PRAGMA optimize'); setMeta(db, 'hk_optimize', t); did.push('optimize'); }
    if (maintenance && due('hk_check', DAY)) {
      // boot skips the full scan after a clean close, so it runs here instead; a failure forces it at the next boot
      const qc = maintenance.quickCheck();
      if (qc === 'ok') db.stmt("DELETE FROM meta WHERE key = 'check_failed'").run();
      else { setMeta(db, 'check_failed', t); log('cortex: daily quick_check failed: ' + qc); }
      setMeta(db, 'hk_check', t); did.push('check');
    }
    if (due('hk_checkpoint', HOUR)) { db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); setMeta(db, 'hk_checkpoint', t); did.push('checkpoint'); }
    if (maintenance && due('hk_backup', DAY)) {
      try { if (maintenance.backup()) did.push('backup'); } catch (err) { log('cortex backup failed: ' + err.message); }
      setMeta(db, 'hk_backup', t);
    }
    return performance.now() - t0;
  }

  async function tick({ deadlineMs = 8, isIdle: idle = isIdle } = {}) {
    if (running) return { did: [], aborted: true, steps: {} };
    running = true;
    const did = [], steps = {};
    let spent = 0;
    const step = async (name, fn) => {
      if (!idle()) return 'abort';
      if (spent >= deadlineMs) return 'stop';
      const r = await fn();
      if (r === null || r === undefined) return 'skip';
      const ms = typeof r === 'number' ? r : r.ms;
      steps[name] = ms; spent += ms; did.push(name);
      if (r.deduped) did.push('dedupe');
      await yieldNow();
      return 'ok';
    };
    try {
      for (const [name, fn] of [['embed', embed], ['link', () => link(Math.max(1, deadlineMs - spent))], ['prune', prune], ['housekeeping', () => housekeeping(did)]]) {
        const r = await step(name, fn);
        if (r === 'abort') return { did: did.filter(d => d !== 'housekeeping'), aborted: true, steps };
        if (r === 'stop') break;
      }
      lastAt = now();
      return { did: did.filter(d => d !== 'housekeeping'), aborted: false, steps };
    } catch (err) {
      log('cortex consolidate failed: ' + err.message);
      return { did, aborted: true, steps, error: err.message };
    } finally { running = false; }
  }

  return { tick, queue, lastAt: () => lastAt };
}

module.exports = { createConsolidate, EMBED_KINDS };
