const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { l2normalize, truncate, quantize, dequantize, dotI8 } = require('../src/core/cortex/vectors');

// seeded PRNG so failures repeat
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function randomUnit(r, dim) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = r() * 2 - 1;
  return l2normalize(v);
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = v => Math.sqrt(dot(v, v));

test('cortex-quality: quantize round-trip max error ≤ scale/2', () => {
  const r = rng(1);
  for (let n = 0; n < 50; n++) {
    const v = randomUnit(r, 256);
    const q = quantize(v);
    assert.ok(q.v instanceof Int8Array);
    const back = dequantize(q);
    for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) <= q.scale / 2 + 1e-7, `i=${i}`);
  }
});

test('cortex-quality: dotI8 matches float dot within 2% of unit scale', () => {
  const r = rng(2);
  for (let n = 0; n < 50; n++) {
    const a = randomUnit(r, 256), b = randomUnit(r, 256);
    const qa = quantize(a), qb = quantize(b);
    assert.ok(Math.abs(dotI8(qa.v, qa.scale, qb.v, qb.scale) - dot(a, b)) <= 0.02);
  }
});

test('cortex-quality: truncate keeps the first dims and returns unit length', () => {
  const v = randomUnit(rng(3), 768);
  const t = truncate(v, 256);
  assert.equal(t.length, 256);
  assert.ok(Math.abs(norm(t) - 1) < 1e-5);
  assert.ok(Math.sign(t[0]) === Math.sign(v[0]));
});

test('cortex-quality: l2normalize of a zero vector stays zero (no NaN)', () => {
  const z = l2normalize(new Float32Array(8));
  assert.ok([...z].every(x => x === 0));
  const q = quantize(z);
  assert.ok([...dequantize(q)].every(x => x === 0));
});

test('cortex-quality: fake embedder is deterministic, unit length and honours synonyms', async () => {
  const { createFakeEmbedder } = require('../src/core/cortex/embedder');
  const e = createFakeEmbedder({ dim: 64, synonyms: { puppy: 'dog' } });
  assert.equal(e.dim, 64);
  const [a, b, c, d] = await e.embed(['my dog', 'my dog', 'my puppy', 'tax invoice']);
  assert.deepEqual([...a], [...b]);
  assert.ok(Math.abs(norm(a) - 1) < 1e-5);
  assert.ok(dot(a, c) > dot(a, d));
});

test('cortex-quality: fixture has 200 docs and 40 labeled queries', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cortex-quality.json'), 'utf8'));
  assert.equal(fx.docs.length, 200);
  assert.equal(fx.queries.length, 40);
  const ids = new Set(fx.docs.map(d => d.id));
  for (const q of fx.queries) assert.ok(q.relevant.length && q.relevant.every(id => ids.has(id)));
});
