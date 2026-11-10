// Throwaway spike (Phase 2a): openWakeWord "hey_jarvis" in Node, checked against upstream v0.5.1
// openwakeword/utils.py AudioFeatures + model.py Model.predict, and the actual .onnx files:
//   melspectrogram.onnx  in  input   float32 [1, N] raw int16-valued samples (NOT /32768)
//                        out output  float32 [1, 1, N/160-3, 32]; then x/10 + 2 (upstream melspec_transform)
//   embedding_model.onnx in  input_1 float32 [n, 76, 32, 1] (76 mel frames)  out [n, 1, 1, 96]
//   hey_jarvis_v0.1.onnx in  x.1     float32 [1, 16, 96]   (last 16 embeddings)  out [1, 1] score
// Streaming per 80 ms chunk (1280 samples): mel over the last 1280+480 samples (8 new frames), embedding over
// the last 76 mel frames (stride 8 = one per chunk), wake model over the last 16 embeddings.
// Buffers start as upstream: mel = ones(76, 32); features = embeddings of 4 s of random int16 in [-1000, 1000);
// the first 5 predictions are forced to 0. Clips are padded with 1 s of silence each side (predict_clip).
//   node scripts/oww-spike.js [--noise-min 10] [--out eval/voice/oww-spike.json]
const fs = require('node:fs');
const path = require('node:path');
const ort = require('onnxruntime-node');
const A = require('./lib/voice-audio');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'engines', 'wake');
const OUT_DIR = path.join(ROOT, 'eval', 'voice', 'out');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CHUNK = 1280, MEL_CTX = 480, WIN = 76, NFEAT = 16, MEL_MAX = 970, FEAT_MAX = 120;

async function load() {
  const s = n => ort.InferenceSession.create(path.join(DIR, n));
  const [mel, emb, wake] = await Promise.all([s('melspectrogram.onnx'), s('embedding_model.onnx'), s('hey_jarvis_v0.1.onnx')]);
  const melOf = async i16 => {   // → array of Float32Array(32) rows, transformed
    const x = Float32Array.from(i16);
    const o = (await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', x, [1, x.length]) }))[mel.outputNames[0]];
    const frames = o.dims[2], rows = [];
    for (let f = 0; f < frames; f++) rows.push(o.data.slice(f * 32, f * 32 + 32).map(v => v / 10 + 2));
    return rows;
  };
  const embOf = async windows => {   // windows: array of 76-row arrays → array of Float32Array(96)
    const x = new Float32Array(windows.length * WIN * 32);
    windows.forEach((w, b) => w.forEach((r, i) => x.set(r, (b * WIN + i) * 32)));
    const o = (await emb.run({ [emb.inputNames[0]]: new ort.Tensor('float32', x, [windows.length, WIN, 32, 1]) }))[emb.outputNames[0]];
    return windows.map((_, b) => o.data.slice(b * 96, b * 96 + 96));
  };
  const wakeOf = async feats => {
    const x = new Float32Array(NFEAT * 96);
    feats.forEach((f, i) => x.set(f, i * 96));
    return (await wake.run({ [wake.inputNames[0]]: new ort.Tensor('float32', x, [1, NFEAT, 96]) }))[wake.outputNames[0]].data[0];
  };
  // initial feature buffer, as upstream: embeddings of 4 s of random int16 noise (seeded here)
  const r = A.rng(1234);
  const noise = Int16Array.from({ length: 16000 * 4 }, () => Math.floor(r() * 2000) - 1000);
  const spec = await melOf(noise), wins = [];
  for (let i = 0; i + WIN <= spec.length; i += 8) wins.push(spec.slice(i, i + WIN));
  const initFeats = await embOf(wins);
  return { melOf, embOf, wakeOf, initFeats };
}

function stream(m) {
  let raw = new Int16Array(0), pend = [], melBuf = Array.from({ length: WIN }, () => new Float32Array(32).fill(1));
  let feats = m.initFeats.slice(), preds = 0;
  return async function push(i16) {   // returns the scores of every completed 80 ms chunk
    for (const v of i16) pend.push(v);
    const out = [];
    while (pend.length >= CHUNK) {
      const chunk = pend.splice(0, CHUNK);
      const keep = new Int16Array(Math.min(raw.length + CHUNK, CHUNK + MEL_CTX));
      const all = new Int16Array(raw.length + CHUNK); all.set(raw); all.set(chunk, raw.length);
      keep.set(all.subarray(all.length - keep.length));
      raw = keep;
      melBuf = melBuf.concat(await m.melOf(raw)).slice(-MEL_MAX);
      feats = feats.concat(await m.embOf([melBuf.slice(-WIN)])).slice(-FEAT_MAX);
      let s = await m.wakeOf(feats.slice(-NFEAT));
      if (preds++ < 5) s = 0;
      out.push(s);
    }
    return out;
  };
}

const pad = i16 => { const o = new Int16Array(i16.length + 32000); o.set(i16, 16000); return o; };
const loadI16 = p => A.toInt16(A.readWav(fs.readFileSync(p)).samples);
// detection with the 2-consecutive-chunk rule and a cooldown (in chunks) between detections
function detections(scores, thr, cooldown = 25) {
  let n = 0, run = 0, cool = 0;
  for (const s of scores) {
    if (cool > 0) { cool--; run = 0; continue; }
    run = s >= thr ? run + 1 : 0;
    if (run >= 2) { n++; run = 0; cool = cooldown; }
  }
  return n;
}

(async () => {
  const m = await load();
  const man = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8'));
  const t0 = performance.now();
  const clips = [];
  for (const c of man.clips) {
    const scores = await stream(m)(pad(loadI16(path.join(OUT_DIR, c.file))));
    clips.push({ id: c.id, category: c.category, wake: c.wake, text: c.text, noise: c.noise, snr: c.snr, scores });
  }
  const perChunkMs = (performance.now() - t0) / clips.reduce((a, c) => a + c.scores.length, 0);
  // continuous noise: --noise-min minutes split across white/pink/fan, at each noise-only file's level, new seeds
  const minutes = +arg('--noise-min', 10), noise = [];
  for (const [k, n] of man.noiseOnly.entries()) {
    const ref = A.readWav(fs.readFileSync(path.join(OUT_DIR, n.file))).samples, level = A.rms(ref);
    const secs = Math.round(minutes * 60 / man.noiseOnly.length);
    const raw = A.noiseOf(n.noise, secs * 16000, 16000, 9000 + k), g = level / A.rms(raw);
    const s = stream(m), scores = [];
    for (let i = 0; i < raw.length; i += 16000) scores.push(...await s(A.toInt16(raw.subarray(i, i + 16000).map(v => v * g))));
    noise.push({ noise: n.noise, seconds: secs, scores });
  }
  const groupOf = c => (c.noise === 'none' ? 'clean' : `snr${c.snr}`);
  const sweep = [];
  for (let t = 0.05; t < 0.96; t += 0.05) {
    const thr = Math.round(t * 100) / 100;
    const w = clips.filter(c => c.wake), nw = clips.filter(c => !c.wake);
    const hit = c => detections(c.scores, thr) > 0;
    const by = {};
    for (const c of w) { const g = (by[groupOf(c)] ||= { n: 0, hit: 0 }); g.n++; g.hit += hit(c); }
    const row = {
      threshold: thr,
      wakeHitPct: Math.round(1000 * w.filter(hit).length / w.length) / 10,
      heyJarvisHitPct: Math.round(1000 * w.filter(c => /^hey jarvis/i.test(c.text)).filter(hit).length / w.filter(c => /^hey jarvis/i.test(c.text)).length) / 10,
      bareJarvisHitPct: Math.round(1000 * w.filter(c => !/^hey jarvis/i.test(c.text)).filter(hit).length / w.filter(c => !/^hey jarvis/i.test(c.text)).length) / 10,
      byGroup: Object.fromEntries(Object.entries(by).map(([g, v]) => [g, Math.round(1000 * v.hit / v.n) / 10])),
      nonWakeFalseAccepts: nw.filter(hit).length, nonWakeClips: nw.length,
      noiseFalseAccepts: noise.reduce((a, n) => a + detections(n.scores, thr), 0),
    };
    sweep.push(row);
  }
  const maxOf = c => Math.max(...c.scores);
  const out = {
    generatedAt: new Date().toISOString(),
    note: "Synthetic Piper speech, not the user's voice. Detection = score ≥ threshold for 2 consecutive 80 ms chunks.",
    models: 'openWakeWord v0.5.1: melspectrogram, embedding_model, hey_jarvis_v0.1',
    perChunkMs: Math.round(perChunkMs * 100) / 100,
    noiseMinutes: noise.reduce((a, n) => a + n.seconds, 0) / 60,
    sweep,
    nonWakeMax: clips.filter(c => !c.wake).map(c => ({ id: c.id, noise: c.noise, snr: c.snr, text: c.text, max: Math.round(maxOf(c) * 1000) / 1000 })).sort((a, b) => b.max - a.max).slice(0, 10),
    wakeMaxLowest: clips.filter(c => c.wake).map(c => ({ id: c.id, noise: c.noise, snr: c.snr, text: c.text, max: Math.round(maxOf(c) * 1000) / 1000 })).sort((a, b) => a.max - b.max).slice(0, 15),
    noiseMax: noise.map(n => ({ noise: n.noise, max: Math.round(Math.max(...n.scores) * 1000) / 1000 })),
  };
  const dest = path.resolve(ROOT, arg('--out', 'eval/voice/oww-spike.json'));
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log('wrote', path.relative(ROOT, dest), 'perChunkMs', out.perChunkMs);
})().catch(e => { console.error(e); process.exit(1); });
