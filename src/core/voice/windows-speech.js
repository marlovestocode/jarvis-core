// Starter speech engines on Windows built-in System.Speech (not AI models, replaceable).
// One long-lived PowerShell host (speech-host.ps1) speaks line-delimited JSON over stdio:
//   → {id, cmd, ...args}      ← {id, ok, result | error}      ← async {ev: 'wake'|'word'|'speak-end', id?}
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const SCRIPT = path.join(__dirname, 'speech-host.ps1');

function createSpeechHost({ spawn = childProcess.spawn, script = SCRIPT, log = () => {} } = {}) {
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
    kid.stderr?.on('data', d => log('speech host:', String(d).trim()));
    kid.on('error', err => { log('speech host error:', err.message); onExit(kid); });
    kid.on('exit', () => onExit(kid));
    kid.stdin.on?.('error', () => {});
  }

  function onExit(kid) {
    if (proc !== kid) return;
    proc = null;
    failAll(new Error('speech host exited'));
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { log('speech host bad line:', line.slice(0, 200)); return; }
    if (msg.ev) {
      for (const fn of [...(handlers.get(msg.ev) || [])]) { try { fn(msg); } catch { /* listener bug */ } }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'speech host error'));
  }

  function request(cmd, args = {}) {
    if (closed) return Promise.reject(new Error('speech host closed'));
    if (!proc) {
      if (starts >= 2) return Promise.reject(new Error('speech host not running'));
      try { start(); } catch (err) { return Promise.reject(err); }
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n'); } catch (err) { pending.delete(id); reject(err); }
    });
  }

  function on(ev, fn) {
    if (!handlers.has(ev)) handlers.set(ev, new Set());
    handlers.get(ev).add(fn);
    return () => handlers.get(ev)?.delete(fn);
  }

  function close() {
    closed = true;
    failAll(new Error('speech host closed'));
    if (proc) { try { proc.kill(); } catch { /* gone */ } proc = null; }
  }

  return { request, on, close, get running() { return !!proc; } };
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
      const s = await host.request('status');
      const ok = !!s?.[key];
      return { ready: ok, detail: ok ? 'Windows speech' : (s?.[key + 'Error'] || 'Not available') };
    } catch (err) { return { ready: false, detail: err.message }; }
  };
}

// TTS levels come from SAPI word-boundary events: 0.7 on each word, then decay.
function windowsTts(host) {
  return {
    id: 'windows', label: 'Windows speech',
    status: statusOf(host, 'tts'),
    speak(text, { rate = 1, signal } = {}) {
      let level = 0;
      let finished = false;
      const p = host.request('speak', { text: String(text), rate: rateToSapi(rate) });
      p.then(() => {}, () => {}).finally(() => { finished = true; });
      // the request id is the one just issued; word events carry it
      const off = host.on('word', () => { level = 0.7; });
      if (signal) {
        if (signal.aborted) host.request('stop-speak').catch(() => {});
        else signal.addEventListener('abort', () => { host.request('stop-speak').catch(() => {}); }, { once: true });
      }
      const done = p.finally(() => off());
      async function* levels() {
        while (!finished) {
          await new Promise(r => setTimeout(r, 33));
          yield level;
          level *= 0.8;
        }
      }
      return { levels: levels(), done };
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
        return String((await host.request('transcribe', { wav: file })) || '');
      } finally {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    },
  };
}

function windowsWake(host) {
  let off = null;
  return {
    id: 'windows', label: 'Windows speech ("Jarvis")',
    status: statusOf(host, 'wake'),
    start(onWake) {
      if (off) off();
      off = host.on('wake', () => onWake());
      host.request('wake-start', { word: 'Jarvis', confidence: 0.7 }).catch(() => { if (off) { off(); off = null; } });
    },
    stop() {
      if (off) { off(); off = null; }
      host.request('wake-stop').catch(() => {});
    },
  };
}

module.exports = { createSpeechHost, windowsTts, windowsStt, windowsWake, rateToSapi, wavBytes, SCRIPT };
