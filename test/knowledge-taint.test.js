const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/cortex');
const { createKnowledgeStore } = require('../src/core/knowledge/store');

const base = { key: 'kn:wikipedia.org:rome', host: 'wikipedia.org', title: 'Rome', url: 'https://en.wikipedia.org/wiki/Rome', text: 'Rome is the capital city of Italy.', ttlClass: 'stable', tool: 'lookup_knowledge', query: 'capital of italy' };

test('knowledge taint: user or tool trust is never written through the knowledge store', () => {
  const cortex = open({});
  const k = createKnowledgeStore({ cortex });
  assert.deepEqual(k.save({ ...base, sourceKind: 'user' }), { skipped: 'source' });
  assert.deepEqual(k.save({ ...base, sourceKind: 'tool' }), { skipped: 'source' });
  assert.deepEqual(k.save({ ...base, sourceKind: 'model' }), { skipped: 'source' });
  assert.equal(cortex.node.list({ kind: 'knowledge' }).length, 0);
});

test('knowledge taint: every stored provenance is wiki or web', () => {
  const cortex = open({});
  const k = createKnowledgeStore({ cortex });
  k.save({ ...base, sourceKind: 'wiki' });
  k.save({ ...base, key: 'kn:example.com:rome', url: 'https://example.com/rome', sourceKind: 'web', ttlClass: 'news-ish' });
  const kinds = cortex.node.list({ kind: 'knowledge' }).flatMap(n => cortex.node.get(n.id).sources.map(s => s.kind));
  assert.deepEqual([...new Set(kinds)].sort(), ['web', 'wiki']);
});

test('knowledge taint: after knowledge saves a tainted user-trust write is still refused', () => {
  const cortex = open({});
  createKnowledgeStore({ cortex }).save({ ...base, sourceKind: 'wiki' });
  const user = cortex.source.add({ kind: 'user', ref: 'chat' });
  assert.throws(() => cortex.node.upsert({ kind: 'fact', text: 'The user lives in Rome', source: user, tainted: true }), e => e.code === 'tainted');
});
