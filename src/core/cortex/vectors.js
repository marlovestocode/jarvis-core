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

module.exports = { l2normalize, truncate, quantize, dequantize, dotI8 };
