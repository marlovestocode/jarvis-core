// Recall-quality check for cortex vectors (core spec §6.3).
//   node scripts/cortex-quality.js [--embedder fake|ollama] [--dim 256] [--host http://127.0.0.1:11434] [--model nomic-embed-text]
// Embeds the labeled fixture, ranks docs per query by full float32 and by int8 at --dim, and prints the mean
// top-10 overlap. Exits 1 when it is below 0.95. `ollama` needs the model installed (it never pulls).
const fs = require('node:fs');
const path = require('node:path');
const { truncate, quantize, dotI8 } = require('../src/core/cortex/vectors');
const embedders = require('../src/core/cortex/embedder');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const kind = arg('embedder', 'fake');
const dim = Number(arg('dim', 256));
const K = 10, GATE = 0.95;

function makeEmbedder() {
  // the fake is hashed bag-of-words, not Matryoshka: built at --dim it measures int8 loss only
  if (kind === 'fake') return embedders.createFakeEmbedder({ dim });
  if (kind === 'ollama') {
    if (!embedders.createOllamaEmbedder) throw new Error('ollama embedder not built yet');
    const host = arg('host', 'http://127.0.0.1:11434');
    return embedders.createOllamaEmbedder({ getConfig: () => ({ ollama: { host } }), fetch: globalThis.fetch, model: arg('model', 'nomic-embed-text'), dim: 0 });
  }
  throw new Error('unknown --embedder ' + kind);
}

const topK = (scores, k) => scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, k).map(x => x[1]);

async function main() {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'cortex-quality.json'), 'utf8'));
  const e = makeEmbedder();
  const full = await e.embed(fx.docs.map(d => d.text), { role: 'doc' });
  const qs = await e.embed(fx.queries.map(q => q.q), { role: 'query' });
  const docsQ = full.map(v => quantize(truncate(v, dim)));
  let overlap = 0, hitFull = 0, hitQ = 0;
  for (let qi = 0; qi < qs.length; qi++) {
    const qf = qs[qi], qq = quantize(truncate(qf, dim));
    const sf = full.map(d => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * qf[i]; return s; });
    const sq = docsQ.map(d => dotI8(d.v, d.scale, qq.v, qq.scale));
    const a = topK(sf, K), b = new Set(topK(sq, K));
    overlap += a.filter(i => b.has(i)).length / K;
    const rel = new Set(fx.queries[qi].relevant);
    hitFull += a.slice(0, 5).filter(i => rel.has(fx.docs[i].id)).length / 5;
    hitQ += [...b].slice(0, 5).filter(i => rel.has(fx.docs[i].id)).length / 5;
  }
  const n = qs.length, mean = overlap / n;
  console.log(`embedder=${e.id} fullDim=${full[0].length} dim=${dim} queries=${n}`);
  console.log(`overlap@10=${mean.toFixed(3)} (gate ${GATE}) precision@5 float32=${(hitFull / n).toFixed(3)} int8=${(hitQ / n).toFixed(3)}`);
  console.log(mean >= GATE ? 'GATE PASS' : 'GATE FAIL');
  process.exit(mean >= GATE ? 0 : 1);
}

main().catch(err => { console.error(err.message); process.exit(2); });
