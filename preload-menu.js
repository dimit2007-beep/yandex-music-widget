/* Мост для popup-меню. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mnu', {
  onInit: (cb) => ipcRenderer.on('menu:init', (_e, data) => cb(data)),
  ready: (size) => ipcRenderer.send('menu:ready', size),
  pick: (id) => ipcRenderer.invoke('menu:pick', id),
  close: () => ipcRenderer.invoke('menu:close'),
  log: (s) => ipcRenderer.send('menu:log', String(s)),
  // клик-сквозь прозрачных полей окна меню
  ignoreMouse: (v) => ipcRenderer.send('menu:ignore', v),
});
