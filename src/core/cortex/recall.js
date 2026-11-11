// Cortex recall (core spec §6): seeds (FTS bm25 + vector cosine, fused by reciprocal rank), two hops of spreading
// activation over effective edge weights, then score and greedy pack into a character budget, one tagged line per item.
const { ftsQuery } = require('./guard');

const DAY = 864e5;
const SEEDS = 20, RRF_K = 60, HOPS = 2, FLOOR = 0.02, MAX_TOUCHED = 200, QUOTA = 0.6;
const LABEL = { user: 'you said', tool: 'tool', import: 'import', wiki: 'wikipedia', web: 'web', model: 'guess' };

function age(ms) {
  const d = Math.max(0, ms) / DAY;
  if (d < 1) return 'today';
  if (d < 30) return Math.floor(d) + 'd';
  if (d < 365) return Math.floor(d / 30) + 'mo';
  return Math.floor(d / 365) + 'y';
}
// plan D6: half weight after 30 idle days, never below 0.5
const recency = (lastMs, now) => 0.5 + 0.5 * Math.pow(0.5, Math.max(0, now - lastMs) / DAY / 30);

function createRecall({ db, edges, vectors, queryVector = async () => null, now = Date.now, log = () => {} }) {
  const rowsFor = ids => db.stmt(`SELECT id, kind, text, status, importance, confidence, updated, last_used FROM node
                                  WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
  const labelsFor = ids => new Map(db.stmt(`SELECT p.node_id id, s.kind, max(s.trust) t FROM provenance p JOIN source s ON s.id = p.source_id
                                            WHERE p.node_id IN (SELECT value FROM json_each(?)) GROUP BY p.node_id`).all(JSON.stringify(ids)).map(r => [r.id, r.kind]));

  async function recall(query, opts = {}) {
    const t0 = performance.now();
    try { return await run(String(query ?? ''), opts, t0); } catch (err) {
      log('cortex recall failed: ' + err.message);
      return { text: '', items: [], ms: performance.now() - t0, mode: 'empty' };
    }
  }

  async function run(query, { budget = 1000, kinds, brief = false, quotas, now: at, debug = false }, t0) {
    const tNow = at ?? now();
    let kindSet = kinds?.length ? new Set(kinds) : null;
    if (brief) { budget = Math.floor(budget / 2); kindSet = new Set([...(kindSet || ['fact', 'entity', 'knowledge', 'reminder', 'track', 'artist', 'playlist', 'file', 'folder'])].filter(k => k !== 'chat')); }
    const kindJson = kindSet ? JSON.stringify([...kindSet]) : null;

    // 1. seeds
    const ranked = [];
    const fq = ftsQuery(query);
    if (fq) ranked.push(db.stmt(`SELECT n.id FROM node_fts JOIN node n ON n.id = node_fts.rowid
                                 WHERE node_fts MATCH ?1 AND n.status = 'active' AND (?2 IS NULL OR n.kind IN (SELECT value FROM json_each(?2)))
                                 ORDER BY bm25(node_fts) LIMIT ${SEEDS}`).all(fq, kindJson).map(r => r.id));
    let usedVector = false;
    const qv = fq || query.trim() ? await queryVector(query) : null;
    if (qv) {
      const hits = vectors.search(qv, SEEDS * 2).map(h => h.id);
      const live = new Map(rowsFor(hits).map(r => [r.id, r]));
      const ok = hits.filter(id => { const r = live.get(id); return r && r.status === 'active' && (!kindSet || kindSet.has(r.kind)); }).slice(0, SEEDS);
      if (ok.length) { ranked.push(ok); usedVector = true; }
    }
    const a = new Map();
    for (const list of ranked) list.forEach((id, i) => a.set(id, (a.get(id) || 0) + 1 / (RRF_K + i + 1)));
    if (!a.size) return { text: '', items: [], ms: performance.now() - t0, mode: 'empty', ...(debug && { stages: { seeds: [], spread: [], packed: [] } }) };
    const top = Math.max(...a.values());
    for (const [id, v] of a) a.set(id, v / top);   // strongest seed = 1, so the 0.02 floor means the same at any corpus size
    const seeds = debug ? [...a].map(([id, v]) => ({ id, a: v })) : null;

    // 2. spread: two hops, each hop passes on what it gained, capped at 200 touched nodes
    let frontier = [...a].sort((x, y) => y[1] - x[1]);
    for (let hop = 1; hop <= HOPS && frontier.length; hop++) {
      const gained = new Map(), damp = Math.pow(0.5, hop);
      for (const [m, am] of frontier) {
        if (am < FLOOR) break;
        for (const e of edges.around(m, tNow, null)) {
          const c = am * e.weight * damp;
          if (c < FLOOR) continue;
          if (!a.has(e.id) && a.size >= MAX_TOUCHED) continue;
          a.set(e.id, (a.get(e.id) || 0) + c);
          gained.set(e.id, (gained.get(e.id) || 0) + c);
        }
      }
      frontier = [...gained].sort((x, y) => y[1] - x[1]);
    }

    // 3. score and pack
    const ids = [...a.keys()];
    const labels = labelsFor(ids);
    const cands = [];
    for (const r of rowsFor(ids)) {
      if (r.status !== 'active' || (kindSet && !kindSet.has(r.kind))) continue;
      const score = a.get(r.id) * (0.6 + 0.4 * r.confidence / 100) * (1 + 0.3 * r.importance) * recency(r.last_used ?? r.updated, tNow);
      cands.push({ r, score });
    }
    cands.sort((x, y) => y.score - x.score);

    const kindsWith = new Set(cands.map(c => c.r.kind));
    const cap = kind => (kindsWith.size < 2 ? Infinity : budget * (quotas?.[kind] ?? QUOTA));
    const usedBy = {}, lines = [], items = [], deferred = [];
    let used = 0;
    const take = (c, line) => {
      used += line.length + (lines.length ? 1 : 0);
      usedBy[c.r.kind] = (usedBy[c.r.kind] || 0) + line.length;
      lines.push(line);
      items.push({ id: c.r.id, kind: c.r.kind, score: c.score, source: LABEL[labels.get(c.r.id)] || 'guess', age: age(tNow - c.r.updated) });
    };
    for (const c of cands) {
      const line = `${c.r.text} [${LABEL[labels.get(c.r.id)] || 'guess'} · ${age(tNow - c.r.updated)}]`;
      const cost = line.length + (lines.length ? 1 : 0);
      if (used + cost > budget) continue;
      if ((usedBy[c.r.kind] || 0) + line.length > cap(c.r.kind)) { deferred.push([c, line]); continue; }
      take(c, line);
    }
    for (const [c, line] of deferred) if (used + line.length + (lines.length ? 1 : 0) <= budget) take(c, line);   // leftover released

    const out = { text: lines.join('\n'), items, ms: performance.now() - t0, mode: usedVector ? 'hybrid' : 'keyword' };
    if (debug) out.stages = { seeds, spread: [...a].map(([id, v]) => ({ id, a: v })), packed: items };
    return out;
  }

  return { recall };
}

module.exports = { createRecall, age, recency };
