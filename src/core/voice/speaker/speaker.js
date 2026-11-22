// Speaker verification: is this the enrolled user's voice? A WeSpeaker ResNet34 ONNX model turns
// speech into a 256-number voice print; two prints of the same voice have a high cosine similarity.
// The user's prints live in one local JSON file. Nothing leaves the PC; audio is never stored.
//   embed(pcm, rate) → Float32Array(256), unit length | null (audio too short)
//   enroll(clips[], { append }) → { ok, count } | { ok:false, reason }   (append keeps the old prints)
//   verify(pcm, rate, { lenient, strict, learn }) → { ok, score, verdict, reason?, threshold }
//     score = mean of the top 3 cosines against individual prints; verdict owner | unsure | guest | null (audio too short).
//     not enrolled / model missing / error → owner, ok:true (no gate); strict: only a non-lenient owner passes.
//     a confident owner utterance is learned as a print (bounded, never replacing an enrolled print).
const fs = require('node:fs');
const path = require('node:path');
const { fbank, RATE } = require('./fbank');

const MIN_MS = 500;            // shorter audio gives an unreliable print
const MIN_ENROLL_MS = 1500;    // per enrollment clip
const MIN_LEARN_MS = 1500;     // shorter audio is not learned from
const MAX_PRINTS = 30;
const MAX_LEARNED = 20;
const TOP_K = 3;
const RECENT = 20;
const norm = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, x => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const r3 = x => Math.round(x * 1000) / 1000;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// linear resample to 16 kHz (mic is 16 kHz already; this only guards other rates)
function to16k(pcm, rate) {
  if (rate === RATE) return pcm;
  const n = Math.floor((pcm.length * RATE) / rate), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = (i * rate) / RATE, j = Math.floor(p), f = p - j; out[i] = (pcm[j] || 0) * (1 - f) + (pcm[j + 1] ?? pcm[j] ?? 0) * f; }
  return out;
}

function createSpeaker({ ort, modelPath, profileFile, getConfig = () => ({}), exists = fs.existsSync, log = () => {} }) {
  let session = null, loading = null, failed = false;
  let prints = [];      // unit-length embeddings, oldest first
  let learned = [];     // parallel to prints: true = learned from use, false = enrolled
  let ids = [];         // parallel to prints: which person (voice) each print belongs to
  let names = {};       // person id -> display name
  let recentScores = [];
  // over the cap: drop the oldest learned print first, then the oldest enrolled one
  const cap = () => {
    while (prints.length > MAX_PRINTS) {
      let i = learned.indexOf(true);
      if (i < 0) i = 0;
      prints.splice(i, 1); learned.splice(i, 1); ids.splice(i, 1);
    }
  };
  try {
    const j = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    if (Array.isArray(j.prints)) {
      j.prints.forEach((p, i) => {
        if (!Array.isArray(p) || p.length !== 256) return;
        prints.push(norm(Float32Array.from(p)));
        learned.push(Array.isArray(j.learned) && j.learned[i] === true);
        ids.push(Array.isArray(j.ids) && typeof j.ids[i] === 'string' ? j.ids[i] : 'v0');
      });
      names = j.names && typeof j.names === 'object' ? { ...j.names } : {};
      cap();
    }
  } catch { prints = []; learned = []; ids = []; names = {}; /* not enrolled yet */ }

  const available = () => !failed && exists(modelPath);
  const enrolled = () => prints.length > 0;
  const counts = () => { const l = learned.filter(Boolean).length; return { enrolled: prints.length - l, learned: l }; };

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
    fs.writeFileSync(tmp, JSON.stringify({ prints: prints.map(p => Array.from(p, x => Math.round(x * 1e6) / 1e6)), learned: learned.slice(), ids: ids.slice(), names, at: new Date().toISOString() }));
    fs.renameSync(tmp, profileFile);
  }

  async function enroll(clips, { append = false, name = '' } = {}) {
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
    if (!append) { try { if (prints.length) fs.copyFileSync(profileFile, profileFile + '.bak'); } catch { /* nothing to back up */ } prints = []; learned = []; ids = []; names = {}; }   // replacing keeps the old voices in voiceprint.json.bak
    const id = 'v' + Date.now().toString(36);
    names[id] = String(name || '').trim().slice(0, 40) || (append ? 'Another person' : 'Main voice');
    prints.push(...made); learned.push(...made.map(() => false)); ids.push(...made.map(() => id));
    cap(); save();
    return { ok: true, count: prints.length };
  }

  function clear() { prints = []; learned = []; ids = []; names = {}; recentScores = []; try { fs.rmSync(profileFile, { force: true }); } catch { /* gone */ } }

  // add the utterance as a learned print; at a cap it only ever replaces the closest learned print
  function learn(e) {
    if (prints.length < MAX_PRINTS && counts().learned < MAX_LEARNED) {
      let bi = 0, bd = -Infinity; prints.forEach((p, i) => { const d = dot(e, p); if (d > bd) { bd = d; bi = i; } });   // a learned print joins the person it matched best
      prints.push(e); learned.push(true); ids.push(ids[bi] || 'v0');
    }
    else {
      let best = -1, bs = -Infinity;
      learned.forEach((isL, i) => { if (!isL) return; const d = dot(e, prints[i]); if (d > bs) { bs = d; best = i; } });
      if (best < 0) return;
      prints[best] = e;
    }
    try { save(); } catch (err) { log('speaker save failed: ' + err.message); }
  }

  // lenient: slightly lower bars, for audio with JARVIS's own voice mixed in (interrupts while it speaks)
  async function verify(pcm, rate = RATE, { lenient = false, strict = false, learn: learnOpt = true } = {}) {
    if (!enrolled() || !available()) return { ok: true, score: null, verdict: 'owner', reason: 'no gate' };
    const cfg = getConfig() || {};
    const shift = lenient ? 0.1 : 0;
    const threshold = r3(num(cfg.speakerThreshold, 0.45) - shift);
    const guestBelow = Math.min(r3(num(cfg.speakerGuestBelow, 0.30) - shift), threshold);
    let e;
    try { e = await embed(pcm, rate); } catch (err) { return { ok: !strict, score: null, verdict: strict ? 'unsure' : 'owner', reason: 'error: ' + err.message }; }   // a broken model never locks the user out, but strict (a spoken yes) fails closed
    if (!e) return { ok: !strict, score: null, verdict: null, reason: 'too short' };
    const sims = prints.map(p => dot(e, p)).sort((a, b) => b - a).slice(0, TOP_K);
    const score = r3(sims.reduce((a, b) => a + b, 0) / sims.length);
    const verdict = score >= threshold ? (lenient ? 'unsure' : 'owner') : score >= guestBelow ? 'unsure' : 'guest';
    recentScores.push({ t: Date.now(), score, verdict });
    if (recentScores.length > RECENT) recentScores.shift();
    if (verdict === 'owner' && learnOpt && cfg.speakerLearn !== false && score >= num(cfg.speakerLearnAbove, 0.60) && (to16k(pcm, rate).length / RATE) * 1000 >= MIN_LEARN_MS) learn(e);
    const ok = strict ? verdict === 'owner' : score >= threshold;
    return { ok, score, verdict, threshold };
  }

  // each registered person: { id, name, enrolled, learned } (prints from the guided sentences, prints learned from use)
  function voices() {
    const out = [];
    prints.forEach((_, i) => {
      let v = out.find(x => x.id === ids[i]);
      if (!v) { v = { id: ids[i], name: names[ids[i]] || (ids[i] === 'v0' ? 'Main voice' : 'Voice'), enrolled: 0, learned: 0 }; out.push(v); }
      if (learned[i]) v.learned++; else v.enrolled++;
    });
    return out;
  }
  // forget one person; the last one removed clears the profile
  function remove(id) {
    const keep = prints.map((_, i) => i).filter(i => ids[i] !== id);
    if (keep.length === prints.length) return false;
    if (!keep.length) { clear(); return true; }
    prints = keep.map(i => prints[i]); learned = keep.map(i => learned[i]); ids = keep.map(i => ids[i]); delete names[id];
    save(); return true;
  }

  return { available, enrolled, embed, enroll, verify, clear, voices, remove, count: () => prints.length, counts, recent: () => recentScores.slice(), warm: () => load().then(() => true, () => false) };
}

module.exports = { createSpeaker, MIN_ENROLL_MS };
