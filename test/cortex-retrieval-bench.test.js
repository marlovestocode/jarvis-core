// Guards the retrieval quality measured by scripts/cortex-retrieval-bench.js: the deterministic small world, current recall
// against the frozen pre-pass baseline. Thresholds sit a little under the measured values so honest noise does not trip them,
// and well above the baseline so a regression of any mechanism does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorld, evaluate } = require('../scripts/lib/cortex-retrieval-world');
const baseline = require('../scripts/lib/cortex-recall-baseline');
const current = require('../src/core/cortex/recall');

async function run(mod, opts = {}) {
  const w = await buildWorld({});
  const r = mod.createRecall({ db: w.db, edges: w.edges, vectors: w.vectors, queryVector: w.queryVector, now: w.now, ...opts, ...(mod === current ? w.recallOpts : {}) });
  return evaluate(w, r.recall);
}

test('cortex-retrieval-bench: current recall meets the 0.75 bar on every headline metric and beats the baseline', async () => {
  const [b, c] = [await run(baseline), await run(current)];
  const o = c.overall;
  assert.ok(o.recallAtK >= 0.75 && o.recallAtK >= b.overall.recallAtK, 'recall ' + o.recallAtK);
  assert.ok(o.precisionAtK >= 0.75, 'precision ' + o.precisionAtK);
  assert.ok(o.ndcgAtK >= 0.75 && o.ndcgAtK >= b.overall.ndcgAtK + 0.25, 'ndcg ' + o.ndcgAtK);
  assert.ok(o.mrr >= 0.9, 'mrr ' + o.mrr);
  assert.ok(o.irrelevantRate <= 0.25, 'irrelevant ' + o.irrelevantRate);
  assert.equal(o.duplicateRate, 0);
});

test('cortex-retrieval-bench: per scenario, the weaknesses the pass targeted stay fixed', async () => {
  const c = await run(current);
  assert.equal(c.cats['no-answer'].irrelevantRate, 0, 'nothing relevant in memory → nothing returned');
  assert.equal(c.cats.conflict.badHits, 0);
  assert.equal(c.cats.conflict.precisionAtK, 1);
  assert.ok(c.cats.semantic.recallAtK >= 0.7 && c.cats.semantic.ndcgAtK >= 0.85);
  assert.ok(c.cats.outdated.mrr >= 1, 'the current address outranks the stale one that was recalled all the time');
  assert.equal(c.cats.duplicate.duplicateRate, 0);
  assert.equal(c.cats['tiny-budget'].recallAtK >= 0.6, true);
  assert.equal(c.cats['weak-inference'].badHits, 0);
  assert.equal(c.cats['important-old'].mrr, 1, 'an old important fact outranks recent trivia');
  assert.equal(c.cats.temporary.badHits, 0, 'a lapsed temporary note is not recalled');
  assert.equal(c.cats['updated-info'].mrr, 1);
  assert.equal(c.cats['live-context'].mrr, 1);
});

test('cortex-retrieval-bench: the baseline really shows the failures (the bench can fail)', async () => {
  const b = await run(baseline);
  assert.ok(b.cats['no-answer'].irrelevantRate === 1, 'baseline answers questions nothing in memory can answer');
  assert.ok(b.cats.semantic.recallAtK < 0.5);
  assert.ok(b.cats.duplicate.duplicateRate > 0);
  assert.ok(b.cats.outdated.mrr < 0.5);
});

test('cortex-retrieval-bench: results are deterministic', async () => {
  const [x, y] = [await run(current), await run(current)];
  const strip = r => r.rows.map(q => [q.q, q.res.items.map(i => i.id)]);
  assert.deepEqual(strip(x), strip(y));
});
