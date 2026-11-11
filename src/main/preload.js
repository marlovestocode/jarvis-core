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
    places: query => ipcRenderer.invoke('settings:places', String(query)),
    close: () => ipcRenderer.invoke('settings:close'),
    speakerStatus: () => ipcRenderer.invoke('speaker:status'),
    speakerEnroll: () => ipcRenderer.invoke('speaker:enroll'),
    speakerClear: () => ipcRenderer.invoke('speaker:clear'),
    memory: {
      list: q => ipcRenderer.invoke('memory:list', q),
      edit: p => ipcRenderer.invoke('memory:edit', p),
      remove: id => ipcRenderer.invoke('memory:delete', { id }),
      approve: (ids, text) => ipcRenderer.invoke('memory:approve', text === undefined ? { ids } : { ids, text }),
      reject: ids => ipcRenderer.invoke('memory:reject', { ids }),
      wipe: confirm => ipcRenderer.invoke('memory:wipe', { confirm }),
      neighbors: id => ipcRenderer.invoke('memory:neighbors', { id }),
      embedder: () => ipcRenderer.invoke('memory:embedder'),
      installEmbedder: () => ipcRenderer.invoke('memory:installEmbedder'),
      exportFile: () => ipcRenderer.invoke('memory:export'),
      importFile: () => ipcRenderer.invoke('memory:import'),
      summaries: () => ipcRenderer.invoke('summaries:list'),
      deleteSummary: p => ipcRenderer.invoke('summaries:delete', p),
    },
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
