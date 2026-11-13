const test = require('node:test');
const assert = require('node:assert/strict');
const { cooling, COOLDOWN_MS, COOL_AT } = require('../src/core/brain/cooldown');

const NOW = 1_700_000_000_000;

test('cooldown: constants match the spec', () => {
  assert.equal(COOLDOWN_MS, 120000);
  assert.equal(COOL_AT, 2);
});

test('cooldown: one ok:false tool failure does not cool it, two do', () => {
  const one = cooling({ tools: [{ name: 'web_search', ok: false, soft: false, t: NOW - 1000 }] }, NOW);
  assert.deepEqual([...one.tools], []);
  const two = cooling({ tools: [
    { name: 'web_search', ok: false, soft: false, t: NOW - 1000 },
    { name: 'web_search', ok: false, soft: false, t: NOW - 500 },
  ] }, NOW);
  assert.deepEqual([...two.tools], ['web_search']);
});

test('cooldown: soft failures count 0.5, so two do not cool a tool and four do', () => {
  const soft = n => Array.from({ length: n }, (_, i) => ({ name: 'fetch', ok: false, soft: true, t: NOW - i }));
  assert.deepEqual([...cooling({ tools: soft(2) }, NOW).tools], []);
  assert.deepEqual([...cooling({ tools: soft(3) }, NOW).tools], []);
  assert.deepEqual([...cooling({ tools: soft(4) }, NOW).tools], ['fetch']);
});

test('cooldown: soft failures recorded as ok:true also count 0.5 (LiveState shape)', () => {
  const soft = n => ({ tools: Array.from({ length: n }, (_, i) => ({ name: 'fetch', ok: true, soft: true, t: NOW - i })) });
  assert.deepEqual([...cooling(soft(3), NOW).tools], []);
  assert.deepEqual([...cooling(soft(4), NOW).tools], ['fetch']);
});

test('cooldown: an entry exactly COOLDOWN_MS old still counts', () => {
  const snap = { tools: [
    { name: 'web_search', ok: false, soft: false, t: NOW - COOLDOWN_MS },
    { name: 'web_search', ok: false, soft: false, t: NOW - COOLDOWN_MS },
  ], models: [{ name: 'qwen', t: NOW - COOLDOWN_MS }, { name: 'qwen', t: NOW - COOLDOWN_MS }] };
  const out = cooling(snap, NOW);
  assert.deepEqual([...out.tools], ['web_search']);
  assert.deepEqual([...out.models], ['qwen']);
});

test('cooldown: ok:true entries count 0', () => {
  const snap = { tools: Array.from({ length: 5 }, () => ({ name: 'web_search', ok: true, soft: false, t: NOW })) };
  assert.deepEqual([...cooling(snap, NOW).tools], []);
});

test('cooldown: entries older than 2 min are ignored', () => {
  const snap = { tools: [
    { name: 'web_search', ok: false, soft: false, t: NOW - COOLDOWN_MS - 1 },
    { name: 'web_search', ok: false, soft: false, t: NOW - COOLDOWN_MS - 5000 },
  ] };
  assert.deepEqual([...cooling(snap, NOW).tools], []);
  const mixed = { tools: [
    { name: 'web_search', ok: false, soft: false, t: NOW - COOLDOWN_MS - 1 },
    { name: 'web_search', ok: false, soft: false, t: NOW - 1000 },
  ] };
  assert.deepEqual([...cooling(mixed, NOW).tools], []);
});

test('cooldown: failures of different tools do not add up', () => {
  const snap = { tools: [
    { name: 'web_search', ok: false, soft: false, t: NOW - 1000 },
    { name: 'read_file', ok: false, soft: false, t: NOW - 900 },
    { name: 'fetch', ok: false, soft: true, t: NOW - 800 },
    { name: 'fetch', ok: false, soft: true, t: NOW - 700 },
  ] };
  assert.deepEqual([...cooling(snap, NOW).tools], []);
});

test('cooldown: models cool from snap.models, one failure each, two cool it', () => {
  const one = cooling({ models: [{ name: 'qwen', t: NOW - 1000 }] }, NOW);
  assert.deepEqual([...one.models], []);
  const two = cooling({ models: [{ name: 'qwen', t: NOW - 1000 }, { name: 'qwen', t: NOW - 500 }] }, NOW);
  assert.deepEqual([...two.models], ['qwen']);
  assert.deepEqual([...two.tools], []);
});

test('cooldown: models outside the window are ignored', () => {
  const snap = { models: [{ name: 'qwen', t: NOW - COOLDOWN_MS - 1 }, { name: 'qwen', t: NOW - COOLDOWN_MS - 2 }] };
  assert.deepEqual([...cooling(snap, NOW).models], []);
});

test('cooldown: missing, null or non-object snap returns empty sets', () => {
  for (const snap of [undefined, null, 'x', 42, true, []]) {
    const out = cooling(snap, NOW);
    assert.ok(out.tools instanceof Set);
    assert.ok(out.models instanceof Set);
    assert.equal(out.tools.size, 0);
    assert.equal(out.models.size, 0);
  }
});

test('cooldown: non-array tools or models return empty sets', () => {
  const out = cooling({ tools: 'web_search', models: { name: 'qwen', t: NOW } }, NOW);
  assert.equal(out.tools.size, 0);
  assert.equal(out.models.size, 0);
});

test('cooldown: entries without a string name or numeric t are skipped', () => {
  const bad = [
    { ok: false, soft: false, t: NOW },
    { name: 42, ok: false, soft: false, t: NOW },
    { name: 'web_search', ok: false, soft: false },
    { name: 'web_search', ok: false, soft: false, t: '123' },
    { name: 'web_search', ok: false, soft: false, t: NaN },
    null,
    'web_search',
  ];
  const out = cooling({ tools: bad, models: bad.map(e => (e && typeof e === 'object' ? { ...e, t: e.t } : e)) }, NOW);
  assert.equal(out.tools.size, 0);
  assert.equal(out.models.size, 0);
});

test('cooldown: a throwing getter never throws, it returns empty sets', () => {
  const snap = {};
  Object.defineProperty(snap, 'tools', { get() { throw new Error('boom'); } });
  const out = cooling(snap, NOW);
  assert.equal(out.tools.size, 0);
  assert.equal(out.models.size, 0);
});

test('cooldown: now defaults to Date.now()', () => {
  const snap = { tools: [{ name: 'web_search', ok: false, soft: false, t: Date.now() }, { name: 'web_search', ok: false, soft: false, t: Date.now() }] };
  assert.deepEqual([...cooling(snap).tools], ['web_search']);
});
