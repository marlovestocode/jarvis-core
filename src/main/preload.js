// The only bridge between renderer and main. Channels are ai:*.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  send: text => ipcRenderer.invoke('ai:send', String(text)),
  stop: () => ipcRenderer.invoke('ai:stop'),
  newChat: () => ipcRenderer.invoke('ai:new'),
  openChat: id => ipcRenderer.invoke('ai:open', String(id)),
  current: () => ipcRenderer.invoke('ai:current'),
  clear: () => ipcRenderer.invoke('ai:clear'),
  retry: () => ipcRenderer.invoke('ai:retry'),
  list: () => ipcRenderer.invoke('ai:list'),
  hide: () => ipcRenderer.invoke('ai:hide'),
  escape: () => ipcRenderer.invoke('ai:escape'),
  copy: text => ipcRenderer.invoke('ai:copy', String(text)),
  openSettings: () => ipcRenderer.invoke('ai:settings'),
  voice: () => ipcRenderer.invoke('ai:voice'),
  status: () => ipcRenderer.invoke('ai:status'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: patch => ipcRenderer.invoke('settings:set', patch),
    capture: on => ipcRenderer.invoke('settings:capture', !!on),
    close: () => ipcRenderer.invoke('settings:close'),
  },
  onEvent: fn => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on('ai:event', h);
    return () => ipcRenderer.off('ai:event', h);
  },
  onShown: fn => {
    const h = () => fn();
    ipcRenderer.on('ai:shown', h);
    return () => ipcRenderer.off('ai:shown', h);
  },
});
