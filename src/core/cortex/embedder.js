// Cortex embedders (core spec §6.2).
// Embedder = { id, dim, embed(texts, { signal, role: 'doc'|'query' }) → Promise<Float32Array[]>, status() → Promise<{ ok, model, reason? }> }
const { l2normalize } = require('./vectors');

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

module.exports = { createFakeEmbedder };
