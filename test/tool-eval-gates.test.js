// Phase 2B eval gates: baseline vs new on the SAME fixtures with the scripted oracle (noise 0.1, seed 1). The oracle simulates the
// model's tool choices, so these gates pin the pipeline (discovery, recovery, duplicates, refusals), not LLM quality.
// The held-out file is SHA-pinned: it must never be edited to make a phase pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runSet, baseGroups } = require('../scripts/tool-eval-run');
const { makeSynthRegistry } = require('./helpers/synth-registry');

const ROOT = path.join(__dirname, '..');
const dev = require('./fixtures/tool-eval-v1.json');
const held = require('./fixtures/tool-eval-heldout.json');
const CATS = ['unfamiliar', 'reference', 'large-registry', 'multi-tool', 'seq-vs-parallel', 'wrong-tool', 'missing-capability', 'malformed-args', 'approval-required', 'duplicate', 'partial-failure'];
const FAULTS = new Set(['transient', 'badargs', 'unavailable', 'timeout', 'wrongpick', 'repeat']);   // wrongpick/repeat: model behaviours the oracle scripts
const OUTCOMES = new Set(['done', 'decline', 'ask', 'not_permitted', 'none']);
const names = e => (typeof e === 'string' ? [e] : e.oneOf);
const opts = { noise: 0.1, seed: 1, modelDelayMs: 0 };

const results = {};
async function both(set, rows) {
  const key = set + rows.length;
  if (!results[key]) results[key] = { baseline: await runSet({ rows, mode: 'baseline', set, ...opts }), nw: await runSet({ rows, mode: 'new', set, ...opts }) };
  return results[key];
}

test('held-out fixture hash is pinned', () => {
  const text = fs.readFileSync(path.join(ROOT, 'test/fixtures/tool-eval-heldout.json'), 'utf8').replace(/\r\n/g, '\n');
  const pinned = fs.readFileSync(path.join(ROOT, 'docs/intelligence/heldout.sha256'), 'utf8').split(/\s+/)[0];
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), pinned, 'the held-out file changed: it is not tuned on, do not edit rows to make a phase pass');
  assert.match(held.about, /^Not tuned on: do not edit rows to make a phase pass/);
});

for (const [label, doc, set, minRows] of [['dev', dev, 'v1', 66], ['held-out', held, 'heldout', 33]]) {
  test(`${label} fixtures: schema, tool names exist in their registry, category counts`, () => {
    assert.ok(doc.rows.length >= minRows);
    const ids = new Set();
    for (const r of doc.rows) {
      assert.ok(!ids.has(r.id), `duplicate id ${r.id}`); ids.add(r.id);
      assert.ok([...CATS, 'simple'].includes(r.cat), r.id);
      assert.match(r.registry, /^(real|synth100|synth300|synth500)$/);
      assert.equal(typeof r.text, 'string');
      assert.ok(Array.isArray(r.want.tools) && ['seq', 'any'].includes(r.want.order) && OUTCOMES.has(r.want.outcome), r.id);
      const known = new Set(baseGroups(r.registry, set).groups.flatMap(g => g.tools.map(t => t.name)));
      const used = [...r.want.tools.flatMap(names), ...(r.want.mustNot || []), ...Object.keys(r.faults || {}), ...(r.history || []).flatMap(h => h.tools)];
      for (const n of used) assert.ok(known.has(n), `${r.id}: ${n} is not in ${r.registry}`);
      for (const f of Object.values(r.faults || {}).flat()) assert.ok(FAULTS.has(f), `${r.id}: fault ${f}`);
      if (r.speaker) assert.ok(['owner', 'guest', 'unsure'].includes(r.speaker));
    }
    for (const c of CATS) assert.ok(doc.rows.filter(r => r.cat === c).length >= (label === 'dev' ? 6 : 3), `${label} ${c}`);
    assert.ok(doc.rows.filter(r => r.simple).length >= (label === 'dev' ? 6 : 3));
  });
}

test('makeSynthRegistry is deterministic for a seed and its second vocabulary shares no names', () => {
  const a = makeSynthRegistry({ n: 120, seed: 3 }), b = makeSynthRegistry({ n: 120, seed: 3 });
  assert.deepEqual(a.tools.map(t => t.name), b.tools.map(t => t.name));
  assert.deepEqual(a.synonyms, b.synonyms);
  const v2 = makeSynthRegistry({ n: 120, seed: 7, vocab: 'b' });
  const names1 = new Set(makeSynthRegistry({ n: 500, seed: 1 }).tools.map(t => t.name));
  assert.ok(v2.tools.every(t => !names1.has(t.name)));
});

for (const [label, doc, set] of [['dev', dev, 'v1'], ['held-out', held, 'heldout']]) {
  test(`${label}: new completion >= baseline; safety and call-count gates`, async () => {
    const { baseline, nw } = await both(set, doc.rows);
    const b = baseline.metrics, n = nw.metrics;
    assert.ok(n.completion >= b.completion, `completion ${n.completion} < ${b.completion}`);
    assert.equal(n.unsafeExecs, 0); assert.equal(b.unsafeExecs, 0);
    assert.equal(n.dupWrites, 0, 'a duplicate write ran');
    assert.ok(n.extraCallsMax <= 1 && b.extraCallsMax <= 1);
    assert.ok(nw.rows.length === doc.rows.length);
  });
}

test('dev: new selectionAccuracy >= baseline', async () => {
  const { baseline, nw } = await both('v1', dev.rows);
  assert.ok(nw.metrics.selectionAccuracy >= baseline.metrics.selectionAccuracy, `${nw.metrics.selectionAccuracy} < ${baseline.metrics.selectionAccuracy}`);
});

// This gate was red (h-multi-tool-1: discovery-only rounds used up the round cap) before the cap fix; the row was observed first,
// so held-out is not a blind set for that behaviour any more. No threshold or row was changed.
test('held-out: new selectionAccuracy >= baseline', async () => {
  const { baseline, nw } = await both('heldout', held.rows);
  assert.ok(nw.metrics.selectionAccuracy >= baseline.metrics.selectionAccuracy, `${nw.metrics.selectionAccuracy} < ${baseline.metrics.selectionAccuracy}`);
});

test('large synthetic registries: new offers fewer spec tokens than baseline (dev)', async () => {
  for (const reg of ['synth300', 'synth500']) {
    const rows = dev.rows.filter(r => r.registry === reg);
    const b = await runSet({ rows, mode: 'baseline', set: 'v1', ...opts }), n = await runSet({ rows, mode: 'new', set: 'v1', ...opts });
    assert.ok(n.metrics.specTokens < b.metrics.specTokens, `${reg}: ${n.metrics.specTokens} >= ${b.metrics.specTokens}`);
    assert.ok(n.metrics.specTokens < 0.6 * b.metrics.specTokens, `${reg}: ratio ${(n.metrics.specTokens / b.metrics.specTokens).toFixed(2)}`);
  }
});

// simple commands: the loop's own model call is unavoidable, but no intent / disambiguation question and no embed call may be added.
// Measured without noise: a noisy wrong call legitimately sends the loop into recovery, which is not the simple path.
for (const [label, doc, set] of [['dev', dev, 'v1'], ['held-out', held, 'heldout']]) {
  test(`${label}: simple commands add no model question and no embed call in either mode`, async () => {
    const rows = doc.rows.filter(r => r.simple);
    for (const mode of ['baseline', 'new']) {
      const r = await runSet({ rows, mode, set, noise: 0, seed: 1, modelDelayMs: 0 });
      for (const x of r.rows) { assert.equal(x.extra, 0, `${mode} ${x.id}`); assert.equal(x.embeds, 0, `${mode} ${x.id}`); assert.ok(x.ok, `${mode} ${x.id}`); }
    }
  });
}

// the group-selection evals must not regress: the oracle at noise 0 is what the documented 62/71 and 27/31 are measured with
for (const [version, min, total] of [['1', 62, 71], ['2', 27, 31]]) {
  test(`group-selection eval v${version}: fake oracle >= ${min}/${total}`, () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/intelligence-eval.js'), '--model', 'fake', '--noise', '0', '--json', '--v', version], { encoding: 'utf8', timeout: 120000 });
    const data = JSON.parse(r.stdout);
    assert.equal(data.total, total);
    assert.ok(data.model.passed >= min, `${data.model.passed} < ${min}`);
  });
}
