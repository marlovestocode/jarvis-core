// Speaker verification: is this the enrolled user's voice? A WeSpeaker ResNet34 ONNX model turns
// speech into a 256-number voice print; two prints of the same voice have a high cosine similarity.
// The user's prints live in one local JSON file. Nothing leaves the PC.
//   embed(pcm, rate) → Float32Array(256), unit length | null (audio too short)
//   enroll(clips[]) → { ok, count } | { ok:false, reason }
//   verify(pcm, rate, { lenient }) → { ok, score, reason? }   (not enrolled / model missing → ok:true: no gate)
const fs = require('node:fs');
const path = require('node:path');
const { fbank, RATE } = require('./fbank');

const MIN_MS = 500;            // shorter audio gives an unreliable print
const MIN_ENROLL_MS = 1500;    // per enrollment clip
const MAX_PRINTS = 12;
const norm = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, x => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// linear resample to 16 kHz (mic is 16 kHz already; this only guards other rates)
function to16k(pcm, rate) {
  if (rate === RATE) return pcm;
  const n = Math.floor((pcm.length * RATE) / rate), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = (i * rate) / RATE, j = Math.floor(p), f = p - j; out[i] = (pcm[j] || 0) * (1 - f) + (pcm[j + 1] ?? pcm[j] ?? 0) * f; }
  return out;
}

function createSpeaker({ ort, modelPath, profileFile, getConfig = () => ({}), exists = fs.existsSync, log = () => {} }) {
  let session = null, loading = null, failed = false;
  let prints = [];      // enrolled unit-length embeddings
  let centroid = null;
  const refresh = () => { centroid = prints.length ? norm(prints.reduce((a, p) => a.map((x, i) => x + p[i]), new Float32Array(prints[0].length))) : null; };
  try {
    const j = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    if (Array.isArray(j.prints)) prints = j.prints.filter(p => Array.isArray(p) && p.length === 256).map(p => norm(Float32Array.from(p))).slice(-MAX_PRINTS);
    refresh();
  } catch { /* not enrolled yet */ }

  const available = () => !failed && exists(modelPath);
  const enrolled = () => prints.length > 0;

  function load() {
    if (session) return Promise.resolve(session);
    if (!available()) return Promise.reject(new Error('Speaker model is not installed'));
    loading ||= ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] }).then(s => { session = s; return s; }, err => { failed = true; loading = null; log('speaker model failed: ' + err.message); throw err; });
    return loading;
  }

  async function embed(pcm, rate = RATE) {
    const x = to16k(pcm, rate);
    if ((x.length / RATE) * 1000 < MIN_MS) return null;
    const f = fbank(x);
    if (!f) return null;
    const s = await load();
    const out = await s.run({ feats: new ort.Tensor('float32', f.data, [1, f.frames, 80]) });
    return norm(out.embs.data);
  }

  function save() {
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    const tmp = profileFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ prints: prints.map(p => Array.from(p, x => Math.round(x * 1e6) / 1e6)), at: new Date().toISOString() }));
    fs.renameSync(tmp, profileFile);
  }

  async function enroll(clips) {
    const made = [];
    for (const c of clips) {
      if ((c.pcm.length / c.rate) * 1000 < MIN_ENROLL_MS) continue;
      const e = await embed(c.pcm, c.rate);
      if (e) made.push(e);
    }
    if (made.length < 2) return { ok: false, reason: 'Not enough speech heard. Speak for about ten seconds.' };
    // the clips must agree with each other, or someone else was talking / noise
    const c0 = norm(made.reduce((a, p) => a.map((x, i) => x + p[i]), new Float32Array(256)));
    const low = made.filter(p => dot(p, c0) < 0.5).length;
    if (low > made.length / 2) return { ok: false, reason: 'The clips did not sound like one voice. Try again in a quiet room.' };
    prints = made.slice(-MAX_PRINTS); refresh(); save();
    return { ok: true, count: prints.length };
  }

  function clear() { prints = []; centroid = null; try { fs.rmSync(profileFile, { force: true }); } catch { /* gone */ } }

  // lenient: slightly lower bar, for audio with JARVIS's own voice mixed in (interrupts while it speaks)
  async function verify(pcm, rate = RATE, { lenient = false } = {}) {
    if (!enrolled() || !available()) return { ok: true, score: null, reason: 'no gate' };
    const base = Number(getConfig().speakerThreshold);
    const threshold = (Number.isFinite(base) ? base : 0.45) - (lenient ? 0.1 : 0);
    let e;
    try { e = await embed(pcm, rate); } catch (err) { return { ok: true, score: null, reason: 'error: ' + err.message }; }   // a broken model never locks the user out
    if (!e) return { ok: true, score: null, reason: 'too short' };
    const score = dot(e, centroid);   // the centroid is unit length, as is e: cosine similarity
    return { ok: score >= threshold, score: Math.round(score * 1000) / 1000, threshold };
  }

  return { available, enrolled, embed, enroll, verify, clear, count: () => prints.length, warm: () => load().then(() => true, () => false) };
}

module.exports = { createSpeaker, MIN_ENROLL_MS };
