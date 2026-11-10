// Render eval/voice/phrases.json to 16 kHz mono WAVs with Piper, then mix each at SNR 20/10/5 dB with
// white / pink / fan noise. Output: eval/voice/out/ (gitignored) + out/manifest.json.
// NOTE: Piper audio is synthetic, not the user's voice. Metrics from it are a relative yardstick only.
// Optional user recordings: eval/voice/recorded/*.wav with a matching *.txt transcript (see voice-bench.js).
// usage: node scripts/make-voice-corpus.js [--engines <dir>] [--only <id>]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('./lib/voice-audio');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ENGINES = arg('--engines', process.env.JARVIS_ENGINES || path.join(ROOT, 'engines'));
const OUT = path.join(ROOT, 'eval', 'voice', 'out');
const SR = 16000, LEAD_MS = 600, TAIL_MS = 1500, PAUSE_MS = 400;
const NOISES = ['white', 'pink', 'fan'], SNRS = [20, 10, 5];
const ms = n => Math.round(n * SR / 1000);

function say(text) {
  const exe = path.join(ENGINES, 'piper', 'bin', 'piper', 'piper.exe');
  const tmp = path.join(OUT, '_tmp.wav');
  const r = spawnSync(exe, ['-m', path.join(ENGINES, 'piper', 'en_GB-alan-medium.onnx'), '--output_file', tmp, '-q'], { input: text + '\n', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(tmp)) throw new Error('piper failed for "' + text + '": ' + (r.stderr || r.error));
  const w = A.readWav(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  return A.resample(w.samples, w.rate, SR);
}

// first/last 20 ms frame above -40 dBFS: where the voice really is (Piper pads each clip with ~190 ms of silence)
function trimVoiced(x) {
  const F = ms(20); let a = -1, b = -1;
  for (let o = 0; o + F <= x.length; o += F) if (A.rms(x, o, o + F) > 0.01) { if (a < 0) a = o; b = o + F; }
  return a < 0 ? x : x.subarray(a, b);
}

function build(phrase) { // lead silence + trimmed speech segments joined by exactly PAUSE_MS gaps + tail silence
  const segs = phrase.text.split('|').map(s => s.trim()).filter(Boolean).map(say).map(x => {
    let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
    return trimVoiced(x.map(v => v * (peak ? 0.5 / peak : 1))); // normalise: Piper levels vary per phrase
  });
  const total = ms(LEAD_MS) + segs.reduce((n, s) => n + s.length, 0) + ms(PAUSE_MS) * (segs.length - 1) + ms(TAIL_MS);
  const x = new Float32Array(total), pauses = [];
  let o = ms(LEAD_MS);
  const start = o;
  segs.forEach((s, i) => {
    x.set(s, o); o += s.length;
    if (i < segs.length - 1) { pauses.push({ startMs: Math.round(o * 1000 / SR), endMs: Math.round((o + ms(PAUSE_MS)) * 1000 / SR) }); o += ms(PAUSE_MS); }
  });
  return { x, speech: [start, o], pauses };
}

function save(name, f) { fs.writeFileSync(path.join(OUT, name), A.wavBuffer(A.toInt16(f), SR)); }

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const only = arg('--only', null);
  const phrases = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'voice', 'phrases.json'), 'utf8')).filter(p => !only || p.id === only);
  const manifest = [];
  let seed = 1;
  for (const p of phrases) {
    const { x, speech, pauses } = build(p);
    const base = { id: p.id, category: p.category, wake: p.wake, text: p.text.replace(/\s*\|\s*/g, ' '), speechStartMs: Math.round(speech[0] * 1000 / SR), speechEndMs: Math.round(speech[1] * 1000 / SR), pauses };
    save(`${p.id}.clean.wav`, x);
    manifest.push({ ...base, file: `${p.id}.clean.wav`, noise: 'none', snr: null });
    for (const kind of NOISES) for (const snr of SNRS) {
      const mixed = A.mixAtSnr(x, A.noiseOf(kind, x.length, SR, seed++), snr, speech[0], speech[1]);
      const file = `${p.id}.${kind}${snr}.wav`;
      save(file, mixed);
      manifest.push({ ...base, file, noise: kind, snr });
    }
    process.stdout.write('.');
  }
  // 60 s noise-only clips (no speech) for false-start counting
  const noiseOnly = [];
  for (const kind of NOISES) {
    const n = A.noiseOf(kind, ms(60000), SR, 900 + noiseOnly.length);
    const g = 0.05 / (A.rms(n) || 1); // a room-noise level, ~ -26 dBFS RMS
    save(`noise-only.${kind}.wav`, n.map(v => v * g));
    noiseOnly.push({ file: `noise-only.${kind}.wav`, noise: kind, seconds: 60 });
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ sampleRate: SR, note: 'Synthetic Piper voice, not the user\'s voice', clips: manifest, noiseOnly }, null, 1));
  console.log(`\n${manifest.length} clips + ${noiseOnly.length} noise-only -> ${path.relative(ROOT, OUT)}`);
}
main();
