// Mic capture in a hidden renderer; frames go to the voice controller.
// The mic is open only while voice is active (listening, transcribing, speaking for barge-in).
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

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

  return { start, stop, ensure, get running() { return running; }, destroy() { if (win && !win.isDestroyed()) win.destroy(); } };
}

module.exports = { createMic, toInt16 };
