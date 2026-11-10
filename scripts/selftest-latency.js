// Gate 4 selftest (plan 4.3, "or the selftest path"): corpus clips are played into the real voice
// controller in real time (20 ms frames on a clock), with the real VAD and Whisper; a fake reply speaks
// at once. Measures actual end of speech (known from the corpus) → first audio, and checks the transcript
// was not clipped. The LLM is left out: Phase 4 does not change it.
//   node scripts/selftest-latency.js [--n 20] [--threads 4]
// Compares the Phase 0 stack (energy VAD, 700 ms, no guard) with Phase 4 (Silero, 550 ms, guard on).
// Audio is synthetic Piper speech, not the user's voice.
const fs = require('node:fs');
const path = require('node:path');
const A = require('./lib/voice-audio');
const M = require('./lib/voice-metrics');
const { createBus } = require('../src/core/bus');
const { createVoiceController } = require('../src/core/voice/controller');
const { createWhisperStt } = require('../src/core/voice/whisper');
const { createVad } = require('../src/core/voice/vad');
const { createModelVad } = require('../src/core/voice/vad-model');
const { loadSilero } = require('../src/core/voice/silero');
const { sttPrompt } = require('../src/core/voice/stt-prompt');
const { DEFAULTS } = require('../src/core/config');

const ROOT = path.join(__dirname, '..');
const ENG = path.join(ROOT, 'engines');
const OUT = path.join(ROOT, 'eval', 'voice', 'out');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SR = 16000, FRAME = 320;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function turn(cfg, vadFactory, whisper, clip) {
  const bus = createBus();
  let firstAudio = null, sent = null;
  const tts = { id: 't', async status() { return { ready: true }; }, speak() { firstAudio ??= performance.now(); return { done: Promise.resolve() }; } };
  const orchestrator = { busy: false, stop() {}, async send(id, text) { sent = text; return { reply: 'Okay.', sessionId: 's' }; } };
  const vc = createVoiceController({ bus, orchestrator, engines: { stt: whisper, tts, wake: null }, getConfig: () => ({ ...DEFAULTS, ...cfg }), getSessionId: () => 's', vadOptions: { silenceMs: cfg.endSilenceMs }, vadFactory });
  const pcm = A.toInt16(A.readWav(fs.readFileSync(path.join(OUT, clip.file))).samples);
  const tail = new Int16Array(SR * 3);   // 3 s of near-silence after the clip (room noise level)
  for (let i = 0; i < tail.length; i++) tail[i] = (Math.random() - 0.5) * 60;
  const all = new Int16Array(pcm.length + tail.length); all.set(pcm); all.set(tail, pcm.length);
  vc.listen();
  const t0 = performance.now(), endAt = t0 + clip.speechEndMs;
  for (let f = 0, k = 0; f + FRAME <= all.length && firstAudio === null; f += FRAME, k++) {
    const due = t0 + (k + 1) * 20;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);
    vc.feed(all.subarray(f, f + FRAME), SR);
  }
  for (let i = 0; i < 100 && firstAudio === null; i++) await sleep(20);
  vc.cancel();
  const w = M.wer(clip.text, sent || '');
  return { id: clip.id, noise: clip.noise, ms: firstAudio === null ? null : Math.round(firstAudio - endAt), sent, clipped: w.errors / Math.max(1, w.ref) > 0.3 };
}

(async () => {
  const n = +arg('--n', 20);
  const man = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  // half clean, half pink 10 dB; commands, long ones and the mid-sentence pause clips
  const pool = man.clips.filter(c => c.wake && (c.noise === 'none' || (c.noise === 'pink' && c.snr === 10)));
  const clips = pool.filter((_, i) => i % Math.ceil(pool.length / n) === 0).slice(0, n);
  const whisper = createWhisperStt({ exe: path.join(ENG, 'whisper', 'bin', 'Release', 'whisper-server.exe'), model: path.join(ENG, 'whisper', 'ggml-base.en.bin'), port: 47894, threads: +arg('--threads', 4), prompt: sttPrompt('v0') });
  await whisper.warm();
  await whisper.transcribe(new Int16Array(SR), SR);   // first call pays setup; not timed
  const silero = await loadSilero({ modelPath: path.join(ENG, 'vad', 'silero_vad.onnx'), ort: require('onnxruntime-node') });
  const setups = {
    'phase0 (energy, 700 ms)': { cfg: { endSilenceMs: 700, continuationGuard: false }, vad: o => createVad(o) },
    'phase4 (silero, 550 ms, guard)': { cfg: { endSilenceMs: 550, continuationGuard: true }, vad: o => createModelVad({ ...o, getModel: () => silero }) },
  };
  const report = { generatedAt: new Date().toISOString(), note: 'Synthetic Piper speech; LLM excluded (fake reply). ms = actual end of speech → first audio.', clips: clips.length, setups: {} };
  for (const [name, s] of Object.entries(setups)) {
    const rows = [];
    for (const c of clips) rows.push(await turn(s.cfg, s.vad, whisper, c));
    const ms = rows.map(r => r.ms).filter(x => x !== null);
    report.setups[name] = { p50: M.percentile(ms, 50), p95: M.percentile(ms, 95), timedOut: rows.filter(r => r.ms === null).length, clipped: rows.filter(r => r.clipped).map(r => `${r.id}/${r.noise}: ${r.sent}`), rows };
    console.log(name.padEnd(32), 'p50', report.setups[name].p50, 'p95', report.setups[name].p95, 'clipped', report.setups[name].clipped.length, 'no reply', report.setups[name].timedOut);
  }
  whisper.close?.();
  fs.writeFileSync(path.join(ROOT, 'eval', 'voice', 'p4-latency.json'), JSON.stringify(report, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
