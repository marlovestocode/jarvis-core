const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolRunner } = require('../src/core/tools/registry');
const { skillTools, createStatusTool } = require('../src/core/tools/skills');

const runner = createToolRunner(skillTools());
const run = (name, args) => runner.run(name, args, {});

test('skill tools: every tool has a name, description and object schema', () => {
  for (const s of runner.specs()) {
    assert.match(s.name, /^[a-z_]+$/);
    assert.ok(s.description.length > 20, s.name);
    assert.equal(s.params.type, 'object');
  }
  assert.deepEqual(runner.specs().map(s => s.name).sort(),
    ['calculate', 'convert_units', 'date_calc', 'differentiate', 'integrate', 'physics_constant', 'solve_equation', 'statistics'].sort());
});

test('calculate: exact and decimal results', async () => {
  assert.deepEqual(await run('calculate', { expression: '2^100' }), { ok: true, text: '2^100 = 1267650600228229401496703205376 (exact)' });
  assert.equal((await run('calculate', { expression: '23.7^3.2' })).text, '23.7^3.2 = 25072.3306882');
  const bad = await run('calculate', { expression: '2 +' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /Unexpected end/);
});

test('calculus tools', async () => {
  assert.match((await run('solve_equation', { equation: 'x^3 - 2x - 5 = 0' })).text, /x = 2\.09455148154/);
  assert.match((await run('solve_equation', { equation: 'x^2 = -1' })).text, /No real roots/);
  assert.match((await run('integrate', { expression: 'x^2 * e^(-x)', from: '0', to: 'inf' })).text, /= 2\b/);
  assert.match((await run('differentiate', { expression: 'x^3*sin(x)', at: 2 })).text, /7\.5823944/);
});

test('statistics, units, constants, dates', async () => {
  const s = (await run('statistics', { values: [4, 8, 15, 16, 23, 42] })).text;
  assert.match(s, /mean 18/); assert.match(s, /sample stdev 13\.4907375632/);
  assert.match((await run('statistics', { values: [1, 2, 3, 4], y: [2, 4.1, 5.9, 8.1] })).text, /slope 2\.01/);
  assert.equal((await run('convert_units', { value: 65, from: 'mph', to: 'm/s' })).text, '65 mph = 29.0576 m/s');
  assert.match((await run('physics_constant', { name: 'planck' })).text, /6\.62607015e-34 J s \(exact\)/);
  assert.equal((await run('physics_constant', { name: 'zzz' })).ok, false);
  assert.match((await run('date_calc', { from: '2024-03-03', to: '2026-11-09' })).text, /981 days/);
});

test('jarvis_status: reports hardware and components from the injected source', async () => {
  const tool = createStatusTool({ getStatus: async () => ({ cpu: 'Ryzen 5 5600X (12 threads)', ramGB: 15.9, gpu: 'NVIDIA GeForce RTX 3050, 8 GB VRAM', os: 'Windows 11', model: 'jarvis-worker:latest', sysmon: 'running' }) });
  const r = await createToolRunner([tool]).run('jarvis_status', {}, {});
  assert.equal(r.ok, true);
  assert.match(r.text, /RTX 3050/); assert.match(r.text, /15\.9 GB/); assert.match(r.text, /jarvis-worker/);
});
