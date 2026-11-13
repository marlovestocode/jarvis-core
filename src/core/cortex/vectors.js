// Cortex vectors: int8 quantization with a per-vector scale (core spec §6.3).
// Vectors are L2-normalized first, so a dot product is a cosine.

function l2normalize(f32) {
  let s = 0;
  for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
  const out = new Float32Array(f32.length);
  if (!s) return out;
  const k = 1 / Math.sqrt(s);
  for (let i = 0; i < f32.length; i++) out[i] = f32[i] * k;
  return out;
}

// Matryoshka truncation: keep the first dims, re-normalize.
function truncate(f32, dim) {
  return l2normalize(f32.length > dim ? f32.subarray(0, dim) : f32);
}

// scale = max|x| / 127, v = round(x / scale); error per element ≤ scale / 2
function quantize(f32) {
  let max = 0;
  for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > max) max = a; }
  const scale = max / 127;
  const v = new Int8Array(f32.length);
  if (scale) for (let i = 0; i < f32.length; i++) v[i] = Math.round(f32[i] / scale);
  return { scale, v };
}

function dequantize({ scale, v }) {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * scale;
  return out;
}

function dotI8(a, sa, b, sb) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s * sa * sb;
}

const asI8 = buf => new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
const asBytes = i8 => new Uint8Array(i8.buffer, i8.byteOffset, i8.byteLength);

// Vector store: rows in `vec`, plus a lazily built in-memory matrix (one Int8Array of N×dim, scales, node ids)
// searched by brute force. An ANN index can replace search() later without touching callers (spec §6.3).
function createVectors(db, { dim = 256, model = 'none' } = {}) {
  const { CortexError } = require('./guard');
  let m = null;   // { ids: Int32Array, scales: Float32Array, data: Int8Array, n, row: Map<id, index> }

  function alloc(cap) { return { ids: new Int32Array(cap), scales: new Float32Array(cap), data: new Int8Array(cap * dim), n: 0, row: new Map() }; }
  function append(id, scale, v) {
    if (m.n === m.ids.length) {
      const bigger = alloc(Math.max(64, m.ids.length * 2));
      bigger.ids.set(m.ids); bigger.scales.set(m.scales); bigger.data.set(m.data); bigger.n = m.n; bigger.row = m.row; bigger.upTo = m.upTo; bigger.complete = m.complete;
      m = bigger;
    }
    m.ids[m.n] = id; m.scales[m.n] = scale; m.data.set(v, m.n * dim); m.row.set(id, m.n); m.n++;
  }
  // The matrix loads in node-id order, a slice at a time (warm), so the idle job never stalls on all of it at once;
  // search() completes a partial load. `upTo` = highest node id loaded so far.
  function loadSome(rows) {
    if (!m) { m = alloc(Math.max(64, rows)); m.upTo = 0; m.complete = false; }   // grows by doubling as slices arrive
    if (m.complete) return;
    const got = db.stmt('SELECT node_id, scale, v FROM vec WHERE dim = ? AND node_id > ? ORDER BY node_id LIMIT ?').all(dim, m.upTo, rows);
    for (const r of got) { if (!m.row.has(r.node_id)) append(r.node_id, r.scale, asI8(r.v)); m.upTo = r.node_id; }
    if (got.length < rows) m.complete = true;
  }
  function load() { while (!m || !m.complete) loadSome(5000); }
  function warm({ rows = 2000 } = {}) { loadSome(rows); return { done: m.complete, loaded: m.n }; }

  function put(nodeId, f32) {
    if (!f32 || f32.length !== dim) throw new CortexError('dim', `vector has ${f32?.length} dims, store uses ${dim}`);
    const { scale, v } = quantize(l2normalize(f32));
    db.stmt('INSERT INTO vec(node_id, dim, scale, v, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET dim = excluded.dim, scale = excluded.scale, v = excluded.v, model = excluded.model')
      .run(nodeId, dim, scale, asBytes(v), model);
    if (!m) return;
    const i = m.row.get(nodeId);
    if (i !== undefined) { m.scales[i] = scale; m.data.set(v, i * dim); } else if (m.complete || nodeId <= m.upTo) append(nodeId, scale, v);
    // else: past the loaded slice; the next slice reads it from the table
  }

  function dropRow(nodeId) {
    const i = m?.row.get(nodeId);
    if (i === undefined) return;
    const last = m.n - 1;
    if (i !== last) {   // swap-remove
      m.ids[i] = m.ids[last]; m.scales[i] = m.scales[last]; m.data.copyWithin(i * dim, last * dim, last * dim + dim); m.row.set(m.ids[i], i);
    }
    m.row.delete(nodeId); m.n--;
  }
  function remove(nodeId) { db.stmt('DELETE FROM vec WHERE node_id = ?').run(nodeId); dropRow(nodeId); }

  // → [{ id, score }] best first; score is the cosine estimate from int8
  function search(qF32, k = 20) {
    if (!qF32 || qF32.length !== dim) return [];
    if (!m || !m.complete) load();
    const { scale: qs, v: q } = quantize(l2normalize(qF32));
    if (!qs || !m.n) return [];
    const topS = [], topI = [];
    const data = m.data;
    for (let r = 0, off = 0; r < m.n; r++, off += dim) {
      let s = 0;
      for (let j = 0; j < dim; j++) s += data[off + j] * q[j];
      const score = s * m.scales[r] * qs;
      if (topS.length === k && score <= topS[k - 1]) continue;
      let p = topS.length;
      while (p > 0 && topS[p - 1] < score) p--;
      topS.splice(p, 0, score); topI.splice(p, 0, r);
      if (topS.length > k) { topS.pop(); topI.pop(); }
    }
    return topI.map((r, i) => ({ id: m.ids[r], score: topS[i] }));
  }

  // cosine of the query against specific nodes (those with a vector), without a scan: → Map<id, cosine>
  function similarity(qF32, ids) {
    const out = new Map();
    if (!qF32 || qF32.length !== dim) return out;
    if (!m || !m.complete) load();
    const { scale: qs, v: q } = quantize(l2normalize(qF32));
    if (!qs) return out;
    for (const id of ids) {
      const r = m.row.get(id);
      if (r === undefined) continue;
      let sum = 0;
      for (let j = 0, off = r * dim; j < dim; j++) sum += m.data[off + j] * q[j];
      out.set(id, sum * m.scales[r] * qs);
    }
    return out;
  }

  const has = nodeId => !!db.stmt('SELECT 1 x FROM vec WHERE node_id = ?').get(nodeId);
  const meta = key => db.stmt('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  const setMeta = (key, value) => db.stmt('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

  // record model + dim; true when they differ from what made the stored vectors (those become stale, still served)
  function markStaleIfModelChanged() {
    const prev = meta('embed_model'), prevDim = meta('embed_dim');
    setMeta('embed_model', model); setMeta('embed_dim', dim);
    return prev !== null && (prev !== model || Number(prevDim) !== dim);
  }
  const staleCount = () => db.stmt('SELECT count(*) n FROM vec WHERE model IS NOT ? OR dim != ?').get(model, dim).n;
  // live nodes of these kinds with no vector at all (written while no embedder was set), oldest first
  const missingIds = (kinds, limit = 100000) => db.stmt(`SELECT n.id FROM node n WHERE n.status != 'archived' AND n.kind IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM vec v WHERE v.node_id = n.id) ORDER BY n.id LIMIT ?`).all(JSON.stringify(kinds), limit).map(r => r.id);
  const staleIds = (limit = 16) => db.stmt('SELECT node_id FROM vec WHERE model IS NOT ? OR dim != ? LIMIT ?').all(model, dim, limit).map(r => r.node_id);

  function stats() {
    return { vectors: db.stmt('SELECT count(*) n FROM vec').get().n, matrixBytes: m ? m.data.byteLength + m.ids.byteLength + m.scales.byteLength : 0 };
  }
  function trim() { m = null; }

  return { dim, model, put, remove, search, similarity, has, warm, isWarm: () => !!m?.complete, markStaleIfModelChanged, staleCount, staleIds, missingIds, stats, trim, forget: dropRow };
}

module.exports = { l2normalize, truncate, quantize, dequantize, dotI8, createVectors };
