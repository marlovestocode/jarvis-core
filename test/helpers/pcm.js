// Fixture PCM: 16 kHz mono Int16 frames of 20 ms.
const SR = 16000;
const FRAME = 320;

function frames(ms, sampleFn) {
  const out = [];
  const n = Math.round(ms / 20);
  let k = 0;
  for (let f = 0; f < n; f++) {
    const a = new Int16Array(FRAME);
    for (let i = 0; i < FRAME; i++, k++) a[i] = Math.max(-32768, Math.min(32767, Math.round(sampleFn(k) * 32767)));
    out.push(a);
  }
  return out;
}

// deterministic "noise" around amplitude amp
function noise(ms, amp = 0.005) {
  let s = 12345;
  return frames(ms, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return ((s / 0x7fffffff) * 2 - 1) * amp * 1.7; });
}
// sine; rms = amp / sqrt(2)
function tone(ms, amp = 0.3, hz = 440) {
  return frames(ms, k => Math.sin(2 * Math.PI * hz * k / SR) * amp);
}

module.exports = { SR, FRAME, frames, noise, tone };
