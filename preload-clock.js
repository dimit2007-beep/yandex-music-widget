/* Мост только для окна часов. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ymc', {
  onFgMode: (cb) => ipcRenderer.on('yp:fgmode', (_e, m) => cb(m)),
  onUi: (cb) => ipcRenderer.on('yp:clockui', (_e, u) => cb(u)),
  uiState: () => ipcRenderer.invoke('ui:getUi').then((u) => u.clock), // настройки именно часов
  ignoreMouse: (v) => ipcRenderer.invoke('ui:ignoreMouse', v),
});
