const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ym', {
  // события от главного процесса
  onState: (cb) => ipcRenderer.on('yp:state', (_e, s) => cb(s)),
  onAuth: (cb) => ipcRenderer.on('yp:auth', (_e, a) => cb(a)),
  onFgMode: (cb) => ipcRenderer.on('yp:fgmode', (_e, m) => cb(m)),
  onUi: (cb) => ipcRenderer.on('yp:ui', (_e, u) => cb(u)),

  // действия
  uiState: () => ipcRenderer.invoke('ui:getUi'),
  ignoreMouse: (v) => ipcRenderer.invoke('ui:ignoreMouse', v),
  pause: () => ipcRenderer.invoke('ctl:pause'),
  play: () => ipcRenderer.invoke('ctl:play'),
  next: () => ipcRenderer.invoke('ctl:next'),
  prev: () => ipcRenderer.invoke('ctl:prev'),
  setLike: (trackId, liked) => ipcRenderer.invoke('ctl:setLike', trackId, liked),
  login: () => ipcRenderer.invoke('ui:login'),
  authState: () => ipcRenderer.invoke('ui:getAuthState'),
});
