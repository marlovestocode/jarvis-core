// Cortex embedders (core spec §6.2).
// Embedder = { id, dim, embed(texts, { signal, role: 'doc'|'query' }) → Promise<Float32Array[]>, status() → Promise<{ ok, model, reason? }> }
const { l2normalize, truncate } = require('./vectors');
const { CortexError } = require('./guard');

const { localOrigin } = require('../net/services');
const STOP = new Set(['the', 'a', 'an', 'my', 'that', 'i', 'is', 'am', 'are', 'to', 'of', 'and', 'it', 'about', 'me', 'on', 'in', 'what', 'do', 'you', 'we', 'he', 'she', 'they', 'this', 'for', 'at', 'be', 'was', 'with', 'or', 'your']);

const fnv1a = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const tokens = s => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Deterministic hashed bag-of-words: each word adds ±1 to two buckets. `synonyms` maps a word to another
// so tests can make "puppy" and "dog" the same direction.
function createFakeEmbedder({ dim = 256, synonyms = {} } = {}) {
  function one(text) {
    const v = new Float32Array(dim);
    for (const raw of tokens(text)) {
      const w = synonyms[raw] || raw;
      const h1 = fnv1a(w), h2 = fnv1a(w + '#');
      v[h1 % dim] += (h1 & 0x80000000) ? -1 : 1;
      v[h2 % dim] += (h2 & 0x80000000) ? -1 : 1;
    }
    return l2normalize(v);
  }
  return {
    id: 'fake', dim,
    async embed(texts) { return texts.map(one); },
    async status() { return { ok: true, model: 'fake' }; },
  };
}

// Ollama /api/embed on the local host only, on CPU (num_gpu 0, short keep_alive) so it holds no VRAM.
// nomic-embed-text wants task prefixes (plan D11); dim > 0 truncates Matryoshka-style, dim 0 keeps the full vector.
// Default 768 = full size: the 2026-11-11 quality run (scripts/cortex-quality.js) gave top-10 overlap 0.773 at 256, 0.823 at 384,
// 0.855 at 512 and 0.993 at 768 (int8), against the 0.95 gate. Layer norm before truncation did not help.
function createOllamaEmbedder({ getConfig, fetch: fetchImpl, model = 'nomic-embed-text', dim = 768, timeoutMs = 30000 } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const host = () => {
    const h = localOrigin((getConfig?.() || {}).ollama?.host);
    if (!h) throw new CortexError('host_not_local', 'the embedder only talks to a local Ollama');
    return h;
  };
  const PREFIX = { query: 'search_query: ', doc: 'search_document: ' };

  async function post(path, body, signal) {
    const res = await doFetch(host() + path, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal || AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!res.ok) throw new CortexError('embed_http', `Ollama HTTP ${res.status}`);
    return res.json();
  }

  async function embed(texts, { signal, role = 'doc' } = {}) {
    const input = texts.map(t => (PREFIX[role] || PREFIX.doc) + String(t));
    const j = await post('/api/embed', { model, input, options: { num_gpu: 0 }, keep_alive: '30s' }, signal);
    const rows = j?.embeddings;
    if (!Array.isArray(rows) || rows.length !== texts.length || rows.some(r => !Array.isArray(r) || !r.length || r.some(x => !Number.isFinite(x)))) throw new CortexError('embed_shape');
    return rows.map(r => (dim > 0 ? truncate(Float32Array.from(r), dim) : l2normalize(Float32Array.from(r))));
  }

  async function status() {
    try {
      const j = await post('/api/tags', null, AbortSignal.timeout(4000));
      const names = (j?.models || []).map(m => String(m.name || m.model || ''));
      const ok = names.some(n => n === model || n.startsWith(model + ':'));
      return ok ? { ok: true, model } : { ok: false, model, reason: 'model_missing' };
    } catch (err) { return { ok: false, model, reason: err.code || 'unreachable' }; }
  }

  return { id: 'ollama:' + model + (dim > 0 ? '@' + dim : ''), dim, embed, status };
}

// The only embedding on the turn path: LRU cache, a hard timeout (null = go keyword-only), short queries skipped (spec §6.2).
function withQueryCache(embedder, { size = 256, timeoutMs = 120, minWords = 3 } = {}) {
  const cache = new Map();
  const contentWords = text => tokens(text).filter(w => w.length > 1 && !STOP.has(w));
  async function query(text) {
    if (!embedder) return null;
    const words = contentWords(text);
    if (words.length < minWords) return null;
    const key = words.join(' ');
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
    const ac = new AbortController();
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => { ac.abort(); resolve(null); }, timeoutMs); });
    const work = embedder.embed([String(text)], { signal: ac.signal, role: 'query' }).then(r => r?.[0] ?? null, () => null);
    const v = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (v) { cache.set(key, v); if (cache.size > size) cache.delete(cache.keys().next().value); }
    return v;
  }
  return { query, size: () => cache.size, clear: () => cache.clear() };
}

module.exports = { createFakeEmbedder, createOllamaEmbedder, withQueryCache };
