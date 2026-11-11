// Starter speech engines on Windows built-in System.Speech (not AI models, replaceable).
// One long-lived PowerShell host (speech-host.ps1) speaks line-delimited JSON over stdio:
//   → {id, cmd, ...args}      ← {id, ok, result | error}      ← async {ev: 'wake'|'word'|'speak-end', id?}
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const SCRIPT = path.join(__dirname, 'speech-host.ps1');

// Request limits (the host answers one line at a time, so a command that never returns would also block the ones behind it).
// status loads the recognizer list; wake-start builds two grammars; stop/wake-stop only flip a flag.
const STATUS_MS = 15000, WAKE_START_MS = 20000, STOP_MS = 5000;
// speak and transcribe run as long as the text / audio does: limits scale with it instead of a flat value.
const speakLimitMs = text => 30000 + 300 * String(text).length;   // 3.3 chars/s is far below the slowest voice rate
const transcribeLimitMs = seconds => 10000 + 2000 * seconds;      // SAPI reads a file faster than real time

function createSpeechHost({ spawn = childProcess.spawn, script = SCRIPT, log = () => {}, name = 'speech host' } = {}) {
  let proc = null;
  let starts = 0;
  let closed = false;
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map(); // ev -> Set<fn>

  function failAll(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function start() {
    starts++;
    const kid = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc = kid;
    let buf = '';
    kid.stdout.setEncoding?.('utf8');
    kid.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    kid.stderr?.on('data', d => log(name + ':', String(d).trim()));
    kid.on('error', err => { log(name + ' error:', err.message); onExit(kid, err.code); });
    kid.on('exit', code => onExit(kid, code));
    kid.stdin.on?.('error', () => {});
  }

  function emitLocal(ev, msg = {}) {
    for (const fn of [...(handlers.get(ev) || [])]) { try { fn({ ev, ...msg }); } catch { /* listener bug */ } }
  }

  // A crash restarts the host once, right away, and tells engines to re-arm (wake word).
  function onExit(kid, code) {
    if (proc !== kid) return;
    proc = null;
    failAll(new Error(name + ' exited'));
    if (closed) return;
    log(`${name} exited (code ${code ?? 'none'})`);
    if (starts >= 2) { log(name + ' gave up after a restart; ' + (name === 'speech host' ? 'voice uses text only' : 'it is off') + ' until the app restarts'); return; }
    try { start(); emitLocal('restart'); } catch (err) { log(name + ' restart failed:', err.message); }
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { log(name + ' bad line:', line.slice(0, 200)); return; }
    if (msg.ev) {
      for (const fn of [...(handlers.get(msg.ev) || [])]) { try { fn(msg); } catch { /* listener bug */ } }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || name + ' error'));
  }

  // timeoutMs: for callers that stop waiting (media). Without it an unanswered request stays in `pending` for ever.
  function request(cmd, args = {}, { timeoutMs } = {}) {
    if (closed) return Promise.reject(new Error(name + ' closed'));
    if (!proc) {
      if (starts >= 2) return Promise.reject(new Error(name + ' not running'));
      try { start(); } catch (err) { return Promise.reject(err); }
    }
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n'); } catch (err) { pending.delete(id); reject(err); }
    });
    if (timeoutMs > 0) {
      const timer = setTimeout(() => { const w = pending.get(id); if (w) { pending.delete(id); w.reject(new Error(name + ' timed out')); } }, timeoutMs);
      p.then(() => clearTimeout(timer), () => clearTimeout(timer));
    }
    p.id = id; // events about this request (word, speak-end) carry the same id
    return p;
  }

  function on(ev, fn) {
    if (!handlers.has(ev)) handlers.set(ev, new Set());
    handlers.get(ev).add(fn);
    return () => handlers.get(ev)?.delete(fn);
  }

  function close() {
    closed = true;
    failAll(new Error(name + ' closed'));
    if (proc) { try { proc.kill(); } catch { /* gone */ } proc = null; }
  }

  return { request, on, close, get running() { return !!proc; }, stats: () => ({ pending: pending.size }) };
}

// voiceRate 0.5..2.0 → SAPI Rate -10..10 (log scale, 1.0 = 0)
function rateToSapi(r) {
  const v = Math.round(Math.log2(Math.max(0.5, Math.min(2, Number(r) || 1))) * 10);
  return Math.max(-10, Math.min(10, v));
}

function wavBytes(pcm, sampleRate) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function statusOf(host, key) {
  return async () => {
    try {
      const s = await host.request('status', {}, { timeoutMs: STATUS_MS });
      const ok = !!s?.[key];
      return { ready: ok, detail: ok ? 'Windows speech' : (s?.[key + 'Error'] || 'Not available') };
    } catch (err) { return { ready: false, detail: err.message }; }
  };
}

const FINISH_MAX_MS = 1500;   // SAPI has no sentence events: a soft stop waits for the next word, at most this long

// TTS levels come from SAPI word-boundary events: 0.7 on each word, then decay.
function windowsTts(host, { finishMaxMs = FINISH_MAX_MS } = {}) {
  return {
    id: 'windows', label: 'Windows speech',
    status: statusOf(host, 'tts'),
    speak(text, { rate = 1, signal } = {}) {
      let level = 0;
      let finished = false;
      const stopSpeak = () => host.request('stop-speak', {}, { timeoutMs: STOP_MS }).catch(() => {});
      const p = host.request('speak', { text: String(text), rate: rateToSapi(rate) }, { timeoutMs: speakLimitMs(text) });
      p.then(() => {}, () => stopSpeak()).finally(() => { finished = true; });   // a speak that is given up on must not keep talking
      const off = host.on('word', m => { if (m.id === p.id) level = 0.7; });
      if (signal) {
        if (signal.aborted) stopSpeak();
        else signal.addEventListener('abort', stopSpeak, { once: true });
      }
      const done = p.finally(() => off());
      async function* levels() {
        while (!finished) {
          await new Promise(r => setTimeout(r, 33));
          const v = level;
          level *= 0.8;   // decay now, so a word that lands while we wait is shown at full height
          yield v;
        }
      }
      // soft stop: cut at the next word boundary (never mid-word), at most finishMaxMs from now
      function finishSentence() {
        if (finished) return Promise.resolve();
        return new Promise(resolve => {
          let t = null, offW = null;
          const stop = () => { clearTimeout(t); offW?.(); stopSpeak(); resolve(); };
          offW = host.on('word', m => { if (m.id === p.id) stop(); });
          t = setTimeout(stop, finishMaxMs);
          p.then(() => {}, () => {}).finally(() => { clearTimeout(t); offW?.(); resolve(); });
        }).then(() => done.catch(() => {}));
      }
      return { levels: levels(), done, finishSentence };
    },
  };
}

function windowsStt(host) {
  return {
    id: 'windows', label: 'Windows dictation (low accuracy)',
    status: statusOf(host, 'stt'),
    async transcribe(pcm16, sampleRate) {
      const file = path.join(os.tmpdir(), `jarvis-stt-${crypto.randomUUID()}.wav`);
      fs.writeFileSync(file, wavBytes(pcm16, sampleRate));
      try {
        return String((await host.request('transcribe', { wav: file }, { timeoutMs: transcribeLimitMs(pcm16.length / sampleRate) })) || '');
      } finally {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    },
  };
}

function windowsWake(host) {
  let off = null;
  let armed = false;
  const arm = () => host.request('wake-start', { word: 'Jarvis', confidence: 0.7 }, { timeoutMs: WAKE_START_MS }).catch(() => {});
  host.on('restart', () => { if (armed) arm(); }); // a crashed host forgot the wake word
  return {
    id: 'windows', label: 'Windows speech ("Jarvis")',
    status: statusOf(host, 'wake'),
    start(onWake) {
      if (off) off();
      off = host.on('wake', () => onWake());
      armed = true;
      arm();
    },
    stop() {
      armed = false;
      if (off) { off(); off = null; }
      host.request('wake-stop', {}, { timeoutMs: STOP_MS }).catch(() => {});
    },
  };
}

module.exports = { FINISH_MAX_MS, createSpeechHost, windowsTts, windowsStt, windowsWake, rateToSapi, wavBytes, SCRIPT };
