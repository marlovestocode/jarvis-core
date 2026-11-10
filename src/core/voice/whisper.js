// Speech-to-text with whisper.cpp on the GPU. One resident whisper-server bound to
// 127.0.0.1 keeps the model in VRAM, so each phrase costs only inference time.
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');
const { wavBytes } = require('./windows-speech');

// whisper writes bracketed descriptions for silence/noise ("[BLANK_AUDIO]", "(machine whirring)", "[sound of rain]",
// "[static]"): spoken words never come in brackets, so any short bracketed text is dropped.
// A lone "you"/"thank you" is a known silence hallucination.
const NOISE = /\[[^\]]{1,40}\]|\([^)]{1,40}\)/g;
const HALLUCINATIONS = /^(?:you|thank you\.?|thanks for watching!?|bye\.?|\.)$/i;

function cleanTranscript(t) {
  const s = String(t || '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(s) ? '' : s;
}

function createWhisperStt({
  // gpu: CUDA + flash attention, full audio context (small.en-q5_1 encodes in ~0.12 s, ~0.5 GB VRAM).
  // CPU: -ng and a ~15 s audio window (base.en answers in ~0.2-0.3 s) so VRAM stays free for the LLM.
  // A GPU server that will not start (no CUDA, no VRAM) restarts once on the CPU with cpuModel.
  // Longer speech is split at its quietest point.
  exe, model, cpuModel = model, gpu = false, minLogprob = -1.0, port = 47810, threads = Math.max(4, Math.min(10, os.cpus().length - 2)), prompt = '', extraArgs, maxChunkSec = 14,
  spawn = childProcess.spawn, fetch: doFetch = (...a) => globalThis.fetch(...a), exists = p => fs.existsSync(p),
  startTimeoutMs = 30000, log = () => {},
}) {
  let proc = null, starting = null;
  const base = `http://127.0.0.1:${port}`;
  const installed = () => exists(exe) && exists(model);
  let useGpu = !!gpu;
  const args = () => (extraArgs || (useGpu ? ['-fa'] : ['-ng', '-ac', '768']));

  async function waitUp() {
    const t0 = Date.now();
    while (Date.now() - t0 < startTimeoutMs) {
      try { const r = await doFetch(base + '/', { signal: AbortSignal.timeout(1000) }); if (r && r.ok !== undefined) return; } catch { /* not yet */ }
      if (!proc) break;
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('Whisper server did not start');
  }

  function ensure() {
    if (!installed()) return Promise.reject(new Error('Whisper is not installed'));
    if (proc && !starting) return Promise.resolve();
    if (starting) return starting;
    const kid = spawn(exe, ['-m', useGpu ? model : cpuModel, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'en', '--no-timestamps', ...args()], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = kid;
    kid.on('exit', code => { if (proc === kid) { proc = null; log(`whisper server exited (${code})`); } });
    kid.on('error', err => { if (proc === kid) { proc = null; log('whisper server error: ' + err.message); } });
    kid.stderr?.on?.('data', () => {});
    kid.stdout?.on?.('data', () => {});
    starting = waitUp().then(() => { starting = null; }, err => {
      starting = null; try { kid.kill(); } catch { /* gone */ } if (proc === kid) proc = null;
      if (useGpu && exists(cpuModel)) { useGpu = false; log('whisper GPU did not start; falling back to CPU: ' + err.message); return ensure(); }
      throw err;
    });
    return starting;
  }

  return {
    id: 'whisper', label: 'Whisper (accurate)',
    async status() {
      return installed() ? { ready: true, detail: useGpu ? 'whisper.cpp on the GPU (CUDA)' : 'whisper.cpp on the CPU (tuned)' } : { ready: false, detail: 'Whisper is not installed' };
    },
    available: () => installed(),
    warm: () => ensure().then(() => true, () => false),
    async transcribe(pcm16, sampleRate, signal) {
      await ensure();
      const parts = [];
      for (const chunk of splitAtQuiet(pcm16, sampleRate, maxChunkSec)) parts.push(await infer(chunk, sampleRate, signal));
      return cleanTranscript(parts.join(' '));
    },
    close() { if (proc) { try { proc.kill(); } catch { /* gone */ } proc = null; } },
  };

  async function infer(pcm16, sampleRate, signal) {
    {
      const form = new FormData();
      form.append('file', new Blob([wavBytes(pcm16, sampleRate)], { type: 'audio/wav' }), 'speech.wav');
      form.append('response_format', 'verbose_json');
      form.append('temperature', '0');
      const p = typeof prompt === 'function' ? prompt() : prompt;
      if (p) form.append('prompt', p);
      const r = await doFetch(base + '/inference', { method: 'POST', body: form, signal });
      if (!r.ok) throw new Error(`Whisper HTTP ${r.status}`);
      const j = await r.json();
      const text = cleanTranscript(j.text);
      // a guess Whisper itself is unsure of is noise or mumbling, not a command: drop it rather than invent an answer
      const lp = meanLogprob(j.segments);
      if (text && lp !== null && lp < minLogprob) { log(`stt dropped (low confidence ${lp.toFixed(2)}): "${text.slice(0, 60)}"`); return ''; }
      return text;
    }
  }
}

// Mean avg_logprob over the segments of one inference, weighted by text length; null when Whisper gave none.
function meanLogprob(segments) {
  if (!Array.isArray(segments) || !segments.length) return null;
  let n = 0, sum = 0;
  for (const g of segments) {
    if (typeof g?.avg_logprob !== 'number') continue;
    const w = Math.max(1, String(g.text || '').trim().length);
    sum += g.avg_logprob * w; n += w;
  }
  return n ? sum / n : null;
}

// Cut long audio into chunks of at most maxSec, each cut at the quietest 20 ms frame
// in the last 40% of the window (a pause between words, not mid-word).
function splitAtQuiet(pcm, rate, maxSec) {
  const max = Math.floor(maxSec * rate), frame = Math.floor(rate / 50), out = [];
  let start = 0;
  while (pcm.length - start > max) {
    let best = start + max, bestE = Infinity;
    for (let f = start + Math.floor(max * 0.6); f + frame <= start + max; f += frame) {
      let e = 0;
      for (let i = f; i < f + frame; i++) e += pcm[i] * pcm[i];
      if (e < bestE) { bestE = e; best = f + Math.floor(frame / 2); }
    }
    out.push(pcm.subarray(start, best));
    start = best;
  }
  out.push(pcm.subarray(start));
  return out;
}

// config.sttModel → a file under engines/whisper. Only a bare *.bin name is accepted; a missing or unsafe
// name falls back to the default model with one warning, so voice never ends up without STT.
const DEFAULT_STT_MODEL = 'ggml-base.en.bin';
const GPU_STT_MODEL = 'ggml-small.en-q5_1.bin';
const SAFE_MODEL = /^[\w-][\w.-]*\.bin$/;   // same rule as config.js: no path parts, no leading dot
function whisperModelPath({ dir, name, exists = require('node:fs').existsSync, log = () => {} }) {
  const want = SAFE_MODEL.test(String(name || '')) ? require('node:path').join(dir, name) : null;
  if (want && exists(want)) return want;
  if (name !== DEFAULT_STT_MODEL) log(`Whisper model "${name}" not found or not allowed; using ${DEFAULT_STT_MODEL}`);
  return require('node:path').join(dir, DEFAULT_STT_MODEL);
}

// small.en is the GPU default; on the CPU it is too slow (~3.5 s), so the CPU default stays base.en.
function pickSttModel({ sttModel, sttGpu }) {
  return !sttGpu && sttModel === GPU_STT_MODEL ? DEFAULT_STT_MODEL : sttModel;
}

module.exports = { meanLogprob, pickSttModel, GPU_STT_MODEL, createWhisperStt, cleanTranscript, whisperModelPath, DEFAULT_STT_MODEL };
