// Cortex recall (core spec §6): seeds (FTS bm25 + vector cosine, fused by strength-weighted reciprocal rank), two hops of spreading
// activation over typed, directed, confidence-aware edges, then score and greedy pack into a character budget, one tagged line per item.
// `debug: true` adds `stages` (what each stage produced) and `explain` (why each packed item is there and what was left out).
const { ftsTokens, ftsOr } = require('./guard');
const { PROPAGATE, REVERSE } = require('./edges');

const DAY = 864e5;
const COMMON_DF = 1000, DF_TTL = 10 * 60e3, DF_CACHE = 4096;
const SEEDS = 20, RRF_K = 60, HOPS = 2, FLOOR = 0.02, MAX_TOUCHED = 200, QUOTA = 0.6, MAX_EXPAND = 40;
// A vector hit counts only when it is this similar in absolute terms AND within VEC_BAND of the best hit: without both,
// the 40 nearest neighbours of an unrelated query would seed the spread at full strength (rank-based fusion cannot tell).
// Calibrated on nomic-embed-text@768 (scripts/cortex-retrieval-bench.js --embedder ollama): related text scored 0.54-0.93, unrelated 0.42-0.50 (27-node world, 3 no-answer queries: re-check on a real store).
const VEC_FLOOR = 0.52, VEC_BAND = 0.15;
// A lexical hit scoring under this share of the best one matched only a generic word of the query.
const FTS_BAND = 0.35;
const CONTEXT_WEIGHT = 0.2;
const REL_BAND = 0.05, REL_SPAN = 0.15, REL_FLOOR = 0.1;   // sweep-chosen: within 0.05 cosine of the best candidate costs nothing, 0.2 away is at the floor
// Two similar facts (a consolidation link, not a copy) are usually an old and a new version of one thing: the older one counts for less.
const STALE_PENALTY = 0.6;
// A candidate scoring under this share of the best one is the far tail of the spread: it would only fill the budget. With a query
// vector (which also keeps off-topic neighbours down) the bar is high; keyword-only, a weak two-hop path is all there is, so it is kept.
// Scores fall off a cliff between the answer and the tail: a candidate under 80% of the one before it ends the list.
const GAP = 0.8;
const MIN_SHARE = 0.25, MIN_SHARE_KEYWORD = 0.05;
// A node nobody stands behind (confidence under 50: a model's guess, an unverified web line) is not pulled in by association alone.
const SPECULATIVE = 50, SPECULATIVE_PULL = 0.4;
const DUP_SIM = 0.88, DUP_TEXT = 0.9, DUP_MIN_TOKENS = 4;   // near-duplicates of a line already packed are skipped
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
// How often a node was used adds at most 10%: being recalled often must not keep an old, unconfirmed fact on top (it is not freshness).
const usage = uses => 1 + 0.1 * Math.min(1, Math.log1p(uses || 0) / Math.log(21));
// Old but important things keep their weight: the user's profile tier and anything rated important decay to 0.9, not 0.5.
const IMPORTANT = 0.8, FRESH_FLOOR = 0.7;   // a never-confirmed old fact keeps 70% of a fresh one's weight; explicit replacements are handled by supersedes and the stale penalty
const freshness = (r, now) => {
  const f = recency(r.updated, now);
  const lo = r.tier === 'profile' || r.importance >= IMPORTANT ? 0.9 : FRESH_FLOOR;
  return lo + (1 - lo) * (f - 0.5) / 0.5;
};
const confidenceOf = r => 0.6 + 0.4 * r.confidence / 100;
const words = text => new Set(ftsTokens(text));
function overlap(a, b) {
  if (a.size < DUP_MIN_TOKENS || b.size < DUP_MIN_TOKENS) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

function createRecall({ db, edges, vectors, queryVector = async () => null, now = Date.now, log = () => {}, commonDf = COMMON_DF, onActivity = null, vecFloor = VEC_FLOOR, vecBand = VEC_BAND }) {
  // Document frequency, counted only up to commonDf + 1 (cheap), cached for a while: it changes slowly.
  const dfCache = new Map();
  function df(token) {
    const hit = dfCache.get(token);
    if (hit && now() - hit.at < DF_TTL) return hit.n;
    const n = db.stmt('SELECT count(*) n FROM (SELECT rowid FROM node_fts WHERE node_fts MATCH ? LIMIT ?)').get(`"${token}"`, commonDf + 1).n;
    if (n <= commonDf) return n;   // rare words are cheap to count, and caching them would hide a word written a moment later
    dfCache.set(token, { n, at: now() });
    if (dfCache.size > DF_CACHE) dfCache.delete(dfCache.keys().next().value);
    return n;
  }
  // A word in more than commonDf nodes is near-stopword for this store: ranking every node it is in costs tens of ms
  // and says little. Such words are dropped when a rarer word is in the query; if all are common, the rarest stays.
  function seedQuery(query) {
    const toks = ftsTokens(query).map(t => ({ t, n: df(t) })).filter(x => x.n > 0);
    if (!toks.length) return null;
    const rare = toks.filter(x => x.n <= commonDf);
    return ftsOr((rare.length ? rare : [toks.reduce((a, b) => (b.n < a.n ? b : a))]).map(x => x.t));
  }

  const SELECT_ROWS = `SELECT id, kind, text, status, importance, confidence, uses, created, updated, last_used, json_extract(data, '$.tier') tier,
                       json_extract(data, '$.expires') expires FROM node WHERE id IN (SELECT value FROM json_each(?))`;
  // rows are read once per recall: `have` is the per-recall cache, `load` fetches only what is missing
  const loader = () => {
    const have = new Map();
    return {
      have,
      load(ids) {
        const need = ids.filter(id => !have.has(id));
        if (need.length) for (const r of db.stmt(SELECT_ROWS).all(JSON.stringify(need))) have.set(r.id, r);
        return ids.map(id => have.get(id)).filter(Boolean);
      },
    };
  };
  const labelsFor = ids => new Map(db.stmt(`SELECT p.node_id id, s.kind, max(s.trust) t FROM provenance p JOIN source s ON s.id = p.source_id
                                            WHERE p.node_id IN (SELECT value FROM json_each(?)) GROUP BY p.node_id`).all(JSON.stringify(ids)).map(r => [r.id, r.kind]));
  // links between the candidates that say "this disputes that" or "this is a copy of that"
  const RELATIONS = `SELECT src, dst, type, weight, last_used FROM edge WHERE type IN ('contradicts', 'similar', 'same_as') AND src IN (SELECT value FROM json_each(?1))
                     UNION ALL SELECT src, dst, type, weight, last_used FROM edge WHERE type IN ('contradicts', 'similar', 'same_as') AND dst IN (SELECT value FROM json_each(?1))`;

  async function recall(query, opts = {}) {
    const t0 = performance.now();
    try { return await run(String(query ?? ''), opts, t0); } catch (err) {
      log('cortex recall failed: ' + err.message);
      return { text: '', items: [], ms: performance.now() - t0, mode: 'empty' };
    }
  }

  async function run(query, { budget = 1000, kinds, brief = false, quotas, exclude, now: at, debug = false, context = '' }, t0) {
    const tNow = at ?? now(), nowIso = new Date(tNow).toISOString();
    const skip = exclude ? new Set(exclude) : null;   // spread through, never packed (W1 E2: profile facts already in the prompt)
    let kindSet = kinds?.length ? new Set(kinds) : null;
    if (brief) { budget = Math.floor(budget / 2); kindSet = new Set([...(kindSet || ['fact', 'entity', 'knowledge', 'reminder', 'track', 'artist', 'playlist', 'file', 'folder'])].filter(k => k !== 'chat')); }
    const kindJson = kindSet ? JSON.stringify([...kindSet]) : null;
    const rows = loader();
    const why = debug ? new Map() : null;   // id → { fts, vec, via[] }
    const note = id => { let w = why.get(id); if (!w) why.set(id, w = { via: [] }); return w; };

    // 1. seeds: each list is rank-fused, but a weak hit counts for less than a strong one (rank alone cannot tell them apart)
    const lists = [];
    const fq = seedQuery(query);
    if (fq) {
      const hits = db.stmt(`SELECT n.id, -bm25(node_fts) s FROM node_fts JOIN node n ON n.id = node_fts.rowid
                            WHERE node_fts MATCH ?1 AND n.status = 'active' AND (?2 IS NULL OR n.kind IN (SELECT value FROM json_each(?2))) AND coalesce(json_extract(n.data, '$.expires'), '9') >= ?3
                            ORDER BY bm25(node_fts) LIMIT ${SEEDS}`).all(fq, kindJson, nowIso);
      const strong = hits.filter(h => !(hits[0].s > 0) || h.s >= FTS_BAND * hits[0].s);
      if (strong.length) lists.push({ name: 'fts', hits: strong.map(h => ({ id: h.id, s: h.s })) });
    }
    // what the user is doing right now (the open chat's topic, the track playing, the window in front): the same lexical search,
    // weighed lightly, so it breaks ties between equally good answers but never outvotes the question
    let ctxHits = null;
    const cq = context ? seedQuery(String(context)) : null;
    if (cq) {
      const hits = db.stmt(`SELECT n.id, -bm25(node_fts) s FROM node_fts JOIN node n ON n.id = node_fts.rowid
                            WHERE node_fts MATCH ?1 AND n.status = 'active' AND (?2 IS NULL OR n.kind IN (SELECT value FROM json_each(?2))) AND coalesce(json_extract(n.data, '$.expires'), '9') >= ?3
                            ORDER BY bm25(node_fts) LIMIT ${SEEDS}`).all(cq, kindJson, nowIso).filter((h, _, all) => h.s >= FTS_BAND * all[0].s);
      if (hits.length) ctxHits = hits;
    }
    let usedVector = false;
    const qv = fq || query.trim() ? await queryVector(query) : null;
    if (qv) {
      const found = vectors.search(qv, SEEDS * 2);
      const live = new Map(rows.load(found.map(h => h.id)).map(r => [r.id, r]));
      const ok = found.filter(h => { const r = live.get(h.id); return r && r.status === 'active' && !(r.expires && r.expires < nowIso) && (!kindSet || kindSet.has(r.kind)); });
      const cut = ok.length ? Math.max(vecFloor, ok[0].score - vecBand) : 0;
      const close = ok.filter(h => h.score >= cut).slice(0, SEEDS);
      if (close.length) { lists.push({ name: 'vec', hits: close.map(h => ({ id: h.id, s: h.score })) }); usedVector = true; }
    }
    // context only nudges what the question already found; with nothing found it stands in for the question ("what about that one?")
    if (ctxHits) {
      const known = new Set(lists.flatMap(l => l.hits.map(h => h.id)));
      const hits = lists.length ? ctxHits.filter(h => known.has(h.id)) : ctxHits;
      if (hits.length) lists.push({ name: 'ctx', w: lists.length ? CONTEXT_WEIGHT : 1, hits });
    }
    const a = new Map(), direct = new Set(), vecSeeds = new Set(lists.find(l => l.name === 'vec')?.hits.map(h => h.id) || []);
    for (const { name, hits, w = 1 } of lists) {
      const best = hits[0].s > 0 ? hits[0].s : 1;
      hits.forEach((h, i) => {
        const rel = Math.max(0, Math.min(1, h.s / best));
        a.set(h.id, (a.get(h.id) || 0) + w * (1 / (RRF_K + i + 1)) * (0.5 + 0.5 * rel)); direct.add(h.id);
        if (why) note(h.id)[name] = { rank: i + 1, score: +h.s.toFixed(4) };
      });
    }
    if (!a.size) return { text: '', items: [], ms: performance.now() - t0, mode: 'empty', ...(debug && { stages: { seeds: [], spread: [], packed: [] }, explain: { items: [], dropped: [] } }) };
    const top = Math.max(...a.values());
    for (const [id, v] of a) a.set(id, v / top);   // strongest seed = 1, so the 0.02 floor means the same at any corpus size
    const seeds = debug ? [...a].map(([id, v]) => ({ id, a: v })) : null;
    if (why) for (const [id, v] of a) note(id).seed = +v.toFixed(4);
    const seedIds = onActivity ? [...a.keys()] : null, trail = [];   // what the wallpaper shows: where it started and the links followed
    rows.load([...a.keys()]);

    // 2. spread: two hops, each hop passes on what it gained. An edge passes activation by its type and direction, scaled by how
    // well established the node it leaves is; activations meeting at a node combine as a probabilistic OR, so they stay below 1 and a
    // hub reached from many places cannot outrank the things that were actually asked for. A node never passes back to the one it came from.
    let frontier = [...a].sort((x, y) => y[1] - x[1]);
    const cameFrom = new Map();   // node → the nodes that activated it in the previous hop
    for (let hop = 1; hop <= HOPS && frontier.length; hop++) {
      const damp = Math.pow(0.5, hop), gain = new Map();   // id → { rest: Π(1 − c), from: Set }
      const expand = [];
      for (const f of frontier.slice(0, MAX_EXPAND)) {   // strongest first; the rest carry little
        if (f[1] * damp < FLOOR) break;   // weights are ≤ 1: nothing it passes on could reach the floor (sorted, so none after it can)
        expand.push(f);
      }
      for (const r of rows.load(expand.map(f => f[0]))) void r;
      for (const [m, am] of expand) {
        const mr = rows.have.get(m);
        if (mr && mr.status !== 'active') continue;   // an archived or pending node has no say in what is recalled
        const carry = am * (mr ? 0.5 + 0.5 * mr.confidence / 100 : 1) * damp;
        const back = cameFrom.get(m);
        for (const e of edges.around(m, tNow, null)) {
          const f = (PROPAGATE[e.type] ?? 0.5) * (e.out === false ? (REVERSE[e.type] ?? 1) : 1);
          const c = carry * e.weight * f;
          if (c < FLOOR || back?.has(e.id)) continue;
          if (!a.has(e.id) && !gain.has(e.id) && a.size + gain.size >= MAX_TOUCHED) continue;
          let g = gain.get(e.id);
          if (!g) gain.set(e.id, g = { rest: 1, from: new Set() });
          g.rest *= 1 - c; g.from.add(m);
          if (trail && trail.length < 240) trail.push([m, e.id, hop]);
          if (why) note(e.id).via.push({ from: m, type: e.type, dir: e.out ? 'out' : 'in', hop, c: +c.toFixed(4) });
        }
      }
      // only active nodes take activation (and pass it on)
      const live = new Map(rows.load([...gain.keys()]).map(r => [r.id, r]));
      const gained = new Map();
      cameFrom.clear();
      for (const [id, g] of gain) {
        if (live.get(id)?.status !== 'active') continue;
        const v = (1 - g.rest) * (live.get(id).confidence < SPECULATIVE ? SPECULATIVE_PULL : 1), prev = a.get(id) || 0;
        a.set(id, 1 - (1 - prev) * (1 - v));
        gained.set(id, v); cameFrom.set(id, g.from);
      }
      frontier = [...gained].sort((x, y) => y[1] - x[1]);
    }

    // 3. score and pack
    const ids = [...a.keys()];
    const labels = labelsFor(ids);
    // Nodes reached only by association are checked against the question itself: a neighbour whose text is unrelated to it counts for less.
    // Every candidate with a vector is also held against the best-matching one: how much less like the question than the closest
    // candidate it is. This is what tells "Rex's vet visit" from "Rex's favourite toy" when both only share the name.
    const sim = qv ? vectors.similarity(qv, ids) : new Map();
    const isName = id => rows.have.get(id)?.kind === 'entity';   // a bare name is close to any question that mentions it: it is no yardstick
    const bestSim = Math.max(-1, ...[...sim].filter(([id]) => !skip?.has(id) && !isName(id)).map(([, x]) => x));
    const related = id => {
      const x = sim.get(id);
      if (x === undefined || vecSeeds.has(id)) return 1;   // a vector hit already passed the band; this judges the rest
      const away = Math.max(0, bestSim - x - REL_BAND), rel = Math.max(REL_FLOOR, 1 - away / REL_SPAN);
      const abs = direct.has(id) || x >= vecFloor ? 1 : 0.5 + 0.5 * Math.max(0, (x - (vecFloor - 0.2)) / 0.2);
      return Math.min(rel, abs);
    };
    const cands = [];
    for (const r of rows.load(ids)) {
      if (r.status !== 'active' || (kindSet && !kindSet.has(r.kind)) || skip?.has(r.id) || (r.expires && r.expires < nowIso)) continue;   // temporary notes lapse (data.expires is an ISO date: a 13-digit epoch looks like a card number to the guard)
      const parts = { activation: a.get(r.id), confidence: confidenceOf(r), importance: 1 + 0.3 * r.importance, freshness: freshness(r, tNow), use: usage(r.uses), relevance: related(r.id) };
      cands.push({ r, parts, score: parts.activation * parts.confidence * parts.importance * parts.freshness * parts.use * parts.relevance });
    }
    cands.sort((x, y) => y.score - x.score);

    // Which candidates are disputed by a better-established one, and which are copies of each other. Only the best-scoring
    // candidates are looked at: that is all the budget can hold.
    const inPlay = new Map(cands.slice(0, 80).map(c => [c.r.id, c]));
    const disputedBy = new Map(), copyOf = new Map(), similarPairs = [];
    if (inPlay.size > 1) {
      for (const e of db.stmt(RELATIONS).all(JSON.stringify([...inPlay.keys()]))) {
        if (!inPlay.has(e.src) || !inPlay.has(e.dst)) continue;
        if (e.type === 'contradicts') { (disputedBy.get(e.src) || disputedBy.set(e.src, []).get(e.src)).push(e.dst); }
        else if (e.type === 'similar' && e.weight < DUP_SIM) similarPairs.push([e.src, e.dst]);
        else if (e.type === 'same_as' || e.weight >= DUP_SIM) {
          (copyOf.get(e.src) || copyOf.set(e.src, new Set()).get(e.src)).add(e.dst);
          (copyOf.get(e.dst) || copyOf.set(e.dst, new Set()).get(e.dst)).add(e.src);
        }
      }
    }

    // the older of two similar-but-not-identical candidates yields to the newer one, unless the older is the better established
    for (const [x, y] of similarPairs) {
      const [older, newer] = inPlay.get(x).r.updated <= inPlay.get(y).r.updated ? [inPlay.get(x), inPlay.get(y)] : [inPlay.get(y), inPlay.get(x)];
      if (older.r.updated === newer.r.updated || older.r.confidence > newer.r.confidence || older.parts.stale) continue;
      older.parts.stale = STALE_PENALTY; older.score *= STALE_PENALTY;
    }
    cands.sort((x, y) => y.score - x.score);

    const kindsWith = new Set(cands.map(c => c.r.kind));
    const cap = kind => (kindsWith.size < 2 ? Infinity : budget * (quotas?.[kind] ?? QUOTA));
    const usedBy = {}, lines = [], items = [], deferred = [], dropped = [], packedWords = [];
    const packedIds = new Set();
    let used = 0;
    const take = (c, line) => {
      used += line.length + (lines.length ? 1 : 0);
      usedBy[c.r.kind] = (usedBy[c.r.kind] || 0) + line.length;
      lines.push(line); packedIds.add(c.r.id); packedWords.push(words(c.r.text));
      items.push({ id: c.r.id, kind: c.r.kind, score: c.score, source: LABEL[labels.get(c.r.id)] || 'guess', age: age(tNow - c.r.updated) });
    };
    // why a candidate is not worth a line: its slot is disputed by a node the user (or a better source) stands behind, or it repeats one
    const redundant = c => {
      const rival = disputedBy.get(c.r.id)?.find(id => inPlay.has(id));
      if (rival !== undefined) return { reason: 'contradicted', by: rival };
      for (const id of copyOf.get(c.r.id) || []) if (packedIds.has(id)) return { reason: 'duplicate', by: id };
      const w = words(c.r.text);
      if (packedWords.some(p => overlap(p, w) >= DUP_TEXT)) return { reason: 'duplicate', by: null };
      return null;
    };
    const lead = cands.find(c => c.r.kind !== 'entity') || cands[0];
    const floor = lead ? lead.score * (qv ? MIN_SHARE : MIN_SHARE_KEYWORD) : 0;
    // The cliff is looked for among what the question found itself. What association added (a second hop) is always lower than its
    // source, so a cliff there is the shape of every multi-hop answer, not a sign of a tail; it is held to the floor and to relevance instead.
    const prevDirect = {};   // per kind: a chat summary is not measured against a fact
    for (const c of cands) {
      const skipWhy = redundant(c);
      if (skipWhy) { if (debug) dropped.push({ id: c.r.id, ...skipWhy }); continue; }
      const pacing = c.r.kind !== 'entity' && direct.has(c.r.id);   // names of things anchor a result but do not set its pace
      if (c.score < floor || (pacing && prevDirect[c.r.kind] !== undefined && c.score < prevDirect[c.r.kind] * GAP)) { if (debug) dropped.push({ id: c.r.id, reason: 'weak', by: null }); continue; }
      const line = `${c.r.text} [${LABEL[labels.get(c.r.id)] || 'guess'} · ${age(tNow - c.r.updated)}]`;
      const cost = line.length + (lines.length ? 1 : 0);
      if (used + cost > budget) continue;
      if (pacing) prevDirect[c.r.kind] = c.score;
      if ((usedBy[c.r.kind] || 0) + line.length > cap(c.r.kind)) { deferred.push([c, line]); continue; }
      take(c, line);
    }
    for (const [c, line] of deferred) if (used + line.length + (lines.length ? 1 : 0) <= budget && !redundant(c)) take(c, line);   // leftover released

    const out = { text: lines.join('\n'), items, ms: performance.now() - t0, mode: usedVector ? 'hybrid' : 'keyword' };
    if (onActivity) { try { onActivity({ seeds: seedIds, trail, items: items.map(i => i.id) }); } catch { /* the picture must never break recall */ } }
    if (debug) {
      out.stages = { seeds, spread: [...a].map(([id, v]) => ({ id, a: v })), packed: items };
      const byId = new Map(cands.map(c => [c.r.id, c]));
      out.explain = {
        items: items.map(i => {
          const w = why.get(i.id) || { via: [] }, c = byId.get(i.id);
          return { id: i.id, score: +i.score.toFixed(4), seed: w.seed ?? null, fts: w.fts ?? null, vec: w.vec ?? null,
            hops: w.seed !== undefined ? 0 : Math.min(...w.via.map(v => v.hop)), via: w.via.slice(0, 6),
            factors: Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, +v.toFixed(4)])) };
        }),
        dropped,
      };
    }
    return out;
  }

  return { recall };
}

module.exports = { createRecall, age, recency };
