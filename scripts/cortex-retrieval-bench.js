// Retrieval relevance bench: the frozen pre-pass recall (scripts/lib/cortex-recall-baseline.js) against src/core/cortex/recall.js
// on the deterministic world in scripts/lib/cortex-retrieval-world.js. Complements cortex-bench.js (latency gates at 50k nodes)
// and cortex-quality.js (int8 vector loss).
//   node scripts/cortex-retrieval-bench.js [--filler 4000] [--embedder fake|ollama] [--vec-floor 0.3] [--verbose] [--json out.json]
// `ollama` embeds the world with the real local nomic-embed-text (no synonym table, small world only) to check the vector floor.
const fs = require('node:fs');
const { buildWorld, evaluate } = require('./lib/cortex-retrieval-world');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const VERBOSE = process.argv.includes('--verbose');
const REAL = arg('embedder', 'fake') === 'ollama';
const FILLER = REAL ? 0 : Number(arg('filler', 4000));
const VEC_FLOOR = arg('vec-floor') ? Number(arg('vec-floor')) : undefined;

const impls = { baseline: require('./lib/cortex-recall-baseline'), current: require('../src/core/cortex/recall') };
const f = (x, d = 3) => (x === null || x === undefined ? '  -  ' : x.toFixed(d));

async function runOne(label, filler) {
  const out = {};
  for (const [name, mod] of Object.entries(impls)) {
    const w = await buildWorld({ filler, embedder: REAL ? require('../src/core/cortex/embedder').createOllamaEmbedder({ getConfig: () => ({ ollama: { host: 'http://127.0.0.1:11434' } }), fetch: globalThis.fetch }) : null });
    const r = mod.createRecall({ db: w.db, edges: w.edges, vectors: w.vectors, queryVector: w.queryVector, now: w.now, ...(name === 'current' && { ...w.recallOpts, ...(VEC_FLOOR !== undefined && { vecFloor: VEC_FLOOR }) }) });
    await evaluate(w, r.recall);   // warm statements and the df cache
    out[name] = await evaluate(w, r.recall, { repeat: filler ? 5 : 20 });
    out[name].world = w;
  }
  return { label, out };
}

function table(label, out) {
  console.log(`\n== ${label} ==`);
  const cols = ['recallAtK', 'precisionAtK', 'mrr', 'ndcgAtK', 'irrelevantRate', 'duplicateRate', 'badHits', 'budgetUse', 'latencyMs'];
  console.log(['category'.padEnd(20), 'impl'.padEnd(9), ...cols.map(c => c.padStart(14))].join(' '));
  const line = (cat, impl, a) => console.log([cat.padEnd(20), impl.padEnd(9), ...cols.map(c => f(a[c], c === 'badHits' ? 0 : c === 'latencyMs' ? 2 : 3).padStart(14))].join(' '));
  for (const cat of Object.keys(out.baseline.cats)) for (const impl of ['baseline', 'current']) line(cat, impl, out[impl].cats[cat]);
  for (const impl of ['baseline', 'current']) line('OVERALL', impl, out[impl].overall);
  if (VERBOSE) {
    for (const impl of ['baseline', 'current']) {
      console.log(`-- ${impl}: queries with a miss or an irrelevant item`);
      const name = Object.fromEntries(Object.entries(out[impl].world.ids).map(([k, v]) => [v, k]));
      for (const r of out[impl][impl === 'baseline' ? 'rows' : 'rows']) {
        if (r.irrelevant || r.recall === 0 || r.dups || r.badHits) console.log(`   [${r.cat}] ${r.q} -> ${r.res.items.map(i => name[i.id] || i.id).join(', ') || '(nothing)'}`);
      }
    }
  }
}

(async () => {
  const runs = [await runOne('small world (27 nodes)', 0), await runOne(`large world (27 + ${FILLER} filler nodes, 300-link hub)`, FILLER)];
  for (const r of runs) table(r.label, r.out);
  if (arg('json')) {
    const slim = runs.map(r => ({ label: r.label, baseline: { overall: r.out.baseline.overall, cats: r.out.baseline.cats }, current: { overall: r.out.current.overall, cats: r.out.current.cats } }));
    fs.writeFileSync(arg('json'), JSON.stringify(slim, null, 2));
  }
})().catch(err => { console.error(err.stack || err.message); process.exit(2); });
