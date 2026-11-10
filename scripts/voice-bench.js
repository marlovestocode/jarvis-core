// Voice bench: runs the corpus from scripts/make-voice-corpus.js through the current VAD and Whisper stack.
//   node scripts/voice-bench.js [--out eval/voice/baseline.json] [--vad energy|silero] [--stt <file in engines/whisper>]
//                               [--skip-stt] [--only-vad] [--limit N] [--prompt v0|v1|none] [--whisper-args "..."]
//                               [--threads N (default 4: gentle on the CPU; the app uses up to 10)] [--lat-n N]
// Reports per group (clean / per SNR / per noise+SNR): VAD recall, early-cut, false-start, end lag;
// wake hit and false-accept (Whisper transcript + the controller's WAKE_PREFIX); WER and STT latency.
// The audio is synthetic Piper speech, NOT the user's voice: treat numbers as a relative yardstick.
// Optional real clips: eval/voice/recorded/NAME.wav + NAME.txt (transcript; scored for wake + WER only).
const fs = require('node:fs');
const path = require('node:path');
const A = require('./lib/voice-audio');
const M = require('./lib/voice-metrics');
const { createVad } = require('../src/core/voice/vad');
const { createModelVad } = require('../src/core/voice/vad-model');
const { loadSilero } = require('../src/core/voice/silero');
const { createWhisperStt, cleanTranscript } = require('../src/core/voice/whisper');
const { WAKE_PREFIX } = require('../src/core/voice/controller');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);
const ENGINES = process.env.JARVIS_ENGINES || path.join(ROOT, 'engines');
const OUT_DIR = path.join(ROOT, 'eval', 'voice', 'out');
const SILENCE_MS = +arg('--silence', 700); // end-of-speech silence: config.endSilenceMs in the app
// same vocabulary prompt module as main.js: --prompt v0 | v1 | none
const PROMPT_NAME = arg('--prompt', 'v0');
const PROMPT = require('../src/core/voice/stt-prompt').sttPrompt(PROMPT_NAME);

const pct = (n, d) => (d ? Math.round(1000 * n / d) / 10 : null);
const round = x => (x === null || x === undefined ? null : Math.round(x));
function groupsOf(c) { const g = ['all', c.noise === 'none' ? 'clean' : `snr${c.snr}`]; if (c.noise !== 'none') g.push(`${c.noise}${c.snr}`); return g; }

async function makeVad(name) {
  if (name === 'energy') return () => createVad({ silenceMs: SILENCE_MS });
  if (name === 'silero') {
    const model = await loadSilero({ modelPath: path.join(ENGINES, 'vad', 'silero_vad.onnx'), ort: require('onnxruntime-node') });
    return () => createModelVad({ silenceMs: SILENCE_MS, getModel: () => model, onError: e => { throw e; } });
  }
  throw new Error(`unknown --vad ${name} (energy | silero)`);
}

function loadClips(limit) {
  const man = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8'));
  let clips = man.clips.map(c => ({ ...c, path: path.join(OUT_DIR, c.file) }));
  const rec = path.join(ROOT, 'eval', 'voice', 'recorded');
  if (fs.existsSync(rec)) for (const f of fs.readdirSync(rec).filter(f => f.endsWith('.wav'))) {
    const txt = path.join(rec, f.replace(/\.wav$/, '.txt'));
    if (!fs.existsSync(txt)) continue;
    const text = fs.readFileSync(txt, 'utf8').trim();
    clips.push({ id: 'rec-' + f, category: 'recorded', text, wake: WAKE_PREFIX.test(text), noise: 'none', snr: null, path: path.join(rec, f), recorded: true });
  }
  if (limit) clips = clips.filter((_, i) => i % Math.ceil(clips.length / limit) === 0);
  return { clips, noiseOnly: man.noiseOnly };
}
const loadI16 = p => { const w = A.readWav(fs.readFileSync(p)); if (w.rate !== 16000) throw new Error(p + ' is not 16 kHz'); return A.toInt16(w.samples); };

async function benchVad(clips, noiseOnly, mk) {
  const acc = {};
  for (const c of clips) {
    if (c.recorded) continue;
    const s = M.scoreClip(await M.runVad(mk(), loadI16(c.path), SILENCE_MS), c);
    for (const g of groupsOf(c)) {
      const a = (acc[g] ||= { n: 0, missed: 0, falseStart: 0, earlyCut: 0, lag: [], pauseN: 0, pauseCut: 0 });
      a.n++; a.missed += s.missed; a.falseStart += s.falseStart; a.earlyCut += s.earlyCut;
      if (s.endLagMs !== null) a.lag.push(s.endLagMs);
      if (c.category === 'pause') { a.pauseN++; a.pauseCut += s.pauseCut; }
    }
  }
  const groups = {};
  for (const [g, a] of Object.entries(acc)) groups[g] = { clips: a.n, recallPct: pct(a.n - a.missed, a.n), falseStartPct: pct(a.falseStart, a.n), earlyCutPct: pct(a.earlyCut, a.n), pauseClips: a.pauseN, pausePrematureCuts: a.pauseCut, endLagP50Ms: round(M.percentile(a.lag, 50)) };
  const noise = {};
  for (const n of noiseOnly) noise[n.noise] = { seconds: n.seconds, falseStarts: await M.countFalseStarts(mk(), loadI16(path.join(OUT_DIR, n.file))) };
  return { silenceMs: SILENCE_MS, groups, noiseOnly: noise };
}

// Latency on exact 3 / 8 / 15 s clips (20 each), cut from the clean corpus speech laid end to end.
// 15 s exceeds the 14 s window, so it is split in two calls, as in the app.
const LAT_N = +arg('--lat-n', 20);
async function fixedLatency(stt, clips) {
  const clean = clips.filter(c => c.noise === 'none' && !c.recorded).map(c => loadI16(c.path));
  const all = new Int16Array(clean.reduce((a, x) => a + x.length, 0));
  clean.reduce((o, x) => (all.set(x, o), o + x.length), 0);
  const out = {}, r = A.rng(77);
  for (const secs of [3, 8, 15]) {
    const ms = [], n = secs * 16000;
    for (let i = 0; i < LAT_N; i++) {
      const at = Math.floor(r() * (all.length - n));
      const t0 = performance.now();
      await stt.transcribe(all.slice(at, at + n), 16000);
      ms.push(performance.now() - t0);
    }
    out[secs + 's'] = { n: LAT_N, p50: round(M.percentile(ms, 50)), p95: round(M.percentile(ms, 95)) };
  }
  return out;
}

async function benchStt(clips, noiseOnly, model) {
  const modelPath = path.isAbsolute(model) ? model : path.join(ENGINES, 'whisper', model);
  // port 47890: the app's own whisper-server uses 47810, so the bench can run beside it
  const extra = String(arg('--whisper-args', '')).split(/\s+/).filter(Boolean);   // e.g. --whisper-args "-sns -nth 0.7"
  const stt = createWhisperStt({ exe: path.join(ENGINES, 'whisper', 'bin', 'Release', 'whisper-server.exe'), model: modelPath, port: 47890, prompt: PROMPT, threads: +arg('--threads', 4), extraArgs: ['-ac', '768', ...extra], log: process.env.BENCH_DEBUG ? console.error : undefined });
  if (!stt.available()) throw new Error('Whisper not installed or model missing: ' + modelPath);
  await stt.warm();
  await stt.transcribe(loadI16(clips[0].path), 16000); // first call pays graph setup; not timed
  const acc = {}, lat = [], latBy = { under5s: [], s5to10: [], over10s: [] };
  const misses = [];
  try {
    for (const c of clips) {
      const pcm = loadI16(c.path), secs = pcm.length / 16000;
      const t0 = performance.now();
      const hyp = await stt.transcribe(pcm, 16000);
      const ms = performance.now() - t0;
      lat.push(ms); latBy[secs < 5 ? 'under5s' : secs <= 10 ? 's5to10' : 'over10s'].push(ms);
      const w = M.wer(c.text, hyp), woke = WAKE_PREFIX.test(hyp);
      if (c.wake !== woke && misses.length < 60) misses.push({ id: c.id, noise: c.noise, snr: c.snr, wanted: c.wake, heard: hyp });
      for (const g of groupsOf(c)) {
        const a = (acc[g] ||= { n: 0, err: 0, ref: 0, wakeN: 0, wakeHit: 0, nonN: 0, nonFalse: 0 });
        a.n++; a.err += w.errors; a.ref += w.ref;
        if (c.wake) { a.wakeN++; a.wakeHit += woke; } else { a.nonN++; a.nonFalse += woke; }
      }
    }
    // noise-only: Whisper must not invent text (cleanTranscript blanks known hallucinations)
    const nonBlank = {};
    for (const n of noiseOnly) { const t = await stt.transcribe(loadI16(path.join(OUT_DIR, n.file)).subarray(0, 8 * 16000), 16000); nonBlank[n.noise] = cleanTranscript(t); }
    const wakeGroups = {}, werGroups = {};
    for (const [g, a] of Object.entries(acc)) {
      wakeGroups[g] = { wakeClips: a.wakeN, hitPct: pct(a.wakeHit, a.wakeN), nonWakeClips: a.nonN, falseAcceptPct: pct(a.nonFalse, a.nonN) };
      werGroups[g] = { clips: a.n, werPct: pct(a.err, a.ref) };
    }
    return {
      model: path.basename(modelPath), promptName: PROMPT_NAME, prompt: PROMPT,
      wake: { regex: String(WAKE_PREFIX), groups: wakeGroups, misses },
      wer: werGroups,
      latencyMs: { p50: round(M.percentile(lat, 50)), p95: round(M.percentile(lat, 95)), byClipLength: Object.fromEntries(Object.entries(latBy).map(([k, v]) => [k, { n: v.length, p50: round(M.percentile(v, 50)), p95: round(M.percentile(v, 95)) }])) },
      whisperArgs: extra, threads: +arg('--threads', 4),
      fixedLatencyMs: await fixedLatency(stt, clips),
      noiseOnlyTranscripts: nonBlank,
    };
  } finally { stt.close(); }
}

(async () => {
  const { clips, noiseOnly } = loadClips(+arg('--limit', 0));
  const out = { generatedAt: new Date().toISOString(), note: "Synthetic Piper speech, not the user's voice. Relative yardstick only.", clips: clips.length, recordedClips: clips.filter(c => c.recorded).length };
  const vadName = arg('--vad', 'energy');
  out.stack = { vad: vadName };
  out.vad = await benchVad(clips, noiseOnly, await makeVad(vadName));
  console.log('VAD done', JSON.stringify(out.vad.groups.all));
  if (!flag('--skip-stt') && !flag('--only-vad')) {
    out.stt = await benchStt(clips, noiseOnly, arg('--stt', 'ggml-base.en.bin'));
    console.log('STT done', JSON.stringify(out.stt.latencyMs));
  }
  const dest = path.resolve(ROOT, arg('--out', 'eval/voice/baseline.json'));
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log('wrote', path.relative(ROOT, dest));
})().catch(e => { console.error(e); process.exit(1); });
