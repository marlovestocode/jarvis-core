const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../scripts/lib/voice-audio');

test('voice-audio: WAV roundtrip keeps rate and samples', () => {
  const i16 = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  const { rate, samples } = A.readWav(A.wavBuffer(i16, 16000));
  assert.equal(rate, 16000);
  assert.deepEqual([...A.toInt16(samples)], [...i16]);
});

test('voice-audio: mixAtSnr hits the requested SNR', () => {
  const sig = Float32Array.from({ length: 16000 }, (_, i) => 0.3 * Math.sin(i / 10));
  for (const kind of ['white', 'pink', 'fan']) {
    const n = A.noiseOf(kind, 16000, 16000, 7);
    const mixed = A.mixAtSnr(sig, n, 10);
    const resid = mixed.map((v, i) => v - sig[i]);
    const snr = 20 * Math.log10(A.rms(sig) / A.rms(resid));
    assert.ok(Math.abs(snr - 10) < 0.1, `${kind} ${snr}`);
  }
});

test('voice-audio: noise is deterministic per seed; resample length scales', () => {
  assert.deepEqual([...A.noiseOf('pink', 100, 16000, 1)], [...A.noiseOf('pink', 100, 16000, 1)]);
  assert.notDeepEqual([...A.noiseOf('white', 100, 16000, 1)], [...A.noiseOf('white', 100, 16000, 2)]);
  assert.equal(A.resample(new Float32Array(22050), 22050, 16000).length, 16000);
});
