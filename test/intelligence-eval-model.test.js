const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Runs scripts/intelligence-eval.js as the user does. fake mode = deterministic oracle from the row labels: these tests pin the
// pipeline (gate, merge, fallbacks, simple-command latency), not real model quality.
const SCRIPT = path.join(__dirname, '..', 'scripts', 'intelligence-eval.js');
const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (...args) => { const r = run(...args, '--json'); return { ...r, data: JSON.parse(r.out) }; };
// the only run-to-run difference in the rule-only report is its timing figure
const maskMs = s => s.replace(/rule layer [\d.]+ ms\/request/g, 'rule layer X ms/request');

// a latency-only failure on a busy machine gets one more try; a simple command calling the model never does
function fake(version, extra = []) {
  let r = json('--v', version, '--model', 'fake', '--noise', '0', ...extra);
  if (r.code !== 0 && r.data.simple.modelCalls === 0) r = json('--v', version, '--model', 'fake', '--noise', '0', ...extra);
  return r;
}

for (const version of ['1', '2']) {
  test(`fake model v${version}: beats rule-only by a margin, no must-not-act regressions, simple commands model-free`, () => {
    const { code, data } = fake(version);
    assert.equal(data.mode, 'fake');
    assert.match(data.note, /not real LLM quality/);
    assert.ok(data.model.accuracy >= data.rule.accuracy + 20, `model ${data.model.accuracy}% vs rule ${data.rule.accuracy}%`);
    assert.equal(data.mustNotActRegressions, 0);
    assert.ok(data.model.falseActions <= data.rule.falseActions);
    assert.ok(data.simple.rows > 0);
    assert.equal(data.simple.modelCalls, 0);
    const l = data.simple.latencyMs;
    assert.ok(l.after.p95 <= l.before.p95 + data.simple.slackMs, JSON.stringify(l));
    assert.equal(code, 0);
    assert.ok(data.gateRate > 0 && data.gateRate < 100);
  });
}

test('fake model v1: rule-only column equals the committed baseline', () => {
  const { data } = fake('1');
  const base = require('../docs/intelligence/baseline-intelligence-eval-v1.json');
  assert.equal(data.rule.accuracy, base.accuracy);
  assert.equal(data.rule.falseActions, base.falseActions);
  for (const [cat, b] of Object.entries(base.byCategory)) assert.equal(data.byCategory[cat].rule, b.ok, cat);
  assert.equal(data.baseline.accuracy, base.accuracy);
});

test('fake model with noise is seeded: same seed, same result; noise costs accuracy', () => {
  const a = json('--model', 'fake', '--noise', '0.15', '--seed', '7').data;
  const b = json('--model', 'fake', '--noise', '0.15', '--seed', '7').data;
  for (const d of [a, b]) delete d.simple.latencyMs;
  assert.deepEqual(a, b);
  assert.ok(a.noiseHits > 0);
  assert.ok(a.model.accuracy <= fake('1').data.model.accuracy);
});

test('--model off is byte-identical to the old default output (text and json)', () => {
  const plain = run();
  const off = run('--model', 'off');
  assert.equal(plain.code, 0);
  assert.equal(maskMs(off.out), maskMs(plain.out));
  assert.match(plain.out, /^intelligence eval v1: 52\.1% \(37\/71\)/);
  const j = JSON.parse(run('--json', '--model', 'off').out);
  const base = require('../docs/intelligence/baseline-intelligence-eval-v1.json');
  delete j.ruleLayerMsPerRequest;
  const { ruleLayerMsPerRequest, ...want } = base;
  assert.deepEqual(j, want);
});

test('unknown --model value exits 2 with a message', () => {
  const r = run('--model', 'gpt');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown --model gpt/);
});
