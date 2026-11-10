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

async function enrollVoice(ctx, { seconds = 12, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!ctx.speaker.available()) return { ok: false, reason: 'The speaker model is not installed.' };
  if (ctx.enrollBuf) return { ok: false, reason: 'Already listening.' };
  ctx.voice?.cancel();
  ctx.enrollBuf = [];
  ctx.mic?.start();
  try {
    await wait(seconds * 1000);
    const frames = ctx.enrollBuf;
    ctx.enrollBuf = null;
    return await ctx.speaker.enroll(speechClips(frames));
  } finally {
    ctx.enrollBuf = null;
    ctx.updateMic?.();
  }
}

module.exports = { enrollVoice, speechClips };
