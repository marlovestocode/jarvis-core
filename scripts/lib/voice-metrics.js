// Metrics for scripts/voice-bench.js: WER, percentiles, and VAD scoring against a clip's known speech span.
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
// lowercase, spell small numbers, drop punctuation; "Jarvis's" stays one word
function words(t) {
  return String(t || '').toLowerCase().replace(/\b(\d{1,2})\b/g, (_, d) => NUM[+d] || d).replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
}
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// { errors, ref } so callers can pool (sum errors / sum ref) instead of averaging per-clip rates
function wer(ref, hyp) { const r = words(ref); return { errors: editDistance(r, words(hyp)), ref: r.length }; }

function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))];
}

const FRAME = 320; // 20 ms @ 16 kHz, what the mic worklet feeds the controller

// Feed a clip through a VAD frame by frame. Returns where it fired, in ms.
// A model VAD (vad.idle) is drained after every frame, as if frames arrived in real time.
//   start: first 'start' event time; end: time of first 'end'/'max'; endSpeechEstimate = end - silenceMs
async function runVad(vad, i16, silenceMs) {
  let start = null, end = null;
  for (let f = 0; f + FRAME <= i16.length; f += FRAME) {
    const r = vad.push(i16.subarray(f, f + FRAME), 16000);
    const t = (f + FRAME) * 1000 / 16000;
    if (r === 'start' && start === null) start = t;
    if ((r === 'end' || r === 'max') && end === null) { end = t; break; }
    if (vad.idle) await vad.idle();
  }
  return { start, end, endSpeechEstimate: end === null ? null : end - silenceMs };
}

// Score one clip with known voiced span [speechStartMs, speechEndMs] and mid-sentence pauses.
//   missed: never detected speech in the span; falseStart: fired before speech began;
//   earlyCut: closed while >300 ms of speech was still to come (the quiet started 'estimate' ms in);
//   pauseCut: closed inside a mid-sentence pause, before the second half began;
//   endLagMs: how long after the last word the capture closed.
function scoreClip(res, clip) {
  const missed = res.start === null || res.start > clip.speechEndMs;
  const falseStart = res.start !== null && res.start < clip.speechStartMs - 100;
  const earlyCut = res.end !== null && res.endSpeechEstimate < clip.speechEndMs - 300;
  const lastPause = (clip.pauses || []).at(-1);
  const pauseCut = !!lastPause && res.end !== null && res.endSpeechEstimate < lastPause.endMs;
  return { missed, falseStart, earlyCut, pauseCut, endLagMs: res.end === null ? null : Math.round(res.end - clip.speechEndMs) };
}

// Count 'start' events over a long noise-only clip, resetting after each end/max like the controller does.
async function countFalseStarts(vad, i16) {
  let n = 0;
  for (let f = 0; f + FRAME <= i16.length; f += FRAME) {
    const r = vad.push(i16.subarray(f, f + FRAME), 16000);
    if (r === 'start') n++;
    if (r === 'end' || r === 'max') vad.reset();
    if (vad.idle) await vad.idle();
  }
  return n;
}

module.exports = { words, wer, percentile, runVad, scoreClip, countFalseStarts, FRAME };
