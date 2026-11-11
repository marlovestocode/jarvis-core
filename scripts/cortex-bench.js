// Cortex bench: the gates of core spec §6.1.
//   node --expose-gc scripts/cortex-bench.js [--nodes 50000] [--edges 200000] [--vectors 20000] [--queries 1000] [--keep <dir>]
// Builds a seeded synthetic corpus in a temp folder (through the cortex modules, in one transaction), then measures in
// fresh child processes: boot (open + first recall), recall latency without a query embedding, upsert latency,
// resident memory with the vector matrix loaded, database size, and the worst consolidation step. Exit 1 on any FAIL.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const N = { nodes: +arg('nodes', 50000), edges: +arg('edges', 200000), vectors: +arg('vectors', 20000), queries: +arg('queries', 1000), plays: +arg('plays', 100000) };
const DIM = 768;   // the real embedder's default (quality gate, see embedder.js)
const GATES = { recallP95: 15, upsertMean: 1, bootMs: 300, memMB: 64, dbMB: 100, musicImportMs: 10000 };   // musicImportMs: W2 §5

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
// Vocabulary drawn by Zipf (exponent 1, like natural language). As in real English, the most frequent ranks are
// function words ("the", "my", "is"...), so they come first; the rest are pseudo-words.
const ENGLISH_TOP = ['the', 'of', 'and', 'to', 'in', 'is', 'it', 'you', 'that', 'he', 'was', 'for', 'on', 'are', 'with', 'as', 'his', 'they', 'at', 'be',
  'this', 'have', 'from', 'or', 'one', 'had', 'by', 'but', 'not', 'what', 'all', 'were', 'we', 'when', 'your', 'can', 'said', 'there', 'an', 'each',
  'which', 'she', 'do', 'how', 'their', 'if', 'will', 'up', 'about', 'out', 'many', 'then', 'them', 'so', 'some', 'her', 'would', 'my', 'me', 'has'];
function vocab(r, n = 20000) {
  const syl = ['ka', 'lo', 'mi', 're', 'su', 'ta', 'ne', 'po', 'vi', 'da', 'ri', 'go', 'be', 'fu', 'shi', 'an', 'el', 'or', 'un', 'is'];
  const out = new Set(ENGLISH_TOP);
  while (out.size < n) { let w = ''; const k = 2 + Math.floor(r() * 3); for (let i = 0; i < k; i++) w += syl[Math.floor(r() * syl.length)]; out.add(w); }
  return [...out];
}
const zipf = (r, n) => Math.min(n - 1, Math.floor(Math.pow(n, r()) - 1));
const sentence = (r, words, len) => Array.from({ length: len }, () => words[zipf(r, words.length)]).join(' ');

const MIX = [['track', 0.40], ['knowledge', 0.20], ['fact', 0.10], ['file', 0.10], ['chat', 0.06], ['artist', 0.06], ['entity', 0.04], ['reminder', 0.03], ['playlist', 0.01]];
const LEN = { track: 6, knowledge: 80, fact: 10, file: 8, chat: 50, artist: 2, entity: 2, reminder: 6, playlist: 3 };
const SRC = { track: 'tool', knowledge: 'wiki', fact: 'user', file: 'tool', chat: 'model', artist: 'tool', entity: 'user', reminder: 'user', playlist: 'tool' };
const EDGE_TYPES = ['mentions', 'part_of', 'from', 'by', 'contains', 'next', 'similar', 'about', 'touched'];

async function build(dir) {
  const { openDb } = require('../src/core/cortex/db');
  const { createSources } = require('../src/core/cortex/sources');
  const { createNodes } = require('../src/core/cortex/nodes');
  const { createEdges } = require('../src/core/cortex/edges');
  const { createVectors } = require('../src/core/cortex/vectors');
  const { createFakeEmbedder } = require('../src/core/cortex/embedder');
  const r = rng(42), words = vocab(r);
  const t = Date.now();
  const db = openDb({ file: path.join(dir, 'cortex.db') });
  const now = () => t - Math.floor(r() * 365 * 864e5);
  const sources = createSources(db, { now });
  const nodes = createNodes(db, { now, sources });
  const edges = createEdges(db, { now });
  const emb = createFakeEmbedder({ dim: DIM });
  const vectors = createVectors(db, { dim: DIM, model: emb.id });
  vectors.markStaleIfModelChanged();
  const src = Object.fromEntries(['user', 'tool', 'wiki', 'model'].map(k => [k, sources.add({ kind: k, ref: 'bench-' + k })]));
  const ids = [], embeddable = [], hubKinds = [];
  const t0 = performance.now();
  db.tx(() => {
    for (let i = 0; i < N.nodes; i++) {
      let x = r(), kind = MIX[0][0];
      for (const [k, p] of MIX) { if (x < p) { kind = k; break; } x -= p; }
      const cap = require('../src/core/cortex/guard').CAPS[kind];
      const text = sentence(r, words, Math.max(2, Math.round(LEN[kind] * (0.6 + r() * 0.8)))).slice(0, cap);
      const { id } = nodes.upsert({ kind, text: text.length >= 3 ? text : text + ' item', source: src[SRC[kind]], importance: r() });
      ids.push(id);
      hubKinds.push(kind === 'entity' || kind === 'artist' || kind === 'playlist');
      if (['fact', 'entity', 'chat', 'knowledge', 'reminder'].includes(kind)) embeddable.push([id, text]);
    }
    // 70% of edges between random nodes; 30% into hubs (entities, artists, playlists) with a skewed draw, so the
    // biggest hub gets a few hundred links: an artist with hundreds of tracks, a pet mentioned in hundreds of facts
    const hubs = ids.filter((_, i) => hubKinds[i]);
    for (let e = 0; e < N.edges; e++) {
      const a = ids[Math.floor(r() * ids.length)];
      const b = r() < 0.3 ? hubs[Math.floor(hubs.length * Math.pow(r(), 1.5))] : ids[Math.floor(r() * ids.length)];
      if (a !== b) edges.link(a, b, EDGE_TYPES[Math.floor(r() * EDGE_TYPES.length)], { weight: 0.05 + r() * 0.9 });
    }
  });
  const tVec = performance.now();
  const chosen = embeddable.slice(0, N.vectors);
  const vs = await emb.embed(chosen.map(x => x[1]), { role: 'doc' });
  db.tx(() => { chosen.forEach(([id], i) => vectors.put(id, vs[i])); });
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const maxInDegree = db.raw.prepare('SELECT max(c) m FROM (SELECT dst, count(*) c FROM edge GROUP BY dst)').get().m;
  db.close();
  return { buildNodesEdgesS: ((tVec - t0) / 1000).toFixed(1), buildVectorsS: ((performance.now() - tVec) / 1000).toFixed(1), vectors: chosen.length, maxInDegree };
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

// ---- child phases ----
async function phase(name, dir) {
  const r = rng(7), words = vocab(rng(42));
  const query = () => sentence(r, words, 2 + Math.floor(r() * 3));
  const file = path.join(dir, 'cortex.db');
  const gc = () => { for (let i = 0; i < 3; i++) global.gc?.(); };
  if (name === 'boot') {
    const tReq = performance.now();
    const cortexLib = require('../src/core/cortex');
    const reqMs = performance.now() - tReq;
    const t0 = performance.now();
    const c = cortexLib.open({ file });
    const first = await c.recall(query());
    const bootMs = performance.now() - t0;
    const qc = c.health().quickCheck;
    c.close();
    return { bootMs, requireMs: reqMs, firstMode: first.mode, quickCheck: qc };
  }
  if (name === 'recall') {
    const c = require('../src/core/cortex').open({ file });
    for (let i = 0; i < 20; i++) await c.recall(query());   // warm statements
    const ms = [], modes = {};
    for (let i = 0; i < N.queries; i++) { const t = performance.now(); const x = await c.recall(query()); ms.push(performance.now() - t); modes[x.mode] = (modes[x.mode] || 0) + 1; }
    c.close();
    return { p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: Math.max(...ms), modes };
  }
  if (name === 'upsert') {
    const c = require('../src/core/cortex').open({ file });
    const s = c.source.add({ kind: 'user', ref: 'bench-upsert' });
    const ms = [];
    for (let i = 0; i < 1000; i++) { const text = 'bench fact ' + i + ' ' + query(); const t = performance.now(); c.node.upsert({ kind: 'fact', text: text.slice(0, 300), source: s }); ms.push(performance.now() - t); }
    c.close();
    return { mean: ms.reduce((a, b) => a + b, 0) / ms.length, p95: pct(ms, 95), max: Math.max(...ms) };
  }
  if (name === 'mem') {
    // code is loaded first (node:sqlite's native library and the JS modules are process cost, not cortex data);
    // the delta is what opening and using the cortex adds: page cache, FTS, statements, the vector matrix
    const { createFakeEmbedder } = require('../src/core/cortex/embedder');
    const cortexLib = require('../src/core/cortex');
    cortexLib.open({}).close();
    gc();
    const before = process.memoryUsage();
    const c = cortexLib.open({ file, embedder: createFakeEmbedder({ dim: DIM }) });
    const ms = [];
    for (let i = 0; i < 300; i++) { const t = performance.now(); await c.recall(query() + ' ' + query()); ms.push(performance.now() - t); }
    gc();
    const after = process.memoryUsage();
    const st = c.stats();
    c.close();
    return { rssDeltaMB: (after.rss - before.rss) / 1048576, heapDeltaMB: (after.heapUsed - before.heapUsed) / 1048576, externalDeltaMB: (after.external - before.external) / 1048576,
      matrixMB: st.matrixBytes / 1048576, hybridP95: pct(ms, 95) };
  }
  if (name === 'consolidate') {
    const { createFakeEmbedder } = require('../src/core/cortex/embedder');
    const c = require('../src/core/cortex').open({ file, embedder: createFakeEmbedder({ dim: DIM }) });
    const s = c.source.add({ kind: 'user', ref: 'bench-cons' });
    for (let i = 0; i < 64; i++) c.node.upsert({ kind: 'fact', text: ('new bench fact ' + i + ' ' + query()).slice(0, 300), source: s });
    const worst = {};
    let ticks = 0;
    for (; ticks < 60; ticks++) {
      const r = await c.consolidate.tick({ deadlineMs: 8 });
      for (const [k, v] of Object.entries(r.steps)) worst[k] = Math.max(worst[k] || 0, v);
      if (!c.consolidate.queue && ticks > 5) break;
    }
    c.close();
    return { worst, ticks };
  }
  if (name === 'music') {
    // wave 2 (W2 §5): the one-time import of a 100,000-play music-plays.jsonl, in the 50 ms slices the app uses
    const { makePlays } = require('../test/fixtures/music-plays');
    const { createMusicImport } = require('../src/core/music/import');
    const mdir = path.join(dir, 'music'); fs.mkdirSync(mdir, { recursive: true });
    const plays = makePlays({ n: N.plays, tracks: 5000, seed: 11, start: Date.UTC(1995, 0, 1) });   // 100k plays with real gaps span ~27 years
    fs.writeFileSync(path.join(mdir, 'music-plays.jsonl'), plays.map(p => JSON.stringify(p)).join('\n') + '\n');
    const c = require('../src/core/cortex').open({ file: path.join(mdir, 'cortex.db') });
    const im = createMusicImport({ cortex: c, file: path.join(mdir, 'music-plays.jsonl') });
    let work = 0, worst = 0, slices = 0, r;
    do { const t = performance.now(); r = im.step({ deadlineMs: 50 }); const d = performance.now() - t; work += d; worst = Math.max(worst, d); slices++; } while (!r.done);
    const st = c.stats();
    c.close();
    return { plays: plays.length, imported: r.imported, workMs: work, worstSliceMs: worst, slices, events: st.events, dbMB: fs.statSync(path.join(mdir, 'cortex.db')).size / 1048576 };
  }
  throw new Error('unknown phase ' + name);
}

function runChild(name, dir) {
  const out = execFileSync(process.execPath, ['--expose-gc', '--no-warnings', __filename, '--phase', name, '--dir', dir, '--queries', String(N.queries), '--plays', String(N.plays)], { encoding: 'utf8', maxBuffer: 1 << 24 });
  return JSON.parse(out.trim().split('\n').pop());
}

async function main() {
  if (arg('phase')) { process.stdout.write(JSON.stringify(await phase(arg('phase'), arg('dir'))) + '\n'); return; }
  const dir = arg('keep') || fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bench-'));
  fs.mkdirSync(dir, { recursive: true });
  console.log(`corpus: ${N.nodes} nodes, ${N.edges} edges, ${N.vectors} vectors (dim ${DIM}) in ${dir}`);
  const b = await build(dir);
  console.log(`built: nodes+edges ${b.buildNodesEdgesS} s, vectors ${b.buildVectorsS} s, biggest hub ${b.maxInDegree} incoming links`);
  const file = path.join(dir, 'cortex.db');
  const dbMB = fs.statSync(file).size / 1048576;

  const boot = runChild('boot', dir);
  const recall = runChild('recall', dir);
  const upsert = runChild('upsert', dir);
  const mem = runChild('mem', dir);
  const cons = runChild('consolidate', dir);
  const music = runChild('music', dir);

  const f = x => x.toFixed(2);
  const rows = [
    ['recall p95 (no query embedding)', `${f(recall.p95)} ms (p50 ${f(recall.p50)}, p99 ${f(recall.p99)}, max ${f(recall.max)}; modes ${JSON.stringify(recall.modes)})`, recall.p95 <= GATES.recallP95, `≤ ${GATES.recallP95} ms`],
    ['node.upsert mean', `${f(upsert.mean)} ms (p95 ${f(upsert.p95)}, max ${f(upsert.max)})`, upsert.mean <= GATES.upsertMean, `≤ ${GATES.upsertMean} ms`],
    ['open + first recall', `${f(boot.bootMs)} ms (require ${f(boot.requireMs)} ms, quick_check ${boot.quickCheck})`, boot.bootMs <= GATES.bootMs, `≤ ${GATES.bootMs} ms`],
    ['cortex resident memory (rss delta, matrix loaded)', `${f(mem.rssDeltaMB)} MB (heap ${f(mem.heapDeltaMB)}, external ${f(mem.externalDeltaMB)}, matrix ${f(mem.matrixMB)})`, mem.rssDeltaMB <= GATES.memMB, `≤ ${GATES.memMB} MB`],
    ['database file', `${f(dbMB)} MB`, dbMB <= GATES.dbMB, `≤ ${GATES.dbMB} MB`],
    [`music import of ${music.plays} plays (work time)`, `${f(music.workMs)} ms in ${music.slices} slices (worst ${f(music.worstSliceMs)} ms, ${music.imported} imported, db ${f(music.dbMB)} MB)`, music.workMs <= GATES.musicImportMs && music.imported === music.plays, `≤ ${GATES.musicImportMs} ms, all imported`],
  ];
  console.log('');
  for (const [name, val, ok, gate] of rows) console.log(`${ok ? 'GATE PASS' : 'GATE FAIL'}  ${name}: ${val}  [gate ${gate}]`);
  console.log(`info      hybrid recall p95 with the fake embedder: ${f(mem.hybridP95)} ms`);
  console.log(`info      worst consolidation step (deadline 8 ms): ${JSON.stringify(Object.fromEntries(Object.entries(cons.worst).map(([k, v]) => [k, +v.toFixed(2)])))} over ${cons.ticks} ticks`);
  if (!arg('keep')) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(rows.every(r => r[2]) ? 0 : 1);
}

main().catch(err => { console.error(err.stack || err.message); process.exit(2); });
