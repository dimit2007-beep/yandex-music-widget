/* Мост только для окна часов (приложение clock-main.js). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ymc', {
  onFgMode: (cb) => ipcRenderer.on('yp:fgmode', (_e, m) => cb(m)),
  onUi: (cb) => ipcRenderer.on('yp:ui', (_e, u) => cb(u)),
  uiState: () => ipcRenderer.invoke('ui:getUi'),
  ignoreMouse: (v) => ipcRenderer.invoke('ui:ignoreMouse', v),
  // ПКМ по часам — открыть меню у курсора
  ctxMenu: () => ipcRenderer.invoke('ymc:ctxmenu'),
  // отладка в лог основного процесса
  log: (msg) => ipcRenderer.send('ymc:log', String(msg)),
  moveTo: (x, y) => ipcRenderer.send('ymc:moveTo', x, y),
  // текущая позиция окна (для старта перетаскивания)
  getPositions: () => ipcRenderer.invoke('ymc:getPositions'),
});
