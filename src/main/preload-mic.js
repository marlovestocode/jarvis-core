// Preload for the hidden mic window only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('micBridge', {
  pcm: frame => ipcRenderer.send('mic:pcm', frame),
  status: (ok, reason = '', sampleRate = 0) => ipcRenderer.send('mic:status', { ok: !!ok, reason: String(reason), sampleRate }),
  ready: () => ipcRenderer.send('mic:ready'),
  onCommand: fn => ipcRenderer.on('mic:cmd', (_e, c) => fn(c)),
});
