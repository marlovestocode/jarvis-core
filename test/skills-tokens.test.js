const test = require('node:test');
const assert = require('node:assert/strict');
const { measureSpecs } = require('./helpers/spec-size');

test("tokens: selected specs are at least 60% smaller than today's flat list", t => {
  const m = measureSpecs();
  assert.ok(m.turns >= 30, `only ${m.turns} deep rows`);
  t.diagnostic(`flat ${m.baseline} chars (${m.baselineTools} tools); selected mean ${Math.round(m.meanChars)} chars, ${m.meanTools.toFixed(1)} tools, over ${m.turns} deep turns; reduction ${(100 * m.reduction).toFixed(1)}%`);
  assert.ok(m.meanChars <= 0.4 * m.baseline, `mean ${Math.round(m.meanChars)} > 40% of ${m.baseline}`);
});
