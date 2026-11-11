const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/core/cortex/db');
const { createSources } = require('../src/core/cortex/sources');
const { createNodes } = require('../src/core/cortex/nodes');
const { createEdges } = require('../src/core/cortex/edges');
const { createVectors } = require('../src/core/cortex/vectors');
const { createFakeEmbedder, withQueryCache } = require('../src/core/cortex/embedder');
const { createRecall } = require('../src/core/cortex/recall');

const T0 = 1_700_000_000_000;
function setup({ embedder = null, queryVector } = {}) {
  const now = () => T0;
  const db = openDb({ file: ':memory:' });
  const sources = createSources(db, { now });
  const nodes = createNodes(db, { now, sources });
  const edges = createEdges(db, { now });
  const vectors = createVectors(db, { dim: 64, model: 'fake' });
  const qv = queryVector || (embedder ? withQueryCache(embedder).query : async () => null);
  const r = createRecall({ db, edges, vectors, queryVector: qv, now });
  const user = sources.add({ kind: 'user', ref: 's1' });
  const add = (kind, text, extra = {}) => nodes.upsert({ kind, text, source: user, ...extra }).id;
  return { db, nodes, edges, vectors, recall: r.recall, add, sources };
}

test('cortex-recall: nothing matches → mode empty, no text', async () => {
  const { recall, add } = setup();
  add('fact', 'Rex has a vet visit in March');
  const r = await recall('quantum chromodynamics');
  assert.equal(r.mode, 'empty');
  assert.equal(r.text, '');
  assert.deepEqual(r.items, []);
  assert.equal(typeof r.ms, 'number');
});

test('cortex-recall: keyword hit is tagged with source and age', async () => {
  const { recall, add } = setup();
  const id = add('fact', 'Rex has a vet visit in March');
  const r = await recall('when is the vet visit');
  assert.equal(r.mode, 'keyword');
  assert.equal(r.items[0].id, id);
  assert.equal(r.items[0].source, 'you said');
  assert.equal(r.items[0].age, 'today');
  assert.equal(r.text, 'Rex has a vet visit in March [you said · today]');
});

test('cortex-recall: two-hop spread reaches a node with no shared word', async () => {
  const { recall, add, edges } = setup();
  const chat = add('chat', 'We talked about my dog and his walks');
  const rex = add('entity', 'Rex', { key: 'entity:rex' });
  const vet = add('fact', 'Rex has a vet visit in March');
  edges.link(chat, rex, 'mentions', { weight: 0.9 });
  edges.link(vet, rex, 'mentions', { weight: 0.9 });
  const r = await recall('my dog', { kinds: ['fact', 'chat'] });
  assert.ok(r.items.some(i => i.id === vet), r.text);
  assert.ok(!r.items.some(i => i.id === rex));   // entity not in kinds: it carries activation but is not packed
});

test('cortex-recall: seed fusion ranks a node found by both paths above either alone', async () => {
  const embedder = createFakeEmbedder({ dim: 64, synonyms: { puppy: 'dog', canine: 'dog' } });
  const { recall, add, vectors } = setup({ embedder });
  const both = add('fact', 'my dog loves the park');
  const kwOnly = add('fact', 'the park closes at nine');
  const vecOnly = add('fact', 'canine loves');
  for (const [id, t] of [[both, 'my dog loves the park'], [kwOnly, 'the park closes at nine'], [vecOnly, 'canine loves']]) vectors.put(id, (await embedder.embed([t]))[0]);
  const r = await recall('puppy loves park outings');
  assert.equal(r.mode, 'hybrid');
  assert.equal(r.items[0].id, both);
  assert.ok(r.items.some(i => i.id === vecOnly));
});

test('cortex-recall: budget is a ceiling', async () => {
  const { recall, add } = setup();
  for (let i = 0; i < 40; i++) add('fact', `Rex fact number ${i} about the dog and its many habits at home`);
  for (const budget of [100, 500, 1000]) {
    const r = await recall('Rex dog habits', { budget });
    assert.ok(r.text.length <= budget, `${r.text.length} > ${budget}`);
    assert.ok(r.items.length > 0);
  }
  assert.equal((await recall('Rex dog habits', { budget: 5 })).text, '');
});

test('cortex-recall: quotas keep facts when chats are many', async () => {
  const { recall, add } = setup();
  for (let i = 0; i < 50; i++) add('chat', `chat ${i}: we talked about the dog Rex again and again and again`, { importance: 1 });
  for (let i = 0; i < 3; i++) add('fact', `Rex fact ${i}: the dog sleeps a lot and dreams`, { importance: 0 });
  const r = await recall('dog Rex', { kinds: ['fact', 'chat'], budget: 500 });
  assert.ok(r.items.filter(i => i.kind === 'fact').length >= 1);
  const chatChars = r.items.filter(i => i.kind === 'chat').length;
  assert.ok(chatChars > 0);
});

test('cortex-recall: quota leftover is released when one kind runs out', async () => {
  const { recall, add } = setup();
  for (let i = 0; i < 30; i++) add('chat', `chat ${i}: the dog Rex was mentioned`);
  const r = await recall('dog Rex', { kinds: ['fact', 'chat'], budget: 500 });
  assert.ok(r.text.length > 300, 'chats may use the whole budget when there are no facts');
});

test('cortex-recall: brief halves the budget and drops chats', async () => {
  const { recall, add } = setup();
  for (let i = 0; i < 20; i++) add('fact', `Rex fact ${i}: the dog sleeps on the sofa all day long`);
  add('chat', 'we talked about the dog Rex');
  const r = await recall('dog Rex sofa', { budget: 600, brief: true });
  assert.ok(r.text.length <= 300);
  assert.ok(!r.items.some(i => i.kind === 'chat'));
});

test('cortex-recall: keyword mode when the embedder times out', async () => {
  const hang = { id: 'hang', dim: 64, embed: () => new Promise(() => {}), status: async () => ({ ok: true }) };
  const { recall, add } = setup({ queryVector: withQueryCache(hang, { timeoutMs: 120 }).query });
  add('fact', 'Rex has a vet visit in March');
  const r = await recall('when does Rex visit the vet');
  assert.equal(r.mode, 'keyword');
  assert.ok(r.items.length === 1);
  assert.ok(r.ms < 400, 'ms ' + r.ms);
});

test('cortex-recall: archived and pending nodes are never returned', async () => {
  const { recall, add, nodes } = setup();
  const a = add('fact', 'Rex has a vet visit in March');
  add('fact', 'Rex has a vet appointment pending', { status: 'pending' });
  nodes.archive(a);
  assert.equal((await recall('Rex vet')).mode, 'empty');
});

test('cortex-recall: operator-shaped queries are safe', async () => {
  const { recall, add } = setup();
  add('fact', 'Rex has a vet visit in March');
  for (const q of ['" OR * NEAR(', '', '   ', '-- ; DROP TABLE node', '🙂', null]) {
    const r = await recall(q);
    assert.equal(typeof r.text, 'string');
  }
});

test('cortex-recall: a vector hit whose node is gone is skipped', async () => {
  const embedder = createFakeEmbedder({ dim: 64 });
  const { recall, add, vectors, db } = setup({ embedder });
  const a = add('fact', 'Rex loves long walks in the forest');
  const b = add('fact', 'Rex loves long walks by the river');
  for (const [id, t] of [[a, 'Rex loves long walks in the forest'], [b, 'Rex loves long walks by the river']]) vectors.put(id, (await embedder.embed([t]))[0]);
  vectors.search(new Float32Array(64).fill(1), 1);          // matrix loaded
  db.stmt('DELETE FROM node WHERE id = ?').run(a);          // row gone, matrix still holds it
  const r = await recall('Rex loves long walks');
  assert.ok(!r.items.some(i => i.id === a));
  assert.ok(r.items.some(i => i.id === b));
});

test('cortex-recall: kinds filter seeds and output', async () => {
  const { recall, add } = setup();
  add('knowledge', 'Rex is a common name for dogs', {});
  const f = add('fact', 'Rex is my dog');
  const r = await recall('Rex dog', { kinds: ['fact'] });
  assert.deepEqual(r.items.map(i => i.id), [f]);
});

test('cortex-recall: debug returns the stages', async () => {
  const { recall, add } = setup();
  add('fact', 'Rex has a vet visit in March');
  const r = await recall('Rex vet', { debug: true });
  assert.ok(Array.isArray(r.stages.seeds) && Array.isArray(r.stages.spread) && Array.isArray(r.stages.packed));
});
