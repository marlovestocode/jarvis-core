// Audio helpers for the voice corpus and bench: WAV io, resampling, seeded noise, SNR mixing.
// Samples are Float32 in [-1, 1] unless a name says Int16.
function rng(seed) { // mulberry32: deterministic, so corpora are reproducible
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

function readWav(buf) { // 16-bit PCM mono/first-channel; returns { rate, samples: Float32Array }
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV');
  let o = 12, rate = 16000, ch = 1, bits = 16, data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4); let size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(o + 10); rate = buf.readUInt32LE(o + 12); bits = buf.readUInt16LE(o + 22); }
    if (id === 'data') { if (o + 8 + size > buf.length) size = buf.length - o - 8; data = buf.subarray(o + 8, o + 8 + size); break; }
    o += 8 + size + (size & 1);
  }
  if (!data || bits !== 16) throw new Error('unsupported WAV (need 16-bit PCM)');
  const n = Math.floor(data.length / 2 / ch), s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2 * ch) / 32768;
  return { rate, samples: s };
}

function toInt16(f) { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768))); return o; }
function fromInt16(i16) { const o = new Float32Array(i16.length); for (let i = 0; i < i16.length; i++) o[i] = i16[i] / 32768; return o; }

function wavBuffer(i16, rate) {
  const b = Buffer.alloc(44 + i16.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + i16.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(i16.length * 2, 40);
  Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).copy(b, 44);
  return b;
}

// linear resample; fine for speech going 22.05 kHz -> 16 kHz (low-passed first by averaging when downsampling)
function resample(x, from, to) {
  if (from === to) return x;
  const ratio = from / to, n = Math.floor(x.length / ratio), out = new Float32Array(n);
  const w = Math.max(1, Math.round(ratio));
  for (let i = 0; i < n; i++) {
    const c = i * ratio; let s = 0, k = 0;
    for (let j = -(w >> 1); j <= (w >> 1); j++) { const p = c + j, p0 = Math.floor(p), f = p - p0; if (p0 < 0 || p0 + 1 >= x.length) continue; s += x[p0] * (1 - f) + x[p0 + 1] * f; k++; }
    out[i] = k ? s / k : 0;
  }
  return out;
}

function noiseOf(kind, n, rate, seed) {
  const r = rng(seed), o = new Float32Array(n);
  if (kind === 'white') { for (let i = 0; i < n; i++) o[i] = gauss(r); return o; }
  if (kind === 'pink') { // Paul Kellet's filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = gauss(r);
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      o[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
    }
    return o;
  }
  if (kind === 'fan') { // low-passed rumble + 120 Hz hum and its harmonics
    const a = Math.exp(-2 * Math.PI * 400 / rate); let y = 0;
    for (let i = 0; i < n; i++) {
      y = a * y + (1 - a) * gauss(r);
      const t = i / rate;
      o[i] = y * 4 + 0.5 * Math.sin(2 * Math.PI * 120 * t) + 0.25 * Math.sin(2 * Math.PI * 240 * t) + 0.1 * Math.sin(2 * Math.PI * 360 * t);
    }
    return o;
  }
  throw new Error('unknown noise ' + kind);
}

function rms(x, from = 0, to = x.length) { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return to > from ? Math.sqrt(s / (to - from)) : 0; }

// signal + noise scaled so rms(signal[from,to)) / rms(noise) = 10^(snrDb/20); returns a new array
function mixAtSnr(signal, noise, snrDb, from = 0, to = signal.length) {
  const g = rms(signal, from, to) / (Math.pow(10, snrDb / 20) * (rms(noise) || 1));
  const out = new Float32Array(signal.length);
  for (let i = 0; i < out.length; i++) out[i] = signal[i] + noise[i % noise.length] * g;
  return out;
}

module.exports = { rng, readWav, wavBuffer, toInt16, fromInt16, resample, noiseOf, rms, mixAtSnr };
