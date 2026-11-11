// Cleaner Piper output: every sentence is a separate WAV, so edges click, levels differ and some sentences start
// or end on long dead air. polishPcm(pcm, rate) → Int16Array: DC offset removed, silence trimmed to a short natural
// lead and tail, short fades at both ends, and the level brought to a steady peak (never boosting hiss: gain is capped).
// Soft consonants (the s in "Sir", the f in "fine", a final t or th) are 20 to 30 dB quieter than the vowels around them, so the
// floor sits low and the margins are wide: trimming is for dead air, never for the edges of a word.
const LEAD_MS = 90;          // quiet kept before the first sound
const TAIL_MS = 200;         // quiet kept after the last sound: a natural pause between sentences
const FADE_IN_MS = 8;
const FADE_OUT_MS = 50;      // always inside the padded tail, never over speech
const FLOOR = 40;            // below this (about -58 dBFS) counts as silence
const TARGET_PEAK = 0.88 * 32767;
const MAX_GAIN = 2.2;
const MIN_GAIN = 0.6;

function polishPcm(pcm, rate = 22050) {
  const n = pcm.length;
  if (n < 64) return pcm;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += pcm[i];
  const dc = Math.round(sum / n);
  let first = -1, last = -1, peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm[i] - dc);
    if (v > peak) peak = v;
    if (v >= FLOOR) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return pcm;   // all quiet: nothing to shape
  const ms = x => Math.round(rate * x / 1000);
  const from = Math.max(0, first - ms(LEAD_MS));
  const to = Math.min(n, last + 1 + ms(TAIL_MS));
  const gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET_PEAK / peak));
  const out = new Int16Array(to - from);
  const fin = Math.max(1, ms(FADE_IN_MS)), fout = Math.max(1, ms(FADE_OUT_MS));
  for (let i = 0; i < out.length; i++) {
    let v = (pcm[from + i] - dc) * gain;
    if (i < fin) v *= i / fin;
    const k = out.length - 1 - i;
    if (k < fout) v *= k / fout;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}

module.exports = { polishPcm };
