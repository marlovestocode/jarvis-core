// Kaldi-style log-mel filterbank features for the WeSpeaker speaker model:
// 16 kHz, 25 ms frames every 10 ms, pre-emphasis 0.97, DC removal, Povey window, 512-point FFT,
// 80 mel bins from 20 Hz to Nyquist, log power, then per-utterance mean subtraction.
// Input samples are int16-scale (the model's normalize_samples = 0).
const RATE = 16000, FRAME = 400, SHIFT = 160, NFFT = 512, BINS = 80, LOW = 20, HIGH = RATE / 2, EPS = 1.1920929e-7;

const mel = f => 1127 * Math.log(1 + f / 700);

const WINDOW = Float64Array.from({ length: FRAME }, (_, i) => Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)), 0.85));

// triangular filters in the mel domain over FFT bins 0..NFFT/2-1 (as Kaldi)
const FILTERS = (() => {
  const nb = NFFT / 2, melLow = mel(LOW), melHigh = mel(HIGH), delta = (melHigh - melLow) / (BINS + 1);
  const out = [];
  for (let b = 0; b < BINS; b++) {
    const left = melLow + b * delta, center = left + delta, right = center + delta;
    const w = new Float64Array(nb);
    for (let i = 0; i < nb; i++) {
      const m = mel((i * RATE) / NFFT);
      if (m > left && m < right) w[i] = m <= center ? (m - left) / (center - left) : (right - m) / (right - center);
    }
    out.push(w);
  }
  return out;
})();

const COS = new Float64Array(NFFT / 2), SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / NFFT); SIN[i] = Math.sin((2 * Math.PI * i) / NFFT); }

// in-place radix-2 FFT
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const step = NFFT / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = COS[k * step], wi = -SIN[k * step];
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

// fbank(pcm: Int16Array|Float32Array at 16 kHz, int16 scale) → { frames, data: Float32Array(frames*80) } or null if under one frame
function fbank(pcm) {
  const frames = pcm.length < FRAME ? 0 : 1 + Math.floor((pcm.length - FRAME) / SHIFT);
  if (!frames) return null;
  const data = new Float32Array(frames * BINS);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), x = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const o = f * SHIFT;
    let mean = 0;
    for (let i = 0; i < FRAME; i++) { x[i] = pcm[o + i]; mean += x[i]; }
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) x[i] -= mean;
    for (let i = FRAME - 1; i > 0; i--) x[i] -= 0.97 * x[i - 1];
    x[0] -= 0.97 * x[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = x[i] * WINDOW[i];
    fft(re, im);
    const p = new Float64Array(NFFT / 2);
    for (let i = 0; i < NFFT / 2; i++) p[i] = re[i] * re[i] + im[i] * im[i];
    for (let b = 0; b < BINS; b++) {
      let e = 0; const w = FILTERS[b];
      for (let i = 0; i < NFFT / 2; i++) if (w[i]) e += w[i] * p[i];
      data[f * BINS + b] = Math.log(Math.max(e, EPS));
    }
  }
  for (let b = 0; b < BINS; b++) {   // cepstral mean normalisation over the utterance
    let m = 0;
    for (let f = 0; f < frames; f++) m += data[f * BINS + b];
    m /= frames;
    for (let f = 0; f < frames; f++) data[f * BINS + b] -= m;
  }
  return { frames, data };
}

module.exports = { fbank, RATE, BINS };
