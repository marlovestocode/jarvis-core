// Mic capture in a hidden renderer; frames go to the voice controller.
// The mic is open only while voice is active (listening, transcribing, speaking for barge-in).
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const READY_MS = 10000;

function toInt16(data) {
  if (data instanceof Int16Array) return data;
  if (ArrayBuffer.isView(data)) return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
  if (data instanceof ArrayBuffer) return new Int16Array(data);
  return null;
}

function createMic({ getDeviceId, onFrame, onStatus, log = () => {} }) {
  let win = null, ready = false, want = false, running = false, lastDevice = null;

  function ensure() {
    if (win && !win.isDestroyed()) return;
    ready = false;
    win = new BrowserWindow({
      show: false, width: 200, height: 100, skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, 'preload-mic.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.loadFile(path.join(__dirname, '..', 'ui', 'mic.html'));
    win.on('closed', () => { win = null; ready = false; running = false; });
  }

  const send = c => { if (win && !win.isDestroyed() && ready) win.webContents.send('mic:cmd', c); };
  const fromMic = e => win && !win.isDestroyed() && e.sender === win.webContents;

  ipcMain.on('mic:ready', e => { if (!fromMic(e)) return; ready = true; if (want) start(); });
  ipcMain.on('mic:pcm', (e, data) => { if (!fromMic(e) || !running) return; const f = toInt16(data); if (f) onFrame(f, 16000); });
  ipcMain.on('mic:status', (e, s) => {
    if (!fromMic(e)) return;
    if (!s.ok) { running = false; want = false; log('mic unavailable:', s.reason); }
    onStatus(s);
  });

  function start() {
    want = true;
    ensure();
    const dev = getDeviceId() || null;
    if (running && dev === lastDevice) return;
    if (!ready) return;          // starts on mic:ready
    running = true; lastDevice = dev;
    send({ cmd: 'start', deviceId: dev });
  }

  function stop() {
    want = false;
    if (!running) return;
    running = false;
    send({ cmd: 'stop' });
  }

  // ---- speech playback through the same hidden window; real levels for the orb ----
  let playSeq = 0;
  const playing = new Map(); // id → { started(latency), ended(), failed(msg) }
  ipcMain.on('mic:played', (e, m) => {
    if (!fromMic(e)) return;
    const p = playing.get(m.id);
    if (!p) return;
    if (m.phase === 'started') p.started(m.latency || 0);
    else if (m.phase === 'error') p.failed(m.error);
    else p.ended();
  });
  // The page loads on first use. If it never does (window closed or crashed), stop polling after READY_MS instead of for ever.
  const whenReady = () => new Promise((res, rej) => {
    ensure();
    const t0 = Date.now();
    const check = () => {
      if (ready) res();
      else if (Date.now() - t0 > READY_MS) rej(new Error('the mic window did not load'));
      else setTimeout(check, 20);
    };
    check();
  });

  async function play(pcm, rate, { signal, onLevel } = {}) {
    if (signal?.aborted) return;
    await whenReady();
    if (signal?.aborted) return;       // cancelled while the page was loading: the abort listener below would never fire
    const id = ++playSeq;
    const durMs = pcm.length / rate * 1000;
    await new Promise((resolve, reject) => {
      let timer = null, t0 = 0, guard = null;
      const finish = err => {
        clearInterval(timer); clearTimeout(guard); playing.delete(id);
        signal?.removeEventListener?.('abort', onAbort);
        onLevel?.(0);
        err ? reject(new Error(err)) : resolve();
      };
      const onAbort = () => { send({ cmd: 'stop-play' }); finish(); };
      playing.set(id, {
        started: latency => {
          t0 = Date.now() + latency * 1000;
          timer = setInterval(() => onLevel?.(levelAt(pcm, rate, (Date.now() - t0) / 1000)), 33);
        },
        ended: () => finish(),
        failed: msg => finish('playback failed: ' + msg),
      });
      guard = setTimeout(() => finish(), durMs + 3000); // never hang on a lost 'ended'
      signal?.addEventListener?.('abort', onAbort, { once: true });
      send({ cmd: 'play', id, pcm, rate });
    });
  }

  return { start, stop, ensure, play, get running() { return running; }, destroy() { if (win && !win.isDestroyed()) win.destroy(); } };
}

// RMS (0..1, scaled for display) of the ~33 ms of audio playing at time t.
function levelAt(pcm, rate, t, win = 0.033) {
  const a = Math.max(0, Math.floor(t * rate)), b = Math.min(pcm.length, a + Math.floor(win * rate));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += (pcm[i] / 32768) ** 2;
  return Math.min(1, Math.sqrt(s / (b - a)) * 3);
}

module.exports = { createMic, toInt16, levelAt };
