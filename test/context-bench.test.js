// Contract test for scripts/context-bench.js: the measured assemble latency stays bounded with healthy, failing and hanging providers
// (fakes only, no real store, no live model), errors are recorded and the package never exceeds its budget.
const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../scripts/context-bench.js');

test('context bench: bounded latency, recorded errors, budget respected', async () => {
  const r = await run({ runs: 40, timeoutMs: 40 });
  assert.ok(r.healthy.p95 < 50, `healthy p95 ${r.healthy.p95}`);
  assert.ok(r.failing.p95 < 50, `failing p95 ${r.failing.p95}`);
  assert.ok(r.hanging.p95 < r.timeoutMs + 250, `hanging p95 ${r.hanging.p95}`);
  assert.strictEqual(r.healthy.errors, 0);
  assert.ok(r.failing.errors > 0);
  assert.ok(r.hanging.errors > 0);
  assert.ok(r.maxChars <= r.budgetChars, `${r.maxChars} > ${r.budgetChars}`);
  assert.ok(r.dropped.budget > 0);
  for (const reason of Object.keys(r.dropped)) assert.ok(['stale', 'superseded', 'duplicate', 'budget', 'access', 'invalid'].includes(reason));
});
