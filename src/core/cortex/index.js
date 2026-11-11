// The cortex: JARVIS's one local store of what he knows, did and was told (core spec). Public API = §5.
// Nothing outside src/core/cortex runs SQL; callers use these fixed verbs. Open never throws: a broken file is
// quarantined and restored, and a path that cannot hold a database gives an in-memory cortex with health().ok = false.
const fs = require('node:fs');
const { openDb } = require('./db');
const guard = require('./guard');
const { createSources } = require('./sources');
const { createNodes } = require('./nodes');
const { createEdges } = require('./edges');
const { createEvents } = require('./events');
const { createVectors } = require('./vectors');
const { withQueryCache } = require('./embedder');
const { createRecall } = require('./recall');
const { createConsolidate, EMBED_KINDS } = require('./consolidate');
const { openChecked, createMaintenance, setMeta, getMeta } = require('./maintenance');

const { CortexError } = guard;
const FLUSH_MS = 60000;
const MAX_REINFORCE = 20;

function open({ file = ':memory:', log = () => {}, bus = null, embedder = null, now = Date.now, isIdle = () => true, backups = 3 } = {}) {
  let opened, ok = true;
  try { opened = openChecked({ file, log, now }); } catch (err) {
    log('cortex: cannot open ' + file + ', running in memory: ' + err.message);
    try { bus?.emit('cortex', { level: 'warn', message: 'cortex running in memory' }); } catch { /* listeners */ }
    opened = { db: openDb({ file: ':memory:', log }), quickCheck: err.message, restoredFrom: null, recoveredEmpty: null };
    file = ':memory:'; ok = false;
  }
  const { db } = opened;

  const sources = createSources(db, { now });
  const vectors = createVectors(db, { dim: embedder?.dim || 256, model: embedder?.id || 'none' });
  if (embedder) { try { vectors.markStaleIfModelChanged(); } catch (err) { log('cortex: ' + err.message); } }
  const edges = createEdges(db, { now });
  const maint = createMaintenance({ db, file, now, keep: backups, log, onWipe: () => vectors.trim() });
  const consolidate = createConsolidate({ db, vectors, edges, maintenance: maint, embedder, isIdle, now, log });
  const nodes = createNodes(db, { now, sources, onWrite: (id, kind) => consolidate.queue.push(id, kind) });
  // nodes written while no embedder was set join the embed queue (W1 E8: the model was installed later)
  if (embedder) { try { for (const id of vectors.missingIds([...EMBED_KINDS])) consolidate.queue.push(id); } catch (err) { log('cortex backfill: ' + err.message); } }
  const events = createEvents(db, { now });
  const queryVector = embedder ? withQueryCache(embedder).query : async () => null;
  const recaller = createRecall({ db, edges, vectors, queryVector, now, log });

  // every failure leaves as a CortexError (validation codes as they are, anything else 'internal')
  const safe = fn => (...a) => {
    try { return fn(...a); } catch (err) {
      if (err instanceof CortexError) throw err;
      log('cortex error: ' + err.message);
      throw new CortexError(/readonly|query_only/i.test(err.message) ? 'read_only' : 'internal', err.message);
    }
  };

  const flushTimer = setInterval(() => { try { nodes.flushUses(); } catch (err) { log('cortex flush: ' + err.message); } }, FLUSH_MS);
  flushTimer.unref?.();
  let closed = false;

  const count = t => db.stmt(`SELECT count(*) n FROM ${t}`).get().n;

  const cortex = {
    CortexError,
    source: { add: safe(sources.add), get: safe(sources.get), find: safe(sources.find) },
    node: {
      upsert: safe(nodes.upsert), update: safe(nodes.update), get: safe(nodes.get), find: safe(nodes.find), list: safe(nodes.list),
      archive: safe(nodes.archive),
      remove: safe(id => { const r = nodes.remove(id); vectors.forget(id); return r; }),
    },
    link: safe(edges.link), unlink: safe(edges.unlink), neighbors: safe(edges.neighbors),
    event: { add: safe(events.add), query: safe(events.query), count: safe(events.count), deleteWhere: safe(events.deleteWhere) },
    recall: (query, opts) => recaller.recall(query, opts),   // never throws

    // co-use after a turn: edges among the injected items grow (η 0.15), their use counts tick. A tainted turn changes nothing.
    reinforce: safe((ids, { tainted = false } = {}) => {
      if (tainted) return 0;
      const list = [...new Set(ids || [])].slice(0, MAX_REINFORCE);
      const pairs = [];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j]]);
      edges.strengthen(pairs);
      nodes.touch(list);
      return pairs.length;
    }),
    weaken: safe(ids => edges.weaken(ids)),
    isCorrection: guard.isCorrection,
    consolidate: { tick: opts => consolidate.tick(opts), get queue() { return consolidate.queue.size; } },

    stats: safe(() => {
      const pages = db.raw.prepare('PRAGMA page_count').get().page_count * db.raw.prepare('PRAGMA page_size').get().page_size;
      let wal = 0;
      if (file !== ':memory:') { try { wal = fs.statSync(file + '-wal').size; } catch { /* none */ } }
      const v = vectors.stats();
      return { nodes: count('node'), edges: count('edge'), vectors: v.vectors, events: count('event'), bytes: pages + wal, matrixBytes: v.matrixBytes,
        queue: consolidate.queue.size, mode: embedder ? 'hybrid' : 'keyword', lastConsolidate: consolidate.lastAt() };
    }),
    trim: () => { vectors.trim(); },
    health: () => ({ ok: ok && !db.readOnly, readOnly: db.readOnly, quickCheck: opened.quickCheck, embedder: embedder?.id || null,
      queue: consolidate.queue.size, lastBackupAt: maint.lastBackupAt(), restoredFrom: opened.restoredFrom, recoveredEmpty: opened.recoveredEmpty }),
    // small markers for wave importers (W1 §3); keys and values are short strings
    meta: {
      get: safe(key => getMeta(db, String(key).slice(0, 100))),
      set: safe((key, value) => { setMeta(db, String(key).slice(0, 100), String(value).slice(0, 1000)); }),
    },
    // run fn (which uses only these verbs) as one transaction: all of it or none (W1 §3 import)
    transaction: safe(fn => db.tx(fn)),
    backup: safe(() => maint.backup()),
    export: safe(() => maint.export()),
    wipe: safe(opts => maint.wipe(opts)),
    close() {
      if (closed) return;
      closed = true;
      clearInterval(flushTimer);
      try { nodes.flushUses(); } catch (err) { log('cortex flush: ' + err.message); }
      if (!db.readOnly) { try { setMeta(db, 'clean_close', '1'); } catch { /* next boot runs the full check */ } }
      db.close();
    },
  };
  return cortex;
}

module.exports = { open, CortexError };
