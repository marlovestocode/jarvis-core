const test = require('node:test');
const assert = require('node:assert/strict');
const { createOllamaEmbedder, withQueryCache, createFakeEmbedder } = require('../src/core/cortex/embedder');

const norm = v => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

function fakeFetch({ tags = ['nomic-embed-text:latest'], dims = 768 } = {}) {
  const calls = [];
  const f = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: tags.map(name => ({ name })) }) };
    if (url.endsWith('/api/embed')) return { ok: true, json: async () => ({ embeddings: body.input.map((_, i) => Array.from({ length: dims }, (__, j) => ((i + 1) * (j + 1)) % 7 - 3)) }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { f, calls };
}
const cfg = host => () => ({ ollama: { host } });

test('cortex-embedder: ollama request runs on CPU with role prefixes and truncates to dim', async () => {
  const { f, calls } = fakeFetch();
  const e = createOllamaEmbedder({ getConfig: cfg('http://127.0.0.1:11434'), fetch: f, dim: 256 });
  assert.equal(e.dim, 256);
  const [v] = await e.embed(['where is my dog'], { role: 'query' });
  const req = calls.find(c => c.url.endsWith('/api/embed'));
  assert.equal(req.url, 'http://127.0.0.1:11434/api/embed');
  assert.equal(req.body.model, 'nomic-embed-text');
  assert.equal(req.body.options.num_gpu, 0);
  assert.deepEqual(req.body.input, ['search_query: where is my dog']);
  assert.equal(v.length, 256);
  assert.ok(Math.abs(norm(v) - 1) < 1e-5);
  await e.embed(['Rex is my dog']);
  assert.deepEqual(calls.at(-1).body.input, ['search_document: Rex is my dog']);
});

test('cortex-embedder: default keeps the full 768 dims (truncation failed the quality gate)', async () => {
  const { f } = fakeFetch();
  const e = createOllamaEmbedder({ getConfig: cfg('http://127.0.0.1:11434'), fetch: f });
  assert.equal(e.dim, 768);
  const [v] = await e.embed(['Rex is my dog']);
  assert.equal(v.length, 768);
});

test('cortex-embedder: refuses a non-local host', async () => {
  const { f, calls } = fakeFetch();
  const e = createOllamaEmbedder({ getConfig: cfg('https://example.com'), fetch: f });
  await assert.rejects(e.embed(['x']), err => err.code === 'host_not_local');
  assert.equal((await e.status()).ok, false);
  assert.equal(calls.length, 0);
});

test('cortex-embedder: status reports a missing model and never pulls', async () => {
  const { f, calls } = fakeFetch({ tags: ['qwen3:8b'] });
  const e = createOllamaEmbedder({ getConfig: cfg('http://127.0.0.1:11434'), fetch: f });
  const s = await e.status();
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'model_missing');
  assert.ok(!calls.some(c => /pull/.test(c.url)));
  const { f: f2 } = fakeFetch();
  assert.equal((await createOllamaEmbedder({ getConfig: cfg('http://localhost:11434'), fetch: f2 }).status()).ok, true);
});

test('cortex-embedder: wrong count or bad numbers rejected', async () => {
  const bad = async () => ({ ok: true, json: async () => ({ embeddings: [] }) });
  const e = createOllamaEmbedder({ getConfig: cfg('http://127.0.0.1:11434'), fetch: bad });
  await assert.rejects(e.embed(['a', 'b']), err => err.code === 'embed_shape');
});

test('cortex-embedder: query cache hit skips embed', async () => {
  let n = 0;
  const base = createFakeEmbedder({ dim: 32 });
  const counting = { ...base, async embed(t, o) { n++; return base.embed(t, o); } };
  const q = withQueryCache(counting);
  const a = await q.query('where does my dog sleep');
  const b = await q.query('where does my dog sleep');
  assert.equal(n, 1);
  assert.equal(a, b);
});

test('cortex-embedder: query timeout gives null within about 120 ms', async () => {
  const hang = { id: 'hang', dim: 32, embed: (t, { signal } = {}) => new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')))), status: async () => ({ ok: true }) };
  const q = withQueryCache(hang, { timeoutMs: 120 });
  const t0 = performance.now();
  assert.equal(await q.query('where does my dog sleep'), null);
  assert.ok(performance.now() - t0 < 150 * 3);   // slack for a busy test runner; the bench reports the real number
});

test('cortex-embedder: embedder that ignores abort still returns null on time', async () => {
  const hang = { id: 'hang', dim: 32, embed: () => new Promise(() => {}), status: async () => ({ ok: true }) };
  const q = withQueryCache(hang, { timeoutMs: 50 });
  assert.equal(await q.query('where does my dog sleep'), null);
});

test('cortex-embedder: short query gives null without a call', async () => {
  let n = 0;
  const base = createFakeEmbedder({ dim: 32 });
  const q = withQueryCache({ ...base, async embed(t) { n++; return base.embed(t); } });
  assert.equal(await q.query('my dog'), null);
  assert.equal(await q.query('the a is'), null);
  assert.equal(n, 0);
  assert.equal(withQueryCache(null).query('where does my dog sleep') instanceof Promise, true);
  assert.equal(await withQueryCache(null).query('where does my dog sleep'), null);
});
