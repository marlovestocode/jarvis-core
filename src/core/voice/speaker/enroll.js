// Voice enrolment: listen to the mic for a fixed time, keep only the frames that are speech, cut them
// into clips and let the speaker module turn them into voice prints. Returns { ok, count } | { ok:false, reason }.
const SPEECH_MIN_RMS = 250;          // int16 scale: quieter frames are room noise
const CLIP_SEC = 3;

function join(list, n) { const out = new Int16Array(n); let o = 0; for (const c of list) { out.set(c, o); o += c.length; } return out; }

function speechClips(frames, { clipSec = CLIP_SEC, minRms = SPEECH_MIN_RMS } = {}) {
  const loud = frames.filter(f => {
    let e = 0; for (const v of f.pcm) e += v * v;
    return f.pcm.length && Math.sqrt(e / f.pcm.length) >= minRms;
  });
  if (!loud.length) return [];
  const rate = loud[0].rate, clips = [];
  let cur = [], n = 0;
  for (const f of loud) {
    cur.push(f.pcm); n += f.pcm.length;
    if (n >= clipSec * rate) { clips.push(join(cur, n)); cur = []; n = 0; }
  }
  if (n >= 1.5 * rate) clips.push(join(cur, n));
  return clips.map(pcm => ({ pcm, rate }));
}

async function enrollVoice(ctx, { seconds = 12, append = false, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!ctx.speaker.available()) return { ok: false, reason: 'The speaker model is not installed.' };
  if (ctx.enrollBuf) return { ok: false, reason: 'Already listening.' };
  ctx.voice?.cancel();
  ctx.enrollBuf = [];
  ctx.mic?.start();
  try {
    await wait(seconds * 1000);
    const frames = ctx.enrollBuf;
    ctx.enrollBuf = null;
    return await ctx.speaker.enroll(speechClips(frames), { append });
  } finally {
    ctx.enrollBuf = null;
    ctx.updateMic?.();
  }
}

// Guided enrolment: everyone who registers reads the same set of sentences, one at a time. The sentences cover the vowels and consonants of English,
// numbers, and the wake word, and every sentence gives its own clip, so the print is built from varied speech and not 12 s of whatever was said.
const PHRASES = [
  "Jarvis, what's the weather like today?",
  'Hey Jarvis, play some music and turn the volume down.',
  'Set a timer for twenty five minutes, then remind me to call my mother.',
  'The quick brown fox jumps over the lazy dog near the river.',
  "Please open my calendar and tell me what's on tomorrow.",
  'Seventeen, forty two, ninety three, one thousand and six.',
  'Jarvis, search the web for the best pizza in Chicago.',
  "She sells sea shells by the sea shore, and I think that's wonderful.",
];
const MIN_PHRASE_SPEECH_SEC = 1.5;

// listen for one sentence; keep it as one clip in ctx.enrollClips. { ok, count, total } | { ok:false, reason } (say it again)
async function recordPhrase(ctx, { seconds = 6, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!ctx.speaker.available()) return { ok: false, reason: 'The speaker model is not installed.' };
  if (ctx.enrollBuf) return { ok: false, reason: 'Already listening.' };
  ctx.voice?.cancel();
  ctx.enrollBuf = [];
  ctx.mic?.start();
  try {
    await wait(seconds * 1000);
    const frames = ctx.enrollBuf;
    ctx.enrollBuf = null;
    const clips = speechClips(frames, { clipSec: 999 });
    if (!clips.length) return { ok: false, reason: `I did not hear enough. Say the whole sentence, a little louder (at least ${MIN_PHRASE_SPEECH_SEC} seconds of speech).` };
    (ctx.enrollClips = ctx.enrollClips || []).push(clips[0]);
    return { ok: true, count: ctx.enrollClips.length, total: PHRASES.length };
  } finally {
    ctx.enrollBuf = null;
    ctx.updateMic?.();
  }
}
// turn the recorded sentences into voice prints (append: keep the voices already enrolled)
async function finishEnroll(ctx, { append = false, name = '' } = {}) {
  const clips = ctx.enrollClips || [];
  ctx.enrollClips = null;
  if (clips.length < 4) return { ok: false, reason: 'I need at least four of the sentences. Start again and read them all.' };
  return ctx.speaker.enroll(clips, { append, name });
}
const cancelEnroll = ctx => { ctx.enrollClips = null; };

module.exports = { enrollVoice, speechClips, PHRASES, recordPhrase, finishEnroll, cancelEnroll };
