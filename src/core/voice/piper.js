// Text-to-speech with Piper (local neural voice). One resident piper process reads one
// sentence per stdin line and prints the WAV it wrote; we play sentences in order while
// later ones are still being synthesized, so speech starts after the first sentence.
// play(pcm, rate, { signal, onLevel }) → Promise is supplied by the app (renderer audio).
const fs = require('node:fs');
const childProcess = require('node:child_process');

// small async queue usable with for-await
function channel() {
  const items = [], waiters = [];
  let closed = false;
  return {
    put(v) { if (closed) return; const w = waiters.shift(); if (w) w({ value: v, done: false }); else items.push(v); },
    close() { closed = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }); },
    [Symbol.asyncIterator]() {
      return { next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : closed ? Promise.resolve({ value: undefined, done: true }) : new Promise(r => waiters.push(r))) };
    },
  };
}

function createPiperTts({
  exe, model, outDir, play, sampleRate = 22050,
  spawn = childProcess.spawn, exists = p => fs.existsSync(p), readFile = p => fs.readFileSync(p), remove = p => fs.rm(p, { force: true }, () => {}),
  log = () => {},
}) {
  let proc = null, procRate = null;
  let pending = [];   // resolvers waiting for the next WAV path, in order
  const installed = () => exists(exe) && exists(model);

  function start(rate) {
    if (proc && procRate === rate) return proc;
    if (proc) { try { proc.kill(); } catch { /* gone */ } }
    for (const p of pending) p.reject(new Error('piper restarted'));
    pending = [];
    try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* exists or test path */ }
    const lengthScale = String(Math.round(100 / Math.max(0.5, Math.min(2, rate))) / 100);
    const kid = spawn(exe, ['-m', model, '--output_dir', outDir, '--length_scale', lengthScale, '-q'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc = kid; procRate = rate;
    let buf = '';
    kid.stdout.setEncoding?.('utf8');
    kid.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line && /\.wav$/i.test(line)) pending.shift()?.resolve(line);
      }
    });
    kid.stderr?.on?.('data', () => {});
    kid.stdin.on?.('error', () => {});
    const gone = msg => { if (proc === kid) { proc = null; for (const p of pending) p.reject(new Error(msg)); pending = []; } };
    kid.on('exit', code => { gone('piper exited'); if (code) log(`piper exited (${code})`); });
    kid.on('error', err => { gone('piper failed: ' + err.message); log('piper error: ' + err.message); });
    return kid;
  }

  function synth(text, rate) {
    const kid = start(rate);
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      kid.stdin.write(text + '\n');
    });
  }

  function pcmOf(path) {
    const b = readFile(path);
    remove(path);
    const n = Math.floor((b.length - 44) / 2);
    return new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + 44 + n * 2));
  }

  function createStream({ rate = 1, signal } = {}) {
    if (!installed()) throw new Error('Piper is not installed');
    const levels = channel();
    const jobs = [];
    let ended = false, wake = null;
    const kick = () => { if (wake) { const w = wake; wake = null; w(); } };

    const done = (async () => {
      try {
        for (let i = 0; ; i++) {
          while (i >= jobs.length && !ended && !signal?.aborted) await new Promise(r => { wake = r; });
          if (signal?.aborted || i >= jobs.length) break;
          let path;
          try { path = await jobs[i]; } catch (err) { if (signal?.aborted) break; throw err; }
          if (signal?.aborted) { remove(path); break; }
          await play(pcmOf(path), sampleRate, { signal, onLevel: v => levels.put(v) });
        }
      } finally {
        levels.close();
      }
    })();
    signal?.addEventListener('abort', kick, { once: true });

    return {
      push(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim();
        if (!t || ended || signal?.aborted) return;
        const job = synth(t, rate);
        job.catch(() => {});
        jobs.push(job);
        kick();
      },
      end() { ended = true; kick(); },
      levels,
      done,
    };
  }

  return {
    id: 'piper', label: 'Piper neural (British, Alan)',
    async status() { return installed() ? { ready: true, detail: 'Piper en_GB alan, local neural voice' } : { ready: false, detail: 'Piper is not installed' }; },
    available: () => installed(),
    warm(rate = 1) { if (installed()) start(rate); },
    createStream,
    speak(text, opts = {}) { const s = createStream(opts); s.push(text); s.end(); return { levels: s.levels, done: s.done }; },
    close() { if (proc) { try { proc.kill(); } catch { /* gone */ } proc = null; } },
  };
}

module.exports = { createPiperTts };
