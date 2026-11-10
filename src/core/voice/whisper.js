// Speech-to-text with whisper.cpp on the GPU. One resident whisper-server bound to
// 127.0.0.1 keeps the model in VRAM, so each phrase costs only inference time.
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');
const { wavBytes } = require('./windows-speech');

// whisper writes these for silence/noise; a lone "you"/"thank you" is a known silence hallucination
const NOISE = /\[(?:BLANK_AUDIO|MUSIC|NOISE|Applause|Laughter|inaudible|silence)[^\]]*\]|\((?:music|noise|silence|applause|laughs?|sighs?|inaudible)[^)]*\)/gi;
const HALLUCINATIONS = /^(?:you|thank you\.?|thanks for watching!?|bye\.?|\.)$/i;

function cleanTranscript(t) {
  const s = String(t || '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(s) ? '' : s;
}

function createWhisperStt({
  // CPU whisper, tuned: base.en with a ~15 s audio window answers in ~0.2-0.3 s on a 6-core Ryzen and
  // leaves all VRAM to the LLM. Longer speech is split at its quietest point.
  exe, model, port = 47810, threads = Math.max(4, Math.min(10, os.cpus().length - 2)), prompt = '', extraArgs = ['-ac', '768'], maxChunkSec = 14,
  spawn = childProcess.spawn, fetch: doFetch = (...a) => globalThis.fetch(...a), exists = p => fs.existsSync(p),
  startTimeoutMs = 30000, log = () => {},
}) {
  let proc = null, starting = null;
  const base = `http://127.0.0.1:${port}`;
  const installed = () => exists(exe) && exists(model);

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
    const kid = spawn(exe, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'en', '--no-timestamps', ...extraArgs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = kid;
    kid.on('exit', code => { if (proc === kid) { proc = null; log(`whisper server exited (${code})`); } });
    kid.on('error', err => { if (proc === kid) { proc = null; log('whisper server error: ' + err.message); } });
    kid.stderr?.on?.('data', () => {});
    kid.stdout?.on?.('data', () => {});
    starting = waitUp().then(() => { starting = null; }, err => { starting = null; try { kid.kill(); } catch { /* gone */ } if (proc === kid) proc = null; throw err; });
    return starting;
  }

  return {
    id: 'whisper', label: 'Whisper base.en (accurate)',
    async status() {
      return installed() ? { ready: true, detail: 'whisper.cpp base.en, tuned CPU (~0.3 s)' } : { ready: false, detail: 'Whisper is not installed' };
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
      form.append('response_format', 'json');
      form.append('temperature', '0');
      if (prompt) form.append('prompt', prompt);
      const r = await doFetch(base + '/inference', { method: 'POST', body: form, signal });
      if (!r.ok) throw new Error(`Whisper HTTP ${r.status}`);
      const j = await r.json();
      return cleanTranscript(j.text);
    }
  }
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

module.exports = { createWhisperStt, cleanTranscript };
