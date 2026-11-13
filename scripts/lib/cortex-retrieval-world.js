// Deterministic retrieval world for the cortex relevance bench and its regression test.
// A hand-written personal memory (facts, entities, chats, slot conflicts, duplicates, stale and speculative nodes)
// plus optional seeded filler, labeled queries with graded relevance, and the metrics. No network, no clock, no randomness
// beyond the fixed seed. The fake embedder's synonym table stands in for semantic similarity (same device the unit tests use).
const { openDb } = require('../../src/core/cortex/db');
const { createSources } = require('../../src/core/cortex/sources');
const { createNodes } = require('../../src/core/cortex/nodes');
const { createEdges } = require('../../src/core/cortex/edges');
const { createVectors } = require('../../src/core/cortex/vectors');
const { createFakeEmbedder, withQueryCache } = require('../../src/core/cortex/embedder');
const { ftsTokens } = require('../../src/core/cortex/guard');

const DAY = 864e5;
const T0 = Date.UTC(2026, 10, 1);
const DIM = 1024;   // wide, so hashed-word collisions in very short filler texts stay rare
const SYN = { pooch: 'rex', doctor: 'vet', checkup: 'appointment', vehicle: 'car', automobile: 'subaru', maintenance: 'oil', sibling: 'maya', residence: 'portland', profession: 'nurse',
  beverage: 'coffee', favorite: 'prefer', brew: 'roast', dwelling: 'live', hometown: 'live' };
const OPTS = { kinds: ['fact', 'entity', 'chat'], budget: 460, quotas: { fact: 0.5, entity: 0.2, chat: 0.5 } };

// A real embedding model gives function words almost no weight; the hashed fake counts them like any word. Dropping them first
// keeps the fake's similarity about content words, so the bench measures retrieval and not the fake's stopword noise.
const contentOnly = base => ({ ...base, embed: (texts, o) => base.embed(texts.map(t => ftsTokens(t).join(' ')), o) });

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

// name, kind, text, source kind, days ago written, extra
const NODES = [
  ['rex', 'entity', 'Rex', 'user', 400, { key: 'entity:rex' }],
  ['maya', 'entity', 'Maya', 'user', 400, { key: 'entity:maya' }],
  ['vet', 'fact', 'Rex has a vet appointment on March 14', 'user', 20, {}],
  ['clinic', 'fact', 'The clinic for Rex is Parkside Animal Hospital on Elm Street', 'user', 90, {}],
  ['breed', 'fact', 'Rex is a golden retriever, three years old', 'user', 300, {}],
  ['food', 'fact', 'Rex eats Orijen salmon kibble twice a day', 'user', 200, {}],
  ['toy', 'fact', 'Rex loves his red rubber ball more than anything', 'user', 150, {}],
  ['swim', 'fact', 'Rex probably enjoys swimming at the lake', 'model', 100, {}],
  ['sister', 'fact', 'Maya lives in Portland and works as a nurse', 'user', 250, {}],
  ['bday', 'fact', 'Maya has a birthday on August 3', 'user', 250, {}],
  ['mugs', 'fact', 'She collects ceramic mugs and loves succulent plants', 'user', 120, {}],
  ['denver', 'fact', 'I live in Denver, I moved in September', 'user', 60, {}],
  ['austin', 'fact', 'I live in Austin near the river', 'user', 1100, {}],
  ['dentist', 'fact', 'My dentist is Dr. Alvarez with an appointment every six months', 'user', 70, {}],
  ['car', 'fact', 'My car is a 2019 Subaru Outback due for an oil change in December', 'user', 40, {}],
  ['coffee', 'fact', 'I prefer dark roast coffee with no sugar', 'user', 180, {}],
  ['laptop', 'fact', 'My work laptop is a ThinkPad X1 running Linux', 'user', 160, {}],
  ['editor1', 'fact', 'My editor is vim', 'user', 400, { key: 'pref:editor' }],
  ['editor2', 'fact', 'My editor is VS Code', 'user', 30, { key: 'pref:editor' }],
  ['editorGuess', 'fact', 'Probably uses emacs for editing', 'model', 20, { key: 'pref:editor' }],
  ['standup1', 'fact', 'Standup meeting is every weekday at 9:30 am', 'user', 80, {}],
  ['standup2', 'fact', 'The weekday standup meeting is at 9:30 am', 'import', 80, {}],
  ['standup3', 'fact', 'Daily standup at 9:30 am on weekdays', 'tool', 70, {}],
  ['hike', 'fact', 'Might enjoy hiking on weekends', 'model', 30, {}],
  ['tea', 'fact', 'Possibly likes green tea in the afternoon', 'model', 30, {}],
  ['allergy', 'fact', 'I am allergic to penicillin so tell any doctor', 'user', 1500, { importance: 0.9 }],
  ['lunch', 'fact', 'Had a sandwich at the cafe next to the doctor office', 'user', 5, { importance: 0.2 }],
  ['parking', 'fact', 'Parked the car on level 3 spot 14', 'user', 2, { data: { expires: new Date(T0 - DAY).toISOString() } }],
  ['job1', 'fact', 'I work at Initech as an analyst', 'user', 800, {}],
  ['job2', 'fact', 'I work at Globex as a manager', 'user', 40, {}],
  ['chatVet', 'chat', 'We talked about scheduling Rex for his yearly vaccines and checkup', 'model', 25, {}],
  ['chatTrip', 'chat', 'Planned a weekend trip to Boulder with a hike and a dinner reservation', 'model', 45, {}],
];
// [src, dst, type, weight, srcKindOverride] (production writes mentions at 0.5)
const EDGES = [
  ['vet', 'rex', 'mentions', 0.5], ['clinic', 'rex', 'mentions', 0.5], ['breed', 'rex', 'mentions', 0.5], ['food', 'rex', 'mentions', 0.5],
  ['toy', 'rex', 'mentions', 0.5], ['swim', 'rex', 'mentions', 0.5], ['chatVet', 'rex', 'mentions', 0.5], ['chatVet', 'vet', 'about', 0.5],
  ['sister', 'maya', 'mentions', 0.5], ['bday', 'maya', 'mentions', 0.5], ['mugs', 'maya', 'mentions', 0.5],
  ['hike', 'chatTrip', 'touched', 0.7], ['tea', 'chatTrip', 'touched', 0.7], ['hike', 'rex', 'touched', 0.7], ['tea', 'rex', 'touched', 0.7],
  ['job1', 'job2', 'similar', 0.84], ['austin', 'denver', 'similar', 0.84],
  ['standup1', 'standup2', 'similar', 0.9], ['standup1', 'standup3', 'similar', 0.9], ['standup2', 'standup3', 'similar', 0.9],
];

// grade 2 = the answer, 1 = useful context, 0/absent = irrelevant; `neutral` = hubs that neither help nor count against
const QUERIES = [
  // exact factual recall
  { cat: 'exact', q: 'what dog food does Rex eat', rel: { food: 2 }, neutral: ['rex'] },
  { cat: 'exact', q: 'when is the vet appointment for Rex', rel: { vet: 2, clinic: 1, chatVet: 1 }, neutral: ['rex'] },
  { cat: 'exact', q: 'what is my work laptop', rel: { laptop: 2 } },
  { cat: 'exact', q: 'what time is the standup meeting', rel: { standup1: 2, standup2: 2, standup3: 2 }, dup: [['standup1', 'standup2', 'standup3']] },
  { cat: 'exact', q: 'which car do I have and when is the oil change', rel: { car: 2 } },
  // semantic recall, different wording (only the vector path can see these)
  { cat: 'semantic', q: 'pooch doctor checkup soon', rel: { vet: 2, chatVet: 1, clinic: 1 }, neutral: ['rex'] },
  { cat: 'semantic', q: 'vehicle automobile maintenance schedule', rel: { car: 2 } },
  { cat: 'semantic', q: 'beverage favorite brew', rel: { coffee: 2 } },
  { cat: 'semantic', q: 'sibling residence profession', rel: { sister: 2, bday: 1 }, neutral: ['maya'] },
  // multi-hop: the answer shares no word with the question and is reached through the entity
  { cat: 'multihop', q: 'gift ideas for Maya birthday', rel: { bday: 2, mugs: 2, sister: 1 }, neutral: ['maya'] },
  { cat: 'multihop', q: 'what should I know about Rex', rel: { breed: 2, vet: 1, food: 1, toy: 1, clinic: 1 }, neutral: ['rex'] },
  // related to the same hub but not to the question
  { cat: 'related-irrelevant', q: 'when is the vet appointment for Rex', rel: { vet: 2, clinic: 1 }, bad: ['toy', 'food', 'breed', 'swim', 'dentist'], neutral: ['rex', 'chatVet'] },
  { cat: 'related-irrelevant', q: 'what is the dentist appointment schedule', rel: { dentist: 2 }, bad: ['vet', 'clinic'], neutral: [] },
  // conflicting memories
  { cat: 'conflict', q: 'what editor do I use for coding', rel: { editor2: 2 }, bad: ['editor1', 'editorGuess'] },
  { cat: 'conflict', q: 'which editor is my favorite editor', rel: { editor2: 2 }, bad: ['editor1', 'editorGuess'] },
  // outdated information that was never explicitly superseded
  { cat: 'outdated', q: 'where do I live now', rel: { denver: 2 }, bad: ['austin'] },
  { cat: 'outdated', q: 'dwelling hometown today', rel: { denver: 2 }, bad: ['austin'] },
  // duplicates must not eat the budget
  { cat: 'duplicate', q: 'daily standup meeting time on weekdays', rel: { standup1: 2, standup2: 2, standup3: 2 }, dup: [['standup1', 'standup2', 'standup3']], opts: { budget: 130 } },
  { cat: 'duplicate', q: 'when does the weekday standup meeting start', rel: { standup1: 2, standup2: 2, standup3: 2 }, dup: [['standup1', 'standup2', 'standup3']], opts: { budget: 130 } },
  // weak model inferences linked by behavioural edges must not outrank what the user said
  { cat: 'weak-inference', q: 'when is the vet appointment for Rex', rel: { vet: 2, clinic: 1 }, bad: ['hike', 'tea', 'swim'], neutral: ['rex', 'chatVet'] },
  { cat: 'weak-inference', q: 'what should I know about Rex', rel: { breed: 2, vet: 1, food: 1, toy: 1, clinic: 1 }, bad: ['hike', 'tea'], neutral: ['rex'] },
  // tiny budgets: the answer must be the one thing that fits
  { cat: 'tiny-budget', q: 'when is the vet appointment for Rex', rel: { vet: 2 }, neutral: ['rex'], opts: { budget: 100 } },
  { cat: 'tiny-budget', q: 'what dog food does Rex eat', rel: { food: 2 }, neutral: ['rex'], opts: { budget: 90 } },
  { cat: 'tiny-budget', q: 'what is my work laptop', rel: { laptop: 2 }, opts: { budget: 80 } },
  // older but important, temporary notes that lapsed, and the thing the user is doing right now
  { cat: 'important-old', q: 'what should the doctor know about my allergies', rel: { allergy: 2 }, bad: ['lunch'] },
  { cat: 'temporary', q: 'where did I park the car', rel: { car: 1 }, bad: ['parking'] },
  { cat: 'updated-info', q: 'where do I work', rel: { job2: 2 }, bad: ['job1'] },
  { cat: 'live-context', q: 'when is the next appointment', rel: { vet: 2 }, bad: ['dentist'], neutral: ['rex', 'chatVet', 'clinic'], opts: { context: 'Rex' } },
  // nothing in memory answers these: the right result is nothing
  { cat: 'no-answer', q: 'explain quantum chromodynamics gluon confinement', rel: {}, empty: true },
  { cat: 'no-answer', q: 'what is the capital city of Mongolia', rel: {}, empty: true },
  { cat: 'no-answer', q: 'how do I bake sourdough bread at home', rel: {}, empty: true },
];

// seeded filler: long-tail words plus the common English words, some embedded, some linked into the Rex hub
function vocab(r, n) {
  const syl = ['ka', 'lo', 'mi', 're', 'su', 'ta', 'ne', 'po', 'vi', 'da', 'ri', 'go', 'be', 'fu', 'shi', 'an', 'el', 'or', 'un', 'is'];
  const common = ['the', 'of', 'and', 'to', 'in', 'is', 'it', 'you', 'my', 'was', 'for', 'on', 'with', 'have', 'at', 'be', 'this', 'about', 'when', 'what'];
  const out = new Set(common);
  while (out.size < n) { let w = ''; const k = 2 + Math.floor(r() * 3); for (let i = 0; i < k; i++) w += syl[Math.floor(r() * syl.length)]; out.add(w); }
  return [...out];
}

async function buildWorld({ filler = 0, seed = 11, now: baseNow = T0, embedder: realEmbedder = null } = {}) {
  let clock = baseNow;
  const now = () => clock;
  const db = openDb({ file: ':memory:' });
  const sources = createSources(db, { now });
  const nodes = createNodes(db, { now, sources });
  const edges = createEdges(db, { now });
  const embedder = realEmbedder || contentOnly(createFakeEmbedder({ dim: DIM, synonyms: SYN }));
  const vectors = createVectors(db, { dim: embedder.dim, model: embedder.id });
  const src = Object.fromEntries(['user', 'tool', 'import', 'wiki', 'model'].map(k => [k, sources.add({ kind: k, ref: 'bench-' + k })]));
  const ids = {};
  const embed = [];
  for (const [name, kind, text, sk, ago, extra] of NODES) {
    clock = baseNow - ago * DAY;
    const r = nodes.upsert({ kind, text, source: src[sk], key: extra.key, data: extra.data, importance: extra.importance });
    ids[name] = r.id;
    if (r.conflict === 'replaced') ids.editor1 = db.stmt("SELECT dst FROM edge WHERE src = ? AND type = 'supersedes'").get(r.id).dst;   // archived copy of the old value
    embed.push([r.id, text]);
  }
  // the superseded copy of the editor slot is the archived node that `editor2` replaced; it is not packed but must not leak
  clock = baseNow;
  for (const [a, b, type, w] of EDGES) edges.link(ids[a], ids[b], type, { weight: w });

  if (filler) {
    const r = rng(seed), words = vocab(r, 4000);
    const zipf = n => Math.min(n - 1, Math.floor(Math.pow(n, r()) - 1));
    const fid = [];
    for (let i = 0; i < filler; i++) {
      clock = baseNow - Math.floor(r() * 700) * DAY;
      const kind = r() < 0.7 ? 'fact' : 'chat';
      let text;
      do text = Array.from({ length: 6 + Math.floor(r() * 10) }, () => words[zipf(words.length)]).join(' ');
      while (ftsTokens(text).length < 4);   // a text of one content word collides with any single-word query in the hashed fake embedding
      const id = nodes.upsert({ kind, text, source: kind === 'fact' ? src.user : src.model }).id;
      fid.push(id); embed.push([id, text]);
    }
    clock = baseNow;
    for (let e = 0; e < filler * 2; e++) { const a = fid[Math.floor(r() * fid.length)], b = fid[Math.floor(r() * fid.length)]; if (a !== b) edges.link(a, b, r() < 0.5 ? 'mentions' : 'similar', { weight: 0.2 + r() * 0.6 }); }
    for (let e = 0; e < Math.min(300, filler); e++) edges.link(fid[e], ids.rex, 'mentions', { weight: 0.5 });   // a hub with hundreds of links
  }
  const vs = await embedder.embed(embed.map(x => x[1]), { role: 'doc' });
  embed.forEach(([id], i) => vectors.put(id, vs[i]));
  clock = baseNow;
  nodes.touch([ids.austin, ids.editor1]); nodes.flushUses();   // old facts that keep being recalled
  return { db, nodes, edges, vectors, ids, queryVector: withQueryCache(embedder, realEmbedder ? { timeoutMs: 20000 } : {}).query, embedder,
    // the fake embedder's cosines sit lower than nomic's (it hashes stopwords too), so its world gets its own floor and band
    recallOpts: realEmbedder ? {} : { vecFloor: 0.35, vecBand: 0.2 }, now, setNow: t => { clock = t; }, sources: src };
}

const log2 = x => Math.log(x) / Math.LN2;
function metricsFor(query, ids, result, K = 5) {
  const name = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  const neutral = new Set((query.neutral || []).map(n => ids[n]));
  const grade = id => query.rel[name[id]] ?? 0;
  const got = result.items.map(i => i.id).filter(id => !neutral.has(id));
  const top = got.slice(0, K);
  // copies of one memory are one answer: finding any of a duplicate group counts, and finding all of them counts once
  const unit = id => { const g = (query.dup || []).findIndex(grp => grp.some(n => ids[n] === id)); return g < 0 ? 'id' + id : 'dup' + g; };
  const relUnits = new Set(Object.keys(query.rel).filter(n => query.rel[n] >= 1).map(n => unit(ids[n])));
  const relTotal = relUnits.size;
  const hits = new Set(top.filter(id => grade(id) >= 1).map(unit)).size;
  const m = { returned: got.length, chars: result.text.length, budget: (query.opts?.budget ?? OPTS.budget) };
  m.irrelevant = got.filter(id => grade(id) === 0).length;
  const dups = (query.dup || []).reduce((n, grp) => { const present = got.filter(id => grp.some(g => ids[g] === id)).length; return n + Math.max(0, present - 1); }, 0);
  m.dups = dups;
  m.badHits = got.filter(id => (query.bad || []).some(b => ids[b] === id)).length;
  if (query.empty) { m.precision = got.length ? 0 : 1; m.recall = null; m.mrr = null; m.ndcg = null; return m; }
  m.recall = relTotal ? hits / Math.min(relTotal, K) : null;
  m.precision = top.length ? top.filter(id => grade(id) >= 1).length / top.length : 0;
  const firstRel = got.findIndex(id => grade(id) >= 1);
  m.mrr = firstRel < 0 ? 0 : 1 / (firstRel + 1);
  const seen = new Set();
  const dcg = top.reduce((sum, id, i) => { const u = unit(id); if (seen.has(u)) return sum; seen.add(u); return sum + (2 ** grade(id) - 1) / log2(i + 2); }, 0);
  const best = new Map();
  for (const [n, g] of Object.entries(query.rel)) { const u = unit(ids[n]); best.set(u, Math.max(best.get(u) || 0, g)); }
  const ideal = [...best.values()].sort((x, y) => y - x).slice(0, K).reduce((sum, g, i) => sum + (2 ** g - 1) / log2(i + 2), 0);
  m.ndcg = ideal ? dcg / ideal : null;
  return m;
}

const mean = xs => { const v = xs.filter(x => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
function aggregate(rows) {
  const returned = rows.reduce((s, r) => s + r.returned, 0);
  return {
    n: rows.length, recallAtK: mean(rows.map(r => r.recall)), precisionAtK: mean(rows.map(r => r.precision)), mrr: mean(rows.map(r => r.mrr)), ndcgAtK: mean(rows.map(r => r.ndcg)),
    irrelevantRate: returned ? rows.reduce((s, r) => s + r.irrelevant, 0) / returned : 0,
    duplicateRate: returned ? rows.reduce((s, r) => s + r.dups, 0) / returned : 0,
    badHits: rows.reduce((s, r) => s + r.badHits, 0),
    budgetUse: mean(rows.map(r => r.chars / r.budget)),
    latencyMs: mean(rows.map(r => r.ms)),
  };
}

// run every labeled query through a recall function: recall(query, opts) → { text, items }
async function evaluate(world, recall, { repeat = 1 } = {}) {
  const rows = [];
  for (const q of QUERIES) {
    let res, ms = 0;
    for (let i = 0; i < repeat; i++) { const t = performance.now(); res = await recall(q.q, { ...OPTS, ...(q.opts || {}), now: world.now() }); ms += performance.now() - t; }
    rows.push({ cat: q.cat, q: q.q, ...metricsFor(q, world.ids, res), ms: ms / repeat, res });
  }
  const cats = {};
  for (const c of new Set(rows.map(r => r.cat))) cats[c] = aggregate(rows.filter(r => r.cat === c));
  return { overall: aggregate(rows), cats, rows };
}

module.exports = { buildWorld, evaluate, aggregate, metricsFor, QUERIES, NODES, EDGES, OPTS, T0, DAY };
