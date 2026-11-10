const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolRunner } = require('../src/core/tools/registry');
const { timeTool } = require('../src/core/tools/time');

const echo = { name: 'echo', description: 'Echo', params: { type: 'object', properties: { s: { type: 'string' } } }, async run(a) { return 'got ' + a.s; } };

test('specs lists tools', () => {
  const r = createToolRunner([echo, timeTool]);
  assert.deepEqual(r.specs().map(s => s.name), ['echo', 'get_time']);
  assert.deepEqual(Object.keys(r.specs()[0]).sort(), ['description', 'name', 'params']);
});

test('run returns ok text', async () => {
  const r = createToolRunner([echo]);
  assert.deepEqual(await r.run('echo', { s: 'x' }, {}), { ok: true, text: 'got x' });
});

test('unknown name → ok:false', async () => {
  const r = createToolRunner([echo]);
  const res = await r.run('nope', {}, {});
  assert.equal(res.ok, false);
  assert.match(res.text, /^Error: .*nope/);
});

test('throwing tool → ok:false with message', async () => {
  const r = createToolRunner([{ ...echo, name: 'bad', async run() { throw new Error('kaput'); } }]);
  assert.deepEqual(await r.run('bad', {}, {}), { ok: false, text: 'Error: kaput' });
});

test('a tool may carry its own longer timeout', async () => {
  const r = createToolRunner([{ ...echo, name: 'slowish', timeoutMs: 200, run: () => new Promise(res => setTimeout(() => res('done'), 60)) }], { timeoutMs: 30 });
  assert.deepEqual(await r.run('slowish', {}), { ok: true, text: 'done' });
});

test('slow tool → ok:false after timeout', async () => {
  const r = createToolRunner([{ ...echo, name: 'slow', run: () => new Promise(res => setTimeout(() => res('late'), 500)) }], { timeoutMs: 30 });
  const t0 = Date.now();
  const res = await r.run('slow', {}, {});
  assert.equal(res.ok, false);
  assert.match(res.text, /timed out/);
  assert.ok(Date.now() - t0 < 300);
});

test('get_time returns local ISO time, weekday and time zone', async () => {
  assert.equal(timeTool.name, 'get_time');
  const text = await timeTool.run({}, {});
  assert.match(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
  assert.match(text, /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
  assert.ok(text.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
});
