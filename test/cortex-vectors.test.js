const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/core/cortex/db');
const { createVectors, l2normalize } = require('../src/core/cortex/vectors');
const { createFakeEmbedder } = require('../src/core/cortex/embedder');

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function setup({ dim = 64, model = 'fake' } = {}) {
  const db = openDb({ file: ':memory:' });
  const addNode = text => Number(db.stmt('INSERT INTO node(kind, text, created, updated) VALUES (?, ?, 1, 1)').run('fact', text).lastInsertRowid);
  return { db, addNode, vectors: createVectors(db, { dim, model }) };
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const randomUnit = (r, dim) => l2normalize(Float32Array.from({ length: dim }, () => r() * 2 - 1));

test('cortex-vectors: fake embedder puts synonyms closer than unrelated words', async () => {
  const e = createFakeEmbedder({ dim: 256, synonyms: { puppy: 'dog' } });
  const [dog, puppy, invoice] = await e.embed(['dog', 'puppy', 'invoice']);
  assert.ok(dot(dog, puppy) > dot(dog, invoice));
});

test('cortex-vectors: search order matches float32 on a fixture', () => {
  const { addNode, vectors } = setup();
  const r = rng(7), vs = [];
  for (let i = 0; i < 100; i++) { const id = addNode('n' + i); const v = randomUnit(r, 64); vs.push({ id, v }); vectors.put(id, v); }
  for (let q = 0; q < 5; q++) {
    const qv = randomUnit(r, 64);
    // int8 error per dot is ≤ 0.02 (cortex-quality test), so only near-ties (< 0.02 apart) may swap
    const exact = new Map(vs.map(x => [x.id, dot(x.v, qv)]));
    const fifth = [...exact.values()].sort((a, b) => b - a)[4];
    const got = vectors.search(qv, 5).map(x => x.id);
    assert.equal(got.length, 5);
    for (const id of got) assert.ok(exact.get(id) >= fifth - 0.02, 'far outside the float32 top 5');
    for (let i = 1; i < got.length; i++) assert.ok(exact.get(got[i - 1]) >= exact.get(got[i]) - 0.02, 'order inverted beyond the int8 error');
  }
});

test('cortex-vectors: put after load updates the matrix in place; remove drops it', () => {
  const { addNode, vectors } = setup();
  const r = rng(9);
  const a = addNode('a'); vectors.put(a, randomUnit(r, 64));
  vectors.search(randomUnit(r, 64), 1);   // loads the matrix
  const b = addNode('b'); const vb = randomUnit(r, 64); vectors.put(b, vb);
  assert.equal(vectors.search(vb, 1)[0].id, b);
  assert.ok(vectors.search(vb, 1)[0].score > 0.98);
  vectors.remove(b);
  assert.ok(!vectors.search(vb, 5).some(x => x.id === b));
  assert.equal(vectors.has(b), false);
  assert.equal(vectors.has(a), true);
});

test('cortex-vectors: trim drops the matrix and the next search reloads', () => {
  const { addNode, vectors } = setup();
  const v = randomUnit(rng(3), 64);
  const id = addNode('a'); vectors.put(id, v);
  vectors.search(v, 1);
  assert.ok(vectors.stats().matrixBytes > 0);
  vectors.trim();
  assert.equal(vectors.stats().matrixBytes, 0);
  assert.equal(vectors.search(v, 1)[0].id, id);
  assert.equal(vectors.stats().vectors, 1);
});

test('cortex-vectors: warm loads the matrix in slices; search finishes a partial load', () => {
  const { addNode, vectors } = setup();
  const r = rng(11), vs = [];
  for (let i = 0; i < 50; i++) { const id = addNode('n' + i); const v = randomUnit(r, 64); vs.push([id, v]); vectors.put(id, v); }
  vectors.trim();
  assert.deepEqual(vectors.warm({ rows: 20 }), { done: false, loaded: 20 });
  assert.deepEqual(vectors.warm({ rows: 20 }), { done: false, loaded: 40 });
  const last = vs[49];
  assert.equal(vectors.search(last[1], 1)[0].id, last[0]);   // row 50 was not warmed yet: search loads the rest
  assert.deepEqual(vectors.warm({ rows: 20 }), { done: true, loaded: 50 });
  const late = addNode('late'); const lv = randomUnit(r, 64); vectors.put(late, lv);
  assert.equal(vectors.search(lv, 1)[0].id, late);
});

test('cortex-vectors: matrix growth keeps the loaded state', () => {
  const { addNode, vectors } = setup();
  const r = rng(13);
  const first = addNode('a'); vectors.put(first, randomUnit(r, 64));
  vectors.search(randomUnit(r, 64), 1);                  // loaded, capacity 64
  let last, lv;
  for (let i = 0; i < 200; i++) { last = addNode('n' + i); lv = randomUnit(r, 64); vectors.put(last, lv); }   // grows past 64
  const hit = vectors.search(lv, 1)[0];
  assert.equal(hit.id, last);
  assert.equal(vectors.isWarm(), true);
  assert.equal(new Set(vectors.search(lv, 300).map(x => x.id)).size, 201);   // every vector once, none duplicated
});

test('cortex-vectors: wrong dim refused', () => {
  const { addNode, vectors } = setup();
  assert.throws(() => vectors.put(addNode('a'), new Float32Array(10)), e => e.code === 'dim');
  assert.deepEqual(vectors.search(new Float32Array(10), 3), []);
});

test('cortex-vectors: model change marks old vectors stale, they still serve until replaced', () => {
  const { db, addNode } = setup();
  const r = rng(5);
  const v1 = createVectors(db, { dim: 64, model: 'm1' });
  assert.equal(v1.markStaleIfModelChanged(), false);
  const id = addNode('a'); const v = randomUnit(r, 64); v1.put(id, v);
  const v2 = createVectors(db, { dim: 64, model: 'm2' });
  assert.equal(v2.markStaleIfModelChanged(), true);
  assert.equal(v2.staleCount(), 1);
  assert.deepEqual(v2.staleIds(10), [id]);
  assert.equal(v2.search(v, 1)[0].id, id);
  v2.put(id, v);
  assert.equal(v2.staleCount(), 0);
});

test('cortex-vectors: zero query returns nothing useful but never throws', () => {
  const { addNode, vectors } = setup();
  vectors.put(addNode('a'), randomUnit(rng(1), 64));
  assert.doesNotThrow(() => vectors.search(new Float32Array(64), 3));
});
