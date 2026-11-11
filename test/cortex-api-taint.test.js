const test = require('node:test');
const assert = require('node:assert/strict');
const cortexLib = require('../src/core/cortex');

test('cortex-api-taint: a tainted turn cannot write user or tool trust', () => {
  const c = cortexLib.open({});
  for (const kind of ['user', 'tool']) {
    const s = c.source.add({ kind, ref: 'turn' });
    assert.throws(() => c.node.upsert({ kind: 'fact', text: 'Rex is my dog', source: s, tainted: true }), e => e.code === 'tainted');
  }
  assert.equal(c.stats().nodes, 0);
  c.close();
});

test('cortex-api-taint: a tainted turn may add web knowledge', () => {
  const c = cortexLib.open({});
  const s = c.source.add({ kind: 'web', ref: 'https://example.org' });
  assert.equal(c.node.upsert({ kind: 'knowledge', text: 'Rex is a common dog name', source: s, tainted: true }).created, true);
  c.close();
});

test('cortex-api-taint: reinforce in a tainted turn changes nothing', () => {
  const c = cortexLib.open({});
  const s = c.source.add({ kind: 'user', ref: 'x' });
  const a = c.node.upsert({ kind: 'fact', text: 'Rex has a vet visit', source: s }).id;
  const b = c.node.upsert({ kind: 'entity', key: 'entity:rex', text: 'Rex', source: s }).id;
  c.link(a, b, 'mentions', { weight: 0.5 });
  c.reinforce([a, b], { tainted: true });
  assert.equal(c.neighbors(a)[0].weight, 0.5);
  c.close();
  });
